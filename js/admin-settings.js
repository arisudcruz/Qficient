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
var settingsCooldownDraft = null;
var settingsHoursDraft = null; // the Window Hours form while being edited (null = showing what is saved)
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
    stations.map(function (s) { return [s.id, s.name, s.code || "", s.active !== false, s.maxQueue || null, stationWindows(s), s.dayLimits || null]; }),
    staffAccounts.map(function (a) { return [a.id, a.role, a.name || ""]; }),
    systemSettings.autoVoidMinutes,
    systemSettings.cancelCooldownSeconds,
    windowHours,
    blockedStudents.map(function (b) { return [b.id, b.untilMs]; }),
    lockedAccounts,
    limitRequestsSignature()
  ]);
}

/* Blocked Students: students blocked from joining for missing their turn too often (functions/lib/strikes.js).
   Admins only; lifting a block also clears their strikes (firestore.rules allows exactly that change). */

var blockedStudents = [];
var blockedUnsubscribe = null;

var BLOCK_REASON_TEXT = {
  noShow: "Missed their turn 3 times in 7 days",
  cancels: "Cancelled " + CANCEL_LIMIT + " tickets in one day"
};

function startBlockedListener() {
  if (blockedUnsubscribe) return;
  blockedUnsubscribe = db.collection("joinState")
    .where("blockedUntil", ">", firebase.firestore.Timestamp.now())
    .onSnapshot(function (snapshot) {
      blockedStudents = snapshot.docs.map(function (doc) {
        var data = doc.data();
        return { id: doc.id, name: data.ownerName || "", studentNumber: data.studentNumber || "", untilMs: timestampToMs(data.blockedUntil, 0), reason: data.blockedReason || "" };
      });
      refreshSettings();
    }, function (error) {
      console.error("Could not load blocked students: " + error.message);
    });
}

function stopBlockedListener() {
  if (blockedUnsubscribe) {
    blockedUnsubscribe();
    blockedUnsubscribe = null;
  }
  blockedStudents = [];
}

function blockedStudentsPanelHtml() {
  var now = serverNow();
  var rows = blockedStudents.filter(function (b) { return b.untilMs > now; })
    .sort(function (a, b) { return a.untilMs - b.untilMs; })
    .map(function (b) {
      return '<tr><td class="settings-strong">' + escapeAdminText(b.name || "Student") + '</td>' +
        '<td>' + escapeAdminText(b.studentNumber || "—") + '</td>' +
        '<td>' + escapeAdminText(manilaDateTimeText(b.untilMs)) + '</td>' +
        '<td>' + escapeAdminText(BLOCK_REASON_TEXT[b.reason] || b.reason || "—") + '</td>' +
        '<td><button type="button" class="settings-btn settings-btn-blue" onclick="confirmUnblockStudent(\'' + escapeAdminText(b.id) + '\')">Unblock</button></td></tr>';
    }).join("") || '<tr><td colspan="5" class="empty-row">No students are blocked.</td></tr>';

  return '<section class="panel settings-panel">' +
    '<div class="panel-header"><h2>Blocked Students</h2></div>' +
    '<p class="settings-help">Students who miss their turn 3 times within 7 days (the last call ran out each time) can\'t join the queue for 24 hours. Students who cancel ' + CANCEL_LIMIT + ' tickets in one day can\'t join again until the day ends. Unblock lets them join right away and clears their missed turns and cancels.</p>' +
    '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Name</th><th>Student No.</th><th>Blocked Until</th><th>Reason</th><th>Action</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
  '</section>';
}

function confirmUnblockStudent(uid) {
  var blocked = blockedStudents.find(function (b) { return b.id === uid; });
  if (!blocked) return;

  showConfirmModal({
    title: "Unblock " + (blocked.name || "this student") + "?",
    message: "They can join the queue again right away, and their missed turns and cancels start from zero.",
    confirmLabel: "Unblock",
    tone: "primary",
    onConfirm: function () {
      return db.collection("joinState").doc(uid).update({
        blockedUntil: null,
        noShows: {},
        cancels: {},
        unblockedBy: staffKey(adminUser.email),
        unblockedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        sayDone((blocked.name || "The student") + " can join the queue again.");
      }).catch(function (error) {
        say("Could not unblock the student: " + error.message);
      });
    }
  });
}

