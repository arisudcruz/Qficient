// Queue Enforcer: staff create a ticket for someone who can't do it on their own device.
var ENFORCER_TYPES = ["regular", "transferee", "guest"];

// Kept here so the form survives switching sections and the list refreshing underneath it.
var ENFORCER_OTHER_PURPOSE = "__other__";

var enforcerDraft = { firstName: "", lastName: "", studentType: "", stationId: "", purpose: "", purposeOther: "", email: "" };
var enforcerFilter = "";

function emptyEnforcerDraft(stationId) {
  return { firstName: "", lastName: "", studentType: "", stationId: stationId || "", purpose: "", purposeOther: "", email: "" };
}

function getEnforcerStations() {
  return getSortedStations().filter(function (station) { return station.active !== false; });
}

function getEnforcerPurposes(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && Array.isArray(station.purposes) && station.purposes.length ? station.purposes : queueMgmtPurposes;
}

function enforcerPurposeOptionsHtml() {
  var purposes = enforcerDraft.stationId ? getEnforcerPurposes(enforcerDraft.stationId) : [];

  var options = purposes.map(function (purpose) {
    return '<option value="' + escapeAdminText(purpose) + '"' + (purpose === enforcerDraft.purpose ? ' selected' : '') + '>' + escapeAdminText(purpose) + '</option>';
  }).join("");

  var other = enforcerDraft.stationId ?
    '<option value="' + ENFORCER_OTHER_PURPOSE + '"' + (enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ? ' selected' : '') + '>Others, please specify</option>' : '';

  return '<option value="">Select Purpose</option>' + options + other;
}

function syncEnforcerOtherField() {
  var field = document.getElementById("enforcerOtherField");
  if (field) field.style.display = enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ? "" : "none";
}

function onEnforcerInput(field, value) {
  enforcerDraft[field] = value;

  if (field === "stationId") {
    enforcerDraft.purpose = "";
    enforcerDraft.purposeOther = "";
    var purposeSelect = document.getElementById("enforcerPurpose");
    if (purposeSelect) {
      purposeSelect.innerHTML = enforcerPurposeOptionsHtml();
      purposeSelect.disabled = !value;
    }
  }

  if (field === "stationId" || field === "purpose") {
    syncEnforcerOtherField();
    if (field === "purpose" && value === ENFORCER_OTHER_PURPOSE) {
      var otherInput = document.getElementById("enforcerOther");
      if (otherInput) otherInput.focus();
    }
  }
}

// The purpose that goes on the ticket: the chosen one, or what was typed for "Others".
function enforcerFinalPurpose() {
  return enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ?
    enforcerDraft.purposeOther.trim().replace(/\s+/g, " ") :
    enforcerDraft.purpose;
}

// The station picker above the form narrows the list and pre-selects that station in the form.
function onEnforcerFilter(stationId) {
  enforcerFilter = stationId;
  if (stationId) {
    enforcerDraft.stationId = stationId;
    enforcerDraft.purpose = "";
    enforcerDraft.purposeOther = "";
  }
  renderEnforcer();
}

function clearEnforcerForm() {
  enforcerDraft = emptyEnforcerDraft(enforcerFilter);
  renderEnforcer();
}

function enforcerFormProblem() {
  var d = enforcerDraft;

  if (!/\p{L}/u.test(d.firstName.trim())) return "Please enter the first name.";
  if (!/\p{L}/u.test(d.lastName.trim())) return "Please enter the last name.";
  if (ENFORCER_TYPES.indexOf(d.studentType) === -1) return "Please select the student type.";
  if (!d.stationId) return "Please select the station.";
  if (!d.purpose) return "Please select the purpose.";
  if (d.purpose === ENFORCER_OTHER_PURPOSE && !/[\p{L}\p{N}]/u.test(d.purposeOther)) return "Please specify the purpose.";

  var emailProblem = guestEmailProblem(d.email.trim());
  return emailProblem ? emailProblem.replace("Enter", "Please enter") : "";
}

function confirmCreateManualTicket() {
  var problem = enforcerFormProblem();
  if (problem) {
    say(problem);
    return;
  }

  var d = enforcerDraft;
  var station = stations.find(function (s) { return s.id === d.stationId; });
  var name = d.firstName.trim().replace(/\s+/g, " ") + " " + d.lastName.trim().replace(/\s+/g, " ");

  showConfirmModal({
    title: "Create Ticket?",
    message: "The queue entry for " + name + " is ready to be created. It joins the " + (station ? station.name : "") + " queue and gets the next queue number.",
    confirmLabel: "Create Ticket",
    tone: "danger",
    onConfirm: function () {
      createManualTicket({
        firstName: d.firstName.trim().replace(/\s+/g, " "),
        lastName: d.lastName.trim().replace(/\s+/g, " "),
        studentType: d.studentType,
        stationId: d.stationId,
        purpose: enforcerFinalPurpose(),
        email: d.email.trim()
      }).then(function (result) {
        if (!result) return;

        enforcerDraft = emptyEnforcerDraft(enforcerFilter);
        renderEnforcer();
        say("Ticket " + result.ticketNo + " created for " + name + " at " + result.stationName + ".");
      });
    }
  });
}

