// Window hours against the Firestore emulator: no new tickets outside them (student join, walk-in QR, manual
// ticket) and the void at closing.
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/hours-emulator.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { joinQueue, JoinError } = require("../lib/join");
const { redeemWalkinPass, hashSecret } = require("../lib/walkin");
const { createManualTicket } = require("../lib/manual");
const { voidAtClose } = require("../lib/jobs");
const { isNoShow } = require("../lib/strikes");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const TZ = config.tzOffsetMs;
const DAY = 24 * 60 * 60 * 1000;
// This week's Monday, midnight in Manila, so the times below are on the right weekdays.
const nowDay = new Date(Date.now() + TZ).getUTCDay();
const MONDAY = Math.floor((Date.now() + TZ) / DAY) * DAY - TZ - ((nowDay + 6) % 7) * DAY;
const at = (d, h, m) => MONDAY + d * DAY + ((h * 60) + (m || 0)) * 60 * 1000;

let clock = at(0, 10);
const deps = { db, FieldValue, Timestamp, config, now: () => clock };

const weekday = { open: true, start: 480, end: 1020 };
const HOURS = {
  enabled: true,
  days: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: { open: true, start: 480, end: 720 }, sun: { open: false, start: 480, end: 1020 } },
  lastJoinMinutes: 30
};

// Each test student gets their own school email, so their own student number (one ticket in line per number).
function testEmail(uid) {
  let n = 7;
  for (const c of String(uid)) n = (n * 31 + c.charCodeAt(0)) % 900000;
  return "jd" + (100000 + n) + "@stimalolos.edu.ph";
}
const student = (uid) => ({ uid, token: { firebase: { sign_in_provider: "microsoft.com" }, name: "Dela Cruz, Juan", email: testEmail(uid) } });
const phone = (uid) => ({ uid, token: { firebase: { sign_in_provider: "anonymous" } } });
const builtInAdmin = { uid: "admin", token: { email: "admin@qficient.com", firebase: { sign_in_provider: "password" } } };

