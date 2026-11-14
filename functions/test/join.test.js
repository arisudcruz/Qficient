// Tests the join logic against the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/join.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { joinQueue, JoinError } = require("../lib/join");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

let clock = Date.now();
const deps = { db, FieldValue, Timestamp, config, now: () => clock };
const advance = (ms) => { clock += ms; };

// Each test student gets their own school email, so their own student number (one ticket in line per number).
function testEmail(uid) {
  let n = 7;
  for (const c of String(uid)) n = (n * 31 + c.charCodeAt(0)) % 900000;
  return "jd" + (100000 + n) + "@stimalolos.edu.ph";
}
const student = (uid, extra) => ({ uid, token: Object.assign({ firebase: { sign_in_provider: "microsoft.com" }, name: "Dela Cruz, John Aris", email: uid === "s1" ? "jd2000123456@stimalolos.edu.ph" : testEmail(uid) }, extra || {}) });
const guest = (uid) => ({ uid, token: { firebase: { sign_in_provider: "anonymous" } } });
const staff = (uid) => ({ uid, token: { firebase: { sign_in_provider: "password" }, email: "admin@qficient.com" } });

async function attempt(auth, data) {
  try {
    return { ok: true, result: await joinQueue(deps, auth, data) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

async function wipe() {
  for (const name of ["tickets", "stations", "joinState", "students", "settings"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function station(id, extra) {
  await db.collection("stations").doc(id).set(Object.assign({ name: "Cashier", count: 0, active: true }, extra || {}));
}

(async () => {
  await wipe();
  await station("cashier");
  await station("registrar", { name: "Registrar" });

  // A normal student join.
  await db.collection("students").doc("s1").set({ studentType: "transferee" });
  let r = await attempt(student("s1"), { stationId: "cashier", purpose: "  Transcript   of Records " });
  check("a student can join", r.ok && r.result.ticketNo === "CA1-001", JSON.stringify(r));
  let t = (await db.collection("tickets").doc(r.result.ticketId).get()).data();
  check("name, student number, type and purpose come from the server's records", t.ownerName === "Dela Cruz, John Aris" && t.studentNumber === "02000" + "2000123456".replace(/\D/g, "") && t.studentType === "transferee" && t.purpose === "Transcript of Records" && t.status === "waiting" && t.verified === false && t.ownerId === "s1", JSON.stringify(t));
  check("the station counter moved on", (await db.collection("stations").doc("cashier").get()).data().count === 1);

  // One live ticket per person.
  advance(10000);
  r = await attempt(student("s1"), { stationId: "registrar", purpose: "x1" });
  check("a second ticket is refused while one is waiting", !r.ok && r.code === "failed-precondition" && /already/.test(r.message), JSON.stringify(r));

  // Tickets ending frees the person; walk-in phones; rate limits.
  await db.collection("tickets").doc((await db.collection("tickets").where("ownerId", "==", "s1").get()).docs[0].id).update({ status: "completed" });
  advance(10000);
  r = await attempt(student("s1"), { stationId: "cashier", purpose: "Another request" });
  check("after the ticket is completed they can join again", r.ok && r.result.ticketNo === "CA1-002", JSON.stringify(r));

  r = await attempt(guest("g1"), { stationId: "cashier", purpose: "Admission", guestName: "Maria Clara" });
  check("a walk-in phone (anonymous) can't join on its own: tickets come from the Queue Enforcer's QR", !r.ok && r.code === "permission-denied" && /Queue Enforcer/.test(r.message), JSON.stringify(r));

  r = await attempt(staff("a1"), { stationId: "cashier", purpose: "x1" });
  check("staff accounts can't join", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(null, { stationId: "cashier", purpose: "x1" });
  check("signed-out requests are refused", !r.ok && r.code === "unauthenticated", JSON.stringify(r));

  r = await attempt(student("s2"), { stationId: "cashier", purpose: "   " });
  check("an empty purpose is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(student("s2"), { stationId: "nowhere", purpose: "x1" });
  check("an unknown station is refused", !r.ok && r.code === "not-found", JSON.stringify(r));
  r = await attempt(student("s2"), { stationId: "../x", purpose: "x1" });
  check("a path-like station id is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));

  await station("closed", { name: "Closed", active: false });
  r = await attempt(student("s2"), { stationId: "closed", purpose: "x1" });
  check("a closed station is refused", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

  // Pause after cancelling.
  r = await attempt(student("s3"), { stationId: "registrar", purpose: "Enrollment" });
  await db.collection("tickets").doc(r.result.ticketId).update({ status: "cancelled", cancelledAt: Timestamp.fromMillis(clock) });
  advance(5000);
  r = await attempt(student("s3"), { stationId: "registrar", purpose: "Enrollment" });
  check("joining right after cancelling is refused", !r.ok && r.code === "resource-exhausted" && /wait/.test(r.message), JSON.stringify(r));
  advance(20000);
  r = await attempt(student("s3"), { stationId: "registrar", purpose: "Enrollment" });
  check("after the pause they can join again", r.ok, JSON.stringify(r));

  // The pause is set in System Settings (settings/system.cancelCooldownSeconds).
  await db.collection("settings").doc("system").set({ autoVoidMinutes: 1, cancelCooldownSeconds: 60 });
  r = await attempt(student("cd1"), { stationId: "registrar", purpose: "Enrollment" });
  await db.collection("tickets").doc(r.result.ticketId).update({ status: "cancelled", cancelledAt: Timestamp.fromMillis(clock) });
  advance(25000);
  r = await attempt(student("cd1"), { stationId: "registrar", purpose: "Enrollment" });
  check("a 60-second cooldown from System Settings still refuses after 25 seconds", !r.ok && r.code === "resource-exhausted" && /35 seconds/.test(r.message), JSON.stringify(r));
  advance(35000);
  r = await attempt(student("cd1"), { stationId: "registrar", purpose: "Enrollment" });
  check("after the 60 seconds they can join again", r.ok, JSON.stringify(r));

  await db.collection("settings").doc("system").set({ autoVoidMinutes: 1, cancelCooldownSeconds: 0 });
  r = await attempt(student("cd2"), { stationId: "registrar", purpose: "Enrollment" });
  await db.collection("tickets").doc(r.result.ticketId).update({ status: "cancelled", cancelledAt: Timestamp.fromMillis(clock) });
  advance(5000);
  r = await attempt(student("cd2"), { stationId: "registrar", purpose: "Enrollment" });
  check("a cooldown of 0 lets them join again right away", r.ok, JSON.stringify(r));

  await db.collection("settings").doc("system").set({ autoVoidMinutes: 1, cancelCooldownSeconds: "60" });
  r = await attempt(student("cd3"), { stationId: "registrar", purpose: "Enrollment" });
  await db.collection("tickets").doc(r.result.ticketId).update({ status: "cancelled", cancelledAt: Timestamp.fromMillis(clock) });
  advance(25000);
  r = await attempt(student("cd3"), { stationId: "registrar", purpose: "Enrollment" });
  check("an unusable setting falls back to the 20-second default", r.ok, JSON.stringify(r));
  await db.collection("settings").doc("system").delete();

  // Minimum gap between joins and the daily limit.
  await station("fast", { name: "Fast" });
  const burst = [];
  for (let i = 0; i < 3; i++) burst.push(attempt(student("s4"), { stationId: "fast", purpose: "Burst " + i }));
  const done = await Promise.all(burst);
  check("three simultaneous joins by one person create exactly one ticket", done.filter((x) => x.ok).length === 1, JSON.stringify(done.map((x) => x.ok || x.code)));
  const mine = await db.collection("tickets").where("ownerId", "==", "s4").get();
  check("only one ticket exists for them", mine.size === 1);

  let created = 0;
  for (let i = 0; i < config.maxJoinsPerDay + 3; i++) {
    advance(30000);
    const attemptResult = await attempt(student("s5"), { stationId: "fast", purpose: "Loop " + i });
    if (attemptResult.ok) {
      created++;
      await db.collection("tickets").doc(attemptResult.result.ticketId).update({ status: "completed" });
    } else if (created >= config.maxJoinsPerDay) {
      check("the daily per-account limit stops further joins", attemptResult.code === "resource-exhausted" && /limit/.test(attemptResult.message), JSON.stringify(attemptResult));
      break;
    }
  }
  check("exactly the daily limit was allowed", created === config.maxJoinsPerDay, "created " + created);

  // Station cap: cancelled and void tickets don't use it up.
  await station("small", { name: "Small", maxQueue: 2 });
  await db.collection("tickets").add({ stationId: "small", status: "cancelled", ownerId: "z", createdAt: Timestamp.fromMillis(clock) });
  await db.collection("tickets").add({ stationId: "small", status: "void", ownerId: "z", createdAt: Timestamp.fromMillis(clock) });
  r = await attempt(student("c1"), { stationId: "small", purpose: "One" });
  advance(10000);
  const r2 = await attempt(student("c2"), { stationId: "small", purpose: "Two" });
  advance(10000);
  const r3 = await attempt(student("c3"), { stationId: "small", purpose: "Three" });
  check("the daily queue cap counts live tickets only", r.ok && r2.ok && !r3.ok && r3.code === "resource-exhausted" && /limit/.test(r3.message), JSON.stringify([r, r2, r3]));

  // A limit approved for one date (a staff request, saved in dayLimits) wins over the normal limit on that date only.
  const todayKey = require("../lib/time").dayKey(config.tzOffsetMs, clock);
  await station("dated", { name: "Dated", maxQueue: 5, dayLimits: { [todayKey]: 1, "2000-01-01": 99 } });
  advance(10000);
  const d1 = await attempt(student("lim1"), { stationId: "dated", purpose: "One" });
  advance(10000);
  const d2 = await attempt(student("lim2"), { stationId: "dated", purpose: "Two" });
  check("a limit approved for today wins over the station's normal limit", d1.ok && !d2.ok && d2.code === "resource-exhausted", JSON.stringify([d1, d2]));
  await station("dated2", { name: "Dated Two", maxQueue: 1, dayLimits: { "2000-01-01": 1, [require("../lib/time").dayKey(config.tzOffsetMs, clock + 86400000)]: 9 } });
  advance(10000);
  const d3 = await attempt(student("lim3"), { stationId: "dated2", purpose: "One" });
  advance(10000);
  const d4 = await attempt(student("lim4"), { stationId: "dated2", purpose: "Two" });
  check("limits for other dates don't apply today: the normal limit does", d3.ok && !d4.ok && d4.code === "resource-exhausted", JSON.stringify([d3, d4]));
  await station("dated3", { name: "Dated Three", dayLimits: { [todayKey]: 2 } });
  advance(10000);
  const d5 = await attempt(student("lim5"), { stationId: "dated3", purpose: "One" });
  advance(10000);
  const d6 = await attempt(student("lim6"), { stationId: "dated3", purpose: "Two" });
  advance(10000);
  const d7 = await attempt(student("lim7"), { stationId: "dated3", purpose: "Three" });
  check("a date limit also caps a station that normally has no limit", d5.ok && d6.ok && !d7.ok && d7.code === "resource-exhausted", JSON.stringify([d5, d6, d7]));

  // Ticket numbers restart each day.
  await station("daily", { name: "Daily", count: 41, countDay: "2000-01-01" });
  r = await attempt(student("d1"), { stationId: "daily", purpose: "New day" });
  check("numbers restart at 001 on a new day", r.ok && r.result.ticketNo === "DA1-001", JSON.stringify(r));

  // Ticket codes: stations whose names start with the same letters get numbered codes.
  await station("admission", { name: "Admission" });
  await station("admission2", { name: "Admission2" });
  await station("advising", { name: "Advising" });
  const e1 = await attempt(student("e1"), { stationId: "admission", purpose: "A" });
  advance(10000);
  const e2 = await attempt(student("e2"), { stationId: "admission2", purpose: "B" });
  advance(10000);
  const e3 = await attempt(student("e3"), { stationId: "advising", purpose: "C" });
  check("codes: Admission, Admission2 and Advising get AD1, AD2 and AD3", e1.ok && e1.result.ticketNo === "AD1-001" && e2.ok && e2.result.ticketNo === "AD2-001" && e3.ok && e3.result.ticketNo === "AD3-001", JSON.stringify([e1, e2, e3]));

  await station("guidance", { name: "Guidance", code: "GU7" });
  advance(10000);
  r = await attempt(student("e4"), { stationId: "guidance", purpose: "D" });
  check("codes: a code saved on the station is used as is", r.ok && r.result.ticketNo === "GU7-001", JSON.stringify(r));

  await station("gu-first", { name: "Gu First", code: "GU1" });
  await station("guard", { name: "Guard" });
  advance(10000);
  r = await attempt(student("e5"), { stationId: "guard", purpose: "E" });
  check("codes: a station without a saved code skips codes already taken", r.ok && r.result.ticketNo === "GU2-001", JSON.stringify(r));

  // Enrollment: the first station of the student type's process, with the process copied onto the ticket.
  await station("en-a", { name: "Alpha" });
  await station("en-b", { name: "Beta" });
  await db.collection("settings").doc("enrollment").set({ flows: { regular: ["en-a", "en-b"], transferee: ["en-b"] } });
  await db.collection("students").doc("f1").set({ studentType: "regular" });
  advance(10000);
  r = await attempt(student("f1"), { stationId: "cashier", purpose: "ignored", enrollment: true });
  t = r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : null;
  check("enrollment: starts at the first station of the type's process", r.ok && t.stationId === "en-a" && /^AL1-/.test(t.ticketNo), JSON.stringify(r));
  check("enrollment: the ticket keeps a copy of the process, at step 0, purpose Enrollment",
    t && t.enrollment === true && JSON.stringify(t.enrollmentFlow) === JSON.stringify(["en-a", "en-b"]) && t.enrollmentStep === 0 && t.purpose === "Enrollment", JSON.stringify(t));

  await db.collection("students").doc("f2").set({ studentType: "transferee" });
  advance(10000);
  r = await attempt(student("f2"), { enrollment: true });
  t = r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : null;
  check("enrollment: each student type has its own process", r.ok && t.stationId === "en-b" && JSON.stringify(t.enrollmentFlow) === JSON.stringify(["en-b"]), JSON.stringify(r));

  advance(10000);
  r = await attempt(student("f3"), { enrollment: true });
  check("enrollment: a student without a student type is asked to set it", !r.ok && r.code === "failed-precondition" && /student type/.test(r.message), JSON.stringify(r));

  advance(10000);
  r = await attempt(guest("f4"), { enrollment: true, guestName: "Guest Person" });
  check("enrollment: walk-in phones can't enroll on their own", !r.ok && r.code === "permission-denied", JSON.stringify(r));

  // The Open / Closed switch (Enrollment Settings): closed refuses new enrollments; normal joins are unaffected.
  await db.collection("settings").doc("enrollment").set({ open: false }, { merge: true });
  await db.collection("students").doc("f7").set({ studentType: "regular" });
  advance(10000);
  r = await attempt(student("f7"), { enrollment: true });
  check("enrollment: closed enrollment is refused", !r.ok && r.code === "failed-precondition" && /currently closed/.test(r.message), JSON.stringify(r));
  advance(10000);
  r = await attempt(student("f7"), { stationId: "cashier", purpose: "Pay tuition" });
  check("enrollment: closed enrollment doesn't stop a normal join", r.ok, JSON.stringify(r));
  await db.collection("settings").doc("enrollment").set({ open: true }, { merge: true });

  await db.collection("settings").doc("enrollment").set({ flows: { regular: ["en-a", "en-b"] } });
  await db.collection("students").doc("f5").set({ studentType: "transferee" });
  advance(10000);
  r = await attempt(student("f5"), { enrollment: true });
  check("enrollment: a type without a process is refused", !r.ok && r.code === "failed-precondition" && /isn't open/.test(r.message), JSON.stringify(r));

  await station("en-a", { name: "Alpha", active: false });
  await db.collection("students").doc("f6").set({ studentType: "regular" });
  advance(10000);
  r = await attempt(student("f6"), { enrollment: true });
  check("enrollment: a disabled first station is refused", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

  await station("en-a", { name: "Alpha", active: true, count: 1 });
  advance(10000);
  r = await attempt(student("f1"), { enrollment: true });
  check("enrollment: one live ticket per person still holds", !r.ok && /already have an active ticket/.test(r.message), JSON.stringify(r));

  advance(10000);
  r = await attempt(student("f1b"), { stationId: "cashier", purpose: "Regular join" });
  t = r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : null;
  check("enrollment: a normal join carries no enrollment fields", r.ok && t.enrollment === undefined && t.enrollmentFlow === undefined && t.enrollmentStep === undefined, JSON.stringify(t));

  const { assignStationCodes } = require("../lib/join");
  const codes = assignStationCodes([{ id: "b", name: "Admission B" }, { id: "a", name: "Admission A" }, { id: "c", name: "Cashier", code: "AD1" }]);
  check("codes: missing codes follow station id order and skip saved ones", codes.a === "AD2" && codes.b === "AD3" && codes.c === "AD1", JSON.stringify(codes));

  // One ticket in line per student number: a walk-in ticket made with a student's number counts as theirs.
  {
    advance(10000);
    await db.collection("tickets").doc("dupJ1").set({
      ticketNo: "RE1-060", stationId: "registrar", ownerId: "nophone:abc", status: "waiting", studentNumber: "02000-555060",
      createdAt: Timestamp.fromMillis(clock)
    });
    const sn = student("sn1", { email: "delacruz.555060@stimalolos.edu.ph" });
    r = await attempt(sn, { stationId: "registrar", purpose: "Tuition" });
    check("a student whose number already has a walk-in ticket can't join", !r.ok && r.code === "failed-precondition" &&
      r.message === "Your student number already has ticket RE1-060 in line at Registrar (made at the front desk).", JSON.stringify(r));
    await db.collection("tickets").doc("dupJ1").update({ status: "completed" });
    r = await attempt(sn, { stationId: "registrar", purpose: "Tuition" });
    check("once that ticket is done, they can join", r.ok, JSON.stringify(r));
    advance(10000);
    r = await attempt(sn, { stationId: "registrar", purpose: "Tuition" });
    check("their own app ticket still gets the usual message", !r.ok && /already have an active ticket/.test(r.message), JSON.stringify(r));
  }

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
