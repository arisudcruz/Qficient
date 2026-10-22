var staffAccounts = [];

var SYSTEM_ROLES = [
  { id: "admin", name: "Admin" },
  { id: "enforcer", name: "Queue Enforcer" }
];
// "standby" is no longer a role, but old records may still carry it, so no station may take that id or name.
var RESERVED_ROLE_IDS = ["admin", "enforcer", "standby"];
var RESERVED_ROLE_NAMES = ["admin", "queue enforcer", "standby"];

// Shown only when an account has no usable role (an old standby record, or a station that was deleted).
var NO_ROLE = { id: "none", name: "No Role" };

var settingsSelectedRole = "admin";
var settingsRoleDrafts = {};
var settingsTimeoutDraft = null;
var settingsSignature = "";

function getSortedStations() {
  return stations.slice().sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });
}

function getAllRoles() {
  var stationRoles = getSortedStations().map(function (s) {
    return { id: s.id, name: s.name };
  });
  return SYSTEM_ROLES.concat(stationRoles);
}

function accountRole(account) {
  var known = getAllRoles().some(function (r) { return r.id === account.role; });
  return known ? account.role : NO_ROLE.id;
}

// The roles listed in the Roles table: the real ones, plus "No Role" while some account has none.
function getListedRoles() {
  var roles = getAllRoles();
  if (staffAccounts.some(function (account) { return accountRole(account) === NO_ROLE.id; })) roles = roles.concat([NO_ROLE]);
  return roles;
}

function computeSettingsSignature() {
  return JSON.stringify([
    stations.map(function (s) { return [s.id, s.name, s.code || "", s.active !== false, s.maxQueue || null]; }),
    staffAccounts.map(function (a) { return [a.id, a.role, a.name || ""]; }),
    systemSettings.autoVoidMinutes
  ]);
}

// Stations made before ticket codes existed get theirs saved the first time an admin opens the console, so the
// code can't shift later when other stations are added or removed.
var stationCodeBackfillKey = null;

function backfillStationCodes() {
  if (typeof adminKind !== "function" || adminKind() !== "admin" || !stations.length) return;

  var missing = stations.filter(function (station) { return !station.code; });
  var key = missing.map(function (station) { return station.id; }).join("|");
  if (!missing.length || key === stationCodeBackfillKey) return;
  stationCodeBackfillKey = key;

  var codes = assignStationCodes(stations);
  var batch = db.batch();
  missing.forEach(function (station) {
    batch.update(db.collection("stations").doc(station.id), { code: codes[station.id] });
  });
  batch.commit().catch(function (error) {
    stationCodeBackfillKey = null;
    console.error("Could not save station ticket codes: " + error.message);
  });
}

function refreshSettings() {
  backfillStationCodes();
  var area = document.getElementById("adminSettingsArea");
  if (!area || area.style.display === "none") return;
  if (computeSettingsSignature() === settingsSignature) return;
  renderSettings();
}

function isTimeoutDirty() {
  return settingsTimeoutDraft !== null && settingsTimeoutDraft.trim() !== String(systemSettings.autoVoidMinutes);
}

function updateConfigButtons() {
  var save = document.getElementById("settingsSaveBtn");
  var cancel = document.getElementById("settingsCancelBtn");
  if (!save || !cancel) return;

  var dirty = isTimeoutDirty();
  save.disabled = !dirty;
  cancel.disabled = !dirty;
  save.className = "settings-btn " + (dirty ? "settings-btn-primary" : "settings-btn-muted");
  cancel.className = "settings-btn " + (dirty ? "settings-btn-slate" : "settings-btn-muted");
}

function onTimeoutInput(value) {
  settingsTimeoutDraft = value;
  updateConfigButtons();
}

function cancelTimeoutEdit() {
  settingsTimeoutDraft = null;
  renderSettings();
}

function confirmSaveConfiguration() {
  var minutes = Number(settingsTimeoutDraft);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    say("Please enter a whole number of minutes between 1 and 1440.");
    return;
  }

  showConfirmModal({
    title: "Save Configuration Changes?",
    message: "The updated system configuration will be applied and take effect across the system.",
    confirmLabel: "Save Changes",
    tone: "danger",
    onConfirm: function () {
      return db.collection("settings").doc("system").set({
        autoVoidMinutes: minutes,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).then(function () {
        settingsTimeoutDraft = null;
        renderSettings();
        sayDone("Configuration saved.");
      }).catch(function (error) {
        say("Could not save configuration: " + error.message);
      });
    }
  });
}

/* Form modals */

function closeFormModal() {
  var overlay = document.getElementById("formModal");
  if (overlay) overlay.remove();
}

