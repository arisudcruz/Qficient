// Enrollment Settings (#/admin/enrollmentsettings, admins only): for each student type, the stations an enrolling
// student goes through, in order. Saved in settings/enrollment as { flows: { regular: [...], transferee: [...] } }.
// A student keeps the order that was set when they started, so changes here only affect new enrollments.

var enrollmentSettingsType = "regular";
var enrollmentFlowDrafts = {}; // unsaved edits per student type; kept while live updates arrive

var ENROLLMENT_TYPE_LABELS = { regular: "Regular", transferee: "Transferee / Irregular" };
var ENROLLMENT_FLOW_MAX = 20;

function enrollmentDraftFor(type) {
  return enrollmentFlowDrafts[type] ? enrollmentFlowDrafts[type] : enrollmentFlowFor(type).slice();
}

function enrollmentSettingsDirty() {
  return ENROLLMENT_TYPES.some(function (type) {
    return enrollmentFlowDrafts[type] && JSON.stringify(enrollmentFlowDrafts[type]) !== JSON.stringify(enrollmentFlowFor(type));
  });
}

function setEnrollmentSettingsType(type) {
  enrollmentSettingsType = ENROLLMENT_TYPES.indexOf(type) !== -1 ? type : "regular";
  renderEnrollmentSettings();
}

function editEnrollmentDraft(change) {
  var draft = enrollmentDraftFor(enrollmentSettingsType).slice();
  change(draft);
  enrollmentFlowDrafts[enrollmentSettingsType] = draft;
  renderEnrollmentSettings();
}

function moveEnrollmentStep(index, delta) {
  editEnrollmentDraft(function (draft) {
    var to = index + delta;
    if (to < 0 || to >= draft.length) return;
    var item = draft.splice(index, 1)[0];
    draft.splice(to, 0, item);
  });
}

function removeEnrollmentStep(index) {
  editEnrollmentDraft(function (draft) { draft.splice(index, 1); });
}

function addEnrollmentStep() {
  var select = document.getElementById("enrollmentAddStation");
  var stationId = select ? select.value : "";
  if (!stationId) {
    say("Please choose a station to add.");
    return;
  }
  editEnrollmentDraft(function (draft) {
    if (draft.indexOf(stationId) === -1 && draft.length < ENROLLMENT_FLOW_MAX) draft.push(stationId);
  });
}

function resetEnrollmentSettings() {
  enrollmentFlowDrafts = {};
  renderEnrollmentSettings();
}

function confirmSaveEnrollmentSettings() {
  if (!enrollmentSettingsDirty()) return;

  var flows = {};
  ENROLLMENT_TYPES.forEach(function (type) { flows[type] = enrollmentDraftFor(type); });

  var missing = [];
  ENROLLMENT_TYPES.forEach(function (type) {
    flows[type].forEach(function (id) {
      if (!stations.some(function (s) { return s.id === id; })) missing.push(id);
    });
  });
  if (missing.length) {
    say("Remove the stations that no longer exist before saving.");
    return;
  }

  showConfirmModal({
    title: "Save the enrollment process?",
    message: "New enrollments follow these steps. Students who are already enrolling keep the steps they started with.",
    confirmLabel: "Save Changes",
    tone: "primary",
    onConfirm: function () {
      return db.collection("settings").doc("enrollment").set({
        flows: flows,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        enrollmentFlowDrafts = {};
        sayDone("Enrollment process saved.");
        renderEnrollmentSettings();
      }).catch(function (error) {
        say("Could not save the enrollment process: " + error.message);
      });
    }
  });
}

