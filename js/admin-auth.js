var ADMIN_EMAIL = "admin@qficient.com";

// Staff sign in with a username. Firebase's password sign-in needs an email, so each username stands for a hidden
// address on this domain (never shown, never mailed): juan.cruz -> juan.cruz@staff.qficient.app. The built-in
// administrator is the username "admin" (its login is admin@qficient.com).
var STAFF_EMAIL_DOMAIN = "staff.qficient.app";
var ADMIN_USERNAME = "admin";
var USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/; // keep in step with firestore.rules and functions/lib/staff.js

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function staffEmailForUsername(username) {
  var u = normalizeUsername(username);
  return u === ADMIN_USERNAME ? ADMIN_EMAIL : u + "@" + STAFF_EMAIL_DOMAIN;
}

function usernameOfEmail(email) {
  var key = String(email || "").trim().toLowerCase();
  if (key === ADMIN_EMAIL) return ADMIN_USERNAME;
  var suffix = "@" + STAFF_EMAIL_DOMAIN;
  return key.slice(-suffix.length) === suffix ? key.slice(0, -suffix.length) : "";
}

// Accounts that sign in with a username: the built-in admin and every account on the staff domain. Older accounts
// made with a real email can no longer sign in; an admin re-creates them with a username.
function isUsernameAccount(email) {
  return !!usernameOfEmail(email);
}

var adminUser = null;
var adminName = ""; // the signed-in staff member's full name, from their staff record
var adminMustChangePassword = false; // still on staff123 or a password an admin reset (js/admin-password.js)
var adminRole = null; // "admin", "enforcer", or the id of the station a Queue Management account belongs to
var adminDeniedRole = null; // the role of an account that signed in but is not allowed in
var staffUnsubscribe = null;

function isAdminSignedIn() {
  return adminUser !== null;
}

function isFullAdmin() {
  return adminUser !== null && adminRole === "admin";
}

// "admin" (no restrictions), "enforcer", or "station" (Queue Management staff of one station); null when signed out.
function adminKind() {
  if (!adminUser) return null;
  if (adminRole === "admin") return "admin";
  return adminRole === "enforcer" ? "enforcer" : "station";
}

// The role, as shown next to the name in the header.
function adminRoleLabel() {
  var kind = adminKind();
  if (kind === "enforcer") return "Queue Enforcer";
  if (kind === "station") return getStationName(adminRole) + " Staff";
  return adminName ? "Administrator" : "QFicient Admin";
}

// Staff of one station only see that station's numbers and notifications. Admins and enforcers see them all.
function canViewStationData(stationId) {
  return adminKind() !== "station" || stationId === adminRole;
}

function isStationRole(role) {
  if (!role || role === "standby" || role === "admin" || role === "enforcer") return Promise.resolve(false);

  return db.collection("stations").doc(role).get().then(function (doc) {
    return doc.exists;
  }).catch(function () {
    return false;
  });
}

function isPasswordUser(firebaseUser) {
  return !!firebaseUser && firebaseUser.providerData.some(function (info) {
    return info.providerId === "password";
  });
}

function staffKey(email) {
  return String(email || "").trim().toLowerCase();
}

function isProtectedAccount(email) {
  var key = staffKey(email);
  return key === ADMIN_EMAIL || (adminUser !== null && key === staffKey(adminUser.email));
}

function startStaffListener() {
  if (staffUnsubscribe) return;

  staffUnsubscribe = db.collection("staff").onSnapshot(function (snapshot) {
    staffAccounts = snapshot.docs.map(function (doc) {
      return Object.assign({ id: doc.id }, doc.data());
    });
    // An admin who edits their own name sees it in the header straight away.
    var me = adminUser && staffAccounts.find(function (a) { return a.id === staffKey(adminUser.email); });
    if (me && (me.name || "") !== adminName) {
      adminName = me.name || "";
      refreshAdminProfileButtons();
    }
    refreshSettings();
  }, function (error) {
    console.error("Could not load staff accounts: " + error.message);
  });
}

function stopStaffListener() {
  if (staffUnsubscribe) {
    staffUnsubscribe();
    staffUnsubscribe = null;
  }
  staffAccounts = [];
}

function resolveAdminAccess(firebaseUser) {
  var email = staffKey(firebaseUser.email);
  var ref = db.collection("staff").doc(email);
  var isBootstrapAdmin = email === ADMIN_EMAIL;
  var now = firebase.firestore.FieldValue.serverTimestamp();

  // Resolves the role, and keeps the person's full name for the header.
  return db.runTransaction(function (transaction) {
    return transaction.get(ref).then(function (doc) {
      if (doc.exists) {
        adminName = doc.data().name || "";
        adminMustChangePassword = doc.data().mustChangePassword === true;
        if (isBootstrapAdmin && doc.data().role !== "admin") {
          transaction.update(ref, { role: "admin", updatedAt: now });
          return "admin";
        }
        return doc.data().role;
      }

      adminName = "";
      adminMustChangePassword = false;
      // Only the built-in admin account may create its own record. Everyone else needs an admin to give them a role.
      if (!isBootstrapAdmin) return null;

      transaction.set(ref, { email: email, role: "admin", createdAt: now, updatedAt: now });
      return "admin";
    });
  });
}

