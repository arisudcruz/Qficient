// Staff choosing their own password. Every new account starts on DEFAULT_STAFF_PASSWORD (js/admin-settings.js), and
// a password an admin resets is temporary too: both mark the staff record mustChangePassword. Right after signing in
// with one, the console asks for a new password (with a Later button; it asks again at the next sign-in). Anyone
// can also change theirs any time from the profile menu (Change Password).
//
// The change itself is Firebase Authentication's (re-authenticate with the current password, then updatePassword);
// afterwards the person's own staff record is marked { mustChangePassword: false, passwordChangedAt }, which is all
// firestore.rules lets them change on it, and which the audit trail logs as "changed their own password". Then they
// are signed out, to sign in again with the new password.

var passwordFormState = null; // { firstTime, current } while the form is open; `current` only for the first-time form

function openChangePasswordModal(options) {
  if (!adminUser) return;
  var firstTime = !!(options && options.firstTime);
  passwordFormState = { firstTime: firstTime, current: firstTime && options.current ? String(options.current) : "" };

  var currentField = passwordFormState.current ? "" :
    '<div class="modal-field"><label for="ownPwCurrent">Current Password</label>' +
      passwordFieldHtml('<input type="password" id="ownPwCurrent" class="modal-input" autocomplete="current-password">') + '</div>';

  showFormModal(firstTime ? "Set a New Password" : "Change Password",
    '<div class="modal-section">' +
      (firstTime ?
        '<p class="modal-help own-pw-note">You\'re using a temporary password. Choose your own so only you can sign in to this account.</p>' : '') +
      currentField +
      '<div class="modal-field"><label for="ownPwNew">New Password</label>' +
        passwordFieldHtml('<input type="password" id="ownPwNew" class="modal-input" placeholder="At least ' + STAFF_PASSWORD_MIN + ' characters" autocomplete="new-password" oninput="updatePasswordMatch()">') + '</div>' +
      '<div class="modal-field"><label for="ownPwConfirm">Confirm New Password</label>' +
        passwordFieldHtml('<input type="password" id="ownPwConfirm" class="modal-input" placeholder="Repeat the new password" autocomplete="new-password" oninput="updatePasswordMatch()">') +
        '<p class="pw-match" id="ownPwMatch" aria-live="polite" hidden></p></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="closeChangePasswordModal()">' + (firstTime ? 'Later' : 'Cancel') + '</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" id="ownPwSave" onclick="saveOwnPassword()">Save Password</button>' +
      '</div>' +
    '</div>');

  // Closing it with ✕ or a click outside also forgets the password held for it.
  var overlay = document.getElementById("formModal");
  if (overlay) {
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay || (event.target.closest && event.target.closest(".form-modal-close"))) passwordFormState = null;
    });
  }

  var first = document.getElementById(passwordFormState.current ? "ownPwNew" : "ownPwCurrent");
  if (first) first.focus();
}

// The line under Confirm New Password: green when both boxes match, red when they don't, nothing while it is empty.
function updatePasswordMatch() {
  var line = document.getElementById("ownPwMatch");
  var next = document.getElementById("ownPwNew");
  var confirm = document.getElementById("ownPwConfirm");
  if (!line || !next || !confirm) return;

  if (!confirm.value) {
    line.hidden = true;
    line.className = "pw-match";
    line.textContent = "";
    return;
  }
  var match = confirm.value === next.value;
  line.hidden = false;
  line.className = "pw-match " + (match ? "is-match" : "is-mismatch");
  line.textContent = (match ? "✓ " : "✕ ") + (match ? "Passwords match" : "Passwords do not match");
}

function closeChangePasswordModal() {
  passwordFormState = null;
  closeFormModal();
}

// What is wrong with the new password, or "".
function ownPasswordProblem(current, next, confirm) {
  if (!current) return "Enter your current password.";
  var problem = passwordProblem(next, confirm, "new password");
  if (problem) return problem;
  if (next === current) return "Your new password must be different from your current one.";
  if (next === DEFAULT_STAFF_PASSWORD) return "Choose a password other than the default one (" + DEFAULT_STAFF_PASSWORD + ").";
  return "";
}

function ownPasswordMessage(error) {
  switch (error && error.code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
      return "Your current password is incorrect.";
    case "auth/requires-recent-login":
    case "auth/user-mismatch":
    case "auth/user-token-expired":
      return "Please sign out and sign in again, then change your password.";
    default:
      return staffAuthMessage(error);
  }
}

// After a change, the person signs in again with the new password: signed out once they close the message (or after
// a few seconds if they don't), through adminLogout (js/admin-auth.js), which also records the sign-out.
var PASSWORD_CHANGE_SIGNOUT_MS = 8000;

function signOutAfterPasswordChange() {
  var done = false;
  function signOut() {
    if (done) return;
    done = true;
    if (typeof Swal !== "undefined" && Swal.isVisible()) Swal.close();
    if (adminUser) adminLogout();
  }
  var timer = setTimeout(signOut, PASSWORD_CHANGE_SIGNOUT_MS);
  Promise.resolve(sayDone("Password changed. Please sign in again with your new password.")).then(function () {
    clearTimeout(timer);
    signOut();
  });
}

function saveOwnPassword() {
  var state = passwordFormState;
  var user = firebase.auth().currentUser;
  if (!state || !user || !adminUser || staffFormBusy) return;

  var currentInput = document.getElementById("ownPwCurrent");
  var current = state.current || (currentInput ? currentInput.value : "");
  var next = document.getElementById("ownPwNew").value;
  var confirm = document.getElementById("ownPwConfirm").value;

  var problem = ownPasswordProblem(current, next, confirm);
  if (problem) {
    say(problem);
    return;
  }

  setStaffFormBusy(true);

  var credential = firebase.auth.EmailAuthProvider.credential(user.email, current);
  user.reauthenticateWithCredential(credential).then(function () {
    return user.updatePassword(next);
  }).then(function () {
    adminMustChangePassword = false;
    // The record notes the change (and drops the reminder). The password itself is already changed even if this
    // write fails, so a failure here only means the reminder comes back.
    return db.collection("staff").doc(staffKey(user.email)).update({
      mustChangePassword: false,
      passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function (error) {
      console.error("Could not mark the password as changed: " + error.message);
    });
  }).then(function () {
    passwordFormState = null;
    closeFormModal();
    signOutAfterPasswordChange();
  }).catch(function (error) {
    console.error("Change password failed:", error);
    say("Could not change your password: " + ownPasswordMessage(error));
  }).then(function () {
    setStaffFormBusy(false);
  });
}
