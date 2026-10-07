var enforcerStations = ["Cashier", "Registrar", "Admission"];

var enforcerManualTickets = [
  { queueNo: "C024", student: "Mik Frane", purpose: "Tuition Fee", station: "Cashier" },
  { queueNo: "R024", student: "Aris Dela Cruz", purpose: "Tuition Fee", station: "Registrar" },
  { queueNo: "A024", student: "Mugiwara no Luffy", purpose: "Tuition Fee", station: "Admission" },
  { queueNo: "C025", student: "Kai Sotto", purpose: "Tuition Fee", station: "Cashier" }
];

function renderEnforcer() {
  var area = document.getElementById("adminEnforcerArea");
  if (!area) return;

  var purposes = ["Tuition Fee"].concat(queueMgmtPurposes);

  var stationOptions = function (placeholder) {
    return '<option value="" disabled selected>' + placeholder + '</option>' + enforcerStations.map(function (name) {
      return '<option>' + escapeAdminText(name) + '</option>';
    }).join("");
  };

  var typeOptions = '<option value="" disabled selected>Select Student Type</option>' +
    Object.keys(STUDENT_TYPE_LABELS).map(function (key) {
      return '<option>' + escapeAdminText(STUDENT_TYPE_LABELS[key]) + '</option>';
    }).join("");

  var purposeOptions = '<option value="" disabled selected>Select Purpose</option>' + purposes.map(function (purpose) {
    return '<option>' + escapeAdminText(purpose) + '</option>';
  }).join("");

  var headerStationOptions = enforcerStations.map(function (name) {
    return '<option>' + escapeAdminText(name) + '</option>';
  }).join("");

  var rowsHtml = enforcerManualTickets.map(function (ticket) {
    return '<tr><td class="settings-strong">' + escapeAdminText(ticket.queueNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.student) + '</td>' +
      '<td>' + escapeAdminText(ticket.purpose) + '</td>' +
      '<td>' + escapeAdminText(ticket.station) + '</td>' +
      '<td><span class="status-badge compact queued">Waiting</span></td></tr>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Queue Enforcer</div>' +
      '<div class="settings-header-user"><span>QFicient Admin</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>' +

    '<div class="enforcer-title-row">' +
      '<h2 class="settings-title">Create Manual Queue Ticket</h2>' +
      '<select class="enforcer-station-select">' + headerStationOptions + '</select>' +
    '</div>' +

    '<div class="enforcer-layout">' +
      '<div class="enforcer-main">' +
        '<section class="panel settings-panel enforcer-panel">' +
          '<div class="panel-header"><h2>Manual Queue Form</h2></div>' +
          '<p class="settings-help">Manually create a queue entry for students who are unable to create one through their device due to technical issues or system problems. The manually created queue entry is added to the active queue and assigned a queue number by the system.</p>' +
          '<div class="enforcer-form-grid">' +
            '<div class="enforcer-field"><label>First Name*</label><input type="text" placeholder="First Name"></div>' +
            '<div class="enforcer-field"><label>Last Name*</label><input type="text" placeholder="Last Name"></div>' +
            '<div class="enforcer-field"><label>Student Type*</label><select>' + typeOptions + '</select></div>' +
            '<div class="enforcer-field enforcer-span-2"><label>Station*</label><select>' + stationOptions("Select Station") + '</select></div>' +
            '<div class="enforcer-field"><label>Purpose*</label><select>' + purposeOptions + '</select></div>' +
            '<div class="enforcer-field enforcer-span-2"><label>Email*</label><input type="email" placeholder="e.g. kimfrane@gmail.com"></div>' +
          '</div>' +
          '<div class="settings-actions enforcer-form-actions">' +
            '<button type="button" class="settings-btn settings-btn-blue enforcer-clear">Clear All</button>' +
            '<button type="button" class="settings-btn settings-btn-primary">Create Ticket</button>' +
          '</div>' +
        '</section>' +

        '<section class="panel settings-panel">' +
          '<div class="panel-header"><h2>Manual Queue Lists</h2></div>' +
          '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr>' +
            '<th>Queue No.</th><th>Student</th><th>Purpose</th><th>Station</th><th>Status</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table></div>' +
        '</section>' +
      '</div>' +
    '</div>';
}
