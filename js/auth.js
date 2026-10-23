function getStudentNumberFromEmail(email) {
  var localPart = (email || "").split("@")[0];
  var digits = localPart.replace(/\D/g, "");
  return digits ? "02000" + digits : "";
}

// A walk-in's phone (js/walkin.js) remembers whose ticket it holds, so a refresh brings it back.
var WALKIN_PROFILE_KEY = "qficient.walkinProfile";
var startingSession = false;
var endingStudentSession = false; // this tab is logging the student out itself

function saveWalkinProfile(profile) {
  try {
    localStorage.setItem(WALKIN_PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {}
}

function loadWalkinProfile(uid) {
  try {
    var profile = JSON.parse(localStorage.getItem(WALKIN_PROFILE_KEY));
    return profile && profile.uid === uid ? profile : null;
  } catch (e) {
    return null;
  }
}

function clearWalkinProfile() {
  try {
    localStorage.removeItem(WALKIN_PROFILE_KEY);
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

// The browser keeps one QFicient login for all its tabs. If a staff member signs in (or someone signs out) in
// another tab, this tab's student screen would keep sending requests as that other account, so it is closed
// with an explanation instead. Returns true when the student session was ended.
function endReplacedStudentSession(firebaseUser) {
  if (!user || startingSession || endingStudentSession) return false;
  if (firebaseUser && firebaseUser.uid === user.id) return false;

  var onStudentScreen = document.body.getAttribute("data-page") === "pageDashboard";
  var nowStaff = !!firebaseUser && isPasswordUser(firebaseUser);

  user = null;
  clearWalkinProfile();
  updateDashboard();

  if (onStudentScreen && (nowStaff || !firebaseUser)) {
    goTo("pageHome");
    sayProblem("You've been signed out",
      nowStaff ?
        "This browser is now signed in with a staff account (in another tab or window). To get a ticket, sign in again with your student account, or use a separate browser for staff." :
        "You were signed out in another tab or window. Sign in again to get a ticket.",
      "warning");
  }
  return true;
}

// Brings a signed-in student or walk-in back after a page refresh.
function restoreStudentSession(firebaseUser) {
  if (startingSession || user) return;
  if (!firebaseUser || isPasswordUser(firebaseUser)) return;

  if (firebaseUser.isAnonymous) {
    var profile = loadWalkinProfile(firebaseUser.uid);
    if (!profile) {
      firebase.auth().signOut();
      return;
    }

    // The visit ends on its own once their ticket is over (js/walkin.js).
    startWalkinSession(firebaseUser.uid, profile);
    return;
  }

  var isMicrosoft = firebaseUser.providerData.some(function (info) {
    return info.providerId === "microsoft.com";
  });
  if (isMicrosoft) enterStudentSession(firebaseUser);
}

function studentLogout() {
  var ticket = user ? myTicket() : null;
  var isWalkin = !!user && user.type === "walkin";

  var finish = function () {
    endingStudentSession = true;
    forgetThisDevice(user && user.id).then(function () {
      return firebase.auth().signOut();
    }).then(function () {
      user = null;
      clearWalkinProfile();
      updateDashboard();
      goTo("pageHome");
    }).catch(function (error) {
      say("Could not log out: " + error.message);
    }).then(function () {
      endingStudentSession = false;
    });
  };

  if (!isWalkin || !ticket) {
    finish();
    return;
  }

  if (ticket.status === "serving") {
    say("You're being served right now. Please finish at the counter first.");
    return;
  }

  Swal.fire({
    icon: "warning",
    title: "End your visit?",
    text: "Your ticket will be cancelled and this phone will no longer follow it. To get back in line you'll need a new QR code from the Queue Enforcer.",
    showCancelButton: true,
    confirmButtonText: "End visit",
    confirmButtonColor: "#1D2E5B"
  }).then(function (result) {
    if (!result.isConfirmed) return;

    db.collection("tickets").doc(ticket.id).update({
      status: "cancelled",
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(finish).catch(function (error) {
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


// Used by Settings when adding staff.
var EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

