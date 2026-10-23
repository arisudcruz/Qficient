// The admin Dashboard (#/admin/dashboard): key performance indicators for a date range and a station.
// Station staff only ever see their own station (canViewStationData). Every number comes from the tickets
// already loaded for the console (the last ADMIN_HISTORY_DAYS days).
//
// Times are per station visit: a transfer or an enrollment step gives the ticket a new number and a fresh
// createdAt at the next station, so wait = servingAt - createdAt and service = completedAt - servingAt.

var dashStation = "all"; // "all" or a station id

var DASH_FIRST_HOUR = 7;  // the hourly chart always shows at least 7 AM to 7 PM
var DASH_LAST_HOUR = 19;

function setDashStation(stationId) {
  dashStation = stationId || "all";
  updateAdmin();
}

function resetDashFilters() {
  dashStation = "all";
  var start = document.getElementById("trafficStartDate");
  var end = document.getElementById("trafficEndDate");
  if (start) start.value = "";
  if (end) end.value = "";
  updateAdmin();
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

// The stations this person may see, narrowed by the Station filter.
function dashStations() {
  return getSortedStations().filter(function (station) {
    return canViewStationData(station.id) && (dashStation === "all" || station.id === dashStation);
  });
}

function dashInStation(ticket) {
  return canViewStationData(ticket.stationId) && (dashStation === "all" || ticket.stationId === dashStation);
}

function getFilteredTickets(filters) {
  return (tickets || []).filter(function (ticket) {
    var createdAt = getTicketDate(ticket);
    return createdAt && createdAt >= filters.start && createdAt <= filters.end && dashInStation(ticket);
  });
}

function waitMs(ticket) {
  var created = timestampToMs(ticket.createdAt, 0);
  var serving = timestampToMs(ticket.servingAt, 0);
  return created && serving && serving >= created ? serving - created : null;
}

function serviceMs(ticket) {
  var serving = timestampToMs(ticket.servingAt, 0);
  var completed = timestampToMs(ticket.completedAt, 0);
  return ticket.status === "completed" && serving && completed && completed >= serving ? completed - serving : null;
}

function averageOf(values) {
  var list = values.filter(function (v) { return v !== null; });
  if (!list.length) return null;
  return list.reduce(function (sum, v) { return sum + v; }, 0) / list.length;
}

// 95000 -> "1m 35s", 4000000 -> "1h 07m"
function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  var totalSeconds = Math.round(ms / 1000);
  var hours = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds % 3600) / 60);
  var seconds = totalSeconds % 60;
  if (hours) return hours + "h " + String(minutes).padStart(2, "0") + "m";
  if (minutes) return minutes + "m " + String(seconds).padStart(2, "0") + "s";
  return seconds + "s";
}

function percentText(part, whole) {
  return whole ? Math.round((part / whole) * 100) + "%" : "—";
}

// The Manila hour (0-23) a ticket was made.
function ticketHour(ticket) {
  var ms = timestampToMs(ticket.createdAt, 0);
  return ms ? new Date(ms + QUEUE_TZ_OFFSET_MS).getUTCHours() : null;
}

function hourLabel(hour) {
  var h = hour % 12 === 0 ? 12 : hour % 12;
  return h + (hour < 12 ? " AM" : " PM");
}

function countBy(list, test) {
  return list.filter(test).length;
}

// Live numbers: who is in line today, whatever the date range.
function liveWaiting(stationId) {
  return (tickets || []).filter(function (t) {
    return (t.status === "waiting" || t.status === "skipped") && isTodayTicket(t) &&
      (stationId ? t.stationId === stationId : dashInStation(t));
  }).length;
}

function kpiCardHtml(card) {
  return '<article class="kpi-card kpi-' + card.tone + '">' +
    '<span class="kpi-label">' + escapeAdminText(card.label) + '</span>' +
    '<span class="kpi-value">' + escapeAdminText(card.value) + '</span>' +
    '<span class="kpi-sub">' + escapeAdminText(card.sub) + '</span>' +
  '</article>';
}

