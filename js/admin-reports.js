// Reports: a summary per station and a day-by-day breakdown for a chosen range of Philippine queue days, with
// PDF and Excel downloads. Admins see every station; Queue Management staff see only their own.
// The tickets are read fresh from Firestore when a report is generated, so any range (up to REPORT_MAX_DAYS) works.

var REPORT_MAX_DAYS = 92;

// Export libraries are only downloaded when someone exports, with an integrity check on each file.
var REPORT_LIBS = {
  xlsx: [{ src: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", integrity: "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw" }],
  pdf: [
    { src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", integrity: "sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk" },
    { src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js", integrity: "sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3" }
  ]
};

var reportDraft = null;   // the filters on screen
var reportResult = null;  // the last generated report

function resetReportState() {
  reportDraft = null;
  reportResult = null;
}

function reportStationChoices() {
  if (adminKind() === "station") return stations.filter(function (s) { return s.id === adminRole; });
  return getSortedStations();
}

function ensureReportDraft() {
  if (reportDraft) return reportDraft;
  var today = getAdminToday();
  reportDraft = { start: today, end: today, stationId: adminKind() === "station" ? adminRole : "all" };
  return reportDraft;
}

function onReportInput(field, value) {
  ensureReportDraft()[field] = value;
}

/* ---------- Numbers ---------- */

function reportOutcome(ticket) {
  if (ticket.status === "completed") return "served";
  if (ticket.status === "cancelled") return "cancelled";
  if (ticket.status === "void") return ticket.autoVoided || ticket.staleCleanup ? "expired" : "removed";
  return "active";
}

function emptyReportRow(label) {
  return { label: label, issued: 0, served: 0, cancelled: 0, removed: 0, expired: 0, active: 0, transferredOut: 0, waitSum: 0, waitCount: 0, serviceSum: 0, serviceCount: 0 };
}

// A queue day ends at midnight, so a gap longer than this is bad data (a test ticket, a clock problem), not a wait.
var REPORT_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

function addToReportRow(row, ticket) {
  row.issued += 1;
  row[reportOutcome(ticket)] += 1;

  var created = timestampToMs(ticket.createdAt, 0);
  var servingAt = timestampToMs(ticket.servingAt, 0);
  var completedAt = timestampToMs(ticket.completedAt, 0);

  if (created && servingAt && servingAt >= created && servingAt - created <= REPORT_MAX_DURATION_MS) {
    row.waitSum += servingAt - created;
    row.waitCount += 1;
  }
  if (ticket.status === "completed" && servingAt && completedAt && completedAt >= servingAt && completedAt - servingAt <= REPORT_MAX_DURATION_MS) {
    row.serviceSum += completedAt - servingAt;
    row.serviceCount += 1;
  }
}

function reportAverage(sum, count) {
  return count ? sum / count : null;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  var totalSeconds = Math.round(ms / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  if (minutes >= 60) return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

function buildReport(allTickets, draft) {
  var stationIds = draft.stationId === "all" ? null : [draft.stationId];
  var visible = allTickets.filter(function (t) {
    return canViewStationData(t.stationId) && (!stationIds || stationIds.indexOf(t.stationId) !== -1);
  });

  var byStation = {};
  var byDay = {};
  var total = emptyReportRow("All stations");

  reportStationChoices().forEach(function (s) {
    if (!stationIds || stationIds.indexOf(s.id) !== -1) byStation[s.id] = emptyReportRow(s.name);
  });

  visible.forEach(function (ticket) {
    var stationRow = byStation[ticket.stationId] || (byStation[ticket.stationId] = emptyReportRow(getStationName(ticket.stationId)));
    var day = queueDayKey(timestampToMs(ticket.createdAt, 0));
    var dayRow = byDay[day] || (byDay[day] = emptyReportRow(day));

    addToReportRow(stationRow, ticket);
    addToReportRow(dayRow, ticket);
    addToReportRow(total, ticket);
  });

  // Tickets sent away from a station still count where they ended up; the source station sees them here.
  allTickets.forEach(function (ticket) {
    if (ticket.transferredFrom && byStation[ticket.transferredFrom] && canViewStationData(ticket.transferredFrom)) {
      byStation[ticket.transferredFrom].transferredOut += 1;
    }
  });
  total.transferredOut = Object.keys(byStation).reduce(function (sum, id) { return sum + byStation[id].transferredOut; }, 0);

  return {
    draft: { start: draft.start, end: draft.end, stationId: draft.stationId },
    stationLabel: draft.stationId === "all" ? "All stations" : getStationName(draft.stationId),
    generatedAt: new Date(),
    total: total,
    stations: Object.keys(byStation).map(function (id) { return byStation[id]; })
      .sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); }),
    days: Object.keys(byDay).sort().map(function (day) { return byDay[day]; })
  };
}

/* ---------- Generating ---------- */

function generateReport() {
  var draft = ensureReportDraft();
  var start = getAdminDate(draft.start, false);
  var end = getAdminDate(draft.end, true);

  if (!start || !end) {
    say("Please choose a start and end date.");
    return;
  }
  if (start > end) {
    say("Please make sure the start date is before the end date.");
    return;
  }
  if ((end - start) / DAY_MS > REPORT_MAX_DAYS) {
    say("Please choose a range of " + REPORT_MAX_DAYS + " days or less.");
    return;
  }

  var button = document.getElementById("reportGenerateBtn");
  setButtonLoading(button, true);

  db.collection("tickets")
    .where("createdAt", ">=", firebase.firestore.Timestamp.fromMillis(start.getTime()))
    .where("createdAt", "<=", firebase.firestore.Timestamp.fromMillis(end.getTime()))
    .get()
    .then(function (snapshot) {
      var found = snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
      reportResult = buildReport(found, draft);
      renderReports();
    })
    .catch(function (error) {
      say("Could not generate the report: " + error.message);
    })
    .then(function () {
      setButtonLoading(document.getElementById("reportGenerateBtn"), false);
    });
}

/* ---------- Screen ---------- */

function reportRowCells(row) {
  return [
    row.issued, row.served, row.cancelled, row.removed, row.expired, row.active,
    formatDuration(reportAverage(row.waitSum, row.waitCount)),
    formatDuration(reportAverage(row.serviceSum, row.serviceCount))
  ];
}

var REPORT_COLUMNS = ["Issued", "Served", "Cancelled", "Removed", "Expired", "Still in queue", "Avg. wait", "Avg. service"];

function reportTableHtml(firstHeader, rows, total, withTransfers) {
  var head = '<tr><th>' + firstHeader + '</th>' + REPORT_COLUMNS.map(function (c) { return '<th>' + c + '</th>'; }).join("") +
    (withTransfers ? '<th>Transferred out</th>' : '') + '</tr>';

  var body = rows.map(function (row) {
    return '<tr><td class="settings-strong">' + escapeAdminText(row.label) + '</td>' +
      reportRowCells(row).map(function (v) { return '<td>' + escapeAdminText(v) + '</td>'; }).join("") +
      (withTransfers ? '<td>' + row.transferredOut + '</td>' : '') + '</tr>';
  }).join("");

  if (!rows.length) body = '<tr><td colspan="' + (REPORT_COLUMNS.length + 2) + '" class="empty-row">No tickets in this range.</td></tr>';

  var foot = total ? '<tr class="report-total"><td>Total</td>' + reportRowCells(total).map(function (v) { return '<td>' + escapeAdminText(v) + '</td>'; }).join("") +
    (withTransfers ? '<td>' + total.transferredOut + '</td>' : '') + '</tr>' : '';

  return '<div class="table-wrap"><table class="queue-table settings-table report-table"><thead>' + head + '</thead><tbody>' + body + '</tbody>' +
    (foot ? '<tfoot>' + foot + '</tfoot>' : '') + '</table></div>';
}

function renderReports() {
  var area = document.getElementById("adminReportsArea");
  if (!area) return;

  var draft = ensureReportDraft();
  var choices = reportStationChoices();
  var stationOptions = (adminKind() === "station" ? '' : '<option value="all"' + (draft.stationId === "all" ? ' selected' : '') + '>All stations</option>') +
    choices.map(function (s) {
      return '<option value="' + escapeAdminText(s.id) + '"' + (draft.stationId === s.id ? ' selected' : '') + '>' + escapeAdminText(s.name) + '</option>';
    }).join("");

  var r = reportResult;
  var resultHtml;

  if (!r) {
    resultHtml = '<div class="settings-empty"><div class="settings-empty-icon">📊</div><p>Choose the dates and press Generate Report.</p></div>';
  } else {
    var t = r.total;
    var cards = [
      { label: "Tickets Issued", value: t.issued, tone: "amber" },
      { label: "Served", value: t.served, tone: "green" },
      { label: "Cancelled", value: t.cancelled, tone: "navy" },
      { label: "Removed / Expired", value: (t.removed + t.expired), tone: "blue" },
      { label: "Avg. Wait", value: formatDuration(reportAverage(t.waitSum, t.waitCount)), tone: "blue" },
      { label: "Avg. Service", value: formatDuration(reportAverage(t.serviceSum, t.serviceCount)), tone: "green" }
    ];

    resultHtml =
      '<p class="report-caption">' + escapeAdminText(r.stationLabel) + ' · ' + escapeAdminText(r.draft.start === r.draft.end ? r.draft.start : r.draft.start + " to " + r.draft.end) +
        ' · generated ' + escapeAdminText(r.generatedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" })) + '</p>' +
      '<section class="report-cards">' + cards.map(function (c) {
        return '<article class="stat-card ' + c.tone + '"><div class="stat-top"><span class="stat-label">' + c.label + '</span></div><div class="stat-value">' + escapeAdminText(c.value) + '</div></article>';
      }).join("") + '</section>' +
      '<section class="panel settings-panel"><div class="panel-header"><h2>Summary per Station</h2></div>' +
        reportTableHtml("Station", r.stations, t, true) + '</section>' +
      '<section class="panel settings-panel"><div class="panel-header"><h2>Daily Summary</h2></div>' +
        reportTableHtml("Date", r.days, t, false) + '</section>' +
      '<p class="report-note">Avg. wait is from getting the ticket to being called. Avg. service is from being called to the end of the transaction. Expired tickets ran out of time after a last call, or were left over at the end of the day.</p>';
  }

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Reports</div>' + adminHeaderRightHtml() + '</div>' +
    '<section class="panel settings-panel">' +
      '<div class="report-filters">' +
        '<label>From<input type="date" id="reportStart" value="' + escapeAdminText(draft.start) + '" onchange="onReportInput(\'start\', this.value)"></label>' +
        '<label>To<input type="date" id="reportEnd" value="' + escapeAdminText(draft.end) + '" onchange="onReportInput(\'end\', this.value)"></label>' +
        '<label>Station<select id="reportStation" onchange="onReportInput(\'stationId\', this.value)"' + (adminKind() === "station" ? ' disabled' : '') + '>' + stationOptions + '</select></label>' +
        '<button type="button" class="settings-btn settings-btn-primary" id="reportGenerateBtn" onclick="generateReport()">Generate Report</button>' +
        '<span class="report-filters-spacer"></span>' +
        '<button type="button" class="settings-btn settings-btn-blue" id="reportPdfBtn" onclick="exportReportPdf()"' + (r ? '' : ' disabled') + '>Export PDF</button>' +
        '<button type="button" class="settings-btn settings-btn-green" id="reportXlsxBtn" onclick="exportReportExcel()"' + (r ? '' : ' disabled') + '>Export Excel</button>' +
      '</div>' +
    '</section>' +
    resultHtml;
}

/* ---------- Exports ---------- */

function loadReportLibs(kind) {
  return REPORT_LIBS[kind].reduce(function (chain, lib) {
    return chain.then(function () {
      if (document.querySelector('script[data-report-lib="' + lib.src + '"]')) return null;
      return new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = lib.src;
        script.integrity = lib.integrity;
        script.crossOrigin = "anonymous";
        script.setAttribute("data-report-lib", lib.src);
        script.onload = resolve;
        script.onerror = function () { script.remove(); reject(new Error("the export tool could not be downloaded. Check the connection.")); };
        document.head.appendChild(script);
      });
    });
  }, Promise.resolve());
}

function reportFileName(ext) {
  var r = reportResult;
  var station = r.draft.stationId === "all" ? "all-stations" : String(r.draft.stationId);
  var range = r.draft.start === r.draft.end ? r.draft.start : r.draft.start + "_to_" + r.draft.end;
  return "QFicient-report_" + station + "_" + range + "." + ext;
}

function reportSheetRows(firstHeader, rows, total, withTransfers) {
  var header = [firstHeader].concat(REPORT_COLUMNS, withTransfers ? ["Transferred out"] : []);
  var data = rows.map(function (row) {
    return [row.label].concat(reportRowCells(row), withTransfers ? [row.transferredOut] : []);
  });
  data.push(["Total"].concat(reportRowCells(total), withTransfers ? [total.transferredOut] : []));
  return [header].concat(data);
}

function exportReportExcel() {
  if (!reportResult) return;
  var button = document.getElementById("reportXlsxBtn");
  setButtonLoading(button, true);

  loadReportLibs("xlsx").then(function () {
    var r = reportResult;
    var book = XLSX.utils.book_new();
    var info = [
      ["QFicient Queue Report"],
      ["Station", r.stationLabel],
      ["From", r.draft.start],
      ["To", r.draft.end],
      ["Generated", r.generatedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" })]
    ];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(info.concat([[]], reportSheetRows("Station", r.stations, r.total, true))), "Per Station");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(reportSheetRows("Date", r.days, r.total, false)), "Daily");
    XLSX.writeFile(book, reportFileName("xlsx"));
  }).catch(function (error) {
    say("Could not export the report: " + error.message);
  }).then(function () {
    setButtonLoading(document.getElementById("reportXlsxBtn"), false);
  });
}

function exportReportPdf() {
  if (!reportResult) return;
  var button = document.getElementById("reportPdfBtn");
  setButtonLoading(button, true);

  loadReportLibs("pdf").then(function () {
    var r = reportResult;
    var doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    var navy = [0, 84, 166];

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(23, 32, 51);
    doc.text("QFicient Queue Report", 40, 48);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(r.stationLabel + "   |   " + (r.draft.start === r.draft.end ? r.draft.start : r.draft.start + " to " + r.draft.end) +
      "   |   Generated " + r.generatedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" }), 40, 66);

    var t = r.total;
    doc.setFontSize(11);
    doc.setTextColor(23, 32, 51);
    doc.text("Issued: " + t.issued + "    Served: " + t.served + "    Cancelled: " + t.cancelled + "    Removed: " + t.removed +
      "    Expired: " + t.expired + "    Avg. wait: " + formatDuration(reportAverage(t.waitSum, t.waitCount)) +
      "    Avg. service: " + formatDuration(reportAverage(t.serviceSum, t.serviceCount)), 40, 90);

    var station = reportSheetRows("Station", r.stations, t, true);
    doc.autoTable({
      startY: 106,
      head: [station[0]],
      body: station.slice(1),
      theme: "grid",
      headStyles: { fillColor: navy, textColor: 255 },
      styles: { fontSize: 9 },
      didParseCell: function (data) {
        if (data.section === "body" && data.row.index === station.length - 2) data.cell.styles.fontStyle = "bold";
      }
    });

    var daily = reportSheetRows("Date", r.days, t, false);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Daily Summary", 40, doc.lastAutoTable.finalY + 28);
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 36,
      head: [daily[0]],
      body: daily.slice(1),
      theme: "grid",
      headStyles: { fillColor: navy, textColor: 255 },
      styles: { fontSize: 9 },
      didParseCell: function (data) {
        if (data.section === "body" && data.row.index === daily.length - 2) data.cell.styles.fontStyle = "bold";
      }
    });

    doc.save(reportFileName("pdf"));
  }).catch(function (error) {
    say("Could not export the report: " + error.message);
  }).then(function () {
    setButtonLoading(document.getElementById("reportPdfBtn"), false);
  });
}
