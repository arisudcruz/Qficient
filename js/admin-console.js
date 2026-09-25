var adminTrafficStation = "all";

function escapeAdminText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getAdminToday() {
  var now = new Date();
  var month = String(now.getMonth() + 1).padStart(2, "0");
  var day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

function getAdminDate(value, endOfDay) {
  var date = new Date(value + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTicketDate(ticket) {
  if (!ticket.createdAt) return null;
  if (typeof ticket.createdAt.toDate === "function") return ticket.createdAt.toDate();
  var date = new Date(ticket.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getAdminFilters() {
  var startInput = document.getElementById("trafficStartDate");
  var endInput = document.getElementById("trafficEndDate");
  var today = getAdminToday();
  var startValue = startInput && startInput.value ? startInput.value : today;
  var endValue = endInput && endInput.value ? endInput.value : startValue;
  var start = getAdminDate(startValue, false);
  var end = getAdminDate(endValue, true);

  if (!start || !end || start > end) {
    startValue = today;
    endValue = today;
    start = getAdminDate(today, false);
    end = getAdminDate(today, true);
  }

  return { startValue: startValue, endValue: endValue, start: start, end: end };
}

function getFilteredTickets(filters) {
  return (tickets || []).filter(function (ticket) {
    var createdAt = getTicketDate(ticket);
    return createdAt && createdAt >= filters.start && createdAt <= filters.end;
  });
}

function getStationName(stationId) {
  var station = (stations || []).find(function (item) { return item.id === stationId; });
  return station ? station.name : stationId || "Unknown";
}

function getTrafficData(filteredTickets) {
  var traffic = (stations || []).map(function (station) {
    return { id: station.id, name: station.name, value: 0 };
  });

  filteredTickets.forEach(function (ticket) {
    var item = traffic.find(function (station) { return station.id === ticket.stationId; });
    if (!item) {
      item = { id: ticket.stationId || "unknown", name: getStationName(ticket.stationId), value: 0 };
      traffic.push(item);
    }
    item.value += 1;
  });

  return traffic;
}

function formatAdminTime(ticket) {
  var date = getTicketDate(ticket);
  return date ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "-";
}

function formatAdminStatus(status) {
  return (status || "waiting").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
}

function selectTrafficStation(stationId) {
  adminTrafficStation = stationId;
  updateAdmin();
}

function updateAdmin() {
  var area = document.getElementById("adminArea");
  if (!area) return;

  var filters = getAdminFilters();
  var filteredTickets = getFilteredTickets(filters);
  var traffic = getTrafficData(filteredTickets);
  var maxTraffic = Math.max.apply(null, traffic.map(function (item) { return item.value; }).concat([1]));
  var visibleTickets = adminTrafficStation === "all" ? filteredTickets : filteredTickets.filter(function (ticket) {
    return ticket.stationId === adminTrafficStation;
  });
  var dateLabel = filters.startValue === filters.endValue ? filters.startValue : filters.startValue + " to " + filters.endValue;

  var stats = [
    { label: "Total Queued", value: filteredTickets.length, change: dateLabel, tone: "amber", icon: "↗" },
    { label: "Completed", value: filteredTickets.filter(function (ticket) { return ticket.status === "completed" || ticket.verified; }).length, change: dateLabel, tone: "blue", icon: "↗" },
    { label: "Waiting", value: filteredTickets.filter(function (ticket) { return ticket.status === "waiting"; }).length, change: dateLabel, tone: "green", icon: "↗" },
    { label: "Cancelled", value: filteredTickets.filter(function (ticket) { return ticket.status === "cancelled"; }).length, change: dateLabel, tone: "navy", icon: "↗" }
  ];

  var cardsHtml = stats.map(function (item) {
    return '<article class="stat-card ' + item.tone + '">' +
      '<div class="stat-top"><span class="stat-label">' + item.label + '</span><span class="stat-icon">' + item.icon + '</span></div>' +
      '<div class="stat-value">' + item.value + '</div>' +
      '<div class="stat-meta"><span class="stat-dot"></span> ' + escapeAdminText(item.change) + '</div>' +
    '</article>';
  }).join("");

  var trafficHtml = '<div class="traffic-filters">' +
    '<label>From <input id="trafficStartDate" type="date" value="' + filters.startValue + '" onchange="updateAdmin()"></label>' +
    '<label>To <input id="trafficEndDate" type="date" value="' + filters.endValue + '" onchange="updateAdmin()"></label>' +
    '<button type="button" class="traffic-reset" onclick="selectTrafficStation(\'all\')">All stations</button>' +
  '</div>' +
  '<div class="chart-grid">' +
    '<div class="chart-axis"><span>' + maxTraffic + '</span><span>' + Math.round(maxTraffic * 0.75) + '</span><span>' + Math.round(maxTraffic * 0.5) + '</span><span>' + Math.round(maxTraffic * 0.25) + '</span><span>0</span></div>' +
    '<div class="chart-bars">' + traffic.map(function (item) {
      var height = item.value ? Math.max(8, (item.value / maxTraffic) * 100) : 2;
      var selected = adminTrafficStation === item.id ? " selected" : "";
      return '<button type="button" class="chart-group' + selected + '" title="' + escapeAdminText(item.name + ': ' + item.value + ' transaction' + (item.value === 1 ? '' : 's')) + '" onclick="selectTrafficStation(\'' + escapeAdminText(item.id) + '\')">' +
        '<span class="bar-fill" style="height:' + height + '%"></span><span class="bar-label">' + escapeAdminText(item.name) + '</span><span class="bar-value">' + item.value + '</span></button>';
    }).join("") + '</div>' +
  '</div>';

  var rowsHtml = visibleTickets.slice().sort(function (first, second) {
    var firstDate = getTicketDate(first) || 0;
    var secondDate = getTicketDate(second) || 0;
    return secondDate - firstDate;
  }).map(function (ticket) {
    var status = formatAdminStatus(ticket.status);
    var statusClass = (ticket.status || "waiting").toLowerCase().replace(/\s+/g, '-');
    return '<tr><td>' + escapeAdminText(ticket.ticketNo || "-") + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName || "-") + '</td>' +
      '<td>' + escapeAdminText(ticket.purpose || "-") + '</td>' +
      '<td>' + escapeAdminText(getStationName(ticket.stationId)) + '</td>' +
      '<td><span class="status-badge ' + statusClass + '">' + escapeAdminText(status) + '</span></td>' +
      '<td>' + escapeAdminText(formatAdminTime(ticket)) + '</td></tr>';
  }).join("");

  if (!rowsHtml) rowsHtml = '<tr><td colspan="6" class="empty-row">No queue transactions found for this filter.</td></tr>';

  area.innerHTML = '<div class="dashboard-header"><div class="header-greeting">Hello Admin</div></div>' +
    '<section class="stats-grid">' + cardsHtml + '</section>' +
    '<section class="panel chart-panel"><div class="panel-header"><h2>Station Traffic Analysis</h2><span class="traffic-selection">' + escapeAdminText(adminTrafficStation === "all" ? "All stations" : getStationName(adminTrafficStation)) + '</span></div>' + trafficHtml + '</section>' +
    '<section class="panel table-panel"><div class="panel-header table-header"><h2>Queue Transactions</h2><span class="traffic-selection">' + escapeAdminText(dateLabel) + '</span></div><div class="table-wrap"><table class="queue-table"><thead><tr><th>Queue No.</th><th>Student</th><th>Purpose</th><th>Station</th><th>Status</th><th>Time</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></section>';
}

window.addEventListener('DOMContentLoaded', function () {
  updateAdmin();
});
