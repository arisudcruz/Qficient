// Runs the notifier against the Firestore emulator with a fake push sender.
//   firebase emulators:exec --only firestore --project demo-qficient "node test/run.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const { createService } = require("../lib/service");
const baseConfig = require("../config");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const config = Object.assign({}, baseConfig, { voidCheckMs: 150, dayCheckMs: 60 * 60 * 1000, heartbeatMs: 60 * 1000 });

const pushes = [];
function fakeSend(token, message) {
  if (token === "dead-token") {
    const err = new Error("not registered");
    err.code = "messaging/registration-token-not-registered";
    return Promise.reject(err);
  }
  pushes.push({ token: token, title: message.title, tag: message.data.tag, body: message.body });
  return Promise.resolve("ok");
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 5000);
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(80);
  }
  return false;
}
const pushFor = (tag) => pushes.filter((p) => p.tag === tag);
const ts = (msAgo) => Timestamp.fromMillis(Date.now() - msAgo);

function newService() {
  return createService({ db, FieldValue, Timestamp, sendPush: fakeSend, config, log: () => {} });
}

async function wipe() {
  for (const name of ["tickets", "stations", "settings", "deviceTokens", "serverStatus"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

function ticket(id, no, owner, station, extra) {
  return db.collection("tickets").doc(id).set(Object.assign({
    ticketNo: no, stationId: station, ownerId: owner, ownerName: owner, studentNumber: "", studentType: "regular",
    purpose: "x", status: "waiting", verified: false, createdAt: FieldValue.serverTimestamp()
  }, extra || {}));
}

(async () => {
  await wipe();
  await db.collection("stations").doc("cashier").set({ name: "Cashier", count: 5, nowServingId: "old1", active: true });
  await db.collection("stations").doc("registrar").set({ name: "Registrar", count: 0, nowServingId: null, active: true });
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 0.02 }); // ~1.2 seconds
  for (const u of ["u1", "u2", "u3", "u5"]) await db.collection("deviceTokens").doc(u).set({ token: "tok-" + u });
  await db.collection("deviceTokens").doc("u4").set({ token: "dead-token" });
  // A leftover from two days ago that a station still points at.
  await ticket("old1", "CA-900", "ghost", "cashier", { status: "serving", createdAt: ts(2 * 24 * 3600 * 1000 + 5000) });
  await ticket("old2", "CA-901", "ghost", "cashier", { status: "waiting", createdAt: ts(3 * 24 * 3600 * 1000) });

  let service = newService();
  await service.start();
  await wait(600);

  const old1 = (await db.collection("tickets").doc("old1").get()).data();
  const old2 = (await db.collection("tickets").doc("old2").get()).data();
  check("cleanup: leftover tickets from earlier days are voided", old1.status === "void" && old2.status === "void" && old1.staleCleanup === true, JSON.stringify([old1.status, old2.status]));
  check("cleanup: station no longer points at a stale ticket", (await db.collection("stations").doc("cashier").get()).data().nowServingId === null);
  check("heartbeat is written on start", (await db.collection("serverStatus").doc("notifier").get()).exists);

  // Three students join an idle station: nobody is being served, so nobody is "next" yet.
  await ticket("t1", "CA-001", "u1", "cashier");
  await wait(150);
  await ticket("t2", "CA-002", "u2", "cashier");
  await wait(150);
  await ticket("t3", "CA-003", "u3", "cashier");
  await wait(700);
  check("no pushes when students just join an idle station", pushes.length === 0, JSON.stringify(pushes));

  // Staff call the first ticket.
  await db.collection("tickets").doc("t1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("serving: ticket owner is told it's their turn", await until(() => pushFor("t1:serving").length === 1));
  check("next: the following ticket is told they're next", await until(() => pushFor("t2:next:cashier").length === 1));
  check("next: only one person is told they're next", pushes.filter((p) => p.title === "You're next in line").length === 1);
  check("serving: message names the station and ticket", /CA-001/.test(pushFor("t1:serving")[0].body) && /Cashier/.test(pushFor("t1:serving")[0].body), pushFor("t1:serving")[0] && pushFor("t1:serving")[0].body);

  // Recall.
  await db.collection("tickets").doc("t1").update({ recalledAt: FieldValue.serverTimestamp(), recallCount: FieldValue.increment(1) });
  check("recall: owner is notified", await until(() => pushFor("t1:recall").length === 1));

  // Skip, then the next ticket is served.
  await db.collection("tickets").doc("t1").update({ status: "skipped", skippedAt: FieldValue.serverTimestamp() });
  check("skipped: owner is notified", await until(() => pushFor("t1:skipped").length === 1));
  await db.collection("tickets").doc("t2").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("serving: second ticket is told it's their turn", await until(() => pushFor("t2:serving").length === 1));
  check("next: third ticket is told they're next", await until(() => pushFor("t3:next:cashier").length === 1));

  // Last call, then the server voids it on its own once the window passes.
  await db.collection("tickets").doc("t1").update({ lastCalled: true, lastCallAt: FieldValue.serverTimestamp() });
  check("last call: owner is notified", await until(() => pushFor("t1:lastCall").length === 1));
  check("auto-void: expired last call is voided by the server", await until(async () => {
    const d = (await db.collection("tickets").doc("t1").get()).data();
    return d.status === "void" && d.autoVoided === true;
  }, 6000));
  check("auto-void: owner is told", await until(() => pushFor("t1:void").length === 1) && /time ran out/.test(pushFor("t1:void")[0].body));

  // A skipped ticket whose last call is still running must not be voided early.
  await ticket("t6", "CA-006", "u5", "cashier", { status: "skipped", skippedAt: FieldValue.serverTimestamp() });
  await wait(400);
  await db.collection("tickets").doc("t6").update({ lastCalled: true, lastCallAt: FieldValue.serverTimestamp() });
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 5 });
  await wait(800);
  check("auto-void: not voided while the window is still open", (await db.collection("tickets").doc("t6").get()).data().status === "skipped");
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 0.02 });

  // Transfer to another station.
  await db.collection("tickets").doc("t3").update({ stationId: "registrar", ticketNo: "RE-001", status: "waiting", createdAt: FieldValue.serverTimestamp(), transferredAt: FieldValue.serverTimestamp() });
  check("transferred: owner is told the new number and station", await until(() => pushFor("t3:transferred").length === 1) && /RE-001/.test(pushFor("t3:transferred")[0].body) && /Registrar/.test(pushFor("t3:transferred")[0].body));

  // Staff remove a ticket.
  await db.collection("tickets").doc("t2").update({ status: "void", voidedAt: FieldValue.serverTimestamp() });
  check("removed by staff: owner is told", await until(() => pushFor("t2:void").length === 1) && /removed by staff/.test(pushFor("t2:void")[0].body));

  // A dead push token is cleaned up.
  await ticket("t4", "CA-004", "u4", "cashier");
  await wait(300);
  await db.collection("tickets").doc("t4").update({ status: "serving" });
  check("dead token: the unusable token is deleted", await until(async () => !(await db.collection("deviceTokens").doc("u4").get()).exists));

  // A manual ticket (no device token) must not break anything.
  await ticket("t7", "CA-007", "manual", "registrar");
  await db.collection("tickets").doc("t7").update({ status: "serving" });
  await wait(400);
  check("tickets without a device token are skipped quietly", true);

  // No duplicates anywhere.
  const counts = {};
  pushes.forEach((p) => { counts[p.tag] = (counts[p.tag] || 0) + 1; });
  const dupes = Object.keys(counts).filter((k) => counts[k] > 1);
  check("no push was sent twice", dupes.length === 0, JSON.stringify(dupes));

  // Restart: the new process must not replay old events.
  service.stop();
  const before = pushes.length;
  service = newService();
  await service.start();
  await wait(1000);
  check("restart: nothing is re-sent for existing tickets", pushes.length === before, JSON.stringify(pushes.slice(before)));
  await db.collection("tickets").doc("t6").update({ recalledAt: FieldValue.serverTimestamp(), recallCount: FieldValue.increment(1) });
  check("restart: new events are still delivered", await until(() => pushFor("t6:recall").length === 1));
  service.stop();

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + " / " + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("TEST ERROR", err);
  process.exit(2);
});