async function attempt(fn, auth, data) {
  try {
    return { ok: true, result: await fn(deps, auth, data) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

async function wipe() {
  for (const name of ["tickets", "stations", "joinState", "students", "settings", "walkinPasses", "staff"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const SECRET = "Abc123_-xyzXYZ789secret";
async function makePass(id) {
  await db.collection("walkinPasses").doc(id).set({
    ownerName: "Maria Clara", stationId: "cashier", purpose: "Pay tuition",
    secretHash: hashSecret(SECRET), createdBy: "enf@x.com", createdAt: Timestamp.fromMillis(clock)
  });
}

async function ticket(id, status, createdMs, extra) {
  await db.collection("tickets").doc(id).set(Object.assign({
    ticketNo: id.toUpperCase(), stationId: "cashier", ownerId: "owner-" + id, status: status,
    createdAt: Timestamp.fromMillis(createdMs)
  }, extra || {}));
}

const statusOf = async (id) => (await db.collection("tickets").doc(id).get()).data();

(async () => {
  await wipe();
  await db.collection("stations").doc("cashier").set({ name: "Cashier", code: "CA1", count: 0, active: true });

  // ---- Joining ----
  let r = await attempt(joinQueue, student("s1"), { stationId: "cashier", purpose: "Tuition" });
  check("no window hours saved: joining works as before", r.ok, JSON.stringify(r));

  await db.collection("settings").doc("windowHours").set(Object.assign({}, HOURS, { enabled: false }));
  clock = at(6, 22);
  r = await attempt(joinQueue, student("s2"), { stationId: "cashier", purpose: "Tuition" });
  check("window hours switched off: joining on a Sunday night works", r.ok, JSON.stringify(r));

  await db.collection("settings").doc("windowHours").set(HOURS);
  clock = at(1, 7, 30);
  r = await attempt(joinQueue, student("s3"), { stationId: "cashier", purpose: "Tuition" });
  check("before opening: refused with when they open", !r.ok && r.code === "failed-precondition" && r.message === "The windows are closed. They open today at 8:00 AM.", JSON.stringify(r));
  const state = (await db.collection("joinState").doc("s3").get());
  check("a refused join uses up nothing", !state.exists || !state.data().joins, JSON.stringify(state.exists && state.data()));

  clock = at(1, 9);
  r = await attempt(joinQueue, student("s3"), { stationId: "cashier", purpose: "Tuition" });
  check("while open: joining works", r.ok, JSON.stringify(r));

  clock = at(2, 16, 50);
  r = await attempt(joinQueue, student("s4"), { stationId: "cashier", purpose: "Tuition" });
  check("in the last 30 minutes: refused, the windows close at 5", !r.ok && r.code === "failed-precondition" && /stopped taking new tickets.*5:00 PM/.test(r.message), JSON.stringify(r));

  clock = at(5, 13);
  r = await attempt(joinQueue, student("s4"), { stationId: "cashier", purpose: "Tuition" });
  check("Saturday after noon: refused until Monday", !r.ok && /open on Monday at 8:00 AM/.test(r.message), JSON.stringify(r));

  clock = at(6, 10);
  r = await attempt(joinQueue, student("s4"), { stationId: "cashier", purpose: "Tuition" });
  check("Sunday: refused", !r.ok && /open tomorrow at 8:00 AM/.test(r.message), JSON.stringify(r));

  // ---- Walk-in QR and manual tickets ----
  clock = at(6, 10);
  await makePass("passClosed01");
  r = await attempt(redeemWalkinPass, phone("w1"), { passId: "passClosed01", secret: SECRET });
  check("walk-in QR outside the hours: refused", !r.ok && r.code === "failed-precondition" && /windows are closed/.test(r.message), JSON.stringify(r));
  check("the pass is not used up", !(await db.collection("walkinPasses").doc("passClosed01").get()).data().usedAt);

  clock = at(0, 11);
  await makePass("passOpen0001");
  r = await attempt(redeemWalkinPass, phone("w2"), { passId: "passOpen0001", secret: SECRET });
  check("walk-in QR during the hours: a ticket", r.ok, JSON.stringify(r));

  clock = at(0, 18);
  r = await attempt(createManualTicket, builtInAdmin, { ownerName: "Lola Cruz", stationId: "cashier", purpose: "Pay tuition" });
  check("manual ticket after closing: refused", !r.ok && r.code === "failed-precondition" && /windows are closed/.test(r.message), JSON.stringify(r));
  clock = at(0, 12);
  r = await attempt(createManualTicket, builtInAdmin, { ownerName: "Lola Cruz", stationId: "cashier", purpose: "Pay tuition" });
  check("manual ticket during the hours: made", r.ok, JSON.stringify(r));

  // ---- Void at closing ----
  for (const name of ["tickets"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const today = at(3, 0);
  await ticket("wait1", "waiting", today + 9 * 3600000);
  await ticket("hold1", "skipped", today + 10 * 3600000, { lastCalled: true, lastCallAt: Timestamp.fromMillis(today + 16 * 3600000) });
  await ticket("serv1", "serving", today + 11 * 3600000);
  await ticket("done1", "completed", today + 8.5 * 3600000);
  await ticket("old1", "waiting", today - 3 * 3600000); // yesterday's: left for the nightly cleanup

  clock = at(3, 16, 59);
  let n = await voidAtClose(deps);
  check("while still open (even in the last minutes): nothing is voided", n === 0 && (await statusOf("wait1")).status === "waiting", String(n));

  clock = at(3, 17, 1);
  n = await voidAtClose(deps);
  const w = await statusOf("wait1");
  const h = await statusOf("hold1");
  check("after closing: today's waiting and on-hold tickets are voided", n === 2 && w.status === "void" && h.status === "void", String(n));
  check("they are marked as voided at closing", w.closedVoid === true && w.autoVoided === true && h.closedVoid === true && !!w.voidedAt, JSON.stringify(w));
  check("a ticket being served is left for the staff", (await statusOf("serv1")).status === "serving");
  check("completed and earlier days' tickets are untouched", (await statusOf("done1")).status === "completed" && (await statusOf("old1")).status === "waiting");
  check("it is not a strike", !isNoShow({ status: "skipped", ownerId: "owner-hold1" }, h));

  n = await voidAtClose(deps);
  check("running again finds nothing to do", n === 0, String(n));

  await ticket("late1", "waiting", at(3, 17, 5), { stationId: "cashier" });
  n = await voidAtClose(deps);
  check("a ticket put in line after closing (a transfer) is voided on the next run", n === 1 && (await statusOf("late1")).closedVoid === true, String(n));

  await db.collection("settings").doc("windowHours").set(Object.assign({}, HOURS, { enabled: false }));
  await ticket("off1", "waiting", at(3, 17, 6));
  n = await voidAtClose(deps);
  check("with the hours switched off nothing is voided", n === 0 && (await statusOf("off1")).status === "waiting", String(n));

  await wipe();
  console.log("\n" + (failures ? failures + " failed" : "all passed"));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
