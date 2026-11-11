// Tests the sign-in lockout (lib/signinlock.js) against the Firestore emulator, with a stand-in for Firebase Auth:
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/signinlock.test.js"
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { JoinError } = require("../lib/join");
const lock = require("../lib/signinlock");
const config = require("../config");

admin.initializeApp({ projectId: "demo-qficient" });
const db = admin.firestore();

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   <-- " + (detail || "")));
}

// A stand-in for Firebase Auth: logins by email, and every disabled change it was asked for.
function fakeAuth(users) {
  const byEmail = {};
  users.forEach(function (u) { byEmail[u.email] = Object.assign({ disabled: false }, u); });
  return {
    users: byEmail,
    updates: [],
    async getUserByEmail(email) {
      if (!byEmail[email]) { const e = new Error("no user"); e.code = "auth/user-not-found"; throw e; }
      return Object.assign({}, byEmail[email]);
    },
    async updateUser(uid, change) {
      const user = Object.keys(byEmail).map(function (k) { return byEmail[k]; }).find(function (u) { return u.uid === uid; });
      this.updates.push({ uid: uid, change: change });
      if (user && "disabled" in change) user.disabled = change.disabled;
    }
  };
}

let clock = Date.UTC(2026, 10, 11, 2, 0, 0);
const MIN = 60 * 1000;

function depsWith(adminAuth) {
  return { db, Timestamp, FieldValue, adminAuth, config, now: function () { return clock; } };
}

async function attempt(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, code: error instanceof JoinError ? error.code : "CRASH:" + error.message };
  }
}

async function failTimes(deps, username, n) {
  let r;
  for (let i = 0; i < n; i++) r = await lock.recordFailedSignIn(deps, { username: username });
  return r;
}

const caller = (email, provider) => ({ uid: "uid-" + email, token: { email: email, firebase: { sign_in_provider: provider || "password" } } });

