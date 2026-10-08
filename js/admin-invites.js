// Settings > Invite Staff: an admin invites an email address to a role. Firebase emails the person a sign-in
// link; accepting it (see invite.js) is what grants the role. Invites expire and can be resent or revoked.
var INVITE_VALID_DAYS = 7;

var staffInvites = [];
var invitesUnsubscribe = null;
var inviteDraft = { email: "", role: "" };
var invitesBusy = false;

function startInvitesListener() {
  if (invitesUnsubscribe) return;

  invitesUnsubscribe = db.collection("invites").onSnapshot(function (snapshot) {
    staffInvites = snapshot.docs.map(function (doc) {
      return Object.assign({ id: doc.id }, doc.data());
    });
    refreshSettings();
  }, function (error) {
    console.error("Could not load invites: " + error.message);
  });
}

function stopInvitesListener() {
  if (invitesUnsubscribe) {
    invitesUnsubscribe();
    invitesUnsubscribe = null;
  }
  staffInvites = [];
}

function inviteExpiresMs(invite) {
  return invite.expiresAt && typeof invite.expiresAt.toMillis === "function" ? invite.expiresAt.toMillis() : 0;
}

function inviteState(invite) {
  if (invite.status === "accepted") return "accepted";
  return inviteExpiresMs(invite) <= Date.now() ? "expired" : "pending";
}

function inviteRoleName(roleId) {
  var role = getAllRoles().find(function (r) { return r.id === roleId; });
  return role ? role.name : roleId;
}

function formatInviteDate(ms) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function onInviteInput(field, value) {
  inviteDraft[field] = value;
}

// Roles that can be invited to: everything except Standby (that is simply "no role yet").
function invitableRoles() {
  return getAllRoles().filter(function (role) { return role.id !== STANDBY_ROLE.id; });
}

function inviteSectionHtml() {
  var roleOptions = '<option value="">Select Role</option>' + invitableRoles().map(function (role) {
    return '<option value="' + escapeAdminText(role.id) + '"' + (role.id === inviteDraft.role ? ' selected' : '') + '>' + escapeAdminText(role.name) + '</option>';
  }).join("");

  var rows = staffInvites.slice().sort(function (a, b) {
    return timestampToMs(b.createdAt, Date.now()) - timestampToMs(a.createdAt, Date.now());
  }).map(function (invite) {
    var state = inviteState(invite);
    var id = escapeAdminText(invite.id);
    var badge = state === "accepted" ? '<span class="status-badge compact completed">Accepted</span>' :
      state === "expired" ? '<span class="status-badge compact void">Expired</span>' :
      '<span class="status-badge compact waiting">Pending</span>';

    var actions = state === "accepted" ?
      '<button type="button" class="settings-btn settings-btn-blue" onclick="confirmRevokeInvite(\'' + id + '\')">Clear</button>' :
      '<button type="button" class="settings-btn settings-btn-blue" onclick="confirmResendInvite(\'' + id + '\')">Resend</button>' +
      '<button type="button" class="settings-btn settings-btn-red" onclick="confirmRevokeInvite(\'' + id + '\')">Revoke</button>';

    return '<tr><td class="settings-strong">' + escapeAdminText(invite.email) + '</td>' +
      '<td>' + escapeAdminText(inviteRoleName(invite.role)) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + (state === "accepted" ? '-' : escapeAdminText(formatInviteDate(inviteExpiresMs(invite)))) + '</td>' +
      '<td><div class="settings-actions">' + actions + '</div></td></tr>';
  }).join("");

  var listHtml = rows ?
    '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' : '';

  return '<section class="panel settings-panel invite-panel">' +
    '<div class="panel-header"><h2>Invite Staff</h2></div>' +
    '<p class="settings-help">Enter their email and choose a role. They receive an email with a link; once they accept, they get that role and can sign in. Invitations expire after ' + INVITE_VALID_DAYS + ' days.</p>' +
    '<div class="invite-form">' +
      '<input type="email" id="inviteEmail" class="invite-input" placeholder="email" maxlength="254" autocomplete="off" value="' + escapeAdminText(inviteDraft.email) + '" oninput="onInviteInput(\'email\', this.value)">' +
      '<select id="inviteRole" class="invite-select" aria-label="Role" onchange="onInviteInput(\'role\', this.value)">' + roleOptions + '</select>' +
      '<button type="button" class="settings-btn settings-btn-primary invite-btn" id="inviteSubmit" onclick="confirmInviteStaff()">Invite</button>' +
    '</div>' +
    listHtml +
  '</section>';
}

