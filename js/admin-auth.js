var ADMIN_EMAIL = "admin@qficient.com";

var adminUser = null;
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

function adminDisplayName() {
  var kind = adminKind();
  if (kind === "enforcer") return "Queue Enforcer";
  if (kind === "station") return getStationName(adminRole) + " Staff";
  return "QFicient Admin";
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

  return db.runTransaction(function (transaction) {
    return transaction.get(ref).then(function (doc) {
      if (doc.exists) {
        if (isBootstrapAdmin && doc.data().role !== "admin") {
          transaction.update(ref, { role: "admin", updatedAt: now });
          return "admin";
        }
        return doc.data().role;
      }

      // Only the built-in admin account may create its own record. Everyone else needs an admin to give them a role.
      if (!isBootstrapAdmin) return null;

      transaction.set(ref, { email: email, role: "admin", createdAt: now, updatedAt: now });
      return "admin";
    });
  });
}

function deactivateAdminSession() {
  if (adminUser) resetAdminPageState();
  adminUser = null;
  adminRole = null;
  setTicketsScope(1);
  stopStaffListener();
  stopBlockedListener();
  stopServerStatusListener();
  stopNotificationsListener();
}

function activateAdminSession(firebaseUser) {
  if (!isPasswordUser(firebaseUser)) {
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
          startServerStatusListener();
        }
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
      return "Incorrect email or password.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
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

// "As an Admin" lets only administrators in; "As a Staff" lets in the Queue Enforcer and Queue Management staff.
var adminLoginMode = "admin";
var adminLoginInProgress = false; // the sign-in form decides where to go, not the background auth listener

function setAdminLoginMode(mode) {
  adminLoginMode = mode === "staff" ? "staff" : "admin";
  var isAdmin = adminLoginMode === "admin";

  var adminTab = document.getElementById("adminModeAdmin");
  var staffTab = document.getElementById("adminModeStaff");
  adminTab.classList.toggle("active", isAdmin);
  staffTab.classList.toggle("active", !isAdmin);
  adminTab.setAttribute("aria-selected", isAdmin ? "true" : "false");
  staffTab.setAttribute("aria-selected", isAdmin ? "false" : "true");

  document.getElementById("adminLoginSub").textContent = isAdmin ?
    "Sign in with your administrator account to continue." :
    "Sign in with your staff account to continue.";
  document.getElementById("adminEmail").placeholder = isAdmin ? "admin@example.com" : "staff@example.com";
  setAdminLoginError("");
}

// Whether the signed-in role fits the tab that was chosen.
function adminRoleFitsMode(mode) {
  var kind = adminKind();
  return mode === "admin" ? kind === "admin" : (kind === "enforcer" || kind === "station");
}

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

  var email = document.getElementById("adminEmail").value.trim();
  var passwordInput = document.getElementById("adminPassword");

  if (!email || !passwordInput.value) {
    setAdminLoginError("Enter your email and password.");
    return;
  }

  setAdminLoginError("");
  setAdminLoginBusy(true);
  adminLoginInProgress = true;

  var signedIn = false;
  var mode = adminLoginMode;

  firebase.auth().signInWithEmailAndPassword(email, passwordInput.value)
    .then(function (credential) {
      signedIn = true;
      return activateAdminSession(credential.user).then(function (allowed) {
        if (allowed && !adminRoleFitsMode(mode)) {
          passwordInput.value = "";
          setAdminLoginError(mode === "admin" ?
            "This is a staff account. Choose \"As a Staff\" to sign in." :
            "This is an administrator account. Choose \"As an Admin\" to sign in.");
          deactivateAdminSession();
          return firebase.auth().signOut();
        }

        if (allowed) {
          document.getElementById("adminLoginForm").reset();
          goTo("pageAdmin");
          return null;
        }

        passwordInput.value = "";
        setAdminLoginError(adminDeniedRole && adminDeniedRole !== "standby" ?
          "This role doesn't have access to the admin console yet. Ask an administrator." :
          "This account has no role yet. Ask an administrator to assign one.");
        return firebase.auth().signOut();
      });
    })
    .catch(function (error) {
      passwordInput.value = "";
      setAdminLoginError(adminLoginErrorMessage(error.code));
      return signedIn ? firebase.auth().signOut() : null;
    })
    .then(function () {
      adminLoginInProgress = false;
      setAdminLoginBusy(false);
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
  return firebase.auth().signOut()
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