function deactivateAdminSession() {
  closeProfileMenu();
  if (adminUser) resetAdminPageState();
  adminUser = null;
  adminName = "";
  adminMustChangePassword = false;
  adminRole = null;
  setTicketsScope(1);
  stopStaffListener();
  stopBlockedListener();
  stopLockedListener();
  stopLimitRequestsListener();
  stopServerStatusListener();
  stopNotificationsListener();
}

function activateAdminSession(firebaseUser) {
  if (!isPasswordUser(firebaseUser)) {
    deactivateAdminSession();
    return Promise.resolve(false);
  }
  // An account made with a real email from before usernames: refused until an admin re-creates it.
  if (!isUsernameAccount(firebaseUser.email)) {
    adminDeniedRole = "email-account";
    deactivateAdminSession();
    return Promise.resolve(false);
  }

  return resolveAdminAccess(firebaseUser).then(function (role) {
    var known = role === "admin" || role === "enforcer" ? Promise.resolve(true) : isStationRole(role);

    return known.then(function (allowed) {
      var current = firebase.auth().currentUser;
      if (allowed && (!current || current.uid !== firebaseUser.uid)) return false;

      if (allowed) {
        adminUser = firebaseUser;
        adminRole = role;
        adminDeniedRole = null;

        // Every role gets the dashboard and the notification inbox, so each loads the longer ticket history.
        setTicketsScope(ADMIN_HISTORY_DAYS);
        startNotificationsListener();

        // The staff list and server status stay with full admins.
        if (role === "admin") {
          startStaffListener();
          startBlockedListener();
          startLockedListener();
          startServerStatusListener();
        }
        // Daily limit requests: admins see the pending ones, station staff their station's (js/admin-limit-requests.js).
        startLimitRequestsListener();
        applyAdminAccess();
      } else {
        adminDeniedRole = role;
        deactivateAdminSession();
      }
      return allowed;
    });
  }).catch(function (error) {
    deactivateAdminSession();
    throw error;
  });
}

function adminLoginErrorMessage(code) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect username or password.";
    case "auth/invalid-email":
      return "Enter a valid username.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in isn't enabled for this project.";
    case "permission-denied":
      return "Could not verify your access. Please contact an administrator.";
    default:
      return "Could not sign in. Please try again.";
  }
}

/* ---------- Sign-in lockout (functions/lib/signinlock.js) ----------
   Firebase checks the password here in the browser, so each wrong one is reported to the server, which counts them and,
   at the limit, switches the account's login off for a while. If a report can't be sent (offline), the usual
   message is shown and nothing else changes. */

function signInLockCall(name, data) {
  return firebase.app().functions(JOIN_FUNCTION_REGION).httpsCallable(name)(data || {}).then(function (result) {
    return result.data || {};
  });
}

function signInLockedText(untilMs) {
  return "Too many failed sign-ins. This account is locked until " + manilaTimeText(untilMs) +
    ". An administrator can unlock it sooner.";
}

// After a wrong password: the message to show, with how many tries are left once only a few remain.
function failedSignInText(username) {
  return signInLockCall("recordFailedSignIn", { username: username }).then(function (r) {
    if (r.locked && r.lockedUntilMs) return signInLockedText(r.lockedUntilMs);
    if (r.attemptsLeft > 0 && r.attemptsLeft <= 2) {
      return "Incorrect username or password. " + r.attemptsLeft + " attempt" + (r.attemptsLeft === 1 ? "" : "s") +
        " left before this account is locked.";
    }
    return adminLoginErrorMessage("auth/invalid-credential");
  }).catch(function () {
    return adminLoginErrorMessage("auth/invalid-credential");
  });
}

// The login is switched off: by a lock (still running, or just ended and now switched back on) or by an administrator.
function disabledSignInStatus(username) {
  return signInLockCall("signInLockStatus", { username: username }).catch(function () {
    return {};
  });
}

// One form for administrators and staff alike: the account's role decides what the console shows.
var adminLoginInProgress = false; // the sign-in form decides where to go, not the background auth listener

