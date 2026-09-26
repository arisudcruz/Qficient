var queueMgmtStations = [
  { id: "cashier", label: "Cashier" },
  { id: "registrar", label: "Register" },
  { id: "admission", label: "Admission" }
];

var queueMgmtPurposes = [
  "Certificate of Registration",
  "Transcript of Records",
  "Enrollment Verification",
  "Good Moral Certificate"
];

var queueMgmtSampleData = {
  cashier: {
    serving: { queueNo: "C025", name: "John Aris A. Dela Cruz", studentType: "Transfer", purpose: "Certificate of Registration" },
    queued: [
      { queueNo: "C020", name: "John Who?", status: "skip" },
      { queueNo: "C021", name: "John Who?", status: "next" },
      { queueNo: "C022", name: "John Who?", status: "waiting" },
      { queueNo: "C023", name: "John Who?", status: "waiting" },
      { queueNo: "C024", name: "John Who?", status: "waiting" },
      { queueNo: "C025", name: "John Who?", status: "waiting" }
    ]
  },
  registrar: { serving: null, queued: [] },
  admission: { serving: null, queued: [] }
};

var activeQueueStation = "cashier";

var queueStatusLabels = {
  skip: "Skipped",
  next: "Next",
  waiting: "Waiting"
};

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

function renderQueueManagement() {
  var area = document.getElementById("adminQueueArea");
  if (!area) return;

  var stationData = queueMgmtSampleData[activeQueueStation] || { serving: null, queued: [] };
  var serving = stationData.serving;

  var tabsHtml = queueMgmtStations.map(function (station) {
    var activeClass = station.id === activeQueueStation ? " active" : "";
    return '<button type="button" class="station-tab' + activeClass + '" onclick="selectQueueStation(\'' + station.id + '\')">' +
      escapeAdminText(station.label) + '</button>';
  }).join("");

  var servingHtml = serving ?
    '<div class="serving-number">' + escapeAdminText(serving.queueNo) + '</div>' +
    '<div class="serving-details">' +
      '<div><span class="detail-label">Name</span><span class="detail-value">' + escapeAdminText(serving.name) + '</span></div>' +
      '<div><span class="detail-label">Student Type</span><span class="detail-value">' + escapeAdminText(serving.studentType) + '</span></div>' +
      '<div class="detail-full"><span class="detail-label">Purpose</span><span class="detail-value">' + escapeAdminText(serving.purpose) + '</span></div>' +
    '</div>' :
    '<div class="serving-number serving-empty">--</div>' +
    '<div class="serving-details"><div class="detail-full"><span class="detail-value">No ticket currently being served.</span></div></div>';

  var purposeOptionsHtml = '<option value="">Select Purpose</option>' + queueMgmtPurposes.map(function (purpose) {
    return '<option value="' + escapeAdminText(purpose) + '">' + escapeAdminText(purpose) + '</option>';
  }).join("");

  var stationOptionsHtml = '<option value="">Select Station</option>' + queueMgmtStations.filter(function (station) {
    return station.id !== activeQueueStation;
  }).map(function (station) {
    return '<option value="' + station.id + '">' + escapeAdminText(station.label) + '</option>';
  }).join("");

  var rowsHtml = stationData.queued.map(function (ticket) {
    return '<tr><td>' + escapeAdminText(ticket.queueNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.name) + '</td>' +
      '<td><span class="status-badge ' + ticket.status + '">' + escapeAdminText(queueStatusLabels[ticket.status] || ticket.status) + '</span></td></tr>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<tr><td colspan="3" class="empty-row">No tickets currently queued for this station.</td></tr>';

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Queue Management</div></div>' +
    '<div class="station-tabs" role="tablist">' + tabsHtml + '</div>' +
    '<div class="queue-mgmt-grid">' +
      '<section class="panel serving-panel">' +
        '<div class="serving-card">' +
          '<div class="serving-card-top">' +
            '<span class="serving-live"><span class="live-dot"></span>Currently Serving</span>' +
            '<span class="serving-time">' + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + '</span>' +
          '</div>' +
          servingHtml +
        '</div>' +
        '<div class="serving-actions">' +
          '<button type="button" class="queue-action-btn">📞 Call Next</button>' +
          '<button type="button" class="queue-action-btn">↺ Recall</button>' +
          '<button type="button" class="queue-action-btn">⏭ Skip</button>' +
          '<button type="button" class="queue-action-btn">🗑 Remove</button>' +
        '</div>' +
        '<label class="transfer-toggle-row">' +
          '<span class="switch"><input type="checkbox" id="queueTransferToggle" checked onchange="toggleQueueTransfer()"><span class="switch-track"></span></span>' +
          '<span>Transfer Ticket</span>' +
        '</label>' +
        '<div class="transfer-section" id="queueTransferSection">' +
          '<div class="transfer-form">' +
            '<div><label>Purpose</label><select>' + purposeOptionsHtml + '</select></div>' +
            '<div><label>To Station</label><select>' + stationOptionsHtml + '</select></div>' +
          '</div>' +
          '<button type="button" class="bigBtn transfer-btn">⇄ Transfer</button>' +
        '</div>' +
      '</section>' +
      '<section class="panel queued-list-panel">' +
        '<div class="panel-header"><h2>Current Queued List</h2><span class="traffic-selection">' + stationData.queued.length + ' in Queue</span></div>' +
        '<div class="table-wrap"><table class="queue-table"><thead><tr><th>Queue No.</th><th>Student</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '</section>' +
    '</div>';
}

window.addEventListener('DOMContentLoaded', function () {
  renderQueueManagement();
});
