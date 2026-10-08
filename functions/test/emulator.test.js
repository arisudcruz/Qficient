// Runs the real functions in the Firestore + Functions emulators; pushes land in a `testPushLog` collection.
//   firebase emulators:exec --only functions,firestore --project demo-qficient "node functions/test/emulator.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { sweepExpired, cleanStale } = require("../lib/jobs");
const { createPusher } = require("../lib/push");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(150);
  }
  return false;
}

async function pushes() {
  const snap = await db.collection("testPushLog").get();
  return snap.docs.map((d) => d.data());
}
async function pushesFor(tag) {
  return (await pushes()).filter((p) => p.tag === tag);
}
const hasPush = (tag, n) => async () => (await pushesFor(tag)).length === (n === undefined ? 1 : n);

async function wipe() {
  for (const name of ["tickets", "stations", "settings", "deviceTokens", "serverStatus", "testPushLog", "pushEvents"]) {
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
const ts = (msAgo) => Timestamp.fromMillis(Date.now() - msAgo);

(async () => {
  await wipe();

  // Wait until the functions emulator has loaded the trigger.
  await db.collection("deviceTokens").doc("probe").set({ token: "tok-probe" });
  await ticket("probe", "PR-001", "probe", "cashier");
  await wait(500);
  await db.collection("tickets").doc("probe").update({ status: "serving" });
  const ready = await until(hasPush("probe:serving"), 90000);
  check("functions emulator is up and reacting to ticket changes", ready);
  if (!ready) process.exit(2);
  await wipe();

  await db.collection("stations").doc("cashier").set({ name: "Cashier", count: 5, nowServingId: "old1", active: true });
  await db.collection("stations").doc("registrar").set({ name: "Registrar", count: 0, nowServingId: null, active: true });
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 0.02 }); // about 1.2 seconds
  for (const u of ["u1", "u2", "u3", "u5"]) await db.collection("deviceTokens").doc(u).set({ token: "tok-" + u });

  // Students join an idle station.
  await ticket("t1", "CA-001", "u1", "cashier");
  await wait(250);
  await ticket("t2", "CA-002", "u2", "cashier");
  await wait(250);
  await ticket("t3", "CA-003", "u3", "cashier");
  await wait(2500);
  check("no pushes when students just join an idle station", (await pushes()).length === 0, JSON.stringify(await pushes()));

  // Staff call the first ticket.
  await db.collection("tickets").doc("t1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("serving: owner is told it's their turn", await until(hasPush("t1:serving")));
  check("next: the following ticket is told they're next", await until(hasPush("t2:next:cashier")));
  const serving = (await pushesFor("t1:serving"))[0];
  check("serving: message names the station and ticket", serving && /CA-001/.test(serving.body) && /Cashier/.test(serving.body), serving && serving.body);
  check("serving: the push goes to the owner's device token", serving && serving.token === "tok-u1");

  // Unrelated edits say nothing.
  await db.collection("tickets").doc("t3").update({ verified: true });
  await db.collection("tickets").doc("t1").update({ verified: true, verifiedAt: FieldValue.serverTimestamp() });
  await wait(2500);

  // Recall, then skip.
  await db.collection("tickets").doc("t1").update({ recalledAt: FieldValue.serverTimestamp(), recallCount: FieldValue.increment(1) });
  check("recall: owner is notified", await until(hasPush("t1:recall")));
  await db.collection("tickets").doc("t1").update({ status: "skipped", skippedAt: FieldValue.serverTimestamp() });
  check("skipped: owner is notified", await until(hasPush("t1:skipped")));

  // The next ticket is served.
  await db.collection("tickets").doc("t2").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("serving: second ticket is told it's their turn", await until(hasPush("t2:serving")));
  check("next: third ticket is told they're next", await until(hasPush("t3:next:cashier")));

  // Last call, then the scheduled sweep voids it.
  await db.collection("tickets").doc("t1").update({ lastCalled: true, lastCallAt: FieldValue.serverTimestamp() });
  check("last call: owner is notified", await until(hasPush("t1:lastCall")));
  await wait(1800);
  const voided = await sweepExpired({ db, FieldValue, config });
  const t1 = (await db.collection("tickets").doc("t1").get()).data();
  check("sweep: the expired last call is voided", voided === 1 && t1.status === "void" && t1.autoVoided === true, JSON.stringify([voided, t1.status]));
  check("sweep: the owner is told why", await until(hasPush("t1:void")) && /time ran out/.test((await pushesFor("t1:void"))[0].body));

  // A last call that is still within its window is left alone.
  await ticket("t6", "CA-006", "u5", "cashier", { status: "skipped", skippedAt: FieldValue.serverTimestamp() });
  await wait(300);
  await db.collection("tickets").doc("t6").update({ lastCalled: true, lastCallAt: FieldValue.serverTimestamp() });
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 5 });
  const early = await sweepExpired({ db, FieldValue, config });
  check("sweep: nothing is voided while the window is open", early === 0 && (await db.collection("tickets").doc("t6").get()).data().status === "skipped");
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 0.02 });

  // Transfer.
  await db.collection("tickets").doc("t3").update({ stationId: "registrar", ticketNo: "RE-001", status: "waiting", createdAt: FieldValue.serverTimestamp(), transferredAt: FieldValue.serverTimestamp() });
  check("transferred: owner is told the new number and station", await until(hasPush("t3:transferred")) && /RE-001/.test((await pushesFor("t3:transferred"))[0].body) && /Registrar/.test((await pushesFor("t3:transferred"))[0].body));

  // Staff remove a ticket.
  await db.collection("tickets").doc("t2").update({ status: "void", voidedAt: FieldValue.serverTimestamp() });
  check("removed by staff: owner is told", await until(hasPush("t2:void")) && /removed by staff/.test((await pushesFor("t2:void"))[0].body));

  // Nothing went out twice.
  await wait(2000);
  const counts = {};
  (await pushes()).forEach((p) => { counts[p.tag] = (counts[p.tag] || 0) + 1; });
  const dupes = Object.keys(counts).filter((k) => counts[k] > 1);
  check("no push was sent twice", dupes.length === 0, JSON.stringify(dupes));

  // Duplicate delivery of the same event is dropped.
  const pusher = createPusher({ db, FieldValue, Timestamp, messaging: null, config });
  const message = { title: "Hi", body: "There" };
  const first = await pusher.pushOnce("dedupe-key", "u1", message, "dedupe:tag");
  const second = await pusher.pushOnce("dedupe-key", "u1", message, "dedupe:tag");
  check("a repeated event is only pushed once", first === true && second === false && (await pushesFor("dedupe:tag")).length === 1);

  // A dead device token is removed (real send path with a fake messaging client).
  await db.collection("deviceTokens").doc("u4").set({ token: "dead-token" });
  const realPusher = createPusher({
    db, FieldValue, Timestamp, config, forceReal: true,
    messaging: { send: () => Promise.reject(Object.assign(new Error("not registered"), { code: "messaging/registration-token-not-registered" })) }
  });
  await realPusher.notifyUser("u4", message, "dead:tag");
  check("dead token: the unusable token is deleted", !(await db.collection("deviceTokens").doc("u4").get()).exists);

  // A student with no device token is skipped quietly.
  check("student without a device token: nothing is sent, nothing breaks", (await pusher.notifyUser("nobody", message, "none:tag")) === false);

  // Daily cleanup.
  await ticket("old1", "CA-900", "ghost", "cashier", { status: "serving", createdAt: ts(2 * 24 * 3600 * 1000 + 5000) });
  await ticket("old2", "CA-901", "ghost", "cashier", { status: "waiting", createdAt: ts(3 * 24 * 3600 * 1000) });
  await ticket("old3", "CA-902", "ghost", "cashier", { status: "completed", createdAt: ts(3 * 24 * 3600 * 1000) });
  await db.collection("pushEvents").doc("ancient").set({ at: ts(5 * 24 * 3600 * 1000) });
  await db.collection("deviceTokens").doc("staleDevice").set({ token: "old", updatedAt: ts(40 * 24 * 3600 * 1000) });
  await db.collection("deviceTokens").doc("freshDevice").set({ token: "new", updatedAt: ts(2 * 24 * 3600 * 1000) });
  const cleaned = await cleanStale({ db, FieldValue, Timestamp, config });
  const o1 = (await db.collection("tickets").doc("old1").get()).data();
  const o3 = (await db.collection("tickets").doc("old3").get()).data();
  check("cleanup: leftovers from earlier days are voided", cleaned === 2 && o1.status === "void" && o1.staleCleanup === true, String(cleaned));
  check("cleanup: finished tickets are left alone", o3.status === "completed");
  check("cleanup: a station no longer points at a stale ticket", (await db.collection("stations").doc("cashier").get()).data().nowServingId === null);
  check("cleanup: a device registration untouched for a month is removed", !(await db.collection("deviceTokens").doc("staleDevice").get()).exists);
  check("cleanup: a recently refreshed device registration is kept", (await db.collection("deviceTokens").doc("freshDevice").get()).exists);
  check("cleanup: old de-duplication records are removed", !(await db.collection("pushEvents").doc("ancient").get()).exists);

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + " / " + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("TEST ERROR", err);
  process.exit(2);
});