/* Locked staff accounts: too many wrong passwords at the admin login (functions/lib/signinlock.js) switch the
   account's login off for a while. Admins only; Unlock (the unlockStaffAccount Cloud Function) ends it early. */

var SIGN_IN_LOCK_TEXT = "5 wrong passwords within 15 minutes lock an account for 15 minutes"; // functions/config.js
var lockedAccounts = {}; // staff email -> lockedUntil (ms)
var lockedUnsubscribe = null;

function startLockedListener() {
  if (lockedUnsubscribe) return;
  lockedUnsubscribe = db.collection("signInLocks")
    .where("lockedUntil", ">", firebase.firestore.Timestamp.now())
    .onSnapshot(function (snapshot) {
      lockedAccounts = {};
      snapshot.docs.forEach(function (doc) {
        lockedAccounts[doc.id] = timestampToMs(doc.data().lockedUntil, 0);
      });
      refreshSettings();
    }, function (error) {
      console.error("Could not load locked accounts: " + error.message);
    });
}

function stopLockedListener() {
  if (lockedUnsubscribe) {
    lockedUnsubscribe();
    lockedUnsubscribe = null;
  }
  lockedAccounts = {};
}

// When the account's lock ends, or 0 when it isn't locked.
function accountLockedUntil(email) {
  var until = lockedAccounts[staffKey(email)] || 0;
  return until > serverNow() ? until : 0;
}

function confirmUnlockStaff(email) {
  var account = staffAccounts.find(function (a) { return a.id === email; });
  var username = usernameOfEmail(email);
  if (!account || !username || !accountLockedUntil(email)) return;

  showConfirmModal({
    title: "Unlock " + staffDisplayName(account) + "?",
    message: "They can sign in again right away, and their failed attempts start from zero.",
    confirmLabel: "Unlock",
    tone: "primary",
    onConfirm: function () {
      return firebase.app().functions(JOIN_FUNCTION_REGION).httpsCallable("unlockStaffAccount")({ username: username })
        .then(function () {
          delete lockedAccounts[staffKey(email)];
          refreshSettings();
          sayDone(staffDisplayName(account) + " can sign in again.");
        }).catch(function (error) {
          say("Could not unlock the account: " + error.message);
        });
    }
  });
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

// Queue Rules & Timeouts (the Auto-Void minutes and the cancel cooldown) and the Window Hours share one Save / Cancel.
function isConfigDirty() {
  return isSystemConfigDirty() || isHoursDirty();
}

function isSystemConfigDirty() {
  var timeout = settingsTimeoutDraft !== null && settingsTimeoutDraft.trim() !== String(systemSettings.autoVoidMinutes);
  var cooldown = settingsCooldownDraft !== null && settingsCooldownDraft.trim() !== String(systemSettings.cancelCooldownSeconds);
  return timeout || cooldown;
}

/* Window Hours (settings/windowHours; js/window-hours.js, functions/lib/hours.js). The form holds the times as
   <input type="time"> values ("08:00") and the minutes as typed, and is turned into the saved shape on Save. */

var HOURS_FORM_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]; // Monday first, as on a school calendar

// Used until an admin first saves the hours: weekdays 8 to 5, Saturday mornings, closed on Sunday.
var HOURS_DEFAULT = {
  enabled: false,
  days: {
    mon: { open: true, start: 480, end: 1020 }, tue: { open: true, start: 480, end: 1020 },
    wed: { open: true, start: 480, end: 1020 }, thu: { open: true, start: 480, end: 1020 },
    fri: { open: true, start: 480, end: 1020 }, sat: { open: true, start: 480, end: 720 },
    sun: { open: false, start: 480, end: 1020 }
  },
  lastJoinMinutes: 30
};

function savedHoursForm() {
  var saved = windowHours && windowHours.days ? windowHours : HOURS_DEFAULT;
  var form = { enabled: !!(windowHours && windowHours.enabled === true), days: {}, lastJoin: "" };
  HOURS_FORM_DAYS.forEach(function (key) {
    var day = saved.days[key] || HOURS_DEFAULT.days[key];
    form.days[key] = { open: day.open === true, start: hoursInputValue(day.start), end: hoursInputValue(Math.min(day.end, 1439)) };
  });
  form.lastJoin = String(hoursWholeMinute(saved.lastJoinMinutes, 0, 240) ? saved.lastJoinMinutes : HOURS_DEFAULT.lastJoinMinutes);
  return form;
}