function hourlyChartHtml(list) {
  var counts = {};
  list.forEach(function (t) {
    var hour = ticketHour(t);
    if (hour !== null) counts[hour] = (counts[hour] || 0) + 1;
  });

  var hours = Object.keys(counts).map(Number);
  var first = Math.min.apply(null, hours.concat([DASH_FIRST_HOUR]));
  var last = Math.max.apply(null, hours.concat([DASH_LAST_HOUR]));
  var max = Math.max.apply(null, hours.map(function (h) { return counts[h]; }).concat([1]));
  var peak = hours.length ? hours.reduce(function (best, h) { return counts[h] > counts[best] ? h : best; }, hours[0]) : null;

  var bars = "";
  for (var h = first; h <= last; h++) {
    var value = counts[h] || 0;
    bars += '<div class="hour-bar' + (h === peak ? ' is-peak' : '') + '" title="' + escapeAdminText(hourLabel(h) + ": " + value + " ticket" + (value === 1 ? "" : "s")) + '">' +
      '<span class="hour-value">' + (value || "") + '</span>' +
      '<span class="hour-fill" style="height:' + (value ? Math.max(4, (value / max) * 100) : 0) + '%"></span>' +
      '<span class="hour-label">' + hourLabel(h).replace(" ", "<br>") + '</span>' +
    '</div>';
  }

  return '<section class="panel dash-panel">' +
    '<div class="panel-header"><h2>Tickets per Hour</h2>' +
      '<span class="traffic-selection">' + (peak === null ? 'No tickets yet' : 'Peak: ' + hourLabel(peak) + ' (' + counts[peak] + ')') + '</span></div>' +
    '<div class="hour-chart" role="img" aria-label="Tickets per hour">' + bars + '</div>' +
  '</section>';
}

function enrollmentPanelHtml(list) {
  var enrolling = list.filter(function (t) { return t.enrollment === true; });
  var done = countBy(enrolling, function (t) { return t.status === "completed"; });
  var active = countBy(enrolling, function (t) { return ACTIVE_TICKET_STATUSES.indexOf(t.status) !== -1; });

  var types = ENROLLMENT_TYPES.map(function (type) {
    var ofType = enrolling.filter(function (t) { return t.studentType === type; });
    return '<li><span>' + escapeAdminText(STUDENT_TYPE_LABELS[type]) + '</span>' +
      '<b>' + ofType.length + '</b>' +
      '<small>' + countBy(ofType, function (t) { return t.status === "completed"; }) + ' done</small></li>';
  }).join("");

  return '<section class="panel dash-panel">' +
    '<div class="panel-header"><h2>Enrollment</h2><span class="traffic-selection">' + percentText(done, enrolling.length) + ' completed</span></div>' +
    '<div class="enroll-stats">' +
      '<div><b>' + enrolling.length + '</b><span>Started</span></div>' +
      '<div><b>' + done + '</b><span>Completed</span></div>' +
      '<div><b>' + active + '</b><span>In progress</span></div>' +
    '</div>' +
    '<ul class="enroll-types">' + types + '</ul>' +
  '</section>';
}

function stationTableHtml(list) {
  var rows = dashStations().map(function (station) {
    var mine = list.filter(function (t) { return t.stationId === station.id; });
    var served = countBy(mine, function (t) { return t.status === "completed"; });
    var voided = countBy(mine, function (t) { return t.status === "void" || t.status === "cancelled"; });
    var serving = servingTicketOf(station);

    var cells = [
      ["Station", '<span class="settings-strong">' + escapeAdminText(station.name) + '</span>' + (station.active === false ? ' <span class="type-tag">Off</span>' : '')],
      ["Waiting now", String(liveWaiting(station.id))],
      ["Now serving", serving ? escapeAdminText(serving.ticketNo) : "—"],
      ["Served", String(served)],
      ["Avg wait", formatDuration(averageOf(mine.map(waitMs)))],
      ["Avg service", formatDuration(averageOf(mine.map(serviceMs)))],
      ["Void rate", percentText(voided, mine.length)]
    ];
    return '<tr>' + cells.map(function (c) { return '<td data-label="' + c[0] + '">' + c[1] + '</td>'; }).join("") + '</tr>';
  }).join("");

  if (!rows) rows = '<tr><td colspan="7" class="empty-row">No stations to show.</td></tr>';

  return '<section class="panel dash-panel dash-stations">' +
    '<div class="panel-header"><h2>Stations</h2></div>' +
    '<div class="table-wrap"><table class="queue-table dash-table"><thead><tr>' +
      '<th>Station</th><th>Waiting now</th><th>Now serving</th><th>Served</th><th>Avg wait</th><th>Avg service</th><th>Void rate</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
  '</section>';
}

