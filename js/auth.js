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
  var signInButton = document.getElementById("lpSignInBtn");
  setButtonLoading(signInButton, true);

  // Someone else may have been using this browser. Their device registration goes first; it is not awaited,
  // because the sign-in popup has to open straight from the click.
  var previous = firebase.auth().currentUser;
  if (previous && !isPasswordUser(previous)) forgetThisDevice(previous.uid);

  firebase.auth().signInWithPopup(provider)
    .then(function (result) {
      return enterStudentSession(result.user);
    })
    .catch(function (error) {
      // Closing the Microsoft window (or clicking twice) just means "not now".
      var cancelled = error && (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request");
      if (!cancelled) say("Microsoft sign-in failed: " + error.message);
      refreshNotificationToggle();
    })
    .then(function () {
      startingSession = false;
      setButtonLoading(signInButton, false);
    });
}


var EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

// Also used by the Queue Enforcer's walk-in form.
function guestEmailProblem(email) {
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return "";
}

