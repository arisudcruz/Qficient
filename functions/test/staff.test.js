// Tests resetStaffPassword against the Auth and Firestore emulators:
//   firebase emulators:exec --only auth,firestore --project demo-qficient "node functions/test/staff.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

const admin = require("firebase-admin");
const { JoinError } = require("../lib/join");
const { resetStaffPassword, emailForUsername } = require("../lib/staff");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();
const adminAuth = admin.auth();
const deps = { db, adminAuth };

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

const caller = (email, provider) => ({ uid: "caller-" + email, token: { email: email, firebase: { sign_in_provider: provider || "password" } } });

async function attempt(auth, data) {
  try {
    return { ok: true, result: await resetStaffPassword(deps, auth, data) };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message, message: error.message };
  }
}

// Signs in through the Auth emulator's REST API; true when the password works.
async function canSignIn(email, password) {
  const res = await fetch("http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST + "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
  });
  return res.ok;
}

async function makeStaff(username, role, password) {
  const email = emailForUsername(username);
  try { await adminAuth.createUser({ email: email, password: password }); } catch (e) {
    const user = await adminAuth.getUserByEmail(email);
    await adminAuth.updateUser(user.uid, { password: password });
  }
  await db.collection("staff").doc(email).set({ email: email, username: username, firstName: "T", lastName: "User", name: "T User", role: role });
  return email;
}

(async () => {
  for (const name of ["staff"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }

  const boss = await makeStaff("boss.admin", "admin", "OldPass123");
  const cashier = await makeStaff("juan.cruz", "cashier", "OldPass123");
  const enforcer = await makeStaff("enf.one", "enforcer", "OldPass123");
  check("hidden email for a username", cashier === "juan.cruz@staff.qficient.app", cashier);
  check("the built-in admin is \"admin\"", emailForUsername("admin") === "admin@qficient.com");

  let r = await attempt(caller(boss), { username: "juan.cruz", password: "NewPass456" });
  check("an admin resets a staff password", r.ok, JSON.stringify(r));
  check("the new password signs in", await canSignIn(cashier, "NewPass456"));
  check("the old password no longer signs in", !(await canSignIn(cashier, "OldPass123")));

  r = await attempt(caller("admin@qficient.com"), { username: "enf.one", password: "Another789" });
  check("the built-in admin can reset passwords", r.ok && await canSignIn(enforcer, "Another789"), JSON.stringify(r));

  r = await attempt(caller(cashier), { username: "enf.one", password: "Hacked1234" });
  check("station staff cannot reset passwords", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(caller(cashier), { username: "juan.cruz", password: "MyOwn12345" });
  check("staff cannot reset even their own password here", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(caller(boss, "google.com"), { username: "juan.cruz", password: "NewPass456" });
  check("a non-password sign-in is refused", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(null, { username: "juan.cruz", password: "NewPass456" });
  check("a signed-out request is refused", !r.ok && r.code === "unauthenticated", JSON.stringify(r));

  r = await attempt(caller(boss), { username: "nobody.here", password: "NewPass456" });
  check("an unknown username is refused", !r.ok && r.code === "not-found", JSON.stringify(r));
  r = await attempt(caller(boss), { username: "Bad Name!", password: "NewPass456" });
  check("an invalid username is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(caller(boss), { username: "juan.cruz", password: "short" });
  check("a short password is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  check("a refused reset leaves the password unchanged", await canSignIn(cashier, "NewPass456"));

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
