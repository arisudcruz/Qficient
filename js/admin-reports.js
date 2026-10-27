// Reports: KPIs, a summary per station, per day, per hour and per student type, and an enrollment summary, for a
// chosen range of Philippine queue days, with PDF and Excel downloads. Before generating, staff tick what the report
// should include; the screen and both downloads show only those parts. Admins see every station; Queue
// Management staff see only their own.
// The tickets are read fresh from Firestore when a report is generated, so any range (up to REPORT_MAX_DAYS) works.
// Wait and service times are per station visit, the same as on the Dashboard (waitMs / serviceMs).

var REPORT_MAX_DAYS = 92;

// Export libraries are only downloaded when someone exports, with an integrity check on each file.
var REPORT_LIBS = {
  xlsx: [{ src: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", integrity: "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw" }],
  pdf: [
    { src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", integrity: "sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk" },
    { src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js", integrity: "sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3" }
  ]
};

// The data that can go into a report. Each ticked item is a KPI card and a column in every table; Peak Hour is
// a whole-report figure, so it is a card only.
var REPORT_FIELDS = [
  { key: "issued", label: "Tickets Issued", tone: "amber", value: function (row) { return row.issued; } },
  { key: "served", label: "Served", tone: "green", value: function (row) { return row.served; } },
  { key: "cancelled", label: "Cancelled", tone: "navy", value: function (row) { return row.cancelled; } },
  { key: "removed", label: "Removed", tone: "blue", value: function (row) { return row.removed; } },
  { key: "voided", label: "Voided", tone: "blue", value: function (row) { return row.voided; } },
  { key: "completionRate", label: "Completion Rate", tone: "green", value: function (row) { return percentText(row.served, row.issued); } },
  { key: "voidRate", label: "Void / No-show Rate", tone: "navy", value: function (row) { return percentText(row.cancelled + row.removed + row.voided, row.issued); } },
  { key: "avgWait", label: "Avg Wait Time", tone: "blue", value: function (row) { return formatDuration(row.waitCount ? row.waitSum / row.waitCount : null); } },
  { key: "avgService", label: "Avg Service Time", tone: "blue", value: function (row) { return formatDuration(row.serviceCount ? row.serviceSum / row.serviceCount : null); } },
  { key: "longestWait", label: "Longest Wait", tone: "amber", value: function (row) { return formatDuration(row.longestWait); } },
  { key: "peakHour", label: "Peak Hour", tone: "amber", cardOnly: true, value: function (row, report) { return reportPeakText(report); } }
];

var REPORT_SECTIONS = [
  { key: "kpis", label: "KPI Summary" },
  { key: "stations", label: "Summary per Station" },
  { key: "days", label: "Daily Summary" },
  { key: "hours", label: "Tickets per Hour" },
  { key: "types", label: "Per Student Type" },
  { key: "enrollment", label: "Enrollment" }
];

// Sections that are tables of the ticked data columns.
var REPORT_TABLE_SECTIONS = ["stations", "days", "hours", "types"];

var reportDraft = null;   // the filters and checklist on screen
var reportResult = null;  // the last generated report

function resetReportState() {
  reportDraft = null;
  reportResult = null;
}

function reportStationChoices() {
  if (adminKind() === "station") return stations.filter(function (s) { return s.id === adminRole; });
  return getSortedStations();
}

function allReportChoices(list) {
  var choices = {};
  list.forEach(function (item) { choices[item.key] = true; });
  return choices;
}

function ensureReportDraft() {
  if (reportDraft) return reportDraft;
  var today = getAdminToday();
  reportDraft = {
    start: today,
    end: today,
    stationId: adminKind() === "station" ? adminRole : "all",
    include: { fields: allReportChoices(REPORT_FIELDS), sections: allReportChoices(REPORT_SECTIONS) }
  };
  return reportDraft;
}

function onReportInput(field, value) {
  ensureReportDraft()[field] = value;
}

function onReportInclude(group, key, checked) {
  ensureReportDraft().include[group][key] = checked;
  refreshReportIncludeNote();
}

function setReportIncludeAll(group, on) {
  var draft = ensureReportDraft();
  (group === "fields" ? REPORT_FIELDS : REPORT_SECTIONS).forEach(function (item) {
    draft.include[group][item.key] = on;
  });
  var panel = document.getElementById("reportInclude");
  if (panel) panel.innerHTML = reportIncludeInnerHtml(draft);
  refreshReportIncludeNote();
}

function copyReportInclude(include) {
  return { fields: Object.assign({}, include.fields), sections: Object.assign({}, include.sections) };
}

function sameReportInclude(a, b) {
  function same(x, y, list) { return list.every(function (item) { return !!x[item.key] === !!y[item.key]; }); }
  return same(a.fields, b.fields, REPORT_FIELDS) && same(a.sections, b.sections, REPORT_SECTIONS);
}

// After a report is on screen, a changed checklist only applies on the next Generate.
function refreshReportIncludeNote() {
  var note = document.getElementById("reportIncludeNote");
  if (note) note.hidden = !reportResult || sameReportInclude(ensureReportDraft().include, reportResult.include);
}

function reportFieldsOf(include) {
  return REPORT_FIELDS.filter(function (f) { return include.fields[f.key]; });
}

function reportColumnsOf(include) {
  return reportFieldsOf(include).filter(function (f) { return !f.cardOnly; });
}

/* ---------- Numbers ---------- */

function reportOutcome(ticket) {
  if (ticket.status === "completed") return "served";
  if (ticket.status === "cancelled") return "cancelled";
  if (ticket.status === "void") return ticket.autoVoided || ticket.staleCleanup ? "voided" : "removed";
  return "active";
}

function emptyReportRow(label) {
  return {
    label: label, issued: 0, served: 0, cancelled: 0, removed: 0, voided: 0, active: 0,
    waitSum: 0, waitCount: 0, serviceSum: 0, serviceCount: 0, longestWait: null
  };
}

function addToReportRow(row, ticket) {
  row.issued += 1;
  row[reportOutcome(ticket)] += 1;

  var wait = waitMs(ticket);
  if (wait !== null) {
    row.waitSum += wait;
    row.waitCount += 1;
    if (row.longestWait === null || wait > row.longestWait) row.longestWait = wait;
  }
  var service = serviceMs(ticket);
  if (service !== null) {
    row.serviceSum += service;
    row.serviceCount += 1;
  }
}

function sortedReportRows(map, compare) {
  return Object.keys(map).sort(compare).map(function (key) { return map[key]; });
}

function reportPeakText(report) {
  var peak = report.hours.reduce(function (best, row) { return !best || row.issued > best.issued ? row : best; }, null);
  return peak ? peak.label + " (" + peak.issued + ")" : "—";
}

function buildEnrollmentSummary(list) {
  var enrolling = list.filter(function (t) { return t.enrollment === true; });
  function summarize(label, group) {
    return {
      label: label,
      started: group.length,
      completed: countBy(group, function (t) { return t.status === "completed"; }),
      active: countBy(group, function (t) { return ACTIVE_TICKET_STATUSES.indexOf(t.status) !== -1; })
    };
  }
  return {
    rows: ENROLLMENT_TYPES.map(function (type) {
      return summarize(STUDENT_TYPE_LABELS[type], enrolling.filter(function (t) { return t.studentType === type; }));
    }),
    total: summarize("Total", enrolling)
  };
}

function buildReport(allTickets, draft, include) {
  var stationIds = draft.stationId === "all" ? null : [draft.stationId];
  var visible = allTickets.filter(function (t) {
    return canViewStationData(t.stationId) && (!stationIds || stationIds.indexOf(t.stationId) !== -1);
  });

  var byStation = {};
  var byDay = {};
  var byHour = {};
  var byType = {};
  var total = emptyReportRow("All stations");

  reportStationChoices().forEach(function (s) {
    if (!stationIds || stationIds.indexOf(s.id) !== -1) byStation[s.id] = emptyReportRow(s.name);
  });
  Object.keys(STUDENT_TYPE_LABELS).forEach(function (type) {
    byType[type] = emptyReportRow(STUDENT_TYPE_LABELS[type]);
  });

  visible.forEach(function (ticket) {
    var stationRow = byStation[ticket.stationId] || (byStation[ticket.stationId] = emptyReportRow(getStationName(ticket.stationId)));
    var day = queueDayKey(timestampToMs(ticket.createdAt, 0));
    var dayRow = byDay[day] || (byDay[day] = emptyReportRow(day));
    var hour = ticketHour(ticket);

    addToReportRow(stationRow, ticket);
    addToReportRow(dayRow, ticket);
    addToReportRow(byType[ticketTypeOf(ticket)], ticket);
    if (hour !== null) addToReportRow(byHour[hour] || (byHour[hour] = emptyReportRow(hourLabel(hour))), ticket);
    addToReportRow(total, ticket);
  });

  return {
    draft: { start: draft.start, end: draft.end, stationId: draft.stationId },
    include: include,
    stationLabel: draft.stationId === "all" ? "All stations" : getStationName(draft.stationId),
    generatedAt: new Date(),
    tickets: visible,
    total: total,
    stations: sortedReportRows(byStation, function (a, b) { return String(byStation[a].label).localeCompare(String(byStation[b].label)); }),
    days: sortedReportRows(byDay),
    hours: sortedReportRows(byHour, function (a, b) { return Number(a) - Number(b); }),
    types: Object.keys(STUDENT_TYPE_LABELS).map(function (type) { return byType[type]; }),
    enrollment: buildEnrollmentSummary(visible)
  };
}

/* ---------- Generating ---------- */

function generateReport() {
  var draft = ensureReportDraft();
  var start = getAdminDate(draft.start, false);
  var end = getAdminDate(draft.end, true);
  var include = copyReportInclude(draft.include);

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
  if (!reportFieldsOf(include).length) {
    say("Please tick at least one item under Data.");
    return;
  }
  if (!REPORT_SECTIONS.some(function (s) { return include.sections[s.key]; })) {
    say("Please tick at least one item under Sections.");
    return;
  }
  if (!reportColumnsOf(include).length && REPORT_TABLE_SECTIONS.some(function (key) { return include.sections[key]; })) {
    say("Peak Hour only shows as a KPI card. Tick another item under Data for the tables.");
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
      reportResult = buildReport(found, draft, include);
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

function reportRangeText(r) {
  return r.draft.start === r.draft.end ? r.draft.start : r.draft.start + " to " + r.draft.end;
}

function reportGeneratedText(r) {
  return r.generatedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

function reportTableHtml(firstHeader, rows, total, fields, emptyText) {
  var head = '<tr><th>' + firstHeader + '</th>' + fields.map(function (f) { return '<th>' + escapeAdminText(f.label) + '</th>'; }).join("") + '</tr>';

  var body = rows.map(function (row) {
    return '<tr><td class="settings-strong">' + escapeAdminText(row.label) + '</td>' +
      fields.map(function (f) { return '<td>' + escapeAdminText(f.value(row)) + '</td>'; }).join("") + '</tr>';
  }).join("");

  if (!rows.length) body = '<tr><td colspan="' + (fields.length + 1) + '" class="empty-row">' + (emptyText || 'No tickets in this range.') + '</td></tr>';

  var foot = total ? '<tr class="report-total"><td>Total</td>' + fields.map(function (f) { return '<td>' + escapeAdminText(f.value(total)) + '</td>'; }).join("") + '</tr>' : '';

  return '<div class="table-wrap report-table-wrap"><table class="queue-table settings-table report-table"><thead>' + head + '</thead><tbody>' + body + '</tbody>' +
    (foot ? '<tfoot>' + foot + '</tfoot>' : '') + '</table></div>';
}

// The enrollment table has its own columns, written as data fields so the table and the exports can share them.
var REPORT_ENROLLMENT_FIELDS = [
  { label: "Started", value: function (row) { return row.started; } },
  { label: "Completed", value: function (row) { return row.completed; } },
  { label: "In Progress", value: function (row) { return row.active; } },
  { label: "Completion Rate", value: function (row) { return percentText(row.completed, row.started); } }
];

function reportPanelHtml(title, inner) {
  return '<section class="panel settings-panel"><div class="panel-header"><h2>' + title + '</h2></div>' + inner + '</section>';
}

function reportResultHtml(r) {
  var inc = r.include;
  var columns = reportColumnsOf(inc);
  var html = '<p class="report-caption">' + escapeAdminText(r.stationLabel) + ' · ' + escapeAdminText(reportRangeText(r)) +
    ' · generated ' + escapeAdminText(reportGeneratedText(r)) + '</p>';

  if (inc.sections.kpis) {
    html += '<section class="report-cards">' + reportFieldsOf(inc).map(function (f) {
      return '<article class="stat-card ' + f.tone + '"><div class="stat-top"><span class="stat-label">' + escapeAdminText(f.label) + '</span></div>' +
        '<div class="stat-value">' + escapeAdminText(f.value(r.total, r)) + '</div></article>';
    }).join("") + '</section>';
  }
  if (inc.sections.stations) html += reportPanelHtml("Summary per Station", reportTableHtml("Station", r.stations, r.total, columns));
  if (inc.sections.days) html += reportPanelHtml("Daily Summary", reportTableHtml("Date", r.days, r.total, columns));
  if (inc.sections.hours) {
    html += hourlyChartHtml(r.tickets) + reportPanelHtml("Per Hour", reportTableHtml("Hour", r.hours, r.total, columns));
  }
  if (inc.sections.types) html += reportPanelHtml("Per Student Type", reportTableHtml("Student Type", r.types, r.total, columns));
  if (inc.sections.enrollment) {
    html += reportPanelHtml("Enrollment", reportTableHtml("Student Type", r.enrollment.rows, r.enrollment.total, REPORT_ENROLLMENT_FIELDS));
  }

  return html + '<p class="report-note">Removed tickets were taken off the queue by staff. Voided tickets ran out of time after a last call, or were left over at the end of the day. ' +
    'Issued also counts tickets that were still in line when the report was generated. Wait time runs from getting the ticket to being called, service time from being called to the end of the transaction; ' +
    'an enrollment student is timed at each station they visit.</p>';
}

function reportChecksHtml(group, list, chosen) {
  return '<div class="report-include-group">' +
    '<div class="report-include-head">' +
      '<h3 class="report-include-title">' + (group === "fields" ? "Data" : "Sections") + '</h3>' +
      '<span class="report-include-links">' +
        '<button type="button" onclick="setReportIncludeAll(\'' + group + '\', true)">Select all</button>' +
        '<button type="button" onclick="setReportIncludeAll(\'' + group + '\', false)">Clear</button>' +
      '</span>' +
    '</div>' +
    '<div class="report-checks">' + list.map(function (item) {
      return '<label class="report-check"><input type="checkbox"' + (chosen[item.key] ? ' checked' : '') +
        ' onchange="onReportInclude(\'' + group + '\', \'' + item.key + '\', this.checked)">' + escapeAdminText(item.label) + '</label>';
    }).join("") + '</div>' +
  '</div>';
}

function reportIncludeInnerHtml(draft) {
  return reportChecksHtml("fields", REPORT_FIELDS, draft.include.fields) + reportChecksHtml("sections", REPORT_SECTIONS, draft.include.sections);
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
  var resultHtml = r ? reportResultHtml(r) :
    '<div class="settings-empty"><div class="settings-empty-icon">📊</div><p>Choose the dates, tick what the report should include, and press Generate Report.</p></div>';

  area.innerHTML =
    '<div class="dashboard-header"><div class="header-greeting">Reports</div>' + adminHeaderRightHtml() + '</div>' +
    '<section class="panel settings-panel">' +
      '<div class="report-filters">' +
        '<label>From<input type="date" id="reportStart" value="' + escapeAdminText(draft.start) + '" onchange="onReportInput(\'start\', this.value)"></label>' +
        '<label>To<input type="date" id="reportEnd" value="' + escapeAdminText(draft.end) + '" onchange="onReportInput(\'end\', this.value)"></label>' +
        '<label>Station<select id="reportStation" onchange="onReportInput(\'stationId\', this.value)"' + (adminKind() === "station" ? ' disabled' : '') + '>' + stationOptions + '</select></label>' +
      '</div>' +
      '<p class="report-include-label">Include in report</p>' +
      '<div class="report-include" id="reportInclude">' + reportIncludeInnerHtml(draft) + '</div>' +
      '<div class="report-actions">' +
        '<button type="button" class="settings-btn settings-btn-primary" id="reportGenerateBtn" onclick="generateReport()">Generate Report</button>' +
        '<p class="report-include-note" id="reportIncludeNote" hidden>Press Generate Report to apply your changes.</p>' +
        '<span class="report-filters-spacer"></span>' +
        '<button type="button" class="settings-btn settings-btn-blue" id="reportPdfBtn" onclick="exportReportPdf()"' + (r ? '' : ' disabled') + '>Export PDF</button>' +
        '<button type="button" class="settings-btn settings-btn-green" id="reportXlsxBtn" onclick="exportReportExcel()"' + (r ? '' : ' disabled') + '>Export Excel</button>' +
      '</div>' +
    '</section>' +
    resultHtml;

  refreshReportIncludeNote();
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

function reportSheetRows(firstHeader, rows, total, fields) {
  var header = [firstHeader].concat(fields.map(function (f) { return f.label; }));
  var data = rows.map(function (row) {
    return [row.label].concat(fields.map(function (f) { return f.value(row); }));
  });
  data.push(["Total"].concat(fields.map(function (f) { return f.value(total); })));
  return [header].concat(data);
}

// The ticked parts of the report as [title, rows] pairs, in screen order. Every table ends with its Total row.
function reportExportTables(r) {
  var inc = r.include;
  var columns = reportColumnsOf(inc);
  var tables = [];

  if (inc.sections.stations) tables.push(["Per Station", "Summary per Station", reportSheetRows("Station", r.stations, r.total, columns)]);
  if (inc.sections.days) tables.push(["Daily", "Daily Summary", reportSheetRows("Date", r.days, r.total, columns)]);
  if (inc.sections.hours) tables.push(["Per Hour", "Tickets per Hour", reportSheetRows("Hour", r.hours, r.total, columns)]);
  if (inc.sections.types) tables.push(["Per Type", "Per Student Type", reportSheetRows("Student Type", r.types, r.total, columns)]);
  if (inc.sections.enrollment) {
    tables.push(["Enrollment", "Enrollment", reportSheetRows("Student Type", r.enrollment.rows, r.enrollment.total, REPORT_ENROLLMENT_FIELDS)]);
  }
  return tables;
}

function reportKpiRows(r) {
  return r.include.sections.kpis ? reportFieldsOf(r.include).map(function (f) { return [f.label, f.value(r.total, r)]; }) : [];
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
      ["Generated", reportGeneratedText(r)]
    ];
    var kpis = reportKpiRows(r);
    if (kpis.length) info = info.concat([[], ["KPI Summary"]], kpis);

    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(info), "Report");
    reportExportTables(r).forEach(function (table) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(table[2]), table[0]);
    });
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
    var pageBottom = doc.internal.pageSize.getHeight() - 60;
    var y = 96;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(23, 32, 51);
    doc.text("QFicient Queue Report", 40, 48);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(r.stationLabel + "   |   " + reportRangeText(r) + "   |   Generated " + reportGeneratedText(r), 40, 66);

    // A title starts a new page unless its table's first rows fit under it.
    function addTable(title, rows, hasTotal) {
      if (y + 70 > pageBottom) {
        doc.addPage();
        y = 48;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(23, 32, 51);
      doc.text(title, 40, y);
      doc.autoTable({
        startY: y + 8,
        head: [rows[0]],
        body: rows.slice(1),
        theme: "grid",
        headStyles: { fillColor: navy, textColor: 255 },
        styles: { fontSize: 9 },
        didParseCell: function (data) {
          if (hasTotal && data.section === "body" && data.row.index === rows.length - 2) data.cell.styles.fontStyle = "bold";
        }
      });
      y = doc.lastAutoTable.finalY + 28;
    }

    var kpis = reportKpiRows(r);
    if (kpis.length) {
      addTable("KPI Summary", [kpis.map(function (k) { return k[0]; }), kpis.map(function (k) { return String(k[1]); })], false);
    }
    reportExportTables(r).forEach(function (table) {
      addTable(table[1], table[2], true);
    });

    doc.save(reportFileName("pdf"));
  }).catch(function (error) {
    say("Could not export the report: " + error.message);
  }).then(function () {
    setButtonLoading(document.getElementById("reportPdfBtn"), false);
  });
}
