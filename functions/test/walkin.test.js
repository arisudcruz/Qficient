// Tests walk-in QR passes against the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/walkin.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { JoinError } = require("../lib/join");
const { redeemWalkinPass, hashSecret } = require("../lib/walkin");

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

const phone = (uid) => ({ uid, token: { firebase: { sign_in_provider: "anonymous" } } });
const student = (uid) => ({ uid, token: { firebase: { sign_in_provider: "microsoft.com" }, name: "Student", email: "s@stimalolos.edu.ph" } });

async function attempt(auth, data) {
  try {
    return { ok: true, result: await redeemWalkinPass(deps, auth, data) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

async function wipe() {
  for (const name of ["tickets", "stations", "joinState", "walkinPasses", "settings"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

// What the Queue Enforcer's browser saves: the details and the hash of the QR code's secret.
async function makePass(id, secret, extra) {
  await db.collection("walkinPasses").doc(id).set(Object.assign({
    ownerName: "Juan Dela Cruz", studentType: "guest", stationId: "cashier", purpose: "Pay tuition",
    secretHash: hashSecret(secret), createdBy: "enf@x.com", createdAt: Timestamp.fromMillis(clock)
  }, extra || {}));
}

const SECRET = "Abc123_-xyzXYZ789secret";

(async () => {
  await wipe();
  await db.collection("stations").doc("cashier").set({ name: "Cashier", code: "CA1", count: 0, active: true });
  await db.collection("stations").doc("registrar").set({ name: "Registrar", code: "RE1", count: 0, active: true });

  await makePass("passOne0001", SECRET);
  let r = await attempt(phone("w1"), { passId: "passOne0001", secret: SECRET });
  check("a walk-in phone redeems a pass and gets a ticket", r.ok && r.result.ticketNo === "CA1-001" && r.result.stationName === "Cashier", JSON.stringify(r));
  const t = r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : {};
  check("the ticket is owned by the phone and carries the enforcer's details", t.ownerId === "w1" && t.ownerName === "Juan Dela Cruz" && t.studentType === "guest" && t.purpose === "Pay tuition" && t.manual === true && t.createdBy === "enf@x.com" && t.status === "waiting" && t.studentNumber === "", JSON.stringify(t));
  const used = (await db.collection("walkinPasses").doc("passOne0001").get()).data();
  check("the pass is marked used with the ticket", !!used.usedAt && used.usedBy === "w1" && used.ticketNo === "CA1-001", JSON.stringify(used));

  r = await attempt(phone("w1"), { passId: "passOne0001", secret: SECRET });
  check("the same phone opening the link again gets the same ticket back", r.ok && r.result.ticketNo === "CA1-001", JSON.stringify(r));
  r = await attempt(phone("w2"), { passId: "passOne0001", secret: SECRET });
  check("another phone can't reuse a pass", !r.ok && r.code === "failed-precondition" && /already been used/.test(r.message), JSON.stringify(r));

  await makePass("passWrong01", SECRET);
  r = await attempt(phone("w3"), { passId: "passWrong01", secret: SECRET + "x" });
  check("a wrong secret is refused", !r.ok && r.code === "not-found", JSON.stringify(r));
  r = await attempt(phone("w3"), { passId: "noSuchPass1", secret: SECRET });
  check("an unknown pass is refused", !r.ok && r.code === "not-found", JSON.stringify(r));
  r = await attempt(phone("w3"), { passId: "../tickets", secret: SECRET });
  check("a malformed pass id is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));

  await makePass("passOld0001", SECRET, { createdAt: Timestamp.fromMillis(clock - (config.walkinPassMinutes * 60 + 5) * 1000) });
  r = await attempt(phone("w3"), { passId: "passOld0001", secret: SECRET });
  check("an expired pass is refused", !r.ok && r.code === "deadline-exceeded", JSON.stringify(r));

  r = await attempt(student("s1"), { passId: "passWrong01", secret: SECRET });
  check("a phone signed in as a student can't redeem", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(null, { passId: "passWrong01", secret: SECRET });
  check("a signed-out request is refused", !r.ok && r.code === "unauthenticated", JSON.stringify(r));

  await makePass("passTwo0001", SECRET, { stationId: "registrar" });
  r = await attempt(phone("w1"), { passId: "passTwo0001", secret: SECRET });
  check("a phone with a live ticket can't take a second one", !r.ok && /already has an active ticket/.test(r.message), JSON.stringify(r));

  await db.collection("stations").doc("registrar").update({ active: false });
  r = await attempt(phone("w4"), { passId: "passTwo0001", secret: SECRET });
  check("a disabled station is refused", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
  check("a refused pass stays unused", !(await db.collection("walkinPasses").doc("passTwo0001").get()).data().usedAt);
  await db.collection("stations").doc("registrar").update({ active: true });

  // Enrollment walk-in: the pass carries the process copied from the settings.
  await makePass("passEnrol01", SECRET, { studentType: "freshman", purpose: "Enrollment", stationId: "registrar", enrollment: true, enrollmentFlow: ["registrar", "cashier"] });
  r = await attempt(phone("w5"), { passId: "passEnrol01", secret: SECRET });
  const e = r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : {};
  check("an enrollment pass starts the enrollment at its first station", r.ok && e.enrollment === true && e.enrollmentStep === 0 && JSON.stringify(e.enrollmentFlow) === JSON.stringify(["registrar", "cashier"]) && e.stationId === "registrar" && e.ticketNo === "RE1-001", JSON.stringify(e));

  // The daily cap.
  await db.collection("stations").doc("cashier").update({ maxQueue: 1 });
  await makePass("passFull001", SECRET);
  r = await attempt(phone("w6"), { passId: "passFull001", secret: SECRET });
  check("a full station is refused", !r.ok && r.code === "resource-exhausted", JSON.stringify(r));

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
