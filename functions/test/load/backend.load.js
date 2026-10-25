// Back-end load test against the Firestore emulator (never the live project): many students joining at once,
// staff calling numbers while people keep joining, and walk-in QR passes. It runs the real joinQueue and
// redeemWalkinPass code, so it shows how the station counters, limits and transactions hold up under a crowd.
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/load/run.js"
// Sizes can be changed with LOAD_STUDENTS, LOAD_STATIONS and LOAD_WALKINS.
//
// The emulator is one process on this PC, so the times here are for comparing runs, not Google's real speed.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../../config");
const { joinQueue } = require("../../lib/join");
const { redeemWalkinPass, hashSecret } = require("../../lib/walkin");
const { compareQueueOrder } = require("../../lib/events");
const { timed, timingLine, failureCodes, createChecks, numberFromEnv } = require("./stats");

if (!/^(127\.0\.0\.1|localhost):/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("Refusing to run: the load test only runs against the local Firestore emulator.");
  process.exit(2);
}

const STUDENTS = numberFromEnv("LOAD_STUDENTS", 300);
const STATIONS = numberFromEnv("LOAD_STATIONS", 5);
const WALKINS = numberFromEnv("LOAD_WALKINS", 100);

const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-qficient" });
const db = app.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;
const deps = { db, FieldValue, Timestamp, config };

const student = (uid) => ({ uid, token: { firebase: { sign_in_provider: "microsoft.com" }, name: "Load Student " + uid, email: uid + "@stimalolos.edu.ph" } });
const phone = (uid) => ({ uid, token: { firebase: { sign_in_provider: "anonymous" } } });

