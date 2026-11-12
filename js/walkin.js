// The walk-in's phone. The Queue Enforcer shows a one-time QR code (js/admin-enforcer.js) that opens
// #/pass/<passId>.<secret> here. This phone signs in anonymously and asks the redeemWalkinPass Cloud Function for
// the ticket, which then belongs to this phone: the walk-in follows it in the app and gets the same alerts as a
// student. The access is temporary: it ends when the ticket is over (completed, removed, cancelled) or the day ends.

var WALKIN_TOKEN_PATTERN = /^([A-Za-z0-9]{10,40})\.([A-Za-z0-9_-]{16,64})$/;
var WALKIN_LOAD_GRACE_MS = 15 * 1000; // how long a fresh session waits for its ticket to arrive before giving up
var walkinSince = 0;
var walkinEnding = false;
var redeemingWalkinPass = false;

// True from the moment a QR link opens until its ticket has arrived (or failed). While it is set, a walk-in
// sign-in left on this phone from an earlier visit is not resumed (js/auth.js): that old visit would see its
// ticket already finished, end itself and sign the phone out, taking the new ticket with it.
function openingWalkinLink() {
  return redeemingWalkinPass || /^#\/pass\//.test(window.location.hash);
}

// Is the walk-in visit this phone is signed in for still going (its ticket waiting, being served or on hold)?
// Reads the ticket directly, because the ticket list may not have arrived yet. If it can't be read, the visit
// is treated as still going, so a live ticket is never dropped by mistake.
function walkinVisitStillLive(uid) {
  var profile = loadWalkinProfile(uid);
  if (!profile || !profile.ticketId) return Promise.resolve(false);

  return db.collection("tickets").doc(profile.ticketId).get().then(function (doc) {
    if (!doc.exists) return false;
    var ticket = doc.data();
    return ticket.ownerId === uid && ACTIVE_TICKET_STATUSES.indexOf(ticket.status) !== -1 && isTodayTicket(ticket);
  }, function () {
    return true;
  });
}

// A new QR code for a phone still signed in from an earlier, finished visit: that sign-in is closed and a fresh
// one made, so the new visit has nothing to do with the old one (its ticket, notifications or alerts).
function freshWalkinSignIn(current) {
  if (!current) return firebase.auth().signInAnonymously().then(function (result) { return result.user; });

  return walkinVisitStillLive(current.uid).then(function (live) {
    // Still in line: keep it. The server hands back the same ticket for the same QR code, or explains that this
    // phone already has one.
    if (live) return current;

    if (user && user.id === current.uid) {
      user = null;           // the old visit, if it was resumed, stops here (it doesn't end itself)
      walkinEnding = true;
    }
    clearWalkinProfile();
    return forgetThisDevice(current.uid)
      .then(function () { return firebase.auth().signOut(); })
      .then(function () { return firebase.auth().signInAnonymously(); })
      .then(function (result) { return result.user; });
  });
}

function startWalkinSession(uid, profile) {
  user = { type: "walkin", id: uid, name: profile.name || "Walk-in", ticketId: profile.ticketId || "", studentNumber: "" };
  walkinSince = Date.now();
  walkinEnding = false;
  updateDashboard();
  goTo("pageDashboard");
  viewMyTicket();
  // If the ticket never shows up (an old link, yesterday's ticket), look again once the grace period is over.
  setTimeout(updateDashboard, WALKIN_LOAD_GRACE_MS + 500);
}

function walkinLinkProblem(title, text) {
  goTo(user ? "pageDashboard" : "pageHome");
  sayProblem(title, text, "warning");
}