function hoursForm() {
  return settingsHoursDraft || savedHoursForm();
}

function editHoursForm() {
  if (!settingsHoursDraft) settingsHoursDraft = savedHoursForm();
  return settingsHoursDraft;
}

// Edited and different from what is saved. Turning the hours on for the first time counts even with the
// starting times unchanged (nothing is saved yet).
function isHoursDirty() {
  if (!settingsHoursDraft) return false;
  var draft = JSON.parse(JSON.stringify(settingsHoursDraft));
  draft.lastJoin = String(draft.lastJoin).trim();
  return JSON.stringify(draft) !== JSON.stringify(savedHoursForm());
}

function onHoursEnabledInput(checked) {
  editHoursForm().enabled = !!checked;
  updateConfigButtons();
}

function onHoursDayOpenInput(key, checked) {
  editHoursForm().days[key].open = !!checked;
  ["Start", "End"].forEach(function (which) {
    var input = document.getElementById("hours" + which + "_" + key);
    if (input) input.disabled = !checked;
  });
  updateConfigButtons();
}

function onHoursTimeInput(key, which, value) {
  editHoursForm().days[key][which] = value;
  updateConfigButtons();
}

function onHoursLastJoinInput(value) {
  editHoursForm().lastJoin = value;
  updateConfigButtons();
}

// The form as the saved shape, or { error } with what to fix.
function hoursFormToConfig(form) {
  var text = String(form.lastJoin).trim();
  var lastJoin = text === "" ? NaN : Number(text);
  if (!Number.isInteger(lastJoin) || lastJoin < 0 || lastJoin > 240) {
    return { error: "Please enter 0 to 240 minutes for when new tickets stop before closing." };
  }

  var days = {};
  var openDays = 0;
  for (var i = 0; i < HOURS_FORM_DAYS.length; i++) {
    var key = HOURS_FORM_DAYS[i];
    var row = form.days[key];
    var name = HOURS_DAY_NAMES[HOURS_DAY_KEYS.indexOf(key)];
    var start = hoursFromInput(row.start);
    var end = hoursFromInput(row.end);
    if (row.open) {
      if (start === null || end === null) return { error: "Please enter both the opening and closing time for " + name + "." };
      if (end <= start) return { error: "On " + name + ", the closing time must be later than the opening time." };
      if (end - start <= lastJoin) {
        return { error: "On " + name + ", the windows are open for less than the " + lastJoin + " minutes before closing when new tickets stop." };
      }
      openDays++;
    }
    // A closed day keeps its times (or the usual ones) so turning it back on later starts from something sensible.
    if (start === null || end === null || end <= start) {
      start = HOURS_DEFAULT.days[key].start;
      end = HOURS_DEFAULT.days[key].end;
    }
    days[key] = { open: !!row.open, start: start, end: end };
  }
  if (form.enabled && !openDays) return { error: "Choose at least one open day, or turn Window Hours off." };

  return { config: { enabled: !!form.enabled, days: days, lastJoinMinutes: lastJoin } };
}

function hoursPanelHtml() {
  var form = hoursForm();
  var rows = HOURS_FORM_DAYS.map(function (key) {
    var row = form.days[key];
    var name = HOURS_DAY_NAMES[HOURS_DAY_KEYS.indexOf(key)];
    var off = row.open ? '' : ' disabled';
    return '<tr>' +
      '<td>' + name + '</td>' +
      '<td class="settings-center"><input type="checkbox" class="hours-open" aria-label="Open on ' + name + '"' + (row.open ? ' checked' : '') +
        ' onchange="onHoursDayOpenInput(\'' + key + '\', this.checked)"></td>' +
      '<td><input type="time" id="hoursStart_' + key + '" class="settings-input hours-time" aria-label="' + name + ' opening time" value="' + escapeAdminText(row.start) + '"' + off +
        ' oninput="onHoursTimeInput(\'' + key + '\', \'start\', this.value)"></td>' +
      '<td><input type="time" id="hoursEnd_' + key + '" class="settings-input hours-time" aria-label="' + name + ' closing time" value="' + escapeAdminText(row.end) + '"' + off +
        ' oninput="onHoursTimeInput(\'' + key + '\', \'end\', this.value)"></td>' +
    '</tr>';
  }).join("");

  return '<section class="panel settings-panel hours-panel">' +
    '<div class="panel-header"><h2>Window Hours</h2>' +
      '<label class="switch" title="Use window hours"><input type="checkbox" id="hoursEnabled" aria-label="Use window hours"' + (form.enabled ? ' checked' : '') +
        ' onchange="onHoursEnabledInput(this.checked)"><span class="switch-track"></span></label></div>' +
    '<p class="settings-help">*When on, students, walk-ins and the Queue Enforcer can only get tickets during these hours (Philippine time). ' +
      'At closing, tickets still waiting or on hold are voided and the students are notified; this doesn\'t count as a missed turn. ' +
      'Tickets being served can still be finished. When off, tickets can be made at any time.</p>' +
    '<div class="table-wrap"><table class="queue-table settings-table hours-table"><thead><tr><th>Day</th><th class="settings-center">Open</th><th>Opens</th><th>Closes</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
    '<label class="settings-field-label" for="hoursLastJoin">Stop New Tickets Before Closing (minutes)</label>' +
    '<p class="settings-help">*New tickets stop this many minutes before the windows close, so the line can be finished. 0 lets students get tickets until closing.</p>' +
    '<input type="number" id="hoursLastJoin" class="settings-input" min="0" max="240" step="1" value="' + escapeAdminText(form.lastJoin) + '" oninput="onHoursLastJoinInput(this.value)">' +
  '</section>';
}