function inviteProblem(email, role) {
  var emailProblem = guestEmailProblem(email);
  if (emailProblem) return emailProblem.replace("Enter", "Please enter");
  if (!role) return "Please select a role.";
  if (!invitableRoles().some(function (r) { return r.id === role; })) return "That role no longer exists.";

  var key = staffKey(email);
  if (adminUser && key === staffKey(adminUser.email)) return "You can't invite yourself.";

  var existing = staffAccounts.find(function (account) { return account.id === key; });
  if (existing && existing.role === role) return "That person already has this role.";
  if (existing && existing.role === "admin") return "That person is already an administrator. Change their role from the Roles list instead.";
  if (key === ADMIN_EMAIL) return "That account is the protected administrator.";

  return "";
}

function confirmInviteStaff() {
  var email = inviteDraft.email.trim();
  var role = inviteDraft.role;
  var problem = inviteProblem(email, role);

  if (problem) {
    say(problem);
    return;
  }

  var key = staffKey(email);
  var earlier = staffInvites.some(function (invite) { return invite.id === key && inviteState(invite) === "pending"; });

  showConfirmModal({
    title: "Send Invitation?",
    message: "An email with a sign-in link goes to " + key + ". When they accept, they become " + inviteRoleName(role) + "." +
      (earlier ? " This replaces their earlier invitation." : ""),
    confirmLabel: "Invite",
    tone: "primary",
    onConfirm: function () {
      sendInvite(key, role).then(function (sent) {
        if (!sent) return;
        inviteDraft = { email: "", role: "" };
        renderSettings();
        say("Invitation sent to " + key + ".");
      });
    }
  });
}

function sendInvite(email, role) {
  if (invitesBusy) return Promise.resolve(false);
  invitesBusy = true;

  var ref = db.collection("invites").doc(email);

  return ref.set({
    email: email,
    role: role,
    invitedBy: staffKey(adminUser.email),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000),
    status: "pending"
  }).then(function () {
    return firebase.auth().sendSignInLinkToEmail(email, {
      url: window.location.origin + "/",
      handleCodeInApp: true
    });
  }).then(function () {
    return true;
  }).catch(function (error) {
    // No email went out, so the invite must not stay behind as if it had.
    ref.delete().catch(function () {});
    say("Could not send the invitation: " + inviteSendErrorMessage(error));
    return false;
  }).then(function (result) {
    invitesBusy = false;
    return result;
  });
}

function inviteSendErrorMessage(error) {
  switch (error && error.code) {
    case "auth/operation-not-allowed":
      return "Email link sign-in isn't turned on in Firebase yet (Authentication > Sign-in method > Email/Password > Email link).";
    case "auth/unauthorized-continue-uri":
      return "This website address isn't in Firebase's authorized domains yet.";
    case "auth/invalid-email":
      return "That email address isn't valid.";
    case "auth/too-many-requests":
      return "Too many emails were sent. Please try again later.";
    case "auth/quota-exceeded":
      return "The daily limit for sign-in emails was reached. Please try again tomorrow.";
    case "permission-denied":
      return "You don't have permission to send invitations.";
    default:
      return (error && error.message) || "Please try again.";
  }
}

function confirmResendInvite(email) {
  var invite = staffInvites.find(function (item) { return item.id === email; });
  if (!invite) return;

  showConfirmModal({
    title: "Resend Invitation?",
    message: "A new email with a sign-in link goes to " + email + ", and the invitation is valid for another " + INVITE_VALID_DAYS + " days.",
    confirmLabel: "Resend",
    tone: "primary",
    onConfirm: function () {
      sendInvite(email, invite.role).then(function (sent) {
        if (sent) say("Invitation resent to " + email + ".");
      });
    }
  });
}

function confirmRevokeInvite(email) {
  var invite = staffInvites.find(function (item) { return item.id === email; });
  if (!invite) return;

  var accepted = inviteState(invite) === "accepted";

  showConfirmModal({
    title: accepted ? "Clear this record?" : "Revoke Invitation?",
    message: accepted ?
      "This only removes the entry from the list. " + email + " keeps the role they accepted." :
      email + " will no longer be able to accept this invitation.",
    confirmLabel: accepted ? "Clear" : "Revoke",
    tone: "danger",
    onConfirm: function () {
      db.collection("invites").doc(email).delete().catch(function (error) {
        say("Could not remove the invitation: " + error.message);
      });
    }
  });
}