// Called by the router for #/pass/<token>.
function redeemWalkinLink(token) {
  // The secret must not stay in the address bar or the history.
  replaceHash("#/");

  var match = WALKIN_TOKEN_PATTERN.exec(String(token || ""));
  if (!match) {
    walkinLinkProblem("This QR code isn't valid", "Ask the Queue Enforcer for a new one.");
    return;
  }
  if (redeemingWalkinPass) return;
  redeemingWalkinPass = true;

  // Wait for the saved sign-in (if any) to come back before deciding anything.
  var stopWaiting = firebase.auth().onAuthStateChanged(function (current) {
    stopWaiting();

    if (current && !current.isAnonymous) {
      redeemingWalkinPass = false;
      walkinLinkProblem("This phone is signed in with another account",
        "Log out of QFicient first (or open the link in another browser), then scan the QR code again.");
      return;
    }

    startingSession = true;
    if (typeof Swal !== "undefined") {
      Swal.fire({ title: "Getting your ticket…", allowOutsideClick: false, allowEscapeKey: false, didOpen: function () { Swal.showLoading(); } });
    }

    freshWalkinSignIn(current).then(function (walkinUser) {
      return firebase.app().functions(JOIN_FUNCTION_REGION).httpsCallable("redeemWalkinPass")({
        passId: match[1],
        secret: match[2]
      }).then(function (response) {
        var result = response.data || {};
        var profile = { uid: walkinUser.uid, ticketId: result.ticketId, name: result.ownerName || "" };
        saveWalkinProfile(profile);
        startWalkinSession(walkinUser.uid, profile);
        if (typeof Swal !== "undefined") Swal.close();
        Promise.resolve(sayDone("Your ticket is " + result.ticketNo + " at " + result.stationName + ". Keep this page open to follow your place in line."))
          .then(offerBackgroundAlerts);
      });
    }).catch(function (err) {
      if (typeof Swal !== "undefined") Swal.close();
      var message = String(err && err.message || "").replace(/\s*\[\d{3}\]\s*$/, "");
      var code = String(err && err.code || "").replace("functions/", "");
      var known = ["failed-precondition", "resource-exhausted", "invalid-argument", "not-found", "permission-denied", "deadline-exceeded"];

      // A fresh anonymous sign-in that got no ticket is of no use to anyone. One that still has its own ticket
      // (this phone was already in line) goes back to following it.
      var signedIn = firebase.auth().currentUser;
      var profile = signedIn && signedIn.isAnonymous ? loadWalkinProfile(signedIn.uid) : null;
      if (signedIn && signedIn.isAnonymous && !profile) firebase.auth().signOut();
      else if (profile && !user) startWalkinSession(signedIn.uid, profile);

      walkinLinkProblem("Couldn't get your ticket",
        known.indexOf(code) !== -1 && message ? message : "Something went wrong. Please try again, or ask the Queue Enforcer for a new QR code.");
    }).then(function () {
      startingSession = false;
      redeemingWalkinPass = false;
    });
  });
}

// Called while a walk-in has no live ticket. Once their ticket is over (or never arrives), the visit ends:
// they are told how it ended and this phone signs out.
function endWalkinVisitIfOver() {
  if (!user || user.type !== "walkin" || walkinEnding || !ticketsLoaded || myTicket()) return;
  if (redeemingWalkinPass) return; // a new QR code is being opened; it decides what happens to this visit

  var last = tickets.find(function (t) { return t.id === user.ticketId; });
  if (!last && Date.now() - walkinSince < WALKIN_LOAD_GRACE_MS) return;
  walkinEnding = true;

  var text = !last ? "This ticket is no longer active." :
    last.status === "completed" ? (last.enrollment === true ? "Your enrollment is complete." : "Your transaction for ticket " + last.ticketNo + " is complete.") :
    last.status === "void" ? (last.closedVoid ? "The windows closed for today, so ticket " + last.ticketNo + " was voided." : last.autoVoided ? "Ticket " + last.ticketNo + " expired because the last call ran out." : "Ticket " + last.ticketNo + " was removed by the staff.") :
    last.status === "cancelled" ? "Ticket " + last.ticketNo + " was cancelled." : "This ticket is no longer active.";
  if (last) markEndNoticeSeen(last.id);

  var leaving = user;
  var finish = function () {
    // A new QR code scanned meanwhile has taken over this phone; it closes the old sign-in itself.
    if (user !== leaving) return;
    forgetThisDevice(leaving.id).then(function () {
      return firebase.auth().signOut();
    }).catch(function () {}).then(function () {
      if (user !== leaving) return;
      user = null;
      clearWalkinProfile();
      updateDashboard();
      goTo("pageHome");
    });
  };

  if (typeof Swal === "undefined") {
    say("Your visit is done. " + text);
    finish();
    return;
  }

  Swal.fire({
    icon: last && last.status === "completed" ? "success" : "info",
    title: "Your visit is done",
    text: text + " Thank you for using QFicient! If you need another ticket, ask the Queue Enforcer for a new QR code.",
    confirmButtonText: "Close",
    confirmButtonColor: "#0054A6",
    allowOutsideClick: false,
    timer: 60 * 1000,
    timerProgressBar: true
  }).then(finish);
}