function enforcerStatusClass(status) {
  return status === "cancelled" || status === "voided" ? "void" : (status || "waiting");
}

// Ticket ids ticked in the manual list. Only tickets still waiting in a queue can be ticked.
var enforcerSelection = {};

function isEnforcerSelectable(ticket) {
  return ticket.status === "waiting" || ticket.status === "skipped";
}

function getEnforcerListTickets() {
  return tickets.filter(function (ticket) {
    return ticket.manual === true && isTodayTicket(ticket) && (!enforcerFilter || ticket.stationId === enforcerFilter);
  }).sort(function (a, b) {
    return timestampToMs(b.createdAt, Date.now()) - timestampToMs(a.createdAt, Date.now());
  });
}

function getSelectedEnforcerTickets() {
  return getEnforcerListTickets().filter(function (ticket) {
    return enforcerSelection[ticket.id] && isEnforcerSelectable(ticket);
  });
}

function enforcerListRowsHtml() {
  var list = getEnforcerListTickets();

  if (!list.length) {
    return '<tr><td colspan="6" class="empty-row">No manual tickets created today.</td></tr>';
  }

  return list.map(function (ticket) {
    var selectable = isEnforcerSelectable(ticket);
    var selected = selectable && !!enforcerSelection[ticket.id];
    var id = escapeAdminText(ticket.id);

    return '<tr class="queue-row' + (selectable ? '' : ' not-selectable') + (selected ? ' selected' : '') + '"' +
      (selectable ? ' data-ticket="' + id + '" onclick="toggleEnforcerSelection(\'' + id + '\', event)"' : '') + '>' +
      '<td class="queue-select-cell"><input type="checkbox" class="queue-select-box" aria-label="Select ticket ' + escapeAdminText(ticket.ticketNo) + '"' +
        (selectable ? '' : ' disabled') + (selected ? ' checked' : '') + '></td>' +
      '<td class="settings-strong">' + escapeAdminText(ticket.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName) + '</td>' +
      '<td>' + escapeAdminText(ticket.purpose) + '</td>' +
      '<td>' + escapeAdminText(getStationName(ticket.stationId)) + '</td>' +
      '<td><span class="status-badge compact ' + enforcerStatusClass(ticket.status) + '">' + escapeAdminText(formatAdminStatus(ticket.status)) + '</span></td></tr>';
  }).join("");
}

function updateEnforcerSelectionUI() {
  var selectableIds = {};
  getEnforcerListTickets().forEach(function (ticket) {
    if (isEnforcerSelectable(ticket)) selectableIds[ticket.id] = true;
  });

  // Forget tickets that are no longer waiting (called, removed, cancelled).
  Object.keys(enforcerSelection).forEach(function (id) {
    if (!selectableIds[id]) delete enforcerSelection[id];
  });

  var selectedCount = 0;
  document.querySelectorAll("#enforcerListBody .queue-row[data-ticket]").forEach(function (row) {
    var selected = !!enforcerSelection[row.getAttribute("data-ticket")];
    row.classList.toggle("selected", selected);
    row.querySelector(".queue-select-box").checked = selected;
    if (selected) selectedCount++;
  });

  var total = Object.keys(selectableIds).length;
  var selectAll = document.getElementById("enforcerSelectAll");
  if (selectAll) {
    selectAll.disabled = total === 0;
    selectAll.checked = total > 0 && selectedCount === total;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
  }

  var actionBtn = document.getElementById("enforcerActionBtn");
  if (actionBtn) {
    actionBtn.style.display = selectedCount ? "" : "none";
    actionBtn.textContent = "Action (" + selectedCount + ")";
  }
}

function toggleEnforcerSelection(ticketId, event) {
  if (event && event.target.closest("button")) return;

  if (enforcerSelection[ticketId]) delete enforcerSelection[ticketId];
  else enforcerSelection[ticketId] = true;
  updateEnforcerSelectionUI();
}

