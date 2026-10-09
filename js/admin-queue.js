var queueMgmtPurposes = [
  "Certificate of Registration",
  "Transcript of Records",
  "Enrollment Verification",
  "Good Moral Certificate"
];

var activeQueueStation = "cashier";
var autoVoidIntervalId = null;

// The transfer form lives inside a panel that re-renders on every live update, so its state is kept here.
var queueTransfer = { open: false, stationId: "", purpose: "" };

function resetQueueTransfer() {
  queueTransfer = { open: false, stationId: "", purpose: "" };
}

// Ticket ids ticked in the queued list; kept here because the list re-renders on every live update.
var queueSelection = {};

// The stations this person may run: all of them for an admin, only their own for Queue Management staff.
function manageableStations() {
  return stations.filter(function (station) { return canServeStation(station.id); });
}

function selectQueueStation(stationId) {
  if (!canServeStation(stationId)) return refuseStation();

  activeQueueStation = stationId;
  resetQueueTransfer();
  queueSelection = {};
  renderQueueManagement();
}

function getQueueListTickets() {
  var serving = getServingTicket(activeQueueStation);

  return tickets.filter(function (t) {
    return t.stationId === activeQueueStation &&
      (t.status === "waiting" || t.status === "skipped") &&
      isTodayTicket(t) &&
      (!serving || t.id !== serving.id);
  }).sort(compareQueueOrder);
}

function getSelectedQueueTickets() {
  return getQueueListTickets().filter(function (t) { return queueSelection[t.id]; });
}

function updateQueueSelectionUI() {
  var listTickets = getQueueListTickets();
  var selectedCount = 0;

  // Forget tickets that left the list (served, cancelled, removed).
  var valid = {};
  listTickets.forEach(function (t) { valid[t.id] = true; });
  Object.keys(queueSelection).forEach(function (id) {
    if (!valid[id]) delete queueSelection[id];
  });

  document.querySelectorAll("#adminQueueArea .queue-row[data-ticket]").forEach(function (row) {
    var selected = !!queueSelection[row.getAttribute("data-ticket")];
    row.classList.toggle("selected", selected);
    row.querySelector(".queue-select-box").checked = selected;
    if (selected) selectedCount++;
  });

  var selectAll = document.getElementById("queueSelectAll");
  if (selectAll) {
    selectAll.checked = listTickets.length > 0 && selectedCount === listTickets.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < listTickets.length;
  }

  var actionBtn = document.getElementById("queueActionBtn");
  if (actionBtn) {
    actionBtn.style.display = selectedCount ? "" : "none";
    actionBtn.textContent = "Action (" + selectedCount + ")";
  }
}

function toggleQueueSelection(ticketId, event) {
  if (event && event.target.closest("button")) return;

  if (queueSelection[ticketId]) delete queueSelection[ticketId];
  else queueSelection[ticketId] = true;
  updateQueueSelectionUI();
}

function toggleQueueSelectAll(checkbox) {
  queueSelection = {};
  if (checkbox.checked) {
    getQueueListTickets().forEach(function (t) { queueSelection[t.id] = true; });
  }
  updateQueueSelectionUI();
}

function queueActionButtonHtml(label, onclick, disabled, title) {
  return '<button type="button" class="queue-action-btn"' + (disabled ? ' disabled' : '') +
    (title ? ' title="' + escapeAdminText(title) + '"' : '') + ' onclick="' + onclick + '">' + label + '</button>';
}

function openQueueActionsModal() {
  var selected = getSelectedQueueTickets();
  if (!selected.length) return;

  var waitingCount = selected.filter(function (t) { return t.status === "waiting"; }).length;
  var numbers = selected.map(function (t) { return escapeAdminText(t.ticketNo); }).join(", ");

  showFormModal("Queue Actions",
    '<p class="modal-help">' + selected.length + ' ticket' + (selected.length === 1 ? '' : 's') + ' selected: ' + numbers + '</p>' +
    '<div class="queue-actions-grid">' +
      queueActionButtonHtml('📞 Call Next', "confirmSelectedAction('call')", selected.length > 1, "Call Next works on one ticket at a time") +
      queueActionButtonHtml('⬆ Prioritize', "confirmSelectedAction('prioritize')", waitingCount === 0, "Only waiting tickets can be prioritized") +
      queueActionButtonHtml('↺ Recall', "confirmSelectedAction('recall')", false, "") +
      queueActionButtonHtml('🗑 Remove', "confirmSelectedAction('remove')", false, "") +
    '</div>' +
    (selected.length > 1 ? '<p class="modal-help queue-actions-note">Call Next is only available when a single ticket is selected.</p>' : ''));
}