async function wipe() {
  for (const name of ["tickets", "stations", "joinState", "walkinPasses", "settings", "students"]) {
    for (;;) {
      const snap = await db.collection(name).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

async function seedStations() {
  const ids = [];
  for (let i = 1; i <= STATIONS; i++) {
    const id = "load" + i;
    ids.push(id);
    await db.collection("stations").doc(id).set({ name: "Load Station " + i, code: "L" + i, count: 0, active: true, nowServingId: null });
  }
  return ids;
}

// What a station's staff page does on Call Next: finish the current ticket, serve the first in line, move the pointer.
async function callNext(stationId) {
  const station = (await db.collection("stations").doc(stationId).get()).data();
  const waiting = (await db.collection("tickets").where("stationId", "==", stationId).where("status", "==", "waiting").get())
    .docs.map((d) => Object.assign({ id: d.id }, d.data())).sort(compareQueueOrder);
  const next = waiting[0];

  const batch = db.batch();
  if (station.nowServingId) {
    batch.update(db.collection("tickets").doc(station.nowServingId), { status: "completed", completedAt: FieldValue.serverTimestamp() });
  }
  if (next) batch.update(db.collection("tickets").doc(next.id), { status: "serving", servingAt: FieldValue.serverTimestamp() });
  batch.update(db.collection("stations").doc(stationId), { nowServingId: next ? next.id : null });
  await batch.commit();
  return !!next;
}

async function ticketsAt(stationId) {
  return (await db.collection("tickets").where("stationId", "==", stationId).get()).docs.map((d) => d.data());
}

async function run() {
  const t = createChecks();
  console.log("\n=== Back-end load test: " + STUDENTS + " students, " + STATIONS + " stations, " + WALKINS + " walk-ins ===\n");

  await wipe();
  const stationIds = await seedStations();

  // 1. Crowd at one station: more and more students join the same station in the same instant, to find where
  //    joins start to fail. Every join updates the station's ticket counter inside a transaction, so this is the
  //    busiest single spot in the system.
  const levels = [10, 25, 50, 100, STUDENTS].filter((n, i, all) => n <= STUDENTS && all.indexOf(n) === i);
  let safeLevel = 0;      // the largest crowd where everyone (and every smaller crowd) got a ticket
  let stillSafe = true;
  for (const level of levels) {
    const id = "crowd" + level;
    await db.collection("stations").doc(id).set({ name: "Crowd " + level, code: "C" + level, count: 0, active: true, nowServingId: null });
    const results = await Promise.all(Array.from({ length: level }, (_, i) =>
      timed(() => joinQueue(deps, student("crowd" + level + "_" + i), { stationId: id, purpose: "Load test" }))));
    const ok = results.filter((r) => r.ok).length;
    const numbers = (await ticketsAt(id)).map((x) => x.ticketNo);
    t.info(timingLine(level + " at once at one station: " + ok + "/" + level + " got a ticket", results.map((r) => r.ms)) +
      (ok < level ? " · failed: " + JSON.stringify(failureCodes(results)) : ""));
    t.check("crowd of " + level + ": no ticket number given out twice, counter matches", new Set(numbers).size === numbers.length &&
      (await db.collection("stations").doc(id).get()).data().count === numbers.length);
    if (ok !== level) stillSafe = false;
    if (stillSafe) safeLevel = level;
  }
  const minCrowd = numberFromEnv("LOAD_MIN_CROWD", 25);
  t.info("Largest crowd at one station where everyone got a ticket: " + (safeLevel || "fewer than " + levels[0]));
  t.check("crowd: a station handles " + minCrowd + " students joining in the same instant", safeLevel >= minCrowd, "only " + safeLevel);

  // 3. Staff call the next number at every station while more students keep joining.
  const calls = [];
  const lateJoins = [];
  const rounds = 20;
  for (let round = 0; round < rounds; round++) {
    const joinWave = Array.from({ length: Math.ceil(STUDENTS / rounds) }, (_, i) =>
      timed(() => joinQueue(deps, student("late" + round + "_" + i), { stationId: stationIds[(round + i) % stationIds.length], purpose: "Load test" })));
    const callWave = stationIds.map((id) => timed(() => callNext(id)));
    const [joins, called] = await Promise.all([Promise.all(joinWave), Promise.all(callWave)]);
    lateJoins.push.apply(lateJoins, joins);
    calls.push.apply(calls, called);
  }
  t.info(timingLine("Call Next while joining", calls.map((r) => r.ms)));
  t.info(timingLine("Joins during calls", lateJoins.map((r) => r.ms)));
  t.check("staff: every Call Next went through (" + calls.filter((r) => r.ok).length + "/" + calls.length + ")", calls.every((r) => r.ok), JSON.stringify(failureCodes(calls)));
  t.check("staff: joins kept working while staff called numbers", lateJoins.every((r) => r.ok), JSON.stringify(failureCodes(lateJoins)));
  let oneServing = true;
  for (const id of stationIds) {
    if ((await ticketsAt(id)).filter((x) => x.status === "serving").length > 1) oneServing = false;
  }
  t.check("staff: no station is serving two people at once", oneServing);

  // 4. Walk-in QR passes scanned at the same time, plus one pass scanned by several phones in the same moment.
  const secret = "LoadTestSecret_0123456789";
  for (let i = 0; i < WALKINS; i++) {
    await db.collection("walkinPasses").doc("loadPass" + String(i).padStart(5, "0")).set({
      ownerName: "Walk-in " + i, studentType: "guest", stationId: stationIds[i % stationIds.length], purpose: "Load test",
      secretHash: hashSecret(secret), createdBy: "enf@load.test", createdAt: Timestamp.now()
    });
  }
  const redeems = await Promise.all(Array.from({ length: WALKINS }, (_, i) =>
    timed(() => redeemWalkinPass(deps, phone("walk" + i), { passId: "loadPass" + String(i).padStart(5, "0"), secret }))));
  t.info(timingLine("Walk-in QR scans", redeems.map((r) => r.ms)));
  t.check("walk-ins: every pass became a ticket (" + redeems.filter((r) => r.ok).length + "/" + WALKINS + ")", redeems.every((r) => r.ok), JSON.stringify(failureCodes(redeems)));

  await db.collection("walkinPasses").doc("loadRace00001").set({
    ownerName: "Race", studentType: "guest", stationId: stationIds[0], purpose: "Load test",
    secretHash: hashSecret(secret), createdBy: "enf@load.test", createdAt: Timestamp.now()
  });
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    timed(() => redeemWalkinPass(deps, phone("racer" + i), { passId: "loadRace00001", secret }))));
  t.check("walk-ins: one pass scanned by 10 phones at once gives exactly one ticket", race.filter((r) => r.ok).length === 1, race.filter((r) => r.ok).length + " tickets");

  return t.failures();
}

module.exports = { run, callNext };

if (require.main === module) {
  run().then((failures) => {
    console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
  }).catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
