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
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && station.nowServingId ? tickets.find(function (t) { return t.id === station.nowServingId; }) : null;
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
    message: "They'll get a 1-minute window to be recalled before their ticket is automatically voided.",
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
    message: "This notifies them to return to the counter and resets their auto-void countdown.",
    confirmLabel: "Recall",
    tone: "primary",
    onConfirm: function () { recallTicket(ticketId); }
  });
}

function tickQueueCountdowns() {
  var now = Date.now();
  document.querySelectorAll(".void-countdown[data-skipped-ms]").forEach(function (el) {
    var baseMs = Number(el.getAttribute("data-skipped-ms"));
    var remainingMs = AUTO_VOID_WINDOW_MS - (now - baseMs);
    el.textContent = "Auto-void in " + formatCountdown(remainingMs);
  });
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
      (!serving || t.id !== serving.id);
  }).sort(function (a, b) {
    var aMs = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    var bMs = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return aMs - bMs;
  });

  var now = Date.now();
  var rowsHtml = queueListTickets.map(function (ticket) {
    var statusCell;
    if (ticket.status === "skipped") {
      var baseMs = (ticket.skippedAt && ticket.skippedAt.toMillis) ? ticket.skippedAt.toMillis() : now;
      var remainingMs = AUTO_VOID_WINDOW_MS - (now - baseMs);
      statusCell =
        '<div class="skip-cell">' +
          '<span class="status-badge skip">Skipped</span>' +
          '<span class="void-countdown" data-skipped-ms="' + baseMs + '">Auto-void in ' + formatCountdown(remainingMs) + '</span>' +
          '<button type="button" class="recall-inline-btn" onclick="confirmRecall(\'' + ticket.id + '\')">Recall</button>' +
        '</div>';
    } else {
      statusCell = '<span class="status-badge waiting">Waiting</span>';
    }

    return '<tr><td>' + escapeAdminText(ticket.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName) + '</td>' +
      '<td>' + statusCell + '</td></tr>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<tr><td colspan="3" class="empty-row">No tickets currently queued for this station.</td></tr>';

  var servingCardClass = "serving-card" + (serving && serving.verified ? " verified" : "");
  var verifyDisabled = !serving || serving.verified;
  var verifyLabel = serving && serving.verified ? "✓ Verified" : "✓ Verify";

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Queue Management</div></div>' +
    '<div class="station-tabs" role="tablist">' + tabsHtml + '</div>' +
    '<div class="queue-mgmt-grid">' +
      '<section class="panel serving-panel">' +
        '<div class="' + servingCardClass + '">' +
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
