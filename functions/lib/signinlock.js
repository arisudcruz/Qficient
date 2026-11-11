// Account lockout for admin and staff sign-ins (js/admin-auth.js). Firebase checks the password in the browser, so
// the login page reports each wrong password here. config.signInLock.maxFailures of them within windowMinutes lock
// the account for lockMinutes: the Firebase login itself is disabled until then, so nothing can sign in to it, even
// outside the app. The lock ends on its own (the every-minute sweep, or the next sign-in attempt), and an
// administrator can lift it early (Settings > Staff, or by resetting the password).
//
// signInLocks/{email}: { username, failures: [ms], lockedUntil, lockedAt, disabledByLock, updatedAt }. Only these
// functions write it; admins can read it (firestore.rules). disabledByLock is true only when this lock disabled the
// login, so an account an administrator disabled for another reason is never switched back on here.
const { JoinError } = require("./join");
const { emailForUsername, isAdminCaller, USERNAME_PATTERN, ADMIN_USERNAME } = require("./staff");

const COLLECTION = "signInLocks";

function lockRules(config) {
  const r = config.signInLock;
  return { maxFailures: r.maxFailures, windowMs: r.windowMinutes * 60 * 1000, lockMs: r.lockMinutes * 60 * 1000 };
}

function msOf(ts) {
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

function nowOf(deps) {
  return deps.now ? deps.now() : Date.now();
}

function usernameOf(data) {
  const username = data && typeof data.username === "string" ? data.username.trim().toLowerCase() : "";
  if (username !== ADMIN_USERNAME && !USERNAME_PATTERN.test(username)) {
    throw new JoinError("invalid-argument", "That username isn't valid.");
  }
  return username;
}

async function authUserOf(adminAuth, email) {
  try {
    return await adminAuth.getUserByEmail(email);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") return null;
    throw error;
  }
}

// Ends a lock: switches the login back on (only if the lock switched it off), then removes the record. With force
// (an administrator unlocking, or a password reset) it ends a lock that is still running, and clears the failure
// count too. Returns the record it removed, or null when there was nothing to end.
async function releaseLock(deps, email, force) {
  const { db, adminAuth } = deps;
  const ref = db.collection(COLLECTION).doc(email);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data();
  const untilMs = msOf(data.lockedUntil);
  if (!force && (!untilMs || untilMs > nowOf(deps))) return null;

  // Switched back on first: if that fails, the record stays and the next sweep tries again.
  if (data.disabledByLock === true) {
    const user = await authUserOf(adminAuth, email);
    if (user && user.disabled) await adminAuth.updateUser(user.uid, { disabled: false });
  }

  await db.runTransaction(async function (transaction) {
    const fresh = await transaction.get(ref);
    // Removed only if it is still the same lock (or, when forced, whatever is there).
    if (fresh.exists && (force || msOf(fresh.data().lockedUntil) === untilMs)) transaction.delete(ref);
  });
  return data;
}

// Admins are told in their notification inbox (js/admin-notifications.js) when a real login is locked. Usernames
// without an account never make one, so guessing names can't fill the inbox. Kept for ALERT_DAYS (dailyCleanup).
const ALERTS = "securityAlerts";
const ALERT_DAYS = 7; // the inbox's look-back (NOTIF_LOOKBACK_DAYS in js/admin-notifications.js)

async function writeLockAlert(deps, email, username, lockedUntilMs, failures) {
  const { db, Timestamp, FieldValue } = deps;
  const staff = await db.collection("staff").doc(email).get();
  const data = staff.exists ? staff.data() : {};
  await db.collection(ALERTS).add({
    type: "accountLocked",
    at: FieldValue ? FieldValue.serverTimestamp() : Timestamp.fromMillis(nowOf(deps)),
    username: username,
    name: data.name || "",
    role: data.role || "",
    lockedUntil: Timestamp.fromMillis(lockedUntilMs),
    failures: failures
  });
}

// The login page reports a wrong password. Usernames without an account are counted the same way, so the answer
// never reveals which usernames exist; only a real login is ever disabled.
// Returns { locked, lockedUntilMs, attemptsLeft, lockedUid } (lockedUid only when this failure started the lock).
async function recordFailedSignIn(deps, data) {
  const { db, Timestamp, adminAuth, config } = deps;
  const username = usernameOf(data);
  const email = emailForUsername(username);
  const { maxFailures, windowMs, lockMs } = lockRules(config);
  const ref = db.collection(COLLECTION).doc(email);

  // A lock that has run out is ended first, so its login is switched back on before counting starts again.
  await releaseLock(deps, email, false);

  const nowMs = nowOf(deps);
  const outcome = await db.runTransaction(async function (transaction) {
    const snap = await transaction.get(ref);
    const d = snap.exists ? snap.data() : {};
    const untilMs = msOf(d.lockedUntil);
    // Still locked: tried again, but the lock is not made longer.
    if (untilMs > nowMs) return { locked: true, lockedUntilMs: untilMs, attemptsLeft: 0, started: false };

    const failures = (Array.isArray(d.failures) ? d.failures : [])
      .filter(function (t) { return typeof t === "number" && t > nowMs - windowMs && t <= nowMs; })
      .concat(nowMs);

    if (failures.length >= maxFailures) {
      const lockedUntilMs = nowMs + lockMs;
      transaction.set(ref, {
        username: username, failures: [], lockedUntil: Timestamp.fromMillis(lockedUntilMs), lockedAt: Timestamp.fromMillis(nowMs),
        disabledByLock: false, updatedAt: Timestamp.fromMillis(nowMs)
      });
      return { locked: true, lockedUntilMs: lockedUntilMs, attemptsLeft: 0, started: true };
    }

    transaction.set(ref, {
      username: username, failures: failures, lockedUntil: null, disabledByLock: false, updatedAt: Timestamp.fromMillis(nowMs)
    });
    return { locked: false, lockedUntilMs: 0, attemptsLeft: maxFailures - failures.length, started: false };
  });

  let lockedUid = "";
  let alertError = null;
  if (outcome.started) {
    const user = await authUserOf(adminAuth, email);
    // Marked before the login is switched off, so a failure in between can never leave it off with no record.
    if (user && !user.disabled) {
      await ref.update({ disabledByLock: true });
      await adminAuth.updateUser(user.uid, { disabled: true });
    }
    if (user) {
      lockedUid = user.uid;
      // The alert never holds up the lock or the reply; a failure is handed back for the log.
      try {
        await writeLockAlert(deps, email, username, outcome.lockedUntilMs, maxFailures);
      } catch (error) {
        alertError = error;
      }
    }
  }

  return { locked: outcome.locked, lockedUntilMs: outcome.lockedUntilMs, attemptsLeft: outcome.attemptsLeft, lockedUid: lockedUid, alertError: alertError };
}

// Sign-in said the account is disabled: is that this lock, and has it run out? Returns { locked, lockedUntilMs } while
// it lasts; once it has run out the login is switched back on and { released: true } tells the page to try again.
async function signInLockStatus(deps, data) {
  const email = emailForUsername(usernameOf(data));
  const snap = await deps.db.collection(COLLECTION).doc(email).get();
  const d = snap.exists ? snap.data() : {};
  const untilMs = msOf(d.lockedUntil);
  if (untilMs > nowOf(deps)) return { locked: true, lockedUntilMs: untilMs, released: false };
  if (!untilMs) return { locked: false, lockedUntilMs: 0, released: false };

  const released = await releaseLock(deps, email, false);
  return { locked: false, lockedUntilMs: 0, released: !!(released && released.disabledByLock === true) };
}

// A successful sign-in clears the person's own failure count (never a running lock).
async function clearSignInFailures(deps, auth) {
  const { db } = deps;
  const provider = auth && auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider;
  const email = auth && auth.token ? String(auth.token.email || "").toLowerCase() : "";
  if (!auth || !auth.uid || provider !== "password" || !email) throw new JoinError("unauthenticated", "Please sign in again.");

  const ref = db.collection(COLLECTION).doc(email);
  const nowMs = nowOf(deps);
  await db.runTransaction(async function (transaction) {
    const snap = await transaction.get(ref);
    if (snap.exists && !(msOf(snap.data().lockedUntil) > nowMs)) transaction.delete(ref);
  });
  return { cleared: true };
}

// An administrator lifts a lock early (Settings > Staff).
async function unlockStaffAccount(deps, auth, data) {
  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please sign in again.");
  if (!(await isAdminCaller(deps.db, auth))) throw new JoinError("permission-denied", "Only an administrator can unlock accounts.");

  const username = usernameOf(data);
  const removed = await releaseLock(deps, emailForUsername(username), true);
  const wasLocked = !!(removed && msOf(removed.lockedUntil) > nowOf(deps));
  return { username: username, wasLocked: wasLocked };
}

// Every minute (sweepExpiredTickets): locks that have run out are ended, so no login stays switched off.
async function releaseExpiredLocks(deps) {
  const { db, Timestamp } = deps;
  const due = await db.collection(COLLECTION).where("lockedUntil", "<=", Timestamp.fromMillis(nowOf(deps))).get();
  let released = 0;
  for (const doc of due.docs) {
    if (await releaseLock(deps, doc.id, false)) released++;
  }
  return released;
}

// Each night (dailyCleanup): failure counts nobody has added to for a day are removed.
async function cleanOldFailures(deps) {
  const { db, Timestamp } = deps;
  const old = await db.collection(COLLECTION).where("updatedAt", "<", Timestamp.fromMillis(nowOf(deps) - 24 * 60 * 60 * 1000)).get();
  const stale = old.docs.filter(function (doc) { return !doc.data().lockedUntil; });
  await Promise.all(stale.map(function (doc) { return doc.ref.delete(); }));
  return stale.length;
}

// Each night (dailyCleanup): lock alerts older than the inbox shows are removed.
async function cleanOldAlerts(deps) {
  const { db, Timestamp } = deps;
  const old = await db.collection(ALERTS).where("at", "<", Timestamp.fromMillis(nowOf(deps) - ALERT_DAYS * 24 * 60 * 60 * 1000)).get();
  await Promise.all(old.docs.map(function (doc) { return doc.ref.delete(); }));
  return old.size;
}

module.exports = {
  cleanOldAlerts,
  recordFailedSignIn, signInLockStatus, clearSignInFailures, unlockStaffAccount, releaseLock, releaseExpiredLocks, cleanOldFailures
};