function confirmSelectedAction(kind) {
  var selected = getSelectedQueueTickets();
  if (!selected.length) {
    closeFormModal();
    return;
  }

  var count = selected.length;
  var noun = count === 1 ? "ticket " + selected[0].ticketNo : count + " tickets";
  var stationId = activeQueueStation;
  var ids = selected.map(function (t) { return t.id; });
  var options;

  if (kind === "call") {
    if (count !== 1) return;
    var serving = getServingTicket(stationId);
    options = {
      title: "Call ticket " + selected[0].ticketNo + " next?",
      message: (serving ? "This marks ticket " + serving.ticketNo + " as completed and calls " : "This calls ") +
        selected[0].ticketNo + " now, ahead of the rest of the queue.",
      confirmLabel: "Call Next",
      tone: "primary",
      run: function () { return callSelectedTicket(stationId, ids[0]); }
    };
  } else if (kind === "prioritize") {
    var waitingIds = selected.filter(function (t) { return t.status === "waiting"; }).map(function (t) { return t.id; });
    if (!waitingIds.length) return;
    options = {
      title: "Prioritize " + (waitingIds.length === 1 ? "this ticket" : waitingIds.length + " tickets") + "?",
      message: "They move to the front of the queue, ahead of everyone who isn't prioritized." +
        (waitingIds.length < count ? " Skipped tickets in your selection are left as they are." : ""),
      confirmLabel: "Prioritize",
      tone: "primary",
      run: function () { return prioritizeTickets(waitingIds); }
    };
  } else if (kind === "recall") {
    options = {
      title: "Recall " + noun + "?",
      message: "This notifies them to go to the counter. It doesn't change any countdown.",
      confirmLabel: "Recall",
      tone: "primary",
      run: function () { return recallTickets(ids); }
    };
  } else {
    options = {
      title: "Remove " + noun + "?",
      message: "This immediately voids the selected " + (count === 1 ? "ticket" : "tickets") + ". This can't be undone.",
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
        queueSelection = {};
        updateQueueSelectionUI();
      });
    }
  });
}

function toggleQueueTransfer() {
  var checkbox = document.getElementById("queueTransferToggle");
  var section = document.getElementById("queueTransferSection");
  if (checkbox && section) {
    queueTransfer.open = checkbox.checked;
    section.style.display = checkbox.checked ? "" : "none";
  }
}

function getTransferPurposes(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && Array.isArray(station.purposes) ? station.purposes : [];
}

function transferPurposeOptionsHtml(stationId) {
  var purposes = getTransferPurposes(stationId);
  var placeholder = (!stationId || purposes.length) ? "Select Purpose" : "Keep current purpose";

  return '<option value="">' + placeholder + '</option>' + purposes.map(function (purpose) {
    return '<option value="' + escapeAdminText(purpose) + '"' + (purpose === queueTransfer.purpose ? ' selected' : '') + '>' + escapeAdminText(purpose) + '</option>';
  }).join("");
}

function onTransferStationChange(select) {
  queueTransfer.stationId = select.value;
  queueTransfer.purpose = "";

  var purposeSelect = document.getElementById("queueTransferPurpose");
  if (purposeSelect) {
    purposeSelect.innerHTML = transferPurposeOptionsHtml(queueTransfer.stationId);
    purposeSelect.disabled = !queueTransfer.stationId;
  }
}

function onTransferPurposeChange(select) {
  queueTransfer.purpose = select.value;
}

