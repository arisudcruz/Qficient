function getStudentNumberFromEmail(email) {
  var localPart = (email || "").split("@")[0];
  var digits = localPart.replace(/\D/g, "");
  return digits ? "02000" + digits : "";
}

var GUEST_PROFILE_KEY = "qficient.guestProfile";
var startingSession = false;

function saveGuestProfile(profile) {
  try {
    localStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {}
}

function loadGuestProfile(uid) {
  try {
    var profile = JSON.parse(localStorage.getItem(GUEST_PROFILE_KEY));
    return profile && profile.uid === uid ? profile : null;
  } catch (e) {
    return null;
  }
}

function clearGuestProfile() {
  try {
    localStorage.removeItem(GUEST_PROFILE_KEY);
  } catch (e) {}
}

function enterStudentSession(signedInUser) {
  user = {
    type: "student",
    id: signedInUser.uid,
    name: signedInUser.displayName || signedInUser.email,
    email: signedInUser.email,
    studentNumber: getStudentNumberFromEmail(signedInUser.email),
    studentType: null
  };

  var sessionUser = user;

  return db.collection("students").doc(sessionUser.id).get()
    .then(function (doc) {
      if (doc.exists && doc.data().studentType) {
        sessionUser.studentType = doc.data().studentType;
      }
    })
    .catch(function (error) {
      console.error("Could not load student profile: " + error.message);
    })
    .then(function () {
      if (user !== sessionUser) return;

      updateDashboard();
      goTo("pageDashboard");

      if (!sessionUser.studentType) {
        promptStudentType(true);
      }
    });
}

// Brings a signed-in student or guest back after a page refresh.
function restoreStudentSession(firebaseUser) {
  if (startingSession || user) return;
  if (!firebaseUser || isPasswordUser(firebaseUser)) return;

  if (firebaseUser.isAnonymous) {
    var profile = loadGuestProfile(firebaseUser.uid);
    if (!profile) {
      firebase.auth().signOut();
      return;
    }

    user = { type: "guest", id: firebaseUser.uid, name: profile.name, email: profile.email, purpose: "" };
    updateDashboard();
    goTo("pageDashboard");
    return;
  }

  var isMicrosoft = firebaseUser.providerData.some(function (info) {
    return info.providerId === "microsoft.com";
  });
  if (isMicrosoft) enterStudentSession(firebaseUser);
}

function studentLogout() {
  var ticket = user ? myTicket() : null;
  var isGuest = !!user && user.type === "guest";

  var finish = function () {
    forgetThisDevice(user && user.id).then(function () {
      return firebase.auth().signOut();
    }).then(function () {
      user = null;
      clearGuestProfile();
      updateDashboard();
      goTo("pageHome");
    }).catch(function (error) {
      say("Could not log out: " + error.message);
    });
  };

  if (!isGuest || !ticket) {
    finish();
    return;
  }

  Swal.fire({
    icon: "warning",
    title: "Log out?",
    text: "Guest tickets can't be recovered once you log out, so your queue ticket will be cancelled.",
    showCancelButton: true,
    confirmButtonText: "Log out",
    confirmButtonColor: "#1D2E5B"
  }).then(function (result) {
    if (!result.isConfirmed) return;

    var cancelWrite = ticket.status === "serving" ?
      Promise.resolve() :
      db.collection("tickets").doc(ticket.id).update({
        status: "cancelled",
        cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
      });

    cancelWrite.then(finish).catch(function (error) {
      say("Could not log out: " + error.message);
    });
  });
}

function login() {
  var provider = new firebase.auth.OAuthProvider("microsoft.com");
  provider.setCustomParameters({
    prompt: "select_account",
    tenant: "3663e35d-c7bc-4b90-90e0-a67a1d53bb77"
  });

  startingSession = true;

  // Someone else may have been using this browser. Their device registration goes first; it is not awaited,
  // because the sign-in popup has to open straight from the click.
  var previous = firebase.auth().currentUser;
  if (previous && !isPasswordUser(previous)) forgetThisDevice(previous.uid);

  firebase.auth().signInWithPopup(provider)
    .then(function (result) {
      return enterStudentSession(result.user);
    })
    .catch(function (error) {
      say("Microsoft sign-in failed: " + error.message);
      refreshNotificationToggle();
    })
    .then(function () {
      startingSession = false;
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
  startingSession = true;

  var previousUser = firebase.auth().currentUser;

  forgetThisDevice(previousUser && !isPasswordUser(previousUser) ? previousUser.uid : null)
    .then(function () {
      return firebase.auth().signOut();
    })
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

      saveGuestProfile({ uid: user.id, name: name, email: email });
      pendingJoinPurpose = purpose;
      updateDashboard();
      goTo("pageDashboard");
    })
    .catch(function (error) {
      say(guestSignInErrorMessage(error.code));
    })
    .then(function () {
      startingSession = false;
      button.disabled = false;
    });
}