function toggleEnforcerSelectAll(checkbox) {
  enforcerSelection = {};
  if (checkbox.checked) {
    getEnforcerListTickets().forEach(function (ticket) {
      if (isEnforcerSelectable(ticket)) enforcerSelection[ticket.id] = true;
    });
  }
  updateEnforcerSelectionUI();
}

// Enforcers manage the tickets they created, but they cannot call or skip anyone: only Prioritize, Recall and Remove.
function openEnforcerActionsModal() {
  var selected = getSelectedEnforcerTickets();
  if (!selected.length) return;

  var waitingCount = selected.filter(function (ticket) { return ticket.status === "waiting"; }).length;
  var numbers = selected.map(function (ticket) { return escapeAdminText(ticket.ticketNo); }).join(", ");

  showFormModal("Queue Actions",
    '<p class="modal-help">' + selected.length + ' ticket' + (selected.length === 1 ? '' : 's') + ' selected: ' + numbers + '</p>' +
    '<div class="queue-actions-grid">' +
      queueActionButtonHtml('\u2B06 Prioritize', "confirmEnforcerAction('prioritize')", waitingCount === 0, "Only waiting tickets can be prioritized") +
      queueActionButtonHtml('\u21BA Recall', "confirmEnforcerAction('recall')", false, "") +
      queueActionButtonHtml('\uD83D\uDDD1 Remove', "confirmEnforcerAction('remove')", false, "") +
    '</div>');
}

function confirmEnforcerAction(kind) {
  var selected = getSelectedEnforcerTickets();
  if (!selected.length) {
    closeFormModal();
    return;
  }

  var count = selected.length;
  var noun = count === 1 ? "ticket " + selected[0].ticketNo : count + " tickets";
  var ids = selected.map(function (ticket) { return ticket.id; });
  var options;

  if (kind === "prioritize") {
    var waitingIds = selected.filter(function (ticket) { return ticket.status === "waiting"; }).map(function (ticket) { return ticket.id; });
    if (!waitingIds.length) return;
    options = {
      title: "Prioritize " + (waitingIds.length === 1 ? "this ticket" : waitingIds.length + " tickets") + "?",
      message: "They move to the front of their station's queue, ahead of everyone who is not prioritized." +
        (waitingIds.length < count ? " Skipped tickets in your selection are left as they are." : ""),
      confirmLabel: "Prioritize",
      tone: "primary",
      run: function () { return prioritizeTickets(waitingIds); }
    };
  } else if (kind === "recall") {
    options = {
      title: "Recall " + noun + "?",
      message: "This records a recall for the selected " + (count === 1 ? "ticket" : "tickets") + ". Walk-ins have no device registered, so no alert is sent to them.",
      confirmLabel: "Recall",
      tone: "primary",
      run: function () { return recallTickets(ids); }
    };
  } else {
    options = {
      title: "Remove " + noun + "?",
      message: "This immediately voids the selected " + (count === 1 ? "ticket" : "tickets") + ". This cannot be undone.",
      confirmLabel: "Remove",
      tone: "danger",
      run: function () { return removeTickets(ids); }
    };
  }

  showConfirmModal({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    tone: options.tone,
    onConfirm: function () {
      options.run().then(function (done) {
        if (!done) return;
        closeFormModal();
        enforcerSelection = {};
        updateEnforcerSelectionUI();
      });
    }
  });
}

// Updates only the list, so typing in the form is never interrupted by live changes.
function refreshEnforcerList() {
  var body = document.getElementById("enforcerListBody");
  if (!body) return;

  body.innerHTML = enforcerListRowsHtml();
  updateEnforcerSelectionUI();
}