function confirmTransfer(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  var dest = stations.find(function (s) { return s.id === queueTransfer.stationId; });
  if (!dest) {
    say("Please choose the station to transfer to.");
    return;
  }
  if (getTransferPurposes(dest.id).length && !queueTransfer.purpose) {
    say("Please select the purpose for " + dest.name + ".");
    return;
  }

  showConfirmModal({
    title: "Transfer ticket " + serving.ticketNo + "?",
    message: "This sends " + serving.ownerName + "'s ticket to " + dest.name + " at the back of its queue. They get a new queue number there and will need to be verified again.",
    confirmLabel: "Transfer",
    tone: "primary",
    onConfirm: function () {
      transferServingTicket(stationId, dest.id, queueTransfer.purpose).then(function (result) {
        if (!result) return;
        resetQueueTransfer();
        renderQueueManagement();
      });
    }
  });
}

function getServingTicket(stationId) {
  return servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
}

function confirmCallNext(stationId) {
  var serving = getServingTicket(stationId);

  showConfirmModal({
    title: serving ? "Call the next ticket?" : "Call the first ticket?",
    message: serving ?
      "This marks ticket " + serving.ticketNo + " as completed and calls the next person in line." :
      "This calls the next waiting ticket for this station.",
    confirmLabel: "Call Next",
    tone: "primary",
    onConfirm: function () { callNextTicket(stationId); }
  });
}

function confirmVerify(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving || serving.verified) return;

  showConfirmModal({
    title: "Verify ticket " + serving.ticketNo + "?",
    message: "This marks " + serving.ownerName + "'s ticket as verified.",
    confirmLabel: "Verify",
    tone: "primary",
    onConfirm: function () { verifyCurrentTicket(stationId); }
  });
}

function confirmSkip(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) return;

  showConfirmModal({
    title: "Skip ticket " + serving.ticketNo + "?",
    message: "They'll have " + formatVoidWindow() + " to return to the counter. After that you can give them a last call before the ticket is voided.",
    confirmLabel: "Skip",
    tone: "danger",
    onConfirm: function () { skipCurrentTicket(stationId); }
  });
}

function confirmRemove(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) return;

  showConfirmModal({
    title: "Remove ticket " + serving.ticketNo + "?",
    message: "This immediately voids the ticket. This can't be undone.",
    confirmLabel: "Remove",
    tone: "danger",
    onConfirm: function () { removeCurrentTicket(stationId); }
  });
}

function confirmRecall(ticketId) {
  if (!ticketId) return;
  var ticket = tickets.find(function (t) { return t.id === ticketId; });

  showConfirmModal({
    title: "Recall ticket " + (ticket ? ticket.ticketNo : "") + "?",
    message: "This notifies them to go to the counter. It doesn't change their countdown.",
    confirmLabel: "Recall",
    tone: "primary",
    onConfirm: function () { recallTicket(ticketId); }
  });
}

function confirmLastCall(ticketId) {
  var ticket = tickets.find(function (t) { return t.id === ticketId; });
  if (!ticket) return;

  showConfirmModal({
    title: "Last call for ticket " + ticket.ticketNo + "?",
    message: "This gives them one last chance to return to the counter. If they don't respond within " + formatVoidWindow() + ", the ticket is voided.",
    confirmLabel: "Last Call",
    tone: "danger",
    onConfirm: function () { lastCallTicket(ticketId); }
  });
}

function tickQueueCountdowns() {
  var now = Date.now();
  var needsRender = false;

  document.querySelectorAll(".void-countdown[data-base-ms]").forEach(function (el) {
    var phase = el.getAttribute("data-phase");
    var remainingMs = AUTO_VOID_WINDOW_MS - (now - Number(el.getAttribute("data-base-ms")));

    if (phase === "initial" && remainingMs <= 0) {
      needsRender = true;
      return;
    }

    el.textContent = (phase === "final" ? "Last chance, voids in " : "Respond within ") + formatCountdown(remainingMs);
  });

  if (needsRender) renderQueueManagement();
}

function startAutoVoidWatcher() {
  if (autoVoidIntervalId) return;
  autoVoidIntervalId = setInterval(function () {
    checkAutoVoid();
    tickQueueCountdowns();
  }, 1000);
}

function stopAutoVoidWatcher() {
  if (autoVoidIntervalId) {
    clearInterval(autoVoidIntervalId);
    autoVoidIntervalId = null;
  }
}