function showFormModal(title, bodyHtml) {
  closeFormModal();

  var overlay = document.createElement("div");
  overlay.className = "confirm-modal-backdrop";
  overlay.id = "formModal";
  overlay.innerHTML =
    '<div class="form-modal-card">' +
      '<div class="form-modal-head"><h2 class="form-modal-title">' + escapeAdminText(title) + '</h2>' +
        '<button type="button" class="form-modal-close" aria-label="Close">✕</button></div>' +
      bodyHtml +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector(".form-modal-close").addEventListener("click", closeFormModal);
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeFormModal();
  });
}

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !document.getElementById("confirmModal")) closeFormModal();
});

/* Stations */

function slugifyStationName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stationNameProblem(name, exceptId) {
  var lower = name.toLowerCase();
  if (RESERVED_ROLE_NAMES.indexOf(lower) !== -1) return "That name is reserved.";
  var taken = stations.some(function (s) {
    return s.id !== exceptId && String(s.name).toLowerCase() === lower;
  });
  return taken ? "A station with that name already exists." : "";
}

function openAddStationModal() {
  showFormModal("New Service Station",
    '<div class="modal-field"><label for="newStationName">Station Name</label>' +
      '<input type="text" id="newStationName" class="modal-input" placeholder="e.g. Guidance" maxlength="40"></div>' +
    '<div class="modal-field"><label>Add Purposes</label>' +
      '<div class="purpose-inputs" id="newStationPurposes">' +
        '<input type="text" class="modal-input purpose-input" placeholder="Purpose" maxlength="60">' +
        '<button type="button" class="purpose-add" onclick="addPurposeInput()" aria-label="Add another purpose">+</button>' +
      '</div></div>' +
    '<div class="settings-actions">' +
      '<button type="button" class="settings-btn settings-btn-primary" onclick="confirmCreateStation()">Create Station</button>' +
      '<button type="button" class="settings-btn settings-btn-blue" onclick="clearAddStationForm()">Clear All</button>' +
    '</div>');
}

function addPurposeInput() {
  var container = document.getElementById("newStationPurposes");
  if (container.querySelectorAll(".purpose-input").length >= 8) return;

  var input = document.createElement("input");
  input.type = "text";
  input.className = "modal-input purpose-input";
  input.placeholder = "Purpose";
  input.maxLength = 60;
  container.insertBefore(input, container.querySelector(".purpose-add"));
  input.focus();
}

function clearAddStationForm() {
  document.getElementById("newStationName").value = "";
  var inputs = document.querySelectorAll("#newStationPurposes .purpose-input");
  inputs.forEach(function (input, index) {
    if (index === 0) input.value = "";
    else input.remove();
  });
}

function confirmCreateStation() {
  var name = document.getElementById("newStationName").value.trim();
  if (!name) {
    say("Please enter a station name.");
    return;
  }

  var id = slugifyStationName(name);
  var problem = !id ? "Please use letters or numbers in the station name." : stationNameProblem(name, null);
  if (!problem && (RESERVED_ROLE_IDS.indexOf(id) !== -1 || stations.some(function (s) { return s.id === id; }))) {
    problem = "A station with that name already exists.";
  }
  if (problem) {
    say(problem);
    return;
  }

  var purposes = [];
  document.querySelectorAll("#newStationPurposes .purpose-input").forEach(function (input) {
    var value = input.value.trim();
    if (value && purposes.indexOf(value) === -1) purposes.push(value);
  });

  showConfirmModal({
    title: "Create Station?",
    message: "The station details are ready to be saved. Creating this station will add it to your system.",
    confirmLabel: "Create Station",
    tone: "danger",
    onConfirm: function () {
      var used = {};
      var codes = assignStationCodes(stations);
      Object.keys(codes).forEach(function (key) { used[codes[key].toUpperCase()] = true; });

      return db.collection("stations").doc(id).set({
        name: name,
        code: nextStationCode(name, used),
        count: 0,
        nowServingId: null,
        active: true,
        maxQueue: null,
        purposes: purposes
      }).then(function () {
        closeFormModal();
        sayDone("Station created.");
      }).catch(function (error) {
        say("Could not create station: " + error.message);
      });
    }
  });
}

