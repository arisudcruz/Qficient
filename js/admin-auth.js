var ADMIN_EMAIL = "admin@qficient.com";

var adminUser = null;
var staffUnsubscribe = null;

function isAdminSignedIn() {
  return adminUser !== null;
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

  return ref.get().then(function (doc) {
    if (doc.exists) {
      if (isBootstrapAdmin && doc.data().role !== "admin") {
        return ref.update({ role: "admin", updatedAt: now }).then(function () { return true; });
      }
      return doc.data().role === "admin";
    }

    var role = isBootstrapAdmin ? "admin" : "standby";
    return ref.set({ email: email, role: role, createdAt: now, updatedAt: now }).then(function () {
      return role === "admin";
    });
  });
}

function deactivateAdminSession() {
  adminUser = null;
  stopStaffListener();
}

function activateAdminSession(firebaseUser) {
  if (!isPasswordUser(firebaseUser)) {
    deactivateAdminSession();
    return Promise.resolve(false);
  }

  return resolveAdminAccess(firebaseUser).then(function (allowed) {
    if (allowed) {
      adminUser = firebaseUser;
      startStaffListener();
    } else {
      deactivateAdminSession();
    }
    return allowed;
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

function setAdminLoginError(text) {
  var el = document.getElementById("adminLoginError");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function setAdminLoginBusy(busy) {
  var button = document.getElementById("adminLoginSubmit");
  button.disabled = busy;
  button.textContent = busy ? "Signing in..." : "Sign in";
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

  var signedIn = false;

  firebase.auth().signInWithEmailAndPassword(email, passwordInput.value)
    .then(function (credential) {
      signedIn = true;
      return activateAdminSession(credential.user).then(function (allowed) {
        if (allowed) {
          document.getElementById("adminLoginForm").reset();
          goTo("pageAdmin");
          return null;
        }

        passwordInput.value = "";
        setAdminLoginError("This account is on standby. Ask an administrator to grant you access.");
        return firebase.auth().signOut();
      });
    })
    .catch(function (error) {
      passwordInput.value = "";
      setAdminLoginError(adminLoginErrorMessage(error.code));
      return signedIn ? firebase.auth().signOut() : null;
    })
    .then(function () {
      setAdminLoginBusy(false);
    });
}

function adminLogout() {
  firebase.auth().signOut()
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
  var loginPage = document.getElementById("pageAdminLogin");
  var adminPage = document.getElementById("pageAdmin");

  if (adminUser && loginPage.classList.contains("show")) {
    goTo("pageAdmin");
  } else if (!adminUser && adminPage.classList.contains("show")) {
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