function renderQueueManagement() {
  var area = document.getElementById("adminQueueArea");
  if (!area) return;

  var visibleStations = manageableStations();
  if (visibleStations.length && !visibleStations.find(function (s) { return s.id === activeQueueStation; })) {
    activeQueueStation = visibleStations[0].id;
  }

  var serving = getServingTicket(activeQueueStation);

  var tabsHtml = visibleStations.map(function (s) {
    var activeClass = s.id === activeQueueStation ? " active" : "";
    return '<button type="button" class="station-tab' + activeClass + '" onclick="selectQueueStation(\'' + s.id + '\')">' +
      escapeAdminText(s.name) + '</button>';
  }).join("");

  var servingHtml = serving ?
    '<div class="serving-number">' + escapeAdminText(serving.ticketNo) + '</div>' +
    '<div class="serving-details">' +
      '<div><span class="detail-label">Name</span><span class="detail-value">' + escapeAdminText(serving.ownerName) + '</span>' +
        (serving.studentNumber ? '<span class="detail-subvalue">' + escapeAdminText(serving.studentNumber) + '</span>' : '') +
      '</div>' +
      '<div><span class="detail-label">Student Type</span><span class="detail-value">' + escapeAdminText(STUDENT_TYPE_LABELS[serving.studentType] || serving.studentType || "—") + '</span></div>' +
      '<div class="detail-full"><span class="detail-label">Purpose</span><span class="detail-value">' + escapeAdminText(serving.purpose || "—") + '</span></div>' +
    '</div>' :
    '<div class="serving-number serving-empty">--</div>' +
    '<div class="serving-details"><div class="detail-full"><span class="detail-value">No ticket currently being served.</span></div></div>';

  var purposeOptionsHtml = transferPurposeOptionsHtml(queueTransfer.stationId);

  var stationOptionsHtml = '<option value="">Select Station</option>' + stations.filter(function (s) {
    return s.id !== activeQueueStation && s.active !== false;
  }).map(function (s) {
    return '<option value="' + escapeAdminText(s.id) + '"' + (s.id === queueTransfer.stationId ? ' selected' : '') + '>' + escapeAdminText(s.name) + '</option>';
  }).join("");

  var queueListTickets = getQueueListTickets();

  var rowsHtml = queueListTickets.map(function (ticket) {
    var statusCell;
    if (ticket.status === "skipped") {
      var skip = getSkipPhase(ticket);
      var countdownHtml;
      var lastCallHtml = "";

      if (skip.phase === "initial") {
        countdownHtml = '<span class="void-countdown" data-phase="initial" data-base-ms="' + skip.baseMs + '">Respond within ' + formatCountdown(skip.remainingMs) + '</span>';
      } else if (skip.phase === "final") {
        countdownHtml = '<span class="void-countdown" data-phase="final" data-base-ms="' + skip.baseMs + '">Last chance, voids in ' + formatCountdown(skip.remainingMs) + '</span>';
      } else {
        countdownHtml = '<span class="void-countdown">Time is up</span>';
        lastCallHtml = '<button type="button" class="last-call-btn" onclick="confirmLastCall(\'' + ticket.id + '\')">Last Call</button>';
      }

      statusCell =
        '<div class="skip-cell">' +
          '<span class="status-badge skip">Skipped</span>' +
          countdownHtml +
          '<button type="button" class="recall-inline-btn" onclick="confirmRecall(\'' + ticket.id + '\')">Recall</button>' +
          lastCallHtml +
        '</div>';
    } else {
      statusCell = '<span class="status-badge waiting">Waiting</span>';
    }

    // Regular tickets stay plain; only the other types are marked.
    var typeClass = (ticket.studentType === "transferee" || ticket.studentType === "guest") ? ' queue-row-' + ticket.studentType : '';
    var typeTag = typeClass ? ' <span class="type-tag">' + escapeAdminText(STUDENT_TYPE_SHORT_LABELS[ticket.studentType]) + '</span>' : '';
    var priorityTag = (ticket.prioritizedAt && ticket.status === "waiting") ? ' <span class="type-tag priority-tag">★ Priority</span>' : '';
    var id = escapeAdminText(ticket.id);

    return '<tr class="queue-row' + typeClass + (queueSelection[ticket.id] ? ' selected' : '') + '" data-ticket="' + id + '" onclick="toggleQueueSelection(\'' + id + '\', event)">' +
      '<td class="queue-select-cell"><input type="checkbox" class="queue-select-box" aria-label="Select ticket ' + escapeAdminText(ticket.ticketNo) + '"' + (queueSelection[ticket.id] ? ' checked' : '') + '></td>' +
      '<td class="queue-row-no">' + escapeAdminText(ticket.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName) + typeTag + priorityTag + '</td>' +
      '<td>' + statusCell + '</td></tr>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<tr><td colspan="4" class="empty-row">No tickets currently queued for this station.</td></tr>';

  var verifyDisabled = !serving || serving.verified;
  var verifyLabel = serving && serving.verified ? "✓ Verified" : "✓ Verify";

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Queue Management</div></div>' +
    '<div class="station-tabs" role="tablist">' + tabsHtml + '</div>' +
    '<div class="queue-mgmt-grid">' +
      '<section class="panel serving-panel">' +
        '<div class="serving-card' + (serving && STUDENT_TYPE_LABELS[serving.studentType] ? ' serving-type-' + serving.studentType : '') + '">' +
          '<div class="serving-card-top">' +
            '<span class="serving-live"><span class="live-dot"></span>Currently Serving</span>' +
            '<span class="serving-time">' + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + '</span>' +
          '</div>' +
          servingHtml +
        '</div>' +
        '<div class="serving-actions">' +
          '<button type="button" class="queue-action-btn queue-action-verify"' + (verifyDisabled ? ' disabled' : '') + ' onclick="confirmVerify(\'' + activeQueueStation + '\')">' + verifyLabel + '</button>' +
          '<button type="button" class="queue-action-btn" onclick="confirmCallNext(\'' + activeQueueStation + '\')">📞 Call Next</button>' +
          '<button type="button" class="queue-action-btn"' + (serving ? '' : ' disabled') + ' onclick="confirmRecall(\'' + (serving ? serving.id : '') + '\')">↺ Recall</button>' +
          '<button type="button" class="queue-action-btn"' + (serving ? '' : ' disabled') + ' onclick="confirmSkip(\'' + activeQueueStation + '\')">⏭ Skip</button>' +
          '<button type="button" class="queue-action-btn"' + (serving ? '' : ' disabled') + ' onclick="confirmRemove(\'' + activeQueueStation + '\')">🗑 Remove</button>' +
        '</div>' +
        '<label class="transfer-toggle-row">' +
          '<span class="switch"><input type="checkbox" id="queueTransferToggle"' + (queueTransfer.open ? ' checked' : '') + ' onchange="toggleQueueTransfer()"><span class="switch-track"></span></span>' +
          '<span>Transfer Ticket</span>' +
        '</label>' +
        '<div class="transfer-section" id="queueTransferSection" style="' + (queueTransfer.open ? '' : 'display: none') + '">' +
          '<div class="transfer-form">' +
            '<div><label>Purpose</label><select id="queueTransferPurpose" onchange="onTransferPurposeChange(this)"' + (queueTransfer.stationId ? '' : ' disabled') + '>' + purposeOptionsHtml + '</select></div>' +
            '<div><label>To Station</label><select id="queueTransferStation" onchange="onTransferStationChange(this)">' + stationOptionsHtml + '</select></div>' +
          '</div>' +
          '<button type="button" class="bigBtn transfer-btn"' + (serving ? '' : ' disabled') + ' onclick="confirmTransfer(\'' + activeQueueStation + '\')">⇄ Transfer</button>' +
        '</div>' +
      '</section>' +
      '<section class="panel queued-list-panel">' +
        '<div class="panel-header"><h2>Current Queued List</h2>' +
          '<div class="queued-tools"><span class="traffic-selection">' + queueListTickets.length + ' in Queue</span>' +
          '<button type="button" id="queueActionBtn" class="settings-btn settings-btn-primary" style="display: none" onclick="openQueueActionsModal()">Action</button></div></div>' +
        '<div class="table-wrap"><table class="queue-table"><thead><tr>' +
          '<th class="queue-select-cell"><input type="checkbox" id="queueSelectAll" aria-label="Select all tickets" onclick="toggleQueueSelectAll(this)"></th>' +
          '<th>Queue No.</th><th>Student</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '</section>' +
    '</div>';

  updateQueueSelectionUI();
}

window.addEventListener('DOMContentLoaded', function () {
  renderQueueManagement();
});