function renderEnforcer() {
  var area = document.getElementById("adminEnforcerArea");
  if (!area) return;

  var activeStations = getEnforcerStations();

  // A draft or filter pointing at a station that has since been disabled or removed is dropped.
  var valid = function (id) { return !id || activeStations.some(function (s) { return s.id === id; }); };
  if (!valid(enforcerDraft.stationId)) {
    enforcerDraft.stationId = "";
    enforcerDraft.purpose = "";
    enforcerDraft.purposeOther = "";
  }
  if (!valid(enforcerFilter)) enforcerFilter = "";

  var stationOptions = function (placeholder, selectedId) {
    return '<option value="">' + placeholder + '</option>' + activeStations.map(function (station) {
      return '<option value="' + escapeAdminText(station.id) + '"' + (station.id === selectedId ? ' selected' : '') + '>' + escapeAdminText(station.name) + '</option>';
    }).join("");
  };

  var typeOptions = '<option value="">Select Student Type</option>' + ENFORCER_TYPES.map(function (key) {
    return '<option value="' + key + '"' + (key === enforcerDraft.studentType ? ' selected' : '') + '>' + escapeAdminText(STUDENT_TYPE_LABELS[key]) + '</option>';
  }).join("");

  var d = enforcerDraft;

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Queue Enforcer</div>' +
      '<div class="settings-header-user"><span>QFicient Admin</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>' +

    '<div class="enforcer-title-row">' +
      '<h2 class="settings-title">Create Manual Queue Ticket</h2>' +
      '<select class="enforcer-station-select" aria-label="Station" onchange="onEnforcerFilter(this.value)">' + stationOptions("All Stations", enforcerFilter) + '</select>' +
    '</div>' +

    '<div class="enforcer-layout">' +
      '<div class="enforcer-main">' +
        '<section class="panel settings-panel enforcer-panel">' +
          '<div class="panel-header"><h2>Manual Queue Form</h2></div>' +
          '<p class="settings-help">Manually create a queue entry for students who are unable to create one through their device due to technical issues or system problems. The manually created queue entry is added to the active queue and assigned a queue number by the system.</p>' +
          '<div class="enforcer-form-grid">' +
            '<div class="enforcer-field"><label for="enforcerFirstName">First Name*</label><input type="text" id="enforcerFirstName" placeholder="First Name" maxlength="50" value="' + escapeAdminText(d.firstName) + '" oninput="onEnforcerInput(\'firstName\', this.value)"></div>' +
            '<div class="enforcer-field"><label for="enforcerLastName">Last Name*</label><input type="text" id="enforcerLastName" placeholder="Last Name" maxlength="50" value="' + escapeAdminText(d.lastName) + '" oninput="onEnforcerInput(\'lastName\', this.value)"></div>' +
            '<div class="enforcer-field"><label for="enforcerType">Student Type*</label><select id="enforcerType" onchange="onEnforcerInput(\'studentType\', this.value)">' + typeOptions + '</select></div>' +
            '<div class="enforcer-field enforcer-span-2"><label for="enforcerStation">Station*</label><select id="enforcerStation" onchange="onEnforcerInput(\'stationId\', this.value)">' + stationOptions("Select Station", d.stationId) + '</select></div>' +
            '<div class="enforcer-field"><label for="enforcerPurpose">Purpose*</label><select id="enforcerPurpose" onchange="onEnforcerInput(\'purpose\', this.value)"' + (d.stationId ? '' : ' disabled') + '>' + enforcerPurposeOptionsHtml() + '</select></div>' +
            '<div class="enforcer-field enforcer-span-2"><label for="enforcerEmail">Email*</label><input type="email" id="enforcerEmail" placeholder="e.g. kimfrane@gmail.com" maxlength="254" value="' + escapeAdminText(d.email) + '" oninput="onEnforcerInput(\'email\', this.value)"></div>' +
            '<div class="enforcer-field enforcer-span-all" id="enforcerOtherField"' + (d.purpose === ENFORCER_OTHER_PURPOSE ? '' : ' style="display: none"') + '><label for="enforcerOther">Please specify the purpose*</label><input type="text" id="enforcerOther" placeholder="e.g. Request for diploma" maxlength="100" value="' + escapeAdminText(d.purposeOther) + '" oninput="onEnforcerInput(\'purposeOther\', this.value)"></div>' +
          '</div>' +
          '<div class="settings-actions enforcer-form-actions">' +
            '<button type="button" class="settings-btn settings-btn-blue enforcer-clear" onclick="clearEnforcerForm()">Clear All</button>' +
            '<button type="button" class="settings-btn settings-btn-primary" onclick="confirmCreateManualTicket()">Create Ticket</button>' +
          '</div>' +
        '</section>' +

        '<section class="panel settings-panel">' +
          '<div class="panel-header"><h2>Manual Queue Lists</h2>' +
            '<div class="queued-tools"><button type="button" id="enforcerActionBtn" class="settings-btn settings-btn-primary" style="display: none" onclick="openEnforcerActionsModal()">Action</button></div></div>' +
          '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr>' +
            '<th class="queue-select-cell"><input type="checkbox" id="enforcerSelectAll" aria-label="Select all waiting tickets" onclick="toggleEnforcerSelectAll(this)"></th>' +
            '<th>Queue No.</th><th>Student</th><th>Purpose</th><th>Station</th><th>Status</th></tr></thead>' +
            '<tbody id="enforcerListBody">' + enforcerListRowsHtml() + '</tbody></table></div>' +
        '</section>' +
      '</div>' +
    '</div>';

  updateEnforcerSelectionUI();
}
