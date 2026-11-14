// Tests the daily cancel limit and its join block against the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/cancels.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { recordCancel, recordNoShow } = require("../lib/strikes");
const { joinQueue, JoinError } = require("../lib/join");
const { toMs, startOfTodayMs, DAY_MS } = require("../lib/time");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const HOUR = 60 * 60 * 1000;
const tz = config.tzOffsetMs;
// 10:00 AM Manila today, so a few hours either way stay on the same queue day.
let clock = startOfTodayMs(tz, Date.now()) + 10 * HOUR;
const deps = { db, FieldValue, Timestamp, config, now: () => clock };
// Each test student gets their own school email, so their own student number (one ticket in line per number).
function testEmail(uid) {
  let n = 7;
  for (const c of String(uid)) n = (n * 31 + c.charCodeAt(0)) % 900000;
  return "jd" + (100000 + n) + "@stimalolos.edu.ph";
}
const student = (uid) => ({ uid, token: { firebase: { sign_in_provider: "microsoft.com" }, name: "Dela Cruz, Juan", email: testEmail(uid) } });
const ticketOf = (id, uid) => ({ id, ownerId: uid, ownerName: "Dela Cruz, Juan", studentNumber: "020002000123456", ticketNo: "CA1-0" + id.slice(-2) });
const state = async (uid) => ((await db.collection("joinState").doc(uid).get()).data() || {});
const limit = config.cancelBlock.limit;

async function attemptJoin(uid) {
  try {
    return { ok: true, result: await joinQueue(deps, student(uid), { stationId: "cashier", purpose: "Tuition" }) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

(async () => {
  for (const name of ["tickets", "stations", "joinState", "students", "settings"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection("stations").doc("cashier").set({ name: "Cashier", code: "CA1", count: 0, active: true });

  // Cancels add up, once per ticket.
  let r = await recordCancel(deps, ticketOf("c01", "s1"), clock);
  check("a cancel is number 1 today", r.counted && r.count === 1 && !r.blockedUntilMs, JSON.stringify(r));
  r = await recordCancel(deps, ticketOf("c01", "s1"), clock);
  check("the same ticket delivered again isn't counted twice", !r.counted && r.count === 1, JSON.stringify(r));
  for (let i = 2; i < limit; i++) r = await recordCancel(deps, ticketOf("c0" + i, "s1"), clock + i * 1000);
  check("cancels below the limit (" + (limit - 1) + ") don't block", r.count === limit - 1 && !r.blockedUntilMs, JSON.stringify(r));
  let join = await attemptJoin("s1");
  check("a student below the limit can still join", join.ok, JSON.stringify(join));
  await db.collection("tickets").doc(join.result.ticketId).update({ status: "completed" });

  // The limit blocks until the queue day ends.
  clock += HOUR;
  r = await recordCancel(deps, ticketOf("c09", "s1"), clock);
  let s = await state("s1");
  const midnight = startOfTodayMs(tz, clock) + DAY_MS;
  check("cancel number " + limit + " blocks until midnight Manila", r.blockedUntilMs === midnight && toMs(s.blockedUntil) === midnight, JSON.stringify(r) + " expected " + midnight);
  check("the block says why, keeps the name for the admin list, and clears the count", s.blockedReason === "cancels" && s.ownerName === "Dela Cruz, Juan" && Object.keys(s.cancels || {}).length === 0, JSON.stringify(s));
  r = await recordCancel(deps, ticketOf("c09", "s1"), clock);
  check("the blocking event delivered again doesn't start a new block", !r.counted, JSON.stringify(r));

  clock += 5000;
  join = await attemptJoin("s1");
  check("a blocked student can't join, and is told it's for cancelling", !join.ok && join.code === "failed-precondition" && /You cancelled 5 tickets today/.test(join.message) && /front desk/.test(join.message), JSON.stringify(join));

  clock = midnight + 5000;
  join = await attemptJoin("s1");
  check("the next day they can join again", join.ok, JSON.stringify(join));

  // Yesterday's cancels don't count.
  clock = startOfTodayMs(tz, Date.now()) + 10 * HOUR;
  for (let i = 1; i < limit; i++) await recordCancel(deps, ticketOf("d0" + i, "s2"), clock - DAY_MS);
  r = await recordCancel(deps, ticketOf("d09", "s2"), clock);
  check("cancels from yesterday don't count today", r.count === 1 && !r.blockedUntilMs && (await state("s2")).cancelsDay !== undefined, JSON.stringify(r));

  // A longer missed-turn block isn't shortened.
  for (const id of ["n1", "n2", "n3"]) await recordNoShow(deps, ticketOf(id, "s3"), clock);
  const noShowUntil = toMs((await state("s3")).blockedUntil);
  for (let i = 1; i <= limit; i++) r = await recordCancel(deps, ticketOf("e0" + i, "s3"), clock + i);
  s = await state("s3");
  check("a missed-turn block that ends later is kept", toMs(s.blockedUntil) === noShowUntil && s.blockedReason === "noShow" && !r.blockedUntilMs, JSON.stringify({ r, until: toMs(s.blockedUntil), noShowUntil, reason: s.blockedReason }));

  // An admin lifting the block (what Settings writes) lets them join at once.
  for (let i = 1; i <= limit; i++) await recordCancel(deps, ticketOf("f0" + i, "s4"), clock + i);
  await db.collection("joinState").doc("s4").update({ blockedUntil: null, noShows: {}, cancels: {}, unblockedBy: "admin@qficient.com", unblockedAt: FieldValue.serverTimestamp() });
  clock += 30000;
  join = await attemptJoin("s4");
  check("after an admin lifts the block they can join right away", join.ok, JSON.stringify(join));

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