function openEditStationModal(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var id = escapeAdminText(station.id);

  showFormModal("Edit Station",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Edit Station Name</h3>' +
      '<div class="modal-field"><label>Current Name</label><input type="text" class="modal-input" value="' + escapeAdminText(station.name) + '" readonly></div>' +
      '<div class="modal-field"><label>Ticket Code</label><input type="text" class="modal-input" value="' + escapeAdminText(stationCodeOf(station.id)) + '" readonly></div>' +
      '<p class="modal-help">Tickets from this station are numbered ' + escapeAdminText(formatTicketNo(stationCodeOf(station.id), 1)) + ', ' + escapeAdminText(formatTicketNo(stationCodeOf(station.id), 2)) + '... The code stays the same if the station is renamed.</p>' +
      '<div class="modal-field"><label for="editStationName">New Name</label>' +
        '<input type="text" id="editStationName" class="modal-input" placeholder="New station name" maxlength="40"></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="document.getElementById(\'editStationName\').value = \'\'">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStationName(\'' + id + '\')">Save Changes</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Edit Purpose</h3>' +
      '<p class="modal-help">These are the purposes this station offers right now, to students and in the Queue Enforcer form. Edit, remove or add, then save. "Others, please specify" is always offered at the end.</p>' +
      '<div class="purpose-edit-list" id="editStationPurposes">' + editPurposeRowsHtml(station) + '</div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="addEditPurposeRow()">+ Add Purpose</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" id="savePurposesBtn" onclick="saveStationPurposes(\'' + id + '\')">Save Changes</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Maximum Service Queue</h3>' +
      '<p class="modal-help">Sets the maximum number of successful queue entries that can be processed within a single day. Once the configured limit is reached, the system prevents additional queue entries from being created for that day. Leave blank for no limit.</p>' +
      '<div class="modal-inline">' +
        '<input type="number" id="editStationMax" class="modal-input" min="1" step="1" placeholder="No limit" value="' + (station.maxQueue > 0 ? station.maxQueue : '') + '">' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStationMax(\'' + id + '\')">Save Changes</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Delete Station</h3>' +
      '<p class="modal-help">Deleting this station will permanently remove it from the system and may affect any data, devices, or configurations associated with it. This action cannot be undone.</p>' +
      '<div class="modal-actions-end"><button type="button" class="settings-btn settings-btn-primary" onclick="confirmDeleteStation(\'' + id + '\')">Delete Station</button></div>' +
    '</div>');
}

function saveStationName(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  var name = document.getElementById("editStationName").value.trim();
  if (!station) return;
  if (!name) {
    say("Please enter the new station name.");
    return;
  }
  if (name === station.name) {
    say("That is already the station's name.");
    return;
  }

  var problem = stationNameProblem(name, stationId);
  if (problem) {
    say(problem);
    return;
  }

  db.collection("stations").doc(stationId).update({ name: name }).then(function () {
    closeFormModal();
    sayDone("Station renamed.");
  }).catch(function (error) {
    say("Could not rename station: " + error.message);
  });
}

/* Edit Purpose */

var STATION_PURPOSE_MAX = 12;

function editPurposeRowHtml(value) {
  return '<div class="purpose-edit-row">' +
    '<input type="text" class="modal-input purpose-edit-input" placeholder="Purpose" maxlength="60" value="' + escapeAdminText(value || "") + '">' +
    '<button type="button" class="settings-icon-btn settings-icon-red" title="Remove this purpose" aria-label="Remove this purpose" onclick="removeEditPurposeRow(this)">✕</button>' +
  '</div>';
}

// The purposes a station offers right now: its own list, or the default list when it has none saved.
function currentStationPurposes(station) {
  return Array.isArray(station.purposes) && station.purposes.length ? station.purposes.slice() : queueMgmtPurposes.slice();
}

function editPurposeRowsHtml(station) {
  var purposes = currentStationPurposes(station);
  return purposes.length ? purposes.map(editPurposeRowHtml).join("") : editPurposeRowHtml("");
}

function addEditPurposeRow() {
  var list = document.getElementById("editStationPurposes");
  if (!list) return;
  if (list.querySelectorAll(".purpose-edit-row").length >= STATION_PURPOSE_MAX) {
    say("A station can have up to " + STATION_PURPOSE_MAX + " purposes.");
    return;
  }
  list.insertAdjacentHTML("beforeend", editPurposeRowHtml(""));
  var inputs = list.querySelectorAll(".purpose-edit-input");
  inputs[inputs.length - 1].focus();
}

function removeEditPurposeRow(button) {
  var row = button.closest(".purpose-edit-row");
  var list = document.getElementById("editStationPurposes");
  if (!row || !list) return;
  // Keep one empty box rather than an empty list, so there is always somewhere to type.
  if (list.querySelectorAll(".purpose-edit-row").length === 1) row.querySelector("input").value = "";
  else row.remove();
}

function saveStationPurposes(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var purposes = [];
  var seen = {};
  document.querySelectorAll("#editStationPurposes .purpose-edit-input").forEach(function (input) {
    var value = input.value.trim().replace(/\s+/g, " ");
    var key = value.toLowerCase();
    if (!value || seen[key]) return;
    seen[key] = true;
    purposes.push(value);
  });

  if (!purposes.length) {
    say("Please keep at least one purpose. \"Others, please specify\" is always offered as well.");
    return;
  }
  if (purposes.length > STATION_PURPOSE_MAX) {
    say("A station can have up to " + STATION_PURPOSE_MAX + " purposes.");
    return;
  }

  var before = currentStationPurposes(station);
  if (JSON.stringify(before) === JSON.stringify(purposes)) {
    say("There are no changes to save.");
    return;
  }

  var save = function () {
    var button = document.getElementById("savePurposesBtn");
    setButtonLoading(button, true);
    return db.collection("stations").doc(stationId).update({ purposes: purposes }).then(function () {
      sayDone("Purposes saved.");
    }).catch(function (error) {
      say("Could not save the purposes: " + error.message);
    }).then(function () {
      setButtonLoading(document.getElementById("savePurposesBtn"), false);
    });
  };

  var removed = before.filter(function (purpose) { return purposes.indexOf(purpose) === -1; });
  if (!removed.length) {
    save();
    return;
  }

  showConfirmModal({
    title: "Are you sure you want to remove " + (removed.length === 1 ? "this purpose" : "these purposes") + "?",
    message: removed.join(", ") + " will no longer be offered at " + station.name + ". Tickets that already use " + (removed.length === 1 ? "it" : "them") + " are not changed.",
    confirmLabel: "Save Changes",
    tone: "danger",
    onConfirm: save
  });
}

function saveStationMax(stationId) {
  var raw = document.getElementById("editStationMax").value.trim();
  var limit = null;

  if (raw !== "") {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
      say("Please enter a whole number of 1 or more, or leave it blank for no limit.");
      return;
    }
  }

  db.collection("stations").doc(stationId).update({ maxQueue: limit }).then(function () {
    closeFormModal();
    sayDone("Maximum service queue saved.");
  }).catch(function (error) {
    say("Could not save the limit: " + error.message);
  });
}

