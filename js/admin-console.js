function updateAdmin() {
  var area = document.getElementById("adminArea");
  if (!area) return;

  var stats = [
    { label: "Total Queued", value: "124", change: "vs yesterday", tone: "amber", icon: "↗" },
    { label: "Completed", value: "124", change: "vs yesterday", tone: "blue", icon: "↗" },
    { label: "Skipped", value: "124", change: "vs yesterday", tone: "green", icon: "↗" },
    { label: "Voided", value: "124", change: "vs yesterday", tone: "navy", icon: "↗" }
  ];

  var traffic = [
    { name: "Cashier", value: 400 },
    { name: "Registrar", value: 300 },
    { name: "Admission", value: 200 }
  ];

  var rows = [
    { ticket: "C024", student: "JeAr Deia Cruz", purpose: "Tuition Fee", station: "Cashier", status: "Active", time: "10:45 AM" },
    { ticket: "R018", student: "Mik Frane", purpose: "Transcript", station: "Registrar", status: "Waiting", time: "10:42 AM" },
    { ticket: "A005", student: "John Who?", purpose: "Enrollment", station: "Admission", status: "Completed", time: "10:30 AM" },
    { ticket: "C020", student: "Jane Who?", purpose: "Misc Fee", station: "Cashier", status: "Skip", time: "10:25 AM" },
    { ticket: "A021", student: "Who’s Who?", purpose: "Misc Fee", station: "Cashier", status: "Void", time: "10:20 AM" }
  ];

  var cardsHtml = stats.map(function (item) {
    return '<article class="stat-card ' + item.tone + '">' +
      '<div class="stat-top">' +
        '<span class="stat-label">' + item.label + '</span>' +
        '<span class="stat-icon">' + item.icon + '</span>' +
      '</div>' +
      '<div class="stat-value">' + item.value + '</div>' +
      '<div class="stat-meta"><span class="stat-dot"></span> ' + item.change + '</div>' +
    '</article>';
  }).join("");

  var trafficHtml = '<div class="chart-grid">' +
    '<div class="chart-axis">' +
      '<span>400</span><span>300</span><span>200</span><span>100</span><span>0</span>' +
    '</div>' +
    '<div class="chart-bars">' +
      traffic.map(function (item) {
        var height = Math.max(42, Math.min(100, (item.value / 400) * 100));
        return '<div class="chart-group"><div class="bar-fill" style="height:' + height + '%"></div><div class="bar-label">' + item.name + '</div></div>';
      }).join("") +
    '</div>' +
  '</div>';

  var rowsHtml = rows.map(function (row) {
    var statusClass = row.status.toLowerCase().replace(/\s+/g, '-');
    return '<tr>' +
      '<td>' + row.ticket + '</td>' +
      '<td>' + row.student + '</td>' +
      '<td>' + row.purpose + '</td>' +
      '<td>' + row.station + '</td>' +
      '<td><span class="status-badge ' + statusClass + '">' + row.status + '</span></td>' +
      '<td>' + row.time + '</td>' +
    '</tr>';
  }).join("");

  area.innerHTML = '<div class="dashboard-header">' +
    '<div class="header-greeting">Hello Admin</div>' +
    '<div class="header-filters">' +
      '<div class="mini-filter"><span>📅</span><span>22/09/2026</span></div>' +
      '<div class="mini-filter"><span>📅</span><span>22/09/2026</span></div>' +
    '</div>' +
  '</div>' +
  '<section class="stats-grid">' + cardsHtml + '</section>' +
  '<section class="panel chart-panel">' +
    '<div class="panel-header">' +
      '<h2>Station Traffic Analysis</h2>' +
      '<div class="panel-tools">' +
        '<div class="mini-filter"><span>📅</span><span>22/09/2026</span></div>' +
        '<div class="mini-filter"><span>📅</span><span>Today</span></div>' +
      '</div>' +
    '</div>' +
    trafficHtml +
  '</section>' +
  '<section class="panel table-panel">' +
    '<div class="panel-header table-header">' +
      '<div class="search-box">Search Student</div>' +
      '<div class="panel-tools">' +
        '<div class="mini-filter"><span>⌕</span><span>22/09/2026</span></div>' +
        '<div class="mini-filter"><span>📅</span><span>Today</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="table-wrap">' +
      '<table class="queue-table">' +
        '<thead><tr><th>Queue No.</th><th>Student</th><th>Purpose</th><th>Station</th><th>Status</th><th>Time</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>' +
  '</section>';
}

window.addEventListener('DOMContentLoaded', function () {
  updateAdmin();
});
