// Tests manual (no-phone) tickets against the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/manual.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../config");
const { JoinError } = require("../lib/join");
const { createManualTicket } = require("../lib/manual");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const deps = { db, FieldValue, config };

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const staffAuth = (email, provider) => ({ uid: "u-" + email, token: { email: email, firebase: { sign_in_provider: provider || "password" } } });
const enforcer = staffAuth("enf@staff.qficient.app");
const builtInAdmin = staffAuth("admin@qficient.com");
const cashierStaff = staffAuth("cash@staff.qficient.app");

async function attempt(auth, data) {
  try {
    return { ok: true, result: await createManualTicket(deps, auth, data) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

async function ticketOf(r) {
  return r.ok ? (await db.collection("tickets").doc(r.result.ticketId).get()).data() : {};
}

const form = (over) => Object.assign({ ownerName: "Lola Cruz", stationId: "cashier", purpose: "Pay tuition" }, over || {});

(async () => {
  for (const name of ["tickets", "stations", "staff", "settings"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection("stations").doc("cashier").set({ name: "Cashier", code: "CA1", count: 4, countDay: "2000-01-01", active: true });
  await db.collection("stations").doc("registrar").set({ name: "Registrar", code: "RE1", count: 0, active: true });
  await db.collection("stations").doc("closed").set({ name: "Closed", code: "CL1", count: 0, active: false });
  await db.collection("staff").doc("enf@staff.qficient.app").set({ role: "enforcer" });
  await db.collection("staff").doc("cash@staff.qficient.app").set({ role: "cashier" });
  await db.collection("settings").doc("enrollment").set({ flows: { freshman: ["registrar", "cashier"] } });

  let r = await attempt(enforcer, form());
  let t = await ticketOf(r);
  check("the enforcer makes a manual ticket; numbers restart on a new day", r.ok && r.result.ticketNo === "CA1-001" && r.result.stationName === "Cashier", JSON.stringify(r));
  check("it is a waiting, no-phone walk-in ticket", t.status === "waiting" && t.noPhone === true && t.manual === true && /^nophone:/.test(t.ownerId) && t.createdBy === "enf@staff.qficient.app" && t.purpose === "Pay tuition" && !t.prioritizedAt, JSON.stringify(t));

  r = await attempt(enforcer, form({ ownerName: "Ben Tan" }));
  check("the next one takes the next number", r.ok && r.result.ticketNo === "CA1-002", JSON.stringify(r));

  r = await attempt(builtInAdmin, form({ priority: true }));
  t = await ticketOf(r);
  check("an admin can make one, and Prioritize puts it at the front", r.ok && !!t.prioritizedAt, JSON.stringify(r.ok ? t : r));

  r = await attempt(enforcer, form({ enrollment: true, studentType: "freshman" }));
  t = await ticketOf(r);
  check("an enrollment manual ticket starts at the first station of the process", r.ok && t.stationId === "registrar" && t.enrollment === true && t.enrollmentStep === 0 &&
    JSON.stringify(t.enrollmentFlow) === JSON.stringify(["registrar", "cashier"]) && t.purpose === "Enrollment" && r.result.ticketNo === "RE1-001", JSON.stringify(r.ok ? t : r));

  r = await attempt(enforcer, form({ enrollment: true, studentType: "regular", studentNumber: "02000-123456" }));
  check("enrollment for a type with no process is refused", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

  // The Open / Closed switch (Enrollment Settings).
  await db.collection("settings").doc("enrollment").set({ open: false }, { merge: true });
  r = await attempt(enforcer, form({ enrollment: true, studentType: "freshman" }));
  check("closed enrollment refuses an enrollment manual ticket", !r.ok && r.code === "failed-precondition" && /currently closed/.test(r.message), JSON.stringify(r));
  r = await attempt(enforcer, form({ ownerName: "Closed Day" }));
  check("closed enrollment doesn't stop an ordinary manual ticket", r.ok, JSON.stringify(r));
  await db.collection("settings").doc("enrollment").set({ open: true }, { merge: true });
  await db.collection("settings").doc("enrollment").set({ flows: { freshman: ["registrar", "cashier"], regular: ["cashier"] } });
  r = await attempt(enforcer, form({ enrollment: true, studentType: "regular" }));
  check("a Regular enrollee needs a student number", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(enforcer, form({ enrollment: true, studentType: "regular", studentNumber: "02000-123456" }));
  t = await ticketOf(r);
  check("a Regular enrollee's student number goes on the ticket", r.ok && t.studentNumber === "02000-123456" && t.studentType === "regular", JSON.stringify(r.ok ? t : r));

  r = await attempt(enforcer, form({ ownerName: "  " }));
  check("a blank name is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(enforcer, form({ stationId: "closed" }));
  check("a disabled station is refused", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
  r = await attempt(enforcer, form({ stationId: "nowhere" }));
  check("an unknown station is refused", !r.ok && r.code === "not-found", JSON.stringify(r));

  r = await attempt(cashierStaff, form());
  check("station staff cannot make manual tickets", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(staffAuth("student@school.edu", "microsoft.com"), form());
  check("a student cannot make manual tickets", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(null, form());
  check("a signed-out request is refused", !r.ok && r.code === "unauthenticated", JSON.stringify(r));

  await db.collection("settings").doc("roleRules").set({ roles: { enforcer: { prioritize: false } } });
  r = await attempt(enforcer, form({ priority: true }));
  check("Prioritize off for the enforcer: a priority manual ticket is refused", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(enforcer, form());
  check("Prioritize off: an ordinary manual ticket still works", r.ok, JSON.stringify(r));
  await db.collection("settings").doc("roleRules").set({ roles: { enforcer: { walkin: false } } });
  r = await attempt(enforcer, form());
  check("walk-in tickets off for the enforcer: refused", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(builtInAdmin, form());
  check("role rules never limit an admin", r.ok, JSON.stringify(r));

  await db.collection("settings").doc("roleRules").delete();
  await db.collection("stations").doc("registrar").update({ maxQueue: 1 });
  r = await attempt(enforcer, form({ enrollment: true, studentType: "freshman" }));
  check("a full station is refused", !r.ok && r.code === "resource-exhausted", JSON.stringify(r));

  // A limit approved for today (dayLimits) wins over the normal one: raising it lets the manual ticket in.
  const todayKey = require("../lib/time").dayKey(config.tzOffsetMs, Date.now());
  await db.collection("stations").doc("registrar").update({ ["dayLimits." + todayKey]: 50 });
  r = await attempt(enforcer, form({ enrollment: true, studentType: "freshman" }));
  check("a limit approved for today replaces the normal one", r.ok, JSON.stringify(r));

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
