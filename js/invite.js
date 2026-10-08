// The invitee's side. They arrive from the emailed link, confirm their email address (signing in with the
// link verifies it), then accept the invitation and choose a password. Accepting grants the role.
var inviteState_ = { email: "", invite: null, busy: false };

function inviteBody() {
  return document.getElementById("inviteBody");
}

function setInviteBusy(busy) {
  inviteState_.busy = busy;
  var button = document.getElementById("inviteAction");
  if (button) button.disabled = busy;
}

function setInviteError(text) {
  var el = document.getElementById("inviteError");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function renderInviteMessage(title, message, showLogin) {
  inviteState_.busy = false;
  inviteBody().innerHTML =
    '<h1 class="admin-login-title">' + escapeAdminText(title) + '</h1>' +
    '<p class="admin-login-sub">' + escapeAdminText(message) + '</p>' +
    (showLogin ? '<button type="button" class="admin-login-submit" onclick="leaveInviteFlow()">Go to Sign In</button>' : '');
}

function leaveInviteFlow() {
  inviteFlowActive = false;
  goTo("pageAdminLogin");
}

function renderInviteEmailStep() {
  inviteBody().innerHTML =
    '<h1 class="admin-login-title">Accept Invitation</h1>' +
    '<p class="admin-login-sub">Confirm the email address this invitation was sent to.</p>' +
    '<form id="inviteEmailForm" onsubmit="submitInviteEmail(event)" novalidate>' +
      '<label for="inviteConfirmEmail">Email</label>' +
      '<input type="email" id="inviteConfirmEmail" autocomplete="username" placeholder="you@example.com">' +
      '<p class="admin-login-error" id="inviteError" role="alert" style="display: none"></p>' +
      '<button type="submit" class="admin-login-submit" id="inviteAction">Continue</button>' +
    '</form>' +
    '<span class="admin-login-back" id="inviteNewLink" style="display: none" onclick="requestNewInviteLink()">Send me a new link</span>';
}

function inviteSignInErrorMessage(error) {
  switch (error && error.code) {
    case "auth/invalid-action-code":
    case "auth/expired-action-code":
      return "This link has expired or was already used. Send yourself a new link below, or ask an administrator to invite you again.";
    case "auth/invalid-email":
      return "That email doesn't match the invitation. Use the address the invitation was sent to.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return "Could not verify the link. Please try again or ask for a new invitation.";
  }
}

function submitInviteEmail(event) {
  event.preventDefault();

  var email = staffKey(document.getElementById("inviteConfirmEmail").value);
  if (!email) {
    setInviteError("Enter your email address.");
    return;
  }

  setInviteError("");
  setInviteBusy(true);

  firebase.auth().signInWithEmailLink(email, window.location.href).then(function (credential) {
    // The one-time code in the address bar is used up; take it out of the URL.
    window.history.replaceState({}, document.title, window.location.pathname);
    inviteState_.email = staffKey(credential.user.email);
    return loadInviteDetails(credential.user);
  }).catch(function (error) {
    setInviteError(inviteSignInErrorMessage(error));
    setInviteBusy(false);

    // An old or used link: let them ask for a fresh one without going back to the administrator.
    var dead = error && (error.code === "auth/invalid-action-code" || error.code === "auth/expired-action-code");
    document.getElementById("inviteNewLink").style.display = dead ? "" : "none";
  });
}

// Emails a fresh sign-in link to the address typed above. The invitation itself is checked after they use it,
// so nothing here reveals whether an invitation exists.
function requestNewInviteLink() {
  var email = staffKey(document.getElementById("inviteConfirmEmail").value);
  if (!email) {
    setInviteError("Enter your email address first.");
    return;
  }

  setInviteError("");
  firebase.auth().sendSignInLinkToEmail(email, {
    url: window.location.origin + "/",
    handleCodeInApp: true
  }).then(function () {
    renderInviteMessage("Check your email", "If there is an invitation for " + email + ", a new link is on its way. Open it on this device to accept.");
  }).catch(function (error) {
    setInviteError(error && error.code === "auth/invalid-email" ? "That email address isn't valid." : "Could not send a new link. Please try again in a moment.");
  });
}

// Looks up the invitation and the person's current staff record, then shows the matching step.
function loadInviteDetails(user) {
  var email = inviteState_.email;

  return Promise.all([
    db.collection("invites").doc(email).get(),
    db.collection("staff").doc(email).get()
  ]).then(function (docs) {
    var invite = docs[0];
    var staff = docs[1];

    if (!invite.exists) {
      return finishInviteMessage("No invitation found", "There is no invitation for " + email + ". It may have been revoked. Ask an administrator to invite you again.");
    }

    var data = invite.data();
    inviteState_.invite = data;

    if (data.status === "accepted") {
      return finishInviteMessage("Already accepted", "This invitation was already accepted. Sign in from the admin sign-in page.", true);
    }
    if (!data.expiresAt || data.expiresAt.toMillis() <= Date.now()) {
      return finishInviteMessage("Invitation expired", "This invitation has expired. Ask an administrator to send a new one.");
    }
    if (staff.exists && staff.data().role === "admin") {
      return finishInviteMessage("Already an administrator", "This account already has full administrator access, so the invitation can't change it.", true);
    }

    renderInviteAcceptStep(data);
    return null;
  }).catch(function (error) {
    return finishInviteMessage("Something went wrong", "Could not load your invitation: " + error.message);
  });
}

// Used for dead ends: the person is signed out again so the link cannot leave a session behind.
function finishInviteMessage(title, message, showLogin) {
  renderInviteMessage(title, message, !!showLogin);
  return firebase.auth().signOut().catch(function () {});
}

function renderInviteAcceptStep(invite) {
  inviteState_.busy = false;
  var roleName = typeof inviteRoleName === "function" ? inviteRoleName(invite.role) : invite.role;

  inviteBody().innerHTML =
    '<h1 class="admin-login-title">You\'re invited</h1>' +
    '<p class="admin-login-sub">' + escapeAdminText(invite.invitedBy) + ' invited you to join QFicient as <strong>' + escapeAdminText(roleName) + '</strong>. ' +
      'Choose a password to accept. You\'ll use it to sign in from now on.</p>' +
    '<form id="inviteAcceptForm" onsubmit="acceptInvitation(event)" novalidate>' +
      '<label for="inviteEmailShown">Email</label>' +
      '<input type="email" id="inviteEmailShown" value="' + escapeAdminText(inviteState_.email) + '" readonly>' +
      '<label for="invitePassword">New password</label>' +
      '<input type="password" id="invitePassword" autocomplete="new-password" placeholder="At least 8 characters">' +
      '<label for="invitePasswordConfirm">Confirm password</label>' +
      '<input type="password" id="invitePasswordConfirm" autocomplete="new-password" placeholder="Type it again">' +
      '<p class="admin-login-error" id="inviteError" role="alert" style="display: none"></p>' +
      '<button type="submit" class="admin-login-submit" id="inviteAction">Accept Invitation</button>' +
    '</form>';
}

function acceptInvitation(event) {
  event.preventDefault();
  if (inviteState_.busy) return;

  var password = document.getElementById("invitePassword").value;
  var confirmation = document.getElementById("invitePasswordConfirm").value;

  if (password.length < 8) {
    setInviteError("Your password must be at least 8 characters.");
    return;
  }
  if (password !== confirmation) {
    setInviteError("The two passwords don't match.");
    return;
  }

  setInviteError("");
  setInviteBusy(true);

  var user = firebase.auth().currentUser;
  var email = inviteState_.email;
  var role = inviteState_.invite.role;
  var staffRef = db.collection("staff").doc(email);
  var inviteRef = db.collection("invites").doc(email);
  var now = firebase.firestore.FieldValue.serverTimestamp();

  // The password first, so the account is usable even if the next step needs a retry.
  user.updatePassword(password).then(function () {
    return db.runTransaction(function (transaction) {
      return transaction.get(staffRef).then(function (doc) {
        if (doc.exists) {
          transaction.update(staffRef, { role: role, updatedAt: now });
        } else {
          transaction.set(staffRef, { email: email, role: role, createdAt: now, updatedAt: now });
        }
        transaction.update(inviteRef, { status: "accepted", acceptedAt: now });
      });
    });
  }).then(function () {
    inviteFlowActive = false;
    return activateAdminSession(user);
  }).then(function (allowed) {
    if (allowed) {
      goTo("pageAdmin");
      return null;
    }

    // The role was granted but it has no admin console access yet (for example a station role).
    renderInviteMessage("Invitation accepted", "You're now " + inviteRoleName(role) + ". That role doesn't have access to the admin console yet. Ask an administrator when it does.");
    return firebase.auth().signOut();
  }).catch(function (error) {
    setInviteError(acceptErrorMessage(error));
    setInviteBusy(false);
  });
}

function acceptErrorMessage(error) {
  switch (error && error.code) {
    case "auth/weak-password":
      return "That password is too weak. Use at least 8 characters.";
    case "auth/requires-recent-login":
      return "For security, please open the invitation link again.";
    case "permission-denied":
      return "This invitation can no longer be accepted. It may have expired or been revoked.";
    default:
      return (error && error.message) || "Please try again.";
  }
}

// Called once at start-up: arriving from an invitation email opens the accept page.
function initInviteFlow() {
  if (!inviteFlowActive) return;

  goTo("pageInvite");
  renderInviteEmailStep();
}

initInviteFlow();