function confirmToggleStation(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var disabling = station.active !== false;
  var inEnrollment = enrollmentStationIds().indexOf(stationId) !== -1;

  showConfirmModal({
    title: disabling ? "Disable Station?" : "Enable Station?",
    message: disabling ?
      "Disabling this station will make it inactive and prevent it from operating until it is enabled again. Existing station data will be retained." +
        (inEnrollment ? " It is part of the enrollment process, so enrolling students can't be sent to it while it is disabled." : "") :
      "Enabling this station will make it active and allow it to resume normal operation. Existing station data and configurations will be retained.",
    confirmLabel: disabling ? "Disable" : "Enable",
    tone: "danger",
    onConfirm: function () {
      db.collection("stations").doc(stationId).update({ active: !disabling }).catch(function (error) {
        say("Could not update station: " + error.message);
      });
    }
  });
}

function confirmDeleteStation(stationId) {
  var hasActiveTickets = tickets.some(function (t) {
    return t.stationId === stationId && ACTIVE_TICKET_STATUSES.indexOf(t.status) !== -1;
  });
  if (hasActiveTickets) {
    say("This station still has tickets in its queue. Clear them before deleting it.");
    return;
  }

  // Enrolling students would have nowhere to go: take it out of the enrollment process first.
  if (enrollmentStationIds().indexOf(stationId) !== -1) {
    say("This station is part of the enrollment process. Remove it in Enrollment Settings before deleting it.");
    return;
  }
  var stillAhead = tickets.some(function (t) {
    if (t.enrollment !== true || ACTIVE_TICKET_STATUSES.indexOf(t.status) === -1 || !isTodayTicket(t)) return false;
    return ticketEnrollmentFlow(t).slice((Number(t.enrollmentStep) || 0) + 1).indexOf(stationId) !== -1;
  });
  if (stillAhead) {
    say("Students who are enrolling today still have this station ahead of them. Delete it after they have finished.");
    return;
  }

  showConfirmModal({
    title: "Are you sure you want to delete this station?",
    message: "This role will be permanently removed from the system. Users assigned to this role may lose their associated access and permissions.",
    confirmLabel: "Delete Station",
    tone: "danger",
    onConfirm: function () {
      var batch = db.batch();
      batch.delete(db.collection("stations").doc(stationId));
      // Staff of a deleted station have nothing left to manage, so their access is removed with it.
      staffAccounts.forEach(function (account) {
        if (account.role === stationId) batch.delete(db.collection("staff").doc(account.id));
      });

      return batch.commit().then(function () {
        if (settingsSelectedRole === stationId) settingsSelectedRole = "admin";
        closeFormModal();
        sayDone("Station deleted.");
      }).catch(function (error) {
        say("Could not delete station: " + error.message);
      });
    }
  });
}

/* Roles and members */

function selectSettingsRole(roleId) {
  settingsSelectedRole = roleId;
  settingsRoleDrafts = {};
  renderSettings();
}

function pendingRoleChanges() {
  return staffAccounts.filter(function (account) {
    var draft = settingsRoleDrafts[account.id];
    return draft !== undefined && draft !== accountRole(account);
  }).map(function (account) {
    return { account: account, role: settingsRoleDrafts[account.id] };
  });
}

function updateMembersButton() {
  var button = document.getElementById("membersSaveBtn");
  if (!button) return;

  var dirty = pendingRoleChanges().length > 0;
  button.disabled = !dirty;
  button.className = "settings-btn " + (dirty ? "settings-btn-primary" : "settings-btn-muted");
}

function onMemberRoleChange(select) {
  settingsRoleDrafts[select.getAttribute("data-account")] = select.value;
  updateMembersButton();
}

