// Staff choosing their own password. Every new account starts on DEFAULT_STAFF_PASSWORD (js/admin-settings.js), and
// a password an admin resets is temporary too: both mark the staff record mustChangePassword. Right after signing in
// with one, the console asks for a new password (with a Later button; it asks again at the next sign-in). Anyone
// can also change theirs any time with the key button in the header.
//
// The change itself is Firebase Authentication's (re-authenticate with the current password, then updatePassword);
// afterwards the person's own staff record is marked { mustChangePassword: false, passwordChangedAt }, which is all
// firestore.rules lets them change on it, and which the audit trail logs as "changed their own password".

var passwordFormState = null; // { firstTime, current } while the form is open; `current` only for the first-time form

function openChangePasswordModal(options) {
  if (!adminUser) return;
  var firstTime = !!(options && options.firstTime);
  passwordFormState = { firstTime: firstTime, current: firstTime && options.current ? String(options.current) : "" };

  var currentField = passwordFormState.current ? "" :
    '<div class="modal-field"><label for="ownPwCurrent">Current Password</label>' +
      '<input type="password" id="ownPwCurrent" class="modal-input" autocomplete="current-password"></div>';

  showFormModal(firstTime ? "Set a New Password" : "Change Password",
    '<div class="modal-section">' +
      (firstTime ?
        '<p class="modal-help own-pw-note">You\'re using a temporary password. Choose your own so only you can sign in to this account.</p>' : '') +
      currentField +
      '<div class="modal-field"><label for="ownPwNew">New Password</label>' +
        '<input type="password" id="ownPwNew" class="modal-input" placeholder="At least ' + STAFF_PASSWORD_MIN + ' characters" autocomplete="new-password"></div>' +
      '<div class="modal-field"><label for="ownPwConfirm">Confirm New Password</label>' +
        '<input type="password" id="ownPwConfirm" class="modal-input" placeholder="Repeat the new password" autocomplete="new-password"></div>' +
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
    sayDone("Password changed. Use your new password the next time you sign in.");
  }).catch(function (error) {
    console.error("Change password failed:", error);
    say("Could not change your password: " + ownPasswordMessage(error));
  }).then(function () {
    setStaffFormBusy(false);
  });
}