function setAdminLoginError(text) {
  var el = document.getElementById("adminLoginError");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function setAdminLoginBusy(busy) {
  setButtonLoading(document.getElementById("adminLoginSubmit"), busy);
}

function adminLogin(event) {
  event.preventDefault();

  var username = normalizeUsername(document.getElementById("adminEmail").value);
  var passwordInput = document.getElementById("adminPassword");

  if (!username || !passwordInput.value) {
    setAdminLoginError("Enter your username and password.");
    return;
  }
  // Accounts sign in with a username now, never an email.
  if (username.indexOf("@") !== -1) {
    setAdminLoginError("Sign in with your username, not an email.");
    return;
  }
  if (username !== ADMIN_USERNAME && !USERNAME_PATTERN.test(username)) {
    setAdminLoginError("Incorrect username or password.");
    return;
  }
  var email = staffEmailForUsername(username);

  setAdminLoginError("");
  setAdminLoginBusy(true);
  adminLoginInProgress = true;

  var signedIn = false;
  var password = passwordInput.value;

  // A lock that has just ended is switched back on by signInLockStatus; the sign-in is then tried once more.
  function signInOnce(retried) {
    return firebase.auth().signInWithEmailAndPassword(email, password).catch(function (error) {
      if (retried || !error || error.code !== "auth/user-disabled") throw error;
      return disabledSignInStatus(username).then(function (status) {
        if (status.released) return signInOnce(true);
        if (status.locked && status.lockedUntilMs) error.lockMessage = signInLockedText(status.lockedUntilMs);
        throw error;
      });
    });
  }

  signInOnce(false)
    .then(function (credential) {
      signedIn = true;
      return activateAdminSession(credential.user).then(function (allowed) {
        if (allowed) {
          var typedPassword = passwordInput.value;
          document.getElementById("adminLoginForm").reset();
          goTo("pageAdmin");
          logAccountEvent("signIn"); // the audit trail (js/admin-audit.js); never holds up the sign-in
          signInLockCall("clearSignInFailures").catch(function () {}); // a fresh count; never holds up the sign-in
          // Still on staff123 (or a password an admin reset): ask them to choose their own (js/admin-password.js).
          if (adminMustChangePassword) openChangePasswordModal({ firstTime: true, current: typedPassword });
          return null;
        }

        passwordInput.value = "";
        setAdminLoginError(adminDeniedRole === "email-account" ?
          "This account uses an email, which can no longer sign in. Ask an administrator to re-create it with a username." :
          adminDeniedRole && adminDeniedRole !== "standby" ?
          "This role doesn't have access to the admin console yet. Ask an administrator." :
          "This account has no role yet. Ask an administrator to assign one.");
        return firebase.auth().signOut();
      });
    })
    .catch(function (error) {
      passwordInput.value = "";
      if (signedIn) {
        setAdminLoginError(adminLoginErrorMessage(error.code));
        return firebase.auth().signOut();
      }
      var code = error && error.code;
      if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        return failedSignInText(username).then(setAdminLoginError);
      }
      setAdminLoginError(error && error.lockMessage || adminLoginErrorMessage(code));
      return null;
    })
    .then(function () {
      adminLoginInProgress = false;
      setAdminLoginBusy(false);
      setPasswordVisible(passwordInput, false); // a password shown with the eye doesn't stay on screen
    });
}

function confirmAdminLogout() {
  showConfirmModal({
    title: "Are you sure you want to log out?",
    message: "You'll need to sign in again to use the admin console on this device.",
    confirmLabel: "Log Out",
    tone: "danger",
    onConfirm: function () { return adminLogout(); }
  });
}

function adminLogout() {
  // Recorded in the audit trail while still signed in (the rules only accept it from the person themselves).
  return logAccountEvent("signOut").then(function () { return firebase.auth().signOut(); })
    .then(function () {
      deactivateAdminSession();
      setAdminSection("dashboard");
      goTo("pageAdminLogin");
    })
    .catch(function (error) {
      say("Could not log out: " + error.message);
    });
}

function routeAfterAdminAuthChange() {
  if (adminLoginInProgress) return;

  var loginPage = document.getElementById("pageAdminLogin");
  var adminPage = document.getElementById("pageAdmin");

  var tvPage = document.getElementById("pageTvBoard");
  var waiting = typeof pendingRoute !== "undefined" && pendingRoute ? pendingRoute.name : "";

  if (adminUser && waiting === "tv") {
    goTo("pageTvBoard");
  } else if (adminUser && (loginPage.classList.contains("show") || waiting === "admin")) {
    goTo("pageAdmin");
  } else if (!adminUser && (adminPage.classList.contains("show") || (tvPage && tvPage.classList.contains("show")))) {
    goTo("pageAdminLogin");
  }
}

firebase.auth().onAuthStateChanged(function (firebaseUser) {
  activateAdminSession(firebaseUser)
    .catch(function (error) {
      console.error("Could not verify admin access: " + error.message);
    })
    .then(routeAfterAdminAuthChange);
});
