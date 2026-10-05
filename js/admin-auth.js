var adminUser = null;

function isAdminSignedIn() {
  return adminUser !== null;
}

function isPasswordUser(firebaseUser) {
  return !!firebaseUser && firebaseUser.providerData.some(function (info) {
    return info.providerId === "password";
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

  firebase.auth().signInWithEmailAndPassword(email, passwordInput.value)
    .then(function (credential) {
      adminUser = credential.user;
      document.getElementById("adminLoginForm").reset();
      goTo("pageAdmin");
    })
    .catch(function (error) {
      passwordInput.value = "";
      setAdminLoginError(adminLoginErrorMessage(error.code));
    })
    .then(function () {
      setAdminLoginBusy(false);
    });
}

function adminLogout() {
  firebase.auth().signOut()
    .then(function () {
      adminUser = null;
      setAdminSection("dashboard");
      goTo("pageAdminLogin");
    })
    .catch(function (error) {
      say("Could not log out: " + error.message);
    });
}

firebase.auth().onAuthStateChanged(function (firebaseUser) {
  adminUser = isPasswordUser(firebaseUser) ? firebaseUser : null;

  var loginPage = document.getElementById("pageAdminLogin");
  var adminPage = document.getElementById("pageAdmin");

  if (adminUser && loginPage.classList.contains("show")) {
    goTo("pageAdmin");
  } else if (!adminUser && adminPage.classList.contains("show")) {
    goTo("pageAdminLogin");
  }
});
