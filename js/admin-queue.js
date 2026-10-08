var queueMgmtPurposes = [
  "Certificate of Registration",
  "Transcript of Records",
  "Enrollment Verification",
  "Good Moral Certificate"
];

var activeQueueStation = "cashier";
var autoVoidIntervalId = null;

function selectQueueStation(stationId) {
  activeQueueStation = stationId;
  renderQueueManagement();
}

function toggleQueueTransfer() {
  var checkbox = document.getElementById("queueTransferToggle");
  var section = document.getElementById("queueTransferSection");
  if (checkbox && section) {
    section.style.display = checkbox.checked ? "" : "none";
  }
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

  if (stations.length && !stations.find(function (s) { return s.id === activeQueueStation; })) {
    activeQueueStation = stations[0].id;
  }

  var serving = getServingTicket(activeQueueStation);

  var tabsHtml = stations.map(function (s) {
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

  var purposeOptionsHtml = '<option value="">Select Purpose</option>' + queueMgmtPurposes.map(function (purpose) {
    return '<option value="' + escapeAdminText(purpose) + '">' + escapeAdminText(purpose) + '</option>';
  }).join("");

  var stationOptionsHtml = '<option value="">Select Station</option>' + stations.filter(function (s) {
    return s.id !== activeQueueStation;
  }).map(function (s) {
    return '<option value="' + s.id + '">' + escapeAdminText(s.name) + '</option>';
  }).join("");

  var queueListTickets = tickets.filter(function (t) {
    return t.stationId === activeQueueStation &&
      (t.status === "waiting" || t.status === "skipped") &&
      isTodayTicket(t) &&
      (!serving || t.id !== serving.id);
  }).sort(function (a, b) {
    var aMs = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    var bMs = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return aMs - bMs;
  });

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

    return '<tr><td>' + escapeAdminText(ticket.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName) + '</td>' +
      '<td>' + statusCell + '</td></tr>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<tr><td colspan="3" class="empty-row">No tickets currently queued for this station.</td></tr>';

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
          '<span class="switch"><input type="checkbox" id="queueTransferToggle" onchange="toggleQueueTransfer()"><span class="switch-track"></span></span>' +
          '<span>Transfer Ticket</span>' +
        '</label>' +
        '<div class="transfer-section" id="queueTransferSection" style="display: none">' +
          '<div class="transfer-form">' +
            '<div><label>Purpose</label><select>' + purposeOptionsHtml + '</select></div>' +
            '<div><label>To Station</label><select>' + stationOptionsHtml + '</select></div>' +
          '</div>' +
          '<button type="button" class="bigBtn transfer-btn">⇄ Transfer</button>' +
        '</div>' +
      '</section>' +
      '<section class="panel queued-list-panel">' +
        '<div class="panel-header"><h2>Current Queued List</h2><span class="traffic-selection">' + queueListTickets.length + ' in Queue</span></div>' +
        '<div class="table-wrap"><table class="queue-table"><thead><tr><th>Queue No.</th><th>Student</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '</section>' +
    '</div>';
}

window.addEventListener('DOMContentLoaded', function () {
  renderQueueManagement();
});
