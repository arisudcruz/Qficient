var staffAccounts = [];

var SYSTEM_ROLES = [
  { id: "admin", name: "Admin" },
  { id: "enforcer", name: "Queue Enforcer" }
];
var STANDBY_ROLE = { id: "standby", name: "Standby" };
var RESERVED_ROLE_IDS = ["admin", "enforcer", "standby"];
var RESERVED_ROLE_NAMES = ["admin", "queue enforcer", "standby"];

var settingsSelectedRole = "standby";
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
  return SYSTEM_ROLES.concat(stationRoles, [STANDBY_ROLE]);
}

function accountRole(account) {
  var known = getAllRoles().some(function (r) { return r.id === account.role; });
  return known ? account.role : STANDBY_ROLE.id;
}

function computeSettingsSignature() {
  return JSON.stringify([
    stations.map(function (s) { return [s.id, s.name, s.active !== false, s.maxQueue || null]; }),
    staffAccounts.map(function (a) { return [a.id, a.role]; }),
    systemSettings.autoVoidMinutes
  ]);
}

function refreshSettings() {
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
      db.collection("settings").doc("system").set({
        autoVoidMinutes: minutes,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).then(function () {
        settingsTimeoutDraft = null;
        renderSettings();
        say("Configuration saved.");
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
      db.collection("stations").doc(id).set({
        name: name,
        count: 0,
        nowServingId: null,
        active: true,
        maxQueue: null,
        purposes: purposes
      }).then(function () {
        closeFormModal();
        say("Station created.");
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
      '<div class="modal-field"><label for="editStationName">New Name</label>' +
        '<input type="text" id="editStationName" class="modal-input" placeholder="New station name" maxlength="40"></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="document.getElementById(\'editStationName\').value = \'\'">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStationName(\'' + id + '\')">Save Changes</button>' +
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
    say("Station renamed.");
  }).catch(function (error) {
    say("Could not rename station: " + error.message);
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
    say("Maximum service queue saved.");
  }).catch(function (error) {
    say("Could not save the limit: " + error.message);
  });
}

function confirmToggleStation(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var disabling = station.active !== false;

  showConfirmModal({
    title: disabling ? "Disable Station?" : "Enable Station?",
    message: disabling ?
      "Disabling this station will make it inactive and prevent it from operating until it is enabled again. Existing station data will be retained." :
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

  showConfirmModal({
    title: "Delete Station?",
    message: "This role will be permanently removed from the system. Users assigned to this role may lose their associated access and permissions.",
    confirmLabel: "Delete Station",
    tone: "danger",
    onConfirm: function () {
      var batch = db.batch();
      batch.delete(db.collection("stations").doc(stationId));
      staffAccounts.forEach(function (account) {
        if (account.role === stationId) {
          batch.update(db.collection("staff").doc(account.id), {
            role: STANDBY_ROLE.id,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      });

      batch.commit().then(function () {
        if (settingsSelectedRole === stationId) settingsSelectedRole = STANDBY_ROLE.id;
        closeFormModal();
        say("Station deleted.");
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

      batch.commit().then(function () {
        settingsRoleDrafts = {};
        renderSettings();
        say("Roles updated.");
      }).catch(function (error) {
        say("Could not update roles: " + error.message);
      });
    }
  });
}

function renderSettings() {
  var area = document.getElementById("adminSettingsArea");
  if (!area) return;

  settingsSignature = computeSettingsSignature();

  var roles = getAllRoles();
  var selected = roles.find(function (r) { return r.id === settingsSelectedRole; });
  if (!selected) {
    selected = STANDBY_ROLE;
    settingsSelectedRole = STANDBY_ROLE.id;
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
      '<td>' + badge + '</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="openEditStationModal(\'' + id + '\')">Edit</button>' + toggleBtn +
      '</div></td></tr>';
  }).join("");

  if (!stationRowsHtml) stationRowsHtml = '<tr><td colspan="3" class="empty-row">No service stations yet.</td></tr>';

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
    return roles.map(function (role) {
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

  var membersDirty = pendingRoleChanges().length > 0;

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">System Settings</div>' +
      '<div class="settings-header-user"><span>QFicient Admin</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
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
      '<p class="settings-help">*Controls the number of minutes a queue entry can remain active before it is automatically voided. Once the configured timeout is reached, the system automatically marks the queue entry as void.</p>' +
      '<input type="number" id="settingsTimeout" class="settings-input" min="1" max="1440" step="1" value="' + escapeAdminText(timeoutValue) + '" oninput="onTimeoutInput(this.value)">' +
    '</section>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Service Station</h2>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="openAddStationModal()">+ Add New Station</button></div>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Station</th><th>Status</th><th>Action</th></tr></thead>' +
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
    '</div>';
}