function renderEnrollmentSettings() {
  var area = document.getElementById("adminEnrollmentSettingsArea");
  if (!area || area.style.display === "none") return;

  var type = enrollmentSettingsType;
  var draft = enrollmentDraftFor(type);
  var dirty = enrollmentSettingsDirty();

  var typeOptions = ENROLLMENT_TYPES.map(function (key) {
    return '<option value="' + key + '"' + (key === type ? ' selected' : '') + '>' + ENROLLMENT_TYPE_LABELS[key] + '</option>';
  }).join("");

  var rowsHtml = draft.map(function (stationId, index) {
    var station = stations.find(function (s) { return s.id === stationId; });
    var name = station ? station.name : "Removed station";
    var note = !station ? ' <span class="enrollment-step-note">no longer exists</span>' :
      station.active === false ? ' <span class="enrollment-step-note">disabled</span>' : '';

    return '<li class="enrollment-step' + (station ? '' : ' is-missing') + '">' +
      '<span class="enrollment-step-no">' + (index + 1) + '</span>' +
      '<span class="enrollment-step-name">' + escapeAdminText(name) + note + '</span>' +
      '<span class="enrollment-step-tools">' +
        '<button type="button" title="Move up" aria-label="Move ' + escapeAdminText(name) + ' up"' + (index === 0 ? ' disabled' : '') + ' onclick="moveEnrollmentStep(' + index + ', -1)">↑</button>' +
        '<button type="button" title="Move down" aria-label="Move ' + escapeAdminText(name) + ' down"' + (index === draft.length - 1 ? ' disabled' : '') + ' onclick="moveEnrollmentStep(' + index + ', 1)">↓</button>' +
        '<button type="button" class="enrollment-step-remove" title="Remove" aria-label="Remove ' + escapeAdminText(name) + '" onclick="removeEnrollmentStep(' + index + ')">✕</button>' +
      '</span>' +
    '</li>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<li class="enrollment-step-empty">No stations yet. ' + ENROLLMENT_TYPE_LABELS[type] + ' students can\'t start an enrollment until at least one is added.</li>';

  var available = getSortedStations().filter(function (s) { return draft.indexOf(s.id) === -1; });
  var addOptions = '<option value="">Select Station</option>' + available.map(function (s) {
    return '<option value="' + escapeAdminText(s.id) + '">' + escapeAdminText(s.name) + (s.active === false ? ' (disabled)' : '') + '</option>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Enrollment Settings</div>' + adminHeaderRightHtml() + '</div>' +
    '<div class="settings-config-head">' +
      '<div><h2 class="settings-title">Enrollment Configuration</h2>' +
        '<p class="settings-sub">Set the stations each student type goes through to enroll, in order.</p></div>' +
    '</div>' +
    '<section class="panel settings-panel enrollment-config">' +
      '<div class="enrollment-config-grid">' +
        '<div>' +
          '<div class="panel-header"><h2>Enrollment Process</h2>' +
            '<select class="queue-type-filter" aria-label="Student type" onchange="setEnrollmentSettingsType(this.value)">' + typeOptions + '</select></div>' +
          '<p class="settings-help">Use the arrows to change the order of stations. When a station finishes with a student, they are sent to the next one automatically.</p>' +
          '<ol class="enrollment-steps">' + rowsHtml + '</ol>' +
          '<div class="settings-actions enrollment-config-actions">' +
            '<button type="button" class="settings-btn ' + (dirty ? 'settings-btn-slate' : 'settings-btn-muted') + '"' + (dirty ? '' : ' disabled') + ' onclick="resetEnrollmentSettings()">Reset</button>' +
            '<button type="button" class="settings-btn ' + (dirty ? 'settings-btn-primary' : 'settings-btn-muted') + '"' + (dirty ? '' : ' disabled') + ' onclick="confirmSaveEnrollmentSettings()">Save Changes</button>' +
          '</div>' +
        '</div>' +
        '<div class="enrollment-add">' +
          '<h3 class="modal-section-title">Add Station</h3>' +
          '<label class="settings-field-label" for="enrollmentAddStation">Station Name</label>' +
          '<select id="enrollmentAddStation" class="settings-select">' + addOptions + '</select>' +
          '<div class="settings-actions modal-actions-end">' +
            '<button type="button" class="settings-btn settings-btn-primary"' + (available.length && draft.length < ENROLLMENT_FLOW_MAX ? '' : ' disabled') + ' onclick="addEnrollmentStep()">Add Station</button>' +
          '</div>' +
          '<p class="settings-help">New stations are created in Settings → Service Station.</p>' +
        '</div>' +
      '</div>' +
    '</section>';
}
