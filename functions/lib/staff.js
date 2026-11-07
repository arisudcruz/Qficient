// Staff accounts sign in with a username (js/admin-auth.js). Firebase's password sign-in needs an email, so each
// username stands for a hidden address on STAFF_EMAIL_DOMAIN; the built-in administrator is "admin"
// (admin@qficient.com). With no real email there is no "forgot password" link, so an administrator sets a new
// password here, without needing the old one.
const { JoinError } = require("./join");

const ADMIN_EMAIL = "admin@qficient.com";
const ADMIN_USERNAME = "admin";
const STAFF_EMAIL_DOMAIN = "staff.qficient.app";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/; // keep in step with js/admin-auth.js and firestore.rules
const PASSWORD_MIN = 8;

function emailForUsername(username) {
  return username === ADMIN_USERNAME ? ADMIN_EMAIL : username + "@" + STAFF_EMAIL_DOMAIN;
}

// Whether the signed-in caller is an administrator: the built-in admin, or a staff record with the admin role.
async function isAdminCaller(db, auth) {
  if (!auth || !auth.token) return false;
  const provider = auth.token.firebase && auth.token.firebase.sign_in_provider;
  if (provider !== "password") return false;
  const email = String(auth.token.email || "").toLowerCase();
  if (!email) return false;
  if (email === ADMIN_EMAIL) return true;
  const record = await db.collection("staff").doc(email).get();
  return record.exists && record.data().role === "admin";
}

// deps: { db, adminAuth }. data: { username, password }.
async function resetStaffPassword(deps, auth, data) {
  const { db, adminAuth } = deps;
  const input = data || {};

  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please sign in again.");
  if (!(await isAdminCaller(db, auth))) {
    throw new JoinError("permission-denied", "Only an administrator can reset staff passwords.");
  }

  const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (username !== ADMIN_USERNAME && !USERNAME_PATTERN.test(username)) {
    throw new JoinError("invalid-argument", "That username isn't valid.");
  }
  if (password.length < PASSWORD_MIN || password.length > 128) {
    throw new JoinError("invalid-argument", "The new password must be at least " + PASSWORD_MIN + " characters.");
  }

  const email = emailForUsername(username);
  const record = await db.collection("staff").doc(email).get();
  if (!record.exists && email !== ADMIN_EMAIL) throw new JoinError("not-found", "No staff account has that username.");

  let user;
  try {
    user = await adminAuth.getUserByEmail(email);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") throw new JoinError("not-found", "No login exists for that username.");
    throw error;
  }

  try {
    await adminAuth.updateUser(user.uid, { password: password });
  } catch (error) {
    if (error && (error.code === "auth/invalid-password" || error.code === "auth/password-does-not-meet-requirements")) {
      throw new JoinError("invalid-argument", "That password doesn't meet the password rules. Try a longer one.");
    }
    throw error;
  }
  return { username: username };
}

module.exports = { resetStaffPassword, emailForUsername, USERNAME_PATTERN };