function confirmSaveMemberRoles() {
  var changes = pendingRoleChanges();
  if (!changes.length) return;

  showConfirmModal({
    title: "Change Role?",
    message: "The user's role will be updated to the selected role. Their access and permissions will change accordingly.",
    confirmLabel: "Change Role",
    tone: "danger",
    onConfirm: function () {
      var batch = db.batch();
      changes.forEach(function (change) {
        batch.update(db.collection("staff").doc(change.account.id), {
          role: change.role,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });

      return batch.commit().then(function () {
        settingsRoleDrafts = {};
        renderSettings();
        sayDone("Roles updated.");
      }).catch(function (error) {
        say("Could not update roles: " + error.message);
      });
    }
  });
}

/* Staff accounts. The admin makes the login here (Email/Password in Firebase Authentication) and chooses the role;
   until a role is saved for an email, signing in with it is refused. */

var STAFF_PASSWORD_MIN = 8;
var staffFormBusy = false;

// A second Firebase app that only creates and updates other people's logins, so the admin's own session is
// never replaced by the account that was just made.
function staffAuthReady() {
  var existing = firebase.apps.find(function (app) { return app.name === "staff-admin"; });
  var app = existing || firebase.initializeApp(firebaseConfig, "staff-admin");
  var auth = app.auth();
  var ready = existing ? Promise.resolve() : auth.setPersistence(firebase.auth.Auth.Persistence.NONE).catch(function () {});

  return ready.then(function () { return auth; });
}

function staffAuthMessage(error) {
  switch (error && error.code) {
    case "staff/email-taken":
      return "That email already has a login with a different password. Enter that login's password, or use another email.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/weak-password":
      return "That password is too weak. Use at least " + STAFF_PASSWORD_MIN + " characters.";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "The current password is wrong.";
    case "auth/user-not-found":
      return "No login exists for this email yet.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in is not turned on for this project in Firebase Authentication.";
    case "auth/admin-restricted-operation":
      return "Creating accounts is switched off in Firebase. Turn on Authentication → Settings → User actions → \"Enable create (sign-up)\", then try again.";
    case "auth/password-does-not-meet-requirements":
      return "That password doesn't meet this project's password rules. Try a longer one with upper and lower case letters and a number.";
    case "auth/quota-exceeded":
      return "Firebase is limiting new accounts right now. Please try again later.";
    case "auth/requires-recent-login":
      return "Firebase needs a fresh sign-in for that login. Please try again.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Your account isn't allowed to change staff. Only an administrator can.";
    case "staff/record-failed":
      return "The login was created, but its role could not be saved (" + (error.detail || "unknown error") + "). Press Add Staff again with the same email and password to finish.";
    default:
      // Show Firebase's own text without its "Firebase: ... (auth/...)" wrapping.
      var text = String((error && error.message) || "").replace(/^Firebase:\s*/, "").replace(/\s*\((auth|firestore)\/[a-z-]+\)\.?$/, "");
      return text || "Something went wrong. Please try again.";
  }
}

function setStaffFormBusy(busy) {
  staffFormBusy = busy;
  document.querySelectorAll("#formModal .settings-btn").forEach(function (button) { button.disabled = busy; });
  setButtonLoading(document.querySelector("#formModal .settings-btn-primary"), busy);
}

function staffDisplayName(account) {
  return account.name || String(account.email || "").split("@")[0];
}

function passwordProblem(password, confirm, label) {
  if (!password) return "Enter a " + label + ".";
  if (password.length < STAFF_PASSWORD_MIN) return "The " + label + " must be at least " + STAFF_PASSWORD_MIN + " characters.";
  if (password !== confirm) return "The passwords do not match.";
  return "";
}

/* Add */

function openAddStaffModal() {
  var roleOptions = '<option value="">Select Role</option>' + getAllRoles().map(function (role) {
    return '<option value="' + escapeAdminText(role.id) + '">' + escapeAdminText(role.name) + '</option>';
  }).join("");

  showFormModal("Add New Staff",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Staff Information</h3>' +
      '<div class="modal-field"><label for="newStaffName">Name</label>' +
        '<input type="text" id="newStaffName" class="modal-input" placeholder="Full name" maxlength="80" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="newStaffEmail">Email</label>' +
        '<input type="email" id="newStaffEmail" class="modal-input" placeholder="name@example.com" maxlength="254" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="newStaffPassword">Password</label>' +
        '<input type="password" id="newStaffPassword" class="modal-input" placeholder="At least ' + STAFF_PASSWORD_MIN + ' characters" autocomplete="new-password"></div>' +
      '<div class="modal-field"><label for="newStaffConfirm">Confirm Password</label>' +
        '<input type="password" id="newStaffConfirm" class="modal-input" placeholder="Repeat the password" autocomplete="new-password"></div>' +
    '</div>' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Roles</h3>' +
      '<div class="modal-field"><label for="newStaffRole">Role</label>' +
        '<select id="newStaffRole" class="modal-input">' + roleOptions + '</select></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="clearAddStaffForm()">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveNewStaff()">Add Staff</button>' +
      '</div>' +
    '</div>');
}

function clearAddStaffForm() {
  ["newStaffName", "newStaffEmail", "newStaffPassword", "newStaffConfirm", "newStaffRole"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
}

function saveNewStaff() {
  if (staffFormBusy) return;

  var name = document.getElementById("newStaffName").value.trim().replace(/\s+/g, " ");
  var email = staffKey(document.getElementById("newStaffEmail").value);
  var password = document.getElementById("newStaffPassword").value;
  var confirm = document.getElementById("newStaffConfirm").value;
  var role = document.getElementById("newStaffRole").value;

  var problem = "";
  if (!/\p{L}/u.test(name)) problem = "Enter the staff member's name.";
  else if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) problem = "Enter a valid email address.";
  else if (staffAccounts.some(function (account) { return account.id === email; })) problem = "That email already belongs to a staff member.";
  else if (passwordProblem(password, confirm, "password")) problem = passwordProblem(password, confirm, "password");
  else if (!role) problem = "Please choose a role.";

  if (problem) {
    say(problem);
    return;
  }

  setStaffFormBusy(true);

  Promise.resolve().then(staffAuthReady).then(function (auth) {
    // The login may already exist (for example after access was removed). That is fine only if the
    // admin knows its password, so nobody can be given a role on an email they do not control.
    return auth.createUserWithEmailAndPassword(email, password).catch(function (error) {
      if (!error || error.code !== "auth/email-already-in-use") throw error;
      return auth.signInWithEmailAndPassword(email, password).catch(function () {
        var taken = new Error("email taken");
        taken.code = "staff/email-taken";
        throw taken;
      });
    }).then(function () {
      return auth.signOut();
    });
  }).then(function () {
    var now = firebase.firestore.FieldValue.serverTimestamp();
    return db.collection("staff").doc(email).set({ email: email, name: name, role: role, createdAt: now, updatedAt: now })
      .catch(function (error) {
        console.error("Staff record for " + email + " was not saved:", error);
        var failed = new Error("record failed");
        failed.code = error && error.code === "permission-denied" ? "permission-denied" : "staff/record-failed";
        failed.detail = error && error.message;
        throw failed;
      });
  }).then(function () {
    closeFormModal();
    settingsSelectedRole = role;
    settingsRoleDrafts = {};
    renderSettings();
    sayDone("Staff added. They can sign in with that email and password.");
  }).catch(function (error) {
    console.error("Add staff failed:", error);
    say("Could not add staff: " + staffAuthMessage(error));
  }).then(function () {
    setStaffFormBusy(false);
  });
}

/* Edit */

function openEditStaffModal(email) {
  var account = staffAccounts.find(function (item) { return item.id === email; });
  if (!account) return;

  var id = escapeAdminText(account.id);

  showFormModal("Edit Staff Information",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Staff Information</h3>' +
      '<div class="modal-field"><label for="editStaffName">Name</label>' +
        '<input type="text" id="editStaffName" class="modal-input" maxlength="80" value="' + escapeAdminText(staffDisplayName(account)) + '" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="editStaffEmail">Email</label>' +
        '<input type="email" id="editStaffEmail" class="modal-input" value="' + escapeAdminText(account.email) + '" readonly></div>' +
      '<p class="modal-help">To change the password, fill in all three password boxes. Leave them empty to keep it.</p>' +
      '<div class="modal-field"><label for="editStaffCurrent">Current Password</label>' +
        '<input type="password" id="editStaffCurrent" class="modal-input" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="editStaffNew">New Password</label>' +
        '<input type="password" id="editStaffNew" class="modal-input" placeholder="At least ' + STAFF_PASSWORD_MIN + ' characters" autocomplete="new-password"></div>' +
      '<div class="modal-field"><label for="editStaffConfirm">Confirm New Password</label>' +
        '<input type="password" id="editStaffConfirm" class="modal-input" autocomplete="new-password"></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="clearEditStaffForm()">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStaffEdit(\'' + id + '\')">Save Changes</button>' +
      '</div>' +
    '</div>');
}

function clearEditStaffForm() {
  ["editStaffName", "editStaffCurrent", "editStaffNew", "editStaffConfirm"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
}

function saveStaffEdit(email) {
  if (staffFormBusy) return;

  var account = staffAccounts.find(function (item) { return item.id === email; });
  if (!account) return;

  var name = document.getElementById("editStaffName").value.trim().replace(/\s+/g, " ");
  var current = document.getElementById("editStaffCurrent").value;
  var next = document.getElementById("editStaffNew").value;
  var confirm = document.getElementById("editStaffConfirm").value;
  var changingPassword = !!(current || next || confirm);

  var problem = "";
  if (!/\p{L}/u.test(name)) problem = "Enter the staff member's name.";
  else if (changingPassword && !current) problem = "Enter the current password to change it.";
  else if (changingPassword && passwordProblem(next, confirm, "new password")) problem = passwordProblem(next, confirm, "new password");
  else if (changingPassword && next === current) problem = "The new password must be different from the current one.";

  if (problem) {
    say(problem);
    return;
  }

  var nameChanged = name !== staffDisplayName(account);
  if (!changingPassword && !nameChanged) {
    closeFormModal();
    return;
  }

  setStaffFormBusy(true);

  var passwordStep = changingPassword ?
    Promise.resolve().then(staffAuthReady).then(function (auth) {
      return auth.signInWithEmailAndPassword(account.email, current).then(function (credential) {
        return credential.user.updatePassword(next);
      }).then(function () {
        return auth.signOut();
      });
    }) :
    Promise.resolve();

  passwordStep.then(function () {
    if (!nameChanged) return null;
    return db.collection("staff").doc(email).update({ name: name, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }).then(function () {
    closeFormModal();
    renderSettings();
    sayDone(changingPassword ? "Staff updated. The new password works from the next sign-in." : "Staff updated.");
  }).catch(function (error) {
    console.error("Edit staff failed:", error);
    say("Could not save the changes: " + staffAuthMessage(error));
  }).then(function () {
    setStaffFormBusy(false);
  });
}

/* Delete */

function confirmDeleteStaff(email) {
  var account = staffAccounts.find(function (item) { return item.id === email; });
  if (!account || isProtectedAccount(account.email)) return;

  showConfirmModal({
    title: "Are you sure you want to delete this staff member?",
    message: staffDisplayName(account) + " (" + account.email + ") loses access to the admin console right away. The login itself is kept, so you can add them again with the same password later.",
    confirmLabel: "Delete Staff",
    tone: "danger",
    onConfirm: function () {
      return db.collection("staff").doc(email).delete().then(function () {
        sayDone("Staff deleted.");
      }).catch(function (error) {
        say("Could not delete staff: " + error.message);
      });
    }
  });
}

function renderSettings() {
  var area = document.getElementById("adminSettingsArea");
  if (!area) return;

  settingsSignature = computeSettingsSignature();

  var roles = getListedRoles();
  var selected = roles.find(function (r) { return r.id === settingsSelectedRole; });
  if (!selected) {
    selected = roles[0];
    settingsSelectedRole = selected.id;
  }

  var timeoutValue = settingsTimeoutDraft !== null ? settingsTimeoutDraft : String(systemSettings.autoVoidMinutes);
  var dirty = isTimeoutDirty();

  var stationRowsHtml = getSortedStations().map(function (station) {
    var active = station.active !== false;
    var id = escapeAdminText(station.id);
    var badge = active ?
      '<span class="status-badge compact station-active">Active</span>' :
      '<span class="status-badge compact station-inactive">Inactive</span>';
    var toggleBtn = active ?
      '<button type="button" class="settings-btn settings-btn-red" onclick="confirmToggleStation(\'' + id + '\')">Disable</button>' :
      '<button type="button" class="settings-btn settings-btn-green" onclick="confirmToggleStation(\'' + id + '\')">Enable</button>';

    return '<tr><td class="settings-strong">' + escapeAdminText(station.name) + '</td>' +
      '<td>' + escapeAdminText(stationCodeOf(station.id)) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="openEditStationModal(\'' + id + '\')">Edit</button>' + toggleBtn +
      '</div></td></tr>';
  }).join("");

  if (!stationRowsHtml) stationRowsHtml = '<tr><td colspan="4" class="empty-row">No service stations yet.</td></tr>';

  var roleRowsHtml = roles.map(function (role) {
    var count = staffAccounts.filter(function (a) { return accountRole(a) === role.id; }).length;
    var rowClass = role.id === selected.id ? ' class="settings-row-selected"' : '';

    return '<tr' + rowClass + '><td class="settings-strong">' + escapeAdminText(role.name) + '</td>' +
      '<td class="settings-center">' + count + ' 👤</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-icon-btn settings-icon-blue" title="View members" onclick="selectSettingsRole(\'' + escapeAdminText(role.id) + '\')">✎</button>' +
      '</div></td></tr>';
  }).join("");

  var members = staffAccounts.filter(function (a) {
    return accountRole(a) === selected.id;
  }).sort(function (a, b) { return String(a.email).localeCompare(String(b.email)); });

  var roleOptions = function (current) {
    var placeholder = current === NO_ROLE.id ? '<option value="' + NO_ROLE.id + '" selected disabled>' + NO_ROLE.name + '</option>' : '';
    return placeholder + getAllRoles().map(function (role) {
      return '<option value="' + escapeAdminText(role.id) + '"' + (role.id === current ? ' selected' : '') + '>' + escapeAdminText(role.name) + '</option>';
    }).join("");
  };

  var membersBodyHtml = members.length ?
    '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>User</th><th>Role</th></tr></thead><tbody>' +
      members.map(function (account) {
        var locked = isProtectedAccount(account.email);
        var current = settingsRoleDrafts[account.id] !== undefined ? settingsRoleDrafts[account.id] : accountRole(account);
        return '<tr><td class="settings-strong">' + escapeAdminText(account.email) + '</td>' +
          '<td><select class="settings-select" data-account="' + escapeAdminText(account.id) + '" onchange="onMemberRoleChange(this)"' +
            (locked ? ' disabled title="This account\'s role can\'t be changed"' : '') + '>' + roleOptions(current) + '</select></td></tr>';
      }).join("") +
    '</tbody></table></div>' :
    '<div class="settings-empty"><div class="settings-empty-icon">⚠</div><p>Nothing to Show Here</p></div>';

  var staffRowsHtml = staffAccounts.slice().sort(function (a, b) {
    return staffDisplayName(a).localeCompare(staffDisplayName(b));
  }).map(function (account) {
    var id = escapeAdminText(account.id);
    var roleName = (roles.find(function (r) { return r.id === accountRole(account); }) || NO_ROLE).name;
    var locked = isProtectedAccount(account.email);

    return '<tr><td class="settings-strong">' + escapeAdminText(staffDisplayName(account)) + '</td>' +
      '<td>' + escapeAdminText(account.email) + '</td>' +
      '<td>' + escapeAdminText(roleName) + '</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-icon-btn settings-icon-blue" title="Edit staff" onclick="openEditStaffModal(\'' + id + '\')">✎</button>' +
        (locked ? '' : '<button type="button" class="settings-icon-btn settings-icon-red" title="Delete staff" onclick="confirmDeleteStaff(\'' + id + '\')">🗑</button>') +
      '</div></td></tr>';
  }).join("");

  if (!staffRowsHtml) staffRowsHtml = '<tr><td colspan="4" class="empty-row">No staff yet.</td></tr>';

  var membersDirty = pendingRoleChanges().length > 0;

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">System Settings</div>' +
      adminHeaderRightHtml() +
    '</div>' +

    '<div class="settings-config-head">' +
      '<div><h2 class="settings-title">System Configuration</h2>' +
        '<p class="settings-sub">Manage global queue rules, user roles and setup service stations</p></div>' +
      '<div class="settings-actions">' +
        '<button type="button" id="settingsSaveBtn" class="settings-btn ' + (dirty ? 'settings-btn-primary' : 'settings-btn-muted') + '"' + (dirty ? '' : ' disabled') + ' onclick="confirmSaveConfiguration()">Save Changes</button>' +
        '<button type="button" id="settingsCancelBtn" class="settings-btn ' + (dirty ? 'settings-btn-slate' : 'settings-btn-muted') + '"' + (dirty ? '' : ' disabled') + ' onclick="cancelTimeoutEdit()">Cancel</button>' +
      '</div>' +
    '</div>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Queue Rules &amp; Timeouts</h2></div>' +
      '<label class="settings-field-label" for="settingsTimeout">Auto-Void Timeout Minute</label>' +
      '<p class="settings-help">*Controls the number of minutes a queue entry on hold has to return to the counter. Once it runs out, staff can send a last call that gives the entry the same amount of time again. If the last call also runs out, the system automatically marks the queue entry as void.</p>' +
      '<input type="number" id="settingsTimeout" class="settings-input" min="1" max="1440" step="1" value="' + escapeAdminText(timeoutValue) + '" oninput="onTimeoutInput(this.value)">' +
    '</section>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Service Station</h2>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="openAddStationModal()">+ Add New Station</button></div>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Station</th><th>Ticket Code</th><th>Status</th><th>Action</th></tr></thead>' +
        '<tbody>' + stationRowsHtml + '</tbody></table></div>' +
    '</section>' +

    '<div class="settings-grid">' +
      '<section class="panel settings-panel">' +
        '<div class="panel-header"><h2>Roles</h2></div>' +
        '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Roles</th><th class="settings-center">Members</th><th>Action</th></tr></thead>' +
          '<tbody>' + roleRowsHtml + '</tbody></table></div>' +
      '</section>' +
      '<section class="panel settings-panel">' +
        '<div class="panel-header"><h2>' + escapeAdminText(selected.name) + ' Members</h2>' +
          '<button type="button" id="membersSaveBtn" class="settings-btn ' + (membersDirty ? 'settings-btn-primary' : 'settings-btn-muted') + '"' + (membersDirty ? '' : ' disabled') + ' onclick="confirmSaveMemberRoles()">Save Changes</button></div>' +
        membersBodyHtml +
      '</section>' +
    '</div>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Staffs</h2>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="openAddStaffModal()">+ Add New Staff</button></div>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Action</th></tr></thead>' +
        '<tbody>' + staffRowsHtml + '</tbody></table></div>' +
    '</section>';
}