function updateAdmin() {
  if (typeof backfillStationCodes === "function") backfillStationCodes();

  var area = document.getElementById("adminArea");
  if (!area) return;

  // A station filter that no longer exists (or isn't theirs) falls back to all.
  if (dashStation !== "all" && !getSortedStations().some(function (s) { return s.id === dashStation && canViewStationData(s.id); })) {
    dashStation = "all";
  }

  var filters = getAdminFilters();
  var list = getFilteredTickets(filters);
  var dateLabel = filters.startValue === filters.endValue ? filters.startValue : filters.startValue + " to " + filters.endValue;

  var completed = countBy(list, function (t) { return t.status === "completed"; });
  var voided = countBy(list, function (t) { return t.status === "void" || t.status === "cancelled"; });
  var waits = list.map(waitMs).filter(function (v) { return v !== null; });

  var cards = [
    { label: "Total Tickets", value: String(list.length), sub: dateLabel, tone: "navy" },
    { label: "Completed", value: String(completed), sub: "transactions finished", tone: "green" },
    { label: "Waiting Now", value: String(liveWaiting()), sub: "in line right now", tone: "amber" },
    { label: "Completion Rate", value: percentText(completed, list.length), sub: "of all tickets", tone: "green" },
    { label: "Void / No-show", value: percentText(voided, list.length), sub: voided + " removed, expired or cancelled", tone: "red" },
    { label: "Avg Wait", value: formatDuration(averageOf(waits)), sub: "ticket made → called", tone: "blue" },
    { label: "Avg Service", value: formatDuration(averageOf(list.map(serviceMs))), sub: "called → done", tone: "blue" },
    { label: "Longest Wait", value: formatDuration(waits.length ? Math.max.apply(null, waits) : null), sub: "before being called", tone: "amber" }
  ];

  var minDate = queueDayKey(Date.now() - (ADMIN_HISTORY_DAYS - 1) * DAY_MS);
  var today = getAdminToday();
  var stationFilter = adminKind() === "station" ? "" :
    '<label>Station <select class="dash-station" onchange="setDashStation(this.value)">' +
      '<option value="all">All stations</option>' +
      getSortedStations().map(function (s) {
        return '<option value="' + escapeAdminText(s.id) + '"' + (s.id === dashStation ? ' selected' : '') + '>' + escapeAdminText(s.name) + '</option>';
      }).join("") +
    '</select></label>';

  var greeting = adminKind() === "enforcer" ? "Hello Enforcer" :
    adminKind() === "station" ? "Hello " + getStationName(adminRole) + " Staff" : "Hello Admin";

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">' + escapeAdminText(greeting) + '</div>' + adminHeaderRightHtml() + '</div>' +
    '<div class="traffic-filters dash-filters">' +
      '<label>From <input id="trafficStartDate" type="date" min="' + minDate + '" max="' + today + '" value="' + filters.startValue + '" onchange="updateAdmin()"></label>' +
      '<label>To <input id="trafficEndDate" type="date" min="' + minDate + '" max="' + today + '" value="' + filters.endValue + '" onchange="updateAdmin()"></label>' +
      stationFilter +
      '<button type="button" class="traffic-reset" onclick="resetDashFilters()">Today</button>' +
    '</div>' +
    '<section class="kpi-grid">' + cards.map(kpiCardHtml).join("") + '</section>' +
    '<p class="dash-note">Times are per station visit: a transfer or the next enrollment step starts a new wait at the next station.</p>' +
    '<div class="dash-row">' + hourlyChartHtml(list) + enrollmentPanelHtml(list) + '</div>' +
    stationTableHtml(list);
}

window.addEventListener("DOMContentLoaded", function () {
  updateAdmin();
});