function updateConfigButtons() {
  var save = document.getElementById("settingsSaveBtn");
  var cancel = document.getElementById("settingsCancelBtn");
  if (!save || !cancel) return;

  var dirty = isConfigDirty();
  save.disabled = !dirty;
  cancel.disabled = !dirty;
  save.className = "settings-btn " + (dirty ? "settings-btn-primary" : "settings-btn-muted");
  cancel.className = "settings-btn " + (dirty ? "settings-btn-slate" : "settings-btn-muted");
}

function onTimeoutInput(value) {
  settingsTimeoutDraft = value;
  updateConfigButtons();
}

function onCooldownInput(value) {
  settingsCooldownDraft = value;
  updateConfigButtons();
}

function cancelTimeoutEdit() {
  settingsTimeoutDraft = null;
  settingsCooldownDraft = null;
  settingsHoursDraft = null;
  renderSettings();
}

function confirmSaveConfiguration() {
  var minutesText = settingsTimeoutDraft !== null ? settingsTimeoutDraft.trim() : String(systemSettings.autoVoidMinutes);
  var cooldownText = settingsCooldownDraft !== null ? settingsCooldownDraft.trim() : String(systemSettings.cancelCooldownSeconds);
  var minutes = minutesText === "" ? NaN : Number(minutesText);
  var cooldownSeconds = cooldownText === "" ? NaN : Number(cooldownText);

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    say("Please enter a whole number of minutes between 1 and 1440.");
    return;
  }
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 3600) {
    say("Please enter a cancel cooldown of 0 to 3600 seconds (0 means no wait).");
    return;
  }

  var hoursDirty = isHoursDirty();
  var hours = hoursDirty ? hoursFormToConfig(settingsHoursDraft) : null;
  if (hours && hours.error) {
    say(hours.error);
    return;
  }
  var systemDirty = isSystemConfigDirty();

  showConfirmModal({
    title: "Save Configuration Changes?",
    message: "The updated system configuration will be applied and take effect across the system." +
      (hours && hours.config.enabled ? " Outside the window hours no new tickets can be made, and tickets still in line at closing are voided." : ""),
    confirmLabel: "Save Changes",
    tone: "danger",
    onConfirm: function () {
      var writes = [];
      if (systemDirty || !hours) {
        writes.push(db.collection("settings").doc("system").set({
          autoVoidMinutes: minutes,
          cancelCooldownSeconds: cooldownSeconds,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }));
      }
      if (hours) {
        writes.push(db.collection("settings").doc("windowHours").set(Object.assign({}, hours.config, {
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })));
      }
      return Promise.all(writes).then(function () {
        settingsTimeoutDraft = null;
        settingsCooldownDraft = null;
        settingsHoursDraft = null;
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
        active: true,
        maxQueue: null,
        windows: 1,
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
      stationDayLimitsEditHtml(station) +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Windows</h3>' +
      '<p class="modal-help">How many counters this station serves from. They share one line: whichever window calls next gets the next person, and the student is told which window to go to. Staff pick their window on Queue Management.</p>' +
      '<div class="modal-inline">' +
        '<input type="number" id="editStationWindows" class="modal-input" min="1" max="' + STATION_WINDOWS_MAX + '" step="1" value="' + stationWindows(station) + '">' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStationWindows(\'' + id + '\')">Save Changes</button>' +
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

var STATION_WINDOWS_MAX = 10; // keep in step with the window check in firestore.rules

function saveStationWindows(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var count = Number(document.getElementById("editStationWindows").value.trim());
  if (!Number.isInteger(count) || count < 1 || count > STATION_WINDOWS_MAX) {
    say("Please enter a whole number from 1 to " + STATION_WINDOWS_MAX + ".");
    return;
  }
  if (count === stationWindows(station)) {
    say("There are no changes to save.");
    return;
  }

  // A window that is still serving someone can't be taken away until that ticket is finished.
  var busy = servingTicketsOf(station).filter(function (t) { return ticketWindow(t) > count; });
  if (busy.length) {
    say("Window " + ticketWindow(busy[0]) + " is still serving " + busy[0].ticketNo + ". Finish that ticket first, then reduce the windows.");
    return;
  }

  db.collection("stations").doc(stationId).update({ windows: count }).then(function () {
    closeFormModal();
    sayDone(station.name + " now has " + count + (count === 1 ? " window." : " windows."));
  }).catch(function (error) {
    say("Could not save the windows: " + error.message);
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
// Every new account's first password. The staff member is asked to choose their own at sign-in (js/admin-password.js).
var DEFAULT_STAFF_PASSWORD = "staff123";
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
    case "staff/username-taken":
      return "That username is already taken. Choose another username.";
    case "auth/invalid-email":
      return "Enter a valid username.";
    case "auth/weak-password":
      return "That password is too weak. Use at least " + STAFF_PASSWORD_MIN + " characters.";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "The current password is wrong.";
    case "auth/user-not-found":
      return "No login exists for this username.";
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
      return "The login was created, but its role could not be saved (" + (error.detail || "unknown error") + "). Press Add Staff again with the same username to finish.";
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
  return account.name || [account.firstName, account.lastName].filter(Boolean).join(" ") || usernameOfEmail(account.email) || String(account.email || "").split("@")[0];
}

// What identifies an account in the lists: its username, or for an old email account, the email.
function staffLoginText(account) {
  return usernameOfEmail(account.email) || account.email || "";
}

function passwordProblem(password, confirm, label) {
  if (!password) return "Enter a " + label + ".";
  if (password.length < STAFF_PASSWORD_MIN) return "The " + label + " must be at least " + STAFF_PASSWORD_MIN + " characters.";
  if (password !== confirm) return "The passwords do not match.";
  return "";
}

function cleanPersonName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function personNameProblem(value, label) {
  if (!/\p{L}/u.test(value)) return "Enter the staff member's " + label + ".";
  if (value.length > 40) return "The " + label + " can be at most 40 characters.";
  return "";
}

// "" when the username can be used for a new account, else what is wrong with it.
function usernameProblem(username) {
  if (!username) return "Enter a username.";
  if (username === ADMIN_USERNAME) return "\"admin\" is reserved for the built-in administrator.";
  if (!USERNAME_PATTERN.test(username)) {
    return "A username is 3 to 30 characters: lowercase letters, numbers, dots, dashes or underscores, starting with a letter or number.";
  }
  if (staffAccounts.some(function (account) { return usernameOfEmail(account.email) === username; })) return "That username is already taken.";
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
      '<div class="modal-field"><label for="newStaffFirst">First Name</label>' +
        '<input type="text" id="newStaffFirst" class="modal-input" placeholder="e.g. Juan" maxlength="40" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="newStaffLast">Last Name</label>' +
        '<input type="text" id="newStaffLast" class="modal-input" placeholder="e.g. Dela Cruz" maxlength="40" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="newStaffUsername">Username</label>' +
        '<input type="text" id="newStaffUsername" class="modal-input" placeholder="e.g. juan.cruz" maxlength="30" autocomplete="off" autocapitalize="none" spellcheck="false"></div>' +
      '<p class="modal-help">They sign in with this username. 3 to 30 characters: lowercase letters, numbers, dots, dashes or underscores.</p>' +
      '<p class="modal-help staff-default-pw">Their first password is <b>' + escapeAdminText(DEFAULT_STAFF_PASSWORD) + '</b>. They\'ll be asked to change it when they sign in.</p>' +
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
  ["newStaffFirst", "newStaffLast", "newStaffUsername", "newStaffRole"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
}

function saveNewStaff() {
  if (staffFormBusy) return;

  var firstName = cleanPersonName(document.getElementById("newStaffFirst").value);
  var lastName = cleanPersonName(document.getElementById("newStaffLast").value);
  var username = normalizeUsername(document.getElementById("newStaffUsername").value);
  var password = DEFAULT_STAFF_PASSWORD;
  var role = document.getElementById("newStaffRole").value;
  var email = staffEmailForUsername(username);

  var problem = personNameProblem(firstName, "first name") || personNameProblem(lastName, "last name") ||
    usernameProblem(username) || (role ? "" : "Please choose a role.");

  if (problem) {
    say(problem);
    return;
  }

  setStaffFormBusy(true);

  // true when the login already exists with another password (someone removed earlier and added back): their
  // password is set back to the default once the record is saved, so the admin never hands over a login they
  // don't control.
  var resetAfterSave = false;

  Promise.resolve().then(staffAuthReady).then(function (auth) {
    return auth.createUserWithEmailAndPassword(email, password).catch(function (error) {
      if (!error || error.code !== "auth/email-already-in-use") throw error;
      return auth.signInWithEmailAndPassword(email, password).catch(function () {
        // Someone who still has access keeps their account; a removed one gets the default password again.
        return db.collection("staff").doc(email).get().then(function (doc) {
          if (doc.exists) {
            var taken = new Error("username taken");
            taken.code = "staff/username-taken";
            throw taken;
          }
          resetAfterSave = true;
        });
      });
    }).then(function () {
      return auth.signOut();
    });
  }).then(function () {
    var now = firebase.firestore.FieldValue.serverTimestamp();
    return db.collection("staff").doc(email).set({
      email: email,
      username: username,
      firstName: firstName,
      lastName: lastName,
      name: firstName + " " + lastName,
      role: role,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now
    }).catch(function (error) {
      console.error("Staff record for " + username + " was not saved:", error);
      var failed = new Error("record failed");
      failed.code = error && error.code === "permission-denied" ? "permission-denied" : "staff/record-failed";
      failed.detail = error && error.message;
      throw failed;
    });
  }).then(function () {
    return resetAfterSave ? resetStaffPassword(username, password) : null;
  }).then(function () {
    closeFormModal();
    settingsSelectedRole = role;
    settingsRoleDrafts = {};
    renderSettings();
    sayDone("Staff added. " + firstName + " can sign in with the username \"" + username + "\" and the password " + password +
      ". They'll be asked to choose their own password.");
  }).catch(function (error) {
    console.error("Add staff failed:", error);
    say("Could not add staff: " + staffAuthMessage(error));
  }).then(function () {
    setStaffFormBusy(false);
  });
}

/* Edit */

// First and last name of an account; older records only have the full name, which is split at the first space.
function staffNameParts(account) {
  if (account.firstName || account.lastName) return { first: account.firstName || "", last: account.lastName || "" };
  var full = String(account.name || "").trim();
  var cut = full.indexOf(" ");
  return cut === -1 ? { first: full, last: "" } : { first: full.slice(0, cut), last: full.slice(cut + 1) };
}

function openEditStaffModal(email) {
  var account = staffAccounts.find(function (item) { return item.id === email; });
  if (!account) return;

  var id = escapeAdminText(account.id);
  var parts = staffNameParts(account);
  var username = usernameOfEmail(account.email);

  // One button puts the password back to the default; the person then chooses their own at sign-in. Not for your
  // own account (or the built-in admin): that is changed from the profile menu instead.
  var passwordHtml = !username ?
    '<p class="rules-off-note">This account was made with an email, which can no longer sign in. Add the person again with a username, then delete this account.</p>' :
    isProtectedAccount(account.email) ?
    '<h3 class="modal-section-title">Password</h3>' +
    '<p class="modal-help">Change your own password from the profile menu (Change Password) at the top right.</p>' :
    '<h3 class="modal-section-title">Reset Password</h3>' +
    '<p class="modal-help">Forgot their password? Reset it to <b>' + escapeAdminText(DEFAULT_STAFF_PASSWORD) + '</b>. They\'ll be asked to choose their own at their next sign-in.</p>' +
    (account.mustChangePassword === true ? '<p class="modal-help staff-reset-note">Currently on a temporary password.</p>' : '') +
    '<div class="modal-field"><button type="button" class="settings-btn settings-btn-blue staff-reset-btn" onclick="confirmResetStaffPassword(\'' + id + '\')">' +
      'Reset to ' + escapeAdminText(DEFAULT_STAFF_PASSWORD) + '</button></div>';

  showFormModal("Edit Staff Information",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Staff Information</h3>' +
      '<div class="modal-field"><label for="editStaffFirst">First Name</label>' +
        '<input type="text" id="editStaffFirst" class="modal-input" maxlength="40" value="' + escapeAdminText(parts.first) + '" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="editStaffLast">Last Name</label>' +
        '<input type="text" id="editStaffLast" class="modal-input" maxlength="40" value="' + escapeAdminText(parts.last) + '" autocomplete="off"></div>' +
      '<div class="modal-field"><label for="editStaffUsername">' + (username ? 'Username' : 'Email') + '</label>' +
        '<input type="text" id="editStaffUsername" class="modal-input" value="' + escapeAdminText(staffLoginText(account)) + '" readonly></div>' +
      passwordHtml +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="closeFormModal()">Cancel</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="saveStaffEdit(\'' + id + '\')">Save Changes</button>' +
      '</div>' +
    '</div>');
}

// An admin sets a new password for a staff account without its old one (Cloud Function resetStaffPassword).
function resetStaffPassword(username, password) {
  return firebase.app().functions(JOIN_FUNCTION_REGION).httpsCallable("resetStaffPassword")({ username: username, password: password });
}

// "Reset to staff123" in Edit Staff: asks first, then resets right away (the Edit dialog stays open underneath).
function confirmResetStaffPassword(email) {
  var account = staffAccounts.find(function (item) { return item.id === email; });
  var username = account && usernameOfEmail(account.email);
  if (!username || isProtectedAccount(account.email)) return;

  showConfirmModal({
    title: "Reset this password?",
    message: staffDisplayName(account) + " (" + username + ") will sign in with " + DEFAULT_STAFF_PASSWORD +
      " and be asked to choose a new password.",
    confirmLabel: "Reset",
    onConfirm: function () {
      return resetStaffPassword(username, DEFAULT_STAFF_PASSWORD).then(function () {
        var note = document.querySelector("#formModal .staff-reset-note");
        if (!note) {
          var button = document.querySelector("#formModal .staff-reset-btn");
          if (button) button.closest(".modal-field").insertAdjacentHTML("beforebegin", '<p class="modal-help staff-reset-note"></p>');
          note = document.querySelector("#formModal .staff-reset-note");
        }
        if (note) note.textContent = "Reset to " + DEFAULT_STAFF_PASSWORD + " just now.";
        sayDone("Password reset. " + staffDisplayName(account) + " can sign in with " + DEFAULT_STAFF_PASSWORD +
          " and will be asked to choose their own.");
      }).catch(function (error) {
        console.error("Reset password failed:", error);
        say("Could not reset the password: " + staffAuthMessage(error));
      });
    }
  });
}

function saveStaffEdit(email) {
  if (staffFormBusy) return;

  var account = staffAccounts.find(function (item) { return item.id === email; });
  if (!account) return;

  var firstName = cleanPersonName(document.getElementById("editStaffFirst").value);
  var lastName = cleanPersonName(document.getElementById("editStaffLast").value);

  var problem = personNameProblem(firstName, "first name") || personNameProblem(lastName, "last name");
  if (problem) {
    say(problem);
    return;
  }

  var parts = staffNameParts(account);
  var nameChanged = firstName !== parts.first || lastName !== parts.last || !account.firstName;
  if (!nameChanged) {
    closeFormModal();
    return;
  }

  setStaffFormBusy(true);

  db.collection("staff").doc(email).update({
    firstName: firstName,
    lastName: lastName,
    name: firstName + " " + lastName,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    closeFormModal();
    renderSettings();
    sayDone("Staff updated.");
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
    message: staffDisplayName(account) + " (" + staffLoginText(account) + ") loses access to the admin console right away. You can add them again later with the same username; their password goes back to " + DEFAULT_STAFF_PASSWORD + ".",
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
  var cooldownValue = settingsCooldownDraft !== null ? settingsCooldownDraft : String(systemSettings.cancelCooldownSeconds);
  var dirty = isConfigDirty();

  var stationRowsHtml = getSortedStations().map(function (station) {
    var active = station.active !== false;
    var id = escapeAdminText(station.id);
    var badge = active ?
      '<span class="status-badge compact station-active">Active</span>' :
      '<span class="status-badge compact station-inactive">Inactive</span>';
    var toggleBtn = active ?
      '<button type="button" class="settings-btn settings-btn-red" onclick="confirmToggleStation(\'' + id + '\')">Disable</button>' :
      '<button type="button" class="settings-btn settings-btn-green" onclick="confirmToggleStation(\'' + id + '\')">Enable</button>';

    return '<tr><td class="settings-strong">' + escapeAdminText(station.name) + stationDayLimitsNoteHtml(station) + '</td>' +
      '<td>' + escapeAdminText(stationCodeOf(station.id)) + '</td>' +
      '<td class="settings-center">' + stationWindows(station) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="openEditStationModal(\'' + id + '\')">Edit</button>' + toggleBtn +
      '</div></td></tr>';
  }).join("");

  if (!stationRowsHtml) stationRowsHtml = '<tr><td colspan="5" class="empty-row">No service stations yet.</td></tr>';

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
        return '<tr><td class="settings-strong">' + escapeAdminText(staffDisplayName(account)) + '<span class="staff-login">' + escapeAdminText(staffLoginText(account)) + '</span></td>' +
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
    var lockedUntil = accountLockedUntil(account.email);

    return '<tr><td class="settings-strong">' + escapeAdminText(staffDisplayName(account)) + '</td>' +
      '<td>' + escapeAdminText(staffLoginText(account)) +
        (usernameOfEmail(account.email) ? '' : ' <span class="type-tag staff-email-tag" title="Made with an email, which can no longer sign in">Email account: re-create with a username</span>') +
        (account.mustChangePassword === true ? ' <span class="type-tag staff-temp-pw-tag" title="Still using the default or a reset password; they\'ll be asked to change it at sign-in">Default password</span>' : '') +
        (lockedUntil ? ' <span class="type-tag staff-locked-tag" title="Too many wrong passwords">Locked until ' + escapeAdminText(manilaTimeText(lockedUntil)) + '</span>' : '') + '</td>' +
      '<td>' + escapeAdminText(roleName) + '</td>' +
      '<td><div class="settings-actions">' +
        (lockedUntil ? '<button type="button" class="settings-btn settings-btn-blue" onclick="confirmUnlockStaff(\'' + id + '\')">Unlock</button>' : '') +
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

    limitRequestsPanelHtml() + // staff asking for a daily limit on one date (js/admin-limit-requests.js)

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Queue Rules &amp; Timeouts</h2></div>' +
      '<label class="settings-field-label" for="settingsTimeout">Auto-Void Timeout Minute</label>' +
      '<p class="settings-help">*Controls the number of minutes a queue entry on hold has to return to the counter. Once it runs out, staff can send a last call that gives the entry the same amount of time again. If the last call also runs out, the system automatically marks the queue entry as void.</p>' +
      '<input type="number" id="settingsTimeout" class="settings-input" min="1" max="1440" step="1" value="' + escapeAdminText(timeoutValue) + '" oninput="onTimeoutInput(this.value)">' +
      '<label class="settings-field-label" for="settingsCooldown">Cancel Cooldown (seconds)</label>' +
      '<p class="settings-help">*How long a student must wait after cancelling a ticket before they can join a queue again. 0 turns the wait off.</p>' +
      '<input type="number" id="settingsCooldown" class="settings-input" min="0" max="3600" step="1" value="' + escapeAdminText(cooldownValue) + '" oninput="onCooldownInput(this.value)">' +
    '</section>' +

    hoursPanelHtml() +

    blockedStudentsPanelHtml() +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Service Station</h2>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="openAddStationModal()">+ Add New Station</button></div>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Station</th><th>Ticket Code</th><th class="settings-center">Windows</th><th>Status</th><th>Action</th></tr></thead>' +
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
      '<p class="settings-help">' + SIGN_IN_LOCK_TEXT + '. Unlock lets them sign in again right away; resetting their password does too.</p>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Action</th></tr></thead>' +
        '<tbody>' + staffRowsHtml + '</tbody></table></div>' +
    '</section>';
}