(async () => {
  for (const name of ["signInLocks", "staff", "securityAlerts"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection("staff").doc("boss.admin@staff.qficient.app").set({ email: "boss.admin@staff.qficient.app", role: "admin" });
  await db.collection("staff").doc("juan.cruz@staff.qficient.app").set({ email: "juan.cruz@staff.qficient.app", role: "cashier", name: "Juan Cruz" });
  const alerts = async () => (await db.collection("securityAlerts").get()).docs.map((d) => d.data());

  const auth = fakeAuth([
    { uid: "u-juan", email: "juan.cruz@staff.qficient.app" },
    { uid: "u-admin", email: "admin@qficient.com" },
    { uid: "u-off", email: "off.user@staff.qficient.app", disabled: true }
  ]);
  const deps = depsWith(auth);
  const rules = config.signInLock;

  // ---- Counting and locking ----
  let r = await failTimes(deps, "juan.cruz", rules.maxFailures - 1);
  check("4 wrong passwords don't lock", !r.locked && r.attemptsLeft === 1 && !auth.users["juan.cruz@staff.qficient.app"].disabled, JSON.stringify(r));
  check("the reply says how many tries are left", r.attemptsLeft === rules.maxFailures - 4);

  r = await lock.recordFailedSignIn(deps, { username: "juan.cruz" });
  check("the 5th locks the account for 15 minutes", r.locked && r.lockedUntilMs === clock + rules.lockMinutes * MIN && r.lockedUid === "u-juan", JSON.stringify(r));
  check("the Firebase login is switched off", auth.users["juan.cruz@staff.qficient.app"].disabled === true);
  let doc = (await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).data();
  check("the record says the lock switched it off", doc.disabledByLock === true && doc.failures.length === 0, JSON.stringify(doc));
  let list = await alerts();
  check("admins get one 'Account Locked' alert", list.length === 1 && list[0].type === "accountLocked" && list[0].username === "juan.cruz" &&
    list[0].name === "Juan Cruz" && list[0].role === "cashier" && list[0].failures === rules.maxFailures &&
    list[0].lockedUntil.toMillis() === r.lockedUntilMs && list[0].at, JSON.stringify(list));
  check("4 failures before it made no alert", list.length === 1);

  const firstUntil = r.lockedUntilMs;
  clock += 5 * MIN;
  r = await lock.recordFailedSignIn(deps, { username: "juan.cruz" });
  check("a wrong password while locked doesn't make the lock longer", r.locked && r.lockedUntilMs === firstUntil && !r.lockedUid, JSON.stringify(r));
  check("and makes no new alert", (await alerts()).length === 1);

  r = await lock.signInLockStatus(deps, { username: "juan.cruz" });
  check("status while locked says until when", r.locked && r.lockedUntilMs === firstUntil && !r.released, JSON.stringify(r));

  // ---- Running out ----
  clock = firstUntil + 1000;
  r = await lock.signInLockStatus(deps, { username: "juan.cruz" });
  check("status after the lock ran out switches the login back on", !r.locked && r.released === true && auth.users["juan.cruz@staff.qficient.app"].disabled === false, JSON.stringify(r));
  check("and removes the record", !(await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).exists);
  r = await lock.signInLockStatus(deps, { username: "juan.cruz" });
  check("status with no lock says nothing to do", !r.locked && !r.released, JSON.stringify(r));

  // ---- The 15-minute window ----
  await failTimes(deps, "juan.cruz", 3);
  clock += rules.windowMinutes * MIN + 1000;
  r = await lock.recordFailedSignIn(deps, { username: "juan.cruz" });
  check("failures older than 15 minutes don't count", !r.locked && r.attemptsLeft === rules.maxFailures - 1, JSON.stringify(r));

  // ---- A successful sign-in clears the count ----
  r = await attempt(() => lock.clearSignInFailures(deps, caller("juan.cruz@staff.qficient.app")));
  check("a successful sign-in clears the count", r.ok && !(await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).exists, JSON.stringify(r));
  r = await attempt(() => lock.clearSignInFailures(deps, null));
  check("clearing needs a sign-in", !r.ok && r.code === "unauthenticated", JSON.stringify(r));
  r = await attempt(() => lock.clearSignInFailures(deps, caller("juan.cruz@staff.qficient.app", "microsoft.com")));
  check("clearing needs a password sign-in", !r.ok && r.code === "unauthenticated", JSON.stringify(r));

  await failTimes(deps, "juan.cruz", rules.maxFailures);
  await lock.clearSignInFailures(deps, caller("juan.cruz@staff.qficient.app"));
  check("clearing never ends a running lock", (await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).exists);

  // ---- The every-minute sweep ----
  clock += rules.lockMinutes * MIN + 1000;
  let released = await lock.releaseExpiredLocks(deps);
  check("the sweep ends locks that ran out", released === 1 && auth.users["juan.cruz@staff.qficient.app"].disabled === false, "released " + released);
  released = await lock.releaseExpiredLocks(deps);
  check("and has nothing left to do after", released === 0);

  // ---- Usernames and accounts the lock must not touch ----
  const before = auth.updates.length;
  r = await failTimes(deps, "nobody.here", rules.maxFailures - 1);
  check("an unknown username gets the same replies", !r.locked && r.attemptsLeft === 1, JSON.stringify(r));
  r = await lock.recordFailedSignIn(deps, { username: "nobody.here" });
  check("and 'locks' the same way", r.locked && !r.lockedUid, JSON.stringify(r));
  check("but no login is touched", auth.updates.length === before);
  check("and no alert is made for a username with no account", !(await alerts()).some((a) => a.username === "nobody.here"));

  r = await failTimes(deps, "off.user", rules.maxFailures);
  check("an account an admin disabled is locked like any other", r.locked, JSON.stringify(r));
  doc = (await db.collection("signInLocks").doc("off.user@staff.qficient.app").get()).data();
  check("but the lock doesn't claim it switched it off", doc.disabledByLock === false, JSON.stringify(doc));
  clock += rules.lockMinutes * MIN + 1000;
  r = await lock.signInLockStatus(deps, { username: "off.user" });
  check("and it is never switched back on", auth.users["off.user@staff.qficient.app"].disabled === true && r.released === false, JSON.stringify(r));

  r = await attempt(() => lock.recordFailedSignIn(deps, { username: "x" }));
  check("a malformed username is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(() => lock.recordFailedSignIn(deps, { username: "someone@gmail.com" }));
  check("an email is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
  r = await attempt(() => lock.recordFailedSignIn(deps, {}));
  check("a missing username is refused", !r.ok && r.code === "invalid-argument", JSON.stringify(r));

  // ---- The built-in admin is locked too ----
  r = await failTimes(deps, "admin", rules.maxFailures);
  check("the built-in admin is locked too", r.locked && auth.users["admin@qficient.com"].disabled === true, JSON.stringify(r));
  list = await alerts();
  const adminAlert = list.find((a) => a.username === "admin");
  check("with an alert (no staff record: no name)", !!adminAlert && adminAlert.name === "" && !r.alertError, JSON.stringify(list));

  // ---- An administrator unlocks ----
  r = await attempt(() => lock.unlockStaffAccount(deps, caller("juan.cruz@staff.qficient.app"), { username: "admin" }));
  check("station staff can't unlock", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(() => lock.unlockStaffAccount(deps, null, { username: "admin" }));
  check("a signed-out request can't unlock", !r.ok && r.code === "unauthenticated", JSON.stringify(r));
  r = await attempt(() => lock.unlockStaffAccount(deps, caller("boss.admin@staff.qficient.app", "google.com"), { username: "admin" }));
  check("a non-password sign-in can't unlock", !r.ok && r.code === "permission-denied", JSON.stringify(r));
  r = await attempt(() => lock.unlockStaffAccount(deps, caller("boss.admin@staff.qficient.app"), { username: "admin" }));
  check("another admin unlocks the built-in admin", r.ok && r.result.wasLocked === true && auth.users["admin@qficient.com"].disabled === false, JSON.stringify(r));
  check("and the record is gone", !(await db.collection("signInLocks").doc("admin@qficient.com").get()).exists);
  r = await attempt(() => lock.unlockStaffAccount(deps, caller("admin@qficient.com"), { username: "juan.cruz" }));
  check("unlocking an account that isn't locked is harmless", r.ok && r.result.wasLocked === false, JSON.stringify(r));

  // ---- A password reset ends a lock (index.js calls releaseLock with force after resetStaffPassword) ----
  await failTimes(deps, "juan.cruz", rules.maxFailures);
  const removed = await lock.releaseLock(deps, "juan.cruz@staff.qficient.app", true);
  check("a forced release (password reset) ends a running lock", !!removed && auth.users["juan.cruz@staff.qficient.app"].disabled === false &&
    !(await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).exists);

  // ---- Nightly cleanup ----
  await failTimes(deps, "juan.cruz", 2);
  clock += 25 * 60 * MIN;
  const cleaned = await lock.cleanOldFailures(deps);
  check("old failure counts are removed each night", cleaned >= 1 && !(await db.collection("signInLocks").doc("juan.cruz@staff.qficient.app").get()).exists, "cleaned " + cleaned);

  const alertCount = (await alerts()).length;
  clock = Date.now() + 6 * 24 * 60 * MIN;
  let removed2 = await lock.cleanOldAlerts(deps);
  check("alerts within 7 days are kept", removed2 === 0 && (await alerts()).length === alertCount, "removed " + removed2);
  clock = Date.now() + 8 * 24 * 60 * MIN;
  removed2 = await lock.cleanOldAlerts(deps);
  check("alerts older than 7 days are removed each night", removed2 === alertCount && (await alerts()).length === 0, "removed " + removed2 + " of " + alertCount);

  for (const name of ["signInLocks", "staff", "securityAlerts"]) {
    const snap = await db.collection(name).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }

  console.log("\n" + (failures ? failures + " failed" : "all passed"));
  process.exit(failures ? 1 : 0);
})();
