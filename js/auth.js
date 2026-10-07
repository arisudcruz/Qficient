function getStudentNumberFromEmail(email) {
  var localPart = (email || "").split("@")[0];
  var digits = localPart.replace(/\D/g, "");
  return digits ? "02000" + digits : "";
}

function login() {
  var provider = new firebase.auth.OAuthProvider("microsoft.com");
  provider.setCustomParameters({
    prompt: "select_account",
    tenant: "3663e35d-c7bc-4b90-90e0-a67a1d53bb77"
  });

  firebase.auth().signInWithPopup(provider)
    .then(function (result) {
      var signedInUser = result.user;
      var name = signedInUser.displayName || signedInUser.email;

      user = {
        type: "student",
        id: signedInUser.uid,
        name: name,
        email: signedInUser.email,
        studentNumber: getStudentNumberFromEmail(signedInUser.email),
        studentType: null
      };

      db.collection("students").doc(user.id).get()
        .then(function (doc) {
          if (doc.exists && doc.data().studentType) {
            user.studentType = doc.data().studentType;
          }
        })
        .catch(function (error) {
          console.error("Could not load student profile: " + error.message);
        })
        .then(function () {
          updateDashboard();
          goTo("pageDashboard");

          if (!user.studentType) {
            promptStudentType(true);
          }
        });
    })
    .catch(function (error) {
      say("Microsoft sign-in failed: " + error.message);
    });
}


function guestSignInErrorMessage(code) {
  switch (code) {
    case "auth/operation-not-allowed":
      return "Could not start guest access: anonymous sign-in isn't enabled for this project yet.";
    case "auth/network-request-failed":
      return "Could not start guest access. Check your connection and try again.";
    default:
      return "Could not start guest access. Please try again.";
  }
}

var EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

function setGuestFieldError(inputId, message) {
  var input = document.getElementById(inputId);
  document.getElementById(inputId + "Error").textContent = message;
  input.classList.toggle("invalid", message !== "");
  input.setAttribute("aria-invalid", message !== "" ? "true" : "false");
}

function guestEmailProblem(email) {
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return "";
}

function startGuestSession() {
  var firstName = document.getElementById("guestFirstName").value.trim().replace(/\s+/g, " ");
  var lastName = document.getElementById("guestLastName").value.trim().replace(/\s+/g, " ");
  var email = document.getElementById("guestEmail").value.trim();
  var purpose = document.getElementById("guestPurpose").value.trim();

  var problems = [
    ["guestFirstName", /\p{L}/u.test(firstName) ? "" : "Enter your first name."],
    ["guestLastName", /\p{L}/u.test(lastName) ? "" : "Enter your last name."],
    ["guestEmail", guestEmailProblem(email)],
    ["guestPurpose", purpose ? "" : "Enter your purpose."]
  ];

  var firstInvalid = null;
  problems.forEach(function (problem) {
    setGuestFieldError(problem[0], problem[1]);
    if (problem[1] && !firstInvalid) firstInvalid = problem[0];
  });

  if (firstInvalid) {
    document.getElementById(firstInvalid).focus();
    return;
  }

  var name = firstName + " " + lastName;
  var button = document.getElementById("guestContinueBtn");
  button.disabled = true;

  firebase.auth().signOut()
    .then(function () {
      return firebase.auth().signInAnonymously();
    })
    .then(function (credential) {
      user = {
        type: "guest",
        id: credential.user.uid,
        name: name,
        email: email,
        purpose: purpose
      };

      pendingJoinPurpose = purpose;
      updateDashboard();
      goTo("pageDashboard");
    })
    .catch(function (error) {
      say(guestSignInErrorMessage(error.code));
    })
    .then(function () {
      button.disabled = false;
    });
}
