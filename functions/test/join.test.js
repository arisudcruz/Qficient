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

const student = (uid, extra) => ({ uid, token: Object.assign({ firebase: { sign_in_provider: "microsoft.com" }, name: "Dela Cruz, John Aris", email: "jd2000123456@stimalolos.edu.ph" }, extra || {}) });
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

  // Tickets ending frees the person; guests; rate limits.
  await db.collection("tickets").doc((await db.collection("tickets").where("ownerId", "==", "s1").get()).docs[0].id).update({ status: "completed" });
  advance(10000);
  r = await attempt(student("s1"), { stationId: "cashier", purpose: "Another request" });
  check("after the ticket is completed they can join again", r.ok && r.result.ticketNo === "CA1-002", JSON.stringify(r));

  r = await attempt(guest("g1"), { stationId: "cashier", purpose: "Admission", guestName: "Maria Clara" });
  check("a guest can join and gets the guest type", r.ok, JSON.stringify(r));
  t = (await db.collection("tickets").doc(r.result.ticketId).get()).data();
  check("guest ticket uses the supplied name and has no student number", t.ownerName === "Maria Clara" && t.studentType === "guest" && t.studentNumber === "", JSON.stringify(t));

  r = await attempt(guest("g2"), { stationId: "cashier", purpose: "Admission" });
  check("a guest without a name is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));

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
  check("enrollment: guests can't enroll", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

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

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
