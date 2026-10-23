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

// The student's notification history (userNotifications).
async function historyOf(owner) {
  const snap = await db.collection("userNotifications").where("ownerId", "==", owner).get();
  return snap.docs.map((d) => d.data());
}
const hasHistory = (owner, type) => async () => (await historyOf(owner)).some((h) => h.type === type);

async function wipe() {
  for (const name of ["tickets", "stations", "settings", "deviceTokens", "serverStatus", "testPushLog", "pushEvents", "smsLog", "ticketContacts", "walkinPasses", "userNotifications"]) {
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
  check("history: joining is saved in the student's notifications", await until(hasHistory("u1", "joined")) && await until(hasHistory("u3", "joined")));
  const joined = (await historyOf("u3")).find((h) => h.type === "joined");
  check("history: the joined entry names the ticket, station and place", joined && /CA-003/.test(joined.body) && /Cashier/.test(joined.body) && /3rd in line/.test(joined.body) && joined.read === false, joined && joined.body);

  // Staff call the first ticket.
  await db.collection("tickets").doc("t1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("serving: owner is told it's their turn", await until(hasPush("t1:serving")));
  check("next: the following ticket is told they're next", await until(hasPush("t2:next:cashier")));
  check("soon: the ticket 2nd in line is told it's almost up", await until(hasPush("t3:soon:CA-003")));
  const soon = (await pushesFor("t3:soon:CA-003"))[0];
  check("soon: message says 2nd in line", soon && /2nd in line/.test(soon.title), soon && soon.title);
  const serving = (await pushesFor("t1:serving"))[0];
  check("serving: message names the station and ticket", serving && /CA-001/.test(serving.body) && /Cashier/.test(serving.body), serving && serving.body);
  check("serving: the push goes to the owner's device token", serving && serving.token === "tok-u1");
  check("history: 'your turn' is saved for the owner", await until(hasHistory("u1", "serving")));
  const servingEntry = (await historyOf("u1")).find((h) => h.type === "serving");
  check("history: the entry keeps the push's title, body and ticket", servingEntry && servingEntry.title === serving.title && servingEntry.body === serving.body && servingEntry.ticketId === "t1" && servingEntry.ticketNo === "CA-001");
  check("history: 'almost up' and 'you're next' are saved too", await until(hasHistory("u3", "soon")) && await until(hasHistory("u2", "next")));

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
  check("soon: a ticket is reminded only once", (await pushesFor("t3:soon:CA-003")).length === 1);

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

  // The transferred ticket is served and finished.
  await db.collection("tickets").doc("t3").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  await until(hasPush("t3:serving"));
  await db.collection("tickets").doc("t3").update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  check("history: a finished transaction is saved", await until(hasHistory("u3", "completed")));
  check("history: no push for a finished transaction", (await pushesFor("t3:completed")).length === 0);
  check("history: the transfer is saved", (await historyOf("u3")).some((h) => h.type === "transferred" && /RE-001/.test(h.body)));

  // Staff remove a ticket.
  await db.collection("tickets").doc("t2").update({ status: "void", voidedAt: FieldValue.serverTimestamp() });
  check("removed by staff: owner is told", await until(hasPush("t2:void")) && /removed by staff/.test((await pushesFor("t2:void"))[0].body));

  // A walk-in who scanned the Queue Enforcer's QR code: their phone owns the ticket, so they get pushes and history.
  await db.collection("deviceTokens").doc("walk1").set({ token: "tok-walk1" });
  await ticket("w1", "RE-002", "walk1", "registrar", { manual: true, createdBy: "enf@x.com", studentType: "guest" });
  check("walk-in: the joined entry is in their history", await until(hasHistory("walk1", "joined")));
  await db.collection("tickets").doc("w1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("walk-in: 'your turn' is pushed to their phone", await until(hasPush("w1:serving")));
  await db.collection("tickets").doc("w1").update({ status: "void", voidedAt: FieldValue.serverTimestamp() });
  check("walk-in: removal is pushed", await until(hasPush("w1:void")));

  // Enrollment: enrollment tickets wait in the station's one line with everyone else, and are told about each next step.
  await db.collection("stations").doc("evaluation").set({ name: "Evaluation", count: 0, nowServingId: null, active: true });
  for (const u of ["u6", "u7", "u8"]) await db.collection("deviceTokens").doc(u).set({ token: "tok-" + u });
  const enrollFields = { enrollment: true, enrollmentFlow: ["evaluation", "registrar"], enrollmentStep: 0, purpose: "Enrollment" };
  await ticket("reg1", "EV-001", "u8", "evaluation");
  await wait(250);
  await ticket("en1", "EV-002", "u6", "evaluation", enrollFields);
  await wait(250);
  await ticket("en2", "EV-003", "u7", "evaluation", enrollFields);
  await wait(1500);
  await db.collection("tickets").doc("reg1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("one line: serving a regular ticket tells the enrollment student behind them they're next", await until(hasPush("en1:next:evaluation")));
  await db.collection("tickets").doc("reg1").update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  await db.collection("tickets").doc("en1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  check("one line: serving an enrollment ticket moves the same line on", await until(hasPush("en2:next:evaluation")));
  check("enrollment: the joined entry says where the enrollment starts", (await historyOf("u6")).some((h) => h.type === "joined" && /enrollment has started/i.test(h.title) && /Evaluation/.test(h.body)));

  await db.collection("tickets").doc("en1").update({
    stationId: "registrar", ticketNo: "RE-009", status: "waiting", enrollmentStep: 1, transferredFrom: "evaluation",
    previousTicketNo: "EV-002", createdAt: FieldValue.serverTimestamp(), transferredAt: FieldValue.serverTimestamp(),
    servingAt: FieldValue.delete()
  });
  check("enrollment: the next step is pushed with the new number", await until(hasPush("en1:enrollmentNext:1")));
  const nextStep = (await pushesFor("en1:enrollmentNext:1"))[0];
  check("enrollment: the next-step push names the station, number and step", nextStep && /Registrar/.test(nextStep.title) && /RE-009/.test(nextStep.body) && /step 2 of 2/.test(nextStep.body), nextStep && nextStep.body);
  check("enrollment: a step move is not reported as a transfer", (await pushesFor("en1:transferred")).length === 0);

  await db.collection("tickets").doc("en1").update({ status: "serving", servingAt: FieldValue.serverTimestamp() });
  await until(hasPush("en1:serving"));
  await db.collection("tickets").doc("en1").update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  check("enrollment: finishing the last station is pushed as 'Enrollment complete'", await until(hasPush("en1:enrollmentCompleted")) && /Enrollment complete/.test((await pushesFor("en1:enrollmentCompleted"))[0].title));
  check("enrollment: the steps are in the student's history", await until(async () => {
    const types = (await historyOf("u6")).map((h) => h.type);
    return types.indexOf("enrollmentNext") !== -1 && types.indexOf("enrollmentCompleted") !== -1;
  }));

  // Nothing went out twice.
  await wait(2000);
  const counts = {};
  // The same message twice is a duplicate; an enrollment student is told "your turn" once at each station.
  (await pushes()).forEach((p) => { const key = p.tag + " | " + p.body; counts[key] = (counts[key] || 0) + 1; });
  const dupes = Object.keys(counts).filter((k) => counts[k] > 1);
  check("no push was sent twice", dupes.length === 0, JSON.stringify(dupes));
  const historyCounts = {};
  (await db.collection("userNotifications").get()).docs.forEach((d) => {
    const key = d.data().ticketId + ":" + d.data().type + ":" + d.data().ticketNo;
    historyCounts[key] = (historyCounts[key] || 0) + 1;
  });
  const historyDupes = Object.keys(historyCounts).filter((k) => historyCounts[k] > 1);
  check("no history entry was saved twice", historyDupes.length === 0, JSON.stringify(historyDupes));

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
  await db.collection("userNotifications").doc("oldHistory").set({ ownerId: "u1", type: "serving", createdAt: ts(8 * 24 * 3600 * 1000) });
  await db.collection("userNotifications").doc("recentHistory").set({ ownerId: "u1", type: "serving", createdAt: ts(2 * 24 * 3600 * 1000) });
  await ticket("oldE", "EV-900", "ghost", "evaluation", Object.assign({}, enrollFields, { status: "serving", createdAt: ts(2 * 24 * 3600 * 1000 + 5000) }));
  await db.collection("stations").doc("evaluation").update({ enrollmentServingId: "oldE" });
  await db.collection("walkinPasses").doc("oldPass").set({ ownerName: "x", createdAt: ts(2 * 24 * 3600 * 1000) });
  await db.collection("walkinPasses").doc("todayPass").set({ ownerName: "x", createdAt: FieldValue.serverTimestamp() });
  await db.collection("ticketContacts").doc("oldContact").set({ mobile: "+639171234567" });
  await db.collection("smsLog").doc("oldText").set({ to: "+639171234567", text: "x" });
  const cleaned = await cleanStale({ db, FieldValue, Timestamp, config });
  check("cleanup: walk-in passes from earlier days are deleted", !(await db.collection("walkinPasses").doc("oldPass").get()).exists);
  check("cleanup: today's walk-in passes are kept", (await db.collection("walkinPasses").doc("todayPass").get()).exists);
  check("cleanup: old SMS walk-in numbers and the SMS log are deleted", !(await db.collection("ticketContacts").doc("oldContact").get()).exists && !(await db.collection("smsLog").doc("oldText").get()).exists);
  const o1 = (await db.collection("tickets").doc("old1").get()).data();
  const o3 = (await db.collection("tickets").doc("old3").get()).data();
  check("cleanup: leftovers from earlier days are voided", cleaned === 3 && o1.status === "void" && o1.staleCleanup === true, String(cleaned));
  check("cleanup: finished tickets are left alone", o3.status === "completed");
  check("cleanup: a station no longer points at a stale ticket", (await db.collection("stations").doc("cashier").get()).data().nowServingId === null);
  check("cleanup: the old enrollment-line pointer is removed", !("enrollmentServingId" in (await db.collection("stations").doc("evaluation").get()).data()));
  check("cleanup: a device registration untouched for a month is removed", !(await db.collection("deviceTokens").doc("staleDevice").get()).exists);
  check("cleanup: a recently refreshed device registration is kept", (await db.collection("deviceTokens").doc("freshDevice").get()).exists);
  check("cleanup: old de-duplication records are removed", !(await db.collection("pushEvents").doc("ancient").get()).exists);
  check("cleanup: notification history older than a week is removed", !(await db.collection("userNotifications").doc("oldHistory").get()).exists);
  check("cleanup: recent notification history is kept", (await db.collection("userNotifications").doc("recentHistory").get()).exists);

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + " / " + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("TEST ERROR", err);
  process.exit(2);
});
