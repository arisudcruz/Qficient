// Tests no-show strikes and the join block against the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/strikes.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { recordNoShow } = require("../lib/strikes");
const { joinQueue, JoinError } = require("../lib/join");
const { toMs } = require("../lib/time");

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
const DAY = 24 * HOUR;
let clock = Date.now();
const deps = { db, FieldValue, Timestamp, config, now: () => clock };
const student = (uid) => ({ uid, token: { firebase: { sign_in_provider: "microsoft.com" }, name: "Dela Cruz, Juan", email: "jd2000123456@stimalolos.edu.ph" } });
const ticketOf = (id, uid) => ({ id, ownerId: uid, ownerName: "Dela Cruz, Juan", studentNumber: "020002000123456", ticketNo: "CA1-0" + id.slice(-2) });
const state = async (uid) => ((await db.collection("joinState").doc(uid).get()).data() || {});

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
  await db.collection("students").doc("s1").set({ studentType: "regular" });
  await db.collection("settings").doc("enrollment").set({ flows: { regular: ["cashier"] } });
  const rules = config.noShow;

  // Strikes add up, once per ticket.
  let r = await recordNoShow(deps, ticketOf("t01", "s1"), clock);
  check("a no-show is strike 1", r.counted && r.strikes === 1 && !r.blockedUntilMs, JSON.stringify(r));
  r = await recordNoShow(deps, ticketOf("t01", "s1"), clock);
  check("the same ticket delivered again isn't counted twice", !r.counted && r.strikes === 1, JSON.stringify(r));
  r = await recordNoShow(deps, ticketOf("t02", "s1"), clock + HOUR);
  check("a second no-show is strike 2", r.strikes === 2 && !r.blockedUntilMs, JSON.stringify(r));
  let join = await attemptJoin("s1");
  check("two strikes don't block joining", join.ok, JSON.stringify(join));
  await db.collection("tickets").doc(join.result.ticketId).update({ status: "completed" });

  // The third within the window blocks.
  clock += 2 * HOUR;
  r = await recordNoShow(deps, ticketOf("t03", "s1"), clock);
  let s = await state("s1");
  check("the third no-show within " + rules.windowDays + " days blocks for " + rules.blockHours + " hours", r.blockedUntilMs === clock + rules.blockHours * HOUR && toMs(s.blockedUntil) === r.blockedUntilMs, JSON.stringify(r));
  check("the block keeps the name and student number for the admin list, and clears the strikes", s.ownerName === "Dela Cruz, Juan" && s.studentNumber && Object.keys(s.noShows || {}).length === 0 && s.blockedReason === "noShow", JSON.stringify(s));
  r = await recordNoShow(deps, ticketOf("t03", "s1"), clock);
  check("the blocking event delivered again doesn't start a new block", !r.counted, JSON.stringify(r));

  clock += 5000;
  join = await attemptJoin("s1");
  check("a blocked student can't join, and is told until when", !join.ok && join.code === "failed-precondition" && /join again on/.test(join.message) && /front desk/.test(join.message), JSON.stringify(join));
  const enrolling = await joinQueue(deps, student("s1"), { enrollment: true }).then(() => null, (e) => e);
  check("a blocked student can't start an enrollment either", enrolling && /join again on/.test(enrolling.message), enrolling && enrolling.message);

  clock += rules.blockHours * HOUR;
  join = await attemptJoin("s1");
  check("after the block ends they can join again", join.ok, JSON.stringify(join));

  // Old strikes fall away.
  await recordNoShow(deps, ticketOf("t11", "s2"), clock);
  await recordNoShow(deps, ticketOf("t12", "s2"), clock + HOUR);
  r = await recordNoShow(deps, ticketOf("t13", "s2"), clock + (rules.windowDays + 1) * DAY);
  check("strikes older than " + rules.windowDays + " days don't count", r.strikes === 1 && !r.blockedUntilMs, JSON.stringify(r));

  // An admin lifting the block (what Settings writes) lets them join at once.
  await recordNoShow(deps, ticketOf("t21", "s3"), clock);
  await recordNoShow(deps, ticketOf("t22", "s3"), clock);
  await recordNoShow(deps, ticketOf("t23", "s3"), clock);
  await db.collection("joinState").doc("s3").update({ blockedUntil: null, noShows: {}, unblockedBy: "admin@qficient.com", unblockedAt: FieldValue.serverTimestamp() });
  clock += 5000;
  join = await attemptJoin("s3");
  check("after an admin lifts the block they can join right away", join.ok, JSON.stringify(join));

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
