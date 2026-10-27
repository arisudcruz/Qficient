var queueMgmtPurposes = [
  "Certificate of Registration",
  "Transcript of Records",
  "Enrollment Verification",
  "Good Moral Certificate"
];

var activeQueueStation = "cashier";
var autoVoidIntervalId = null;

// Student-type filters of the two lists ("" = all types).
var queueTypeFilter = "";
var holdTypeFilter = "";

function setQueueTypeFilter(value) {
  queueTypeFilter = value;
  renderQueueManagement();
}

function setHoldTypeFilter(value) {
  holdTypeFilter = value;
  renderQueueManagement();
}

// The stations this person may run: all of them for an admin, only their own for Queue Management staff.
function manageableStations() {
  return stations.filter(function (station) { return canServeStation(station.id); });
}

function selectQueueStation(stationId) {
  if (!canServeStation(stationId)) return refuseStation();

  activeQueueStation = stationId;
  renderQueueManagement();
}

// Today's tickets at the open station with one status ("waiting" or "skipped"), in queue order.
function queueTicketsWithStatus(status) {
  var serving = getServingTicket(activeQueueStation);
  return tickets.filter(function (t) {
    return t.stationId === activeQueueStation && t.status === status && isTodayTicket(t) && (!serving || t.id !== serving.id);
  }).sort(compareQueueOrder);
}

function queueActionButtonHtml(label, onclick, disabled, title) {
  return '<button type="button" class="queue-action-btn"' + (disabled ? ' disabled' : '') +
    (title ? ' title="' + escapeAdminText(title) + '"' : '') + ' onclick="' + onclick + '">' + label + '</button>';
}

// Icons for the buttons (24x24, drawn with the text colour).
var QM_ICONS = {
  call: '<path d="M3 5h18v12H3z"/><circle cx="9" cy="10" r="2"/><path d="M5.5 15c.7-1.6 2-2.3 3.5-2.3s2.8.7 3.5 2.3M15 9h3M15 12h3M8 21h8"/>',
  prioritize: '<path d="M4 6h10M4 12h7M4 18h10M17 9l3 3-3 3"/>',
  recall: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5 1.2 0 2.3.3 3.2.9"/><path d="M21 14a3.5 3.5 0 1 1-1-2.5M21 10.5V12h-1.5"/>',
  remove: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  hold: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6 7-2.5 0-4-1.2-5.2-3.2L4 14.6a1.4 1.4 0 0 1 2.3-1.6L8 15"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>'
};

function qmIcon(name) {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + QM_ICONS[name] + '</svg>';
}

// One icon button in a list row.
function qmRowButton(kind, ticket, label, disabledTitle) {
  return '<button type="button" class="qm-row-btn' + (kind === "remove" ? ' is-danger' : '') + '" title="' + escapeAdminText(disabledTitle || label) + '"' +
    ' aria-label="' + escapeAdminText(label + " " + ticket.ticketNo) + '"' + (disabledTitle ? ' disabled' : '') +
    ' onclick="confirmTicketAction(\'' + kind + '\', \'' + escapeAdminText(ticket.id) + '\')">' + qmIcon(kind) + '</button>';
}

// The buttons in each list row: call this ticket now, prioritize it, recall it, or remove it.
function confirmTicketAction(kind, ticketId) {
  var ticket = tickets.find(function (t) { return t.id === ticketId; });
  if (!ticket || ticket.stationId !== activeQueueStation || (ticket.status !== "waiting" && ticket.status !== "skipped")) {
    say("That ticket is no longer in this queue.");
    return;
  }

  var stationId = activeQueueStation;
  var options;

  if (kind === "call") {
    var serving = getServingTicket(stationId);
    options = {
      title: "Call ticket " + ticket.ticketNo + " now?",
      message: (serving ? currentTicketFateText(serving) + " and calls " : "This calls ") +
        ticket.ticketNo + " now, ahead of the rest of the queue.",
      confirmLabel: "Call Now",
      tone: "primary",
      run: function () { return callSelectedTicket(stationId, ticket.id); }
    };
  } else if (kind === "prioritize") {
    if (ticket.status !== "waiting" || ticket.prioritizedAt) return;
    options = {
      title: "Prioritize ticket " + ticket.ticketNo + "?",
      message: "It moves to the front of the queue, ahead of everyone who isn't prioritized.",
      confirmLabel: "Prioritize",
      tone: "primary",
      run: function () { return prioritizeTickets([ticket.id]); }
    };
  } else if (kind === "recall") {
    options = {
      title: "Recall ticket " + ticket.ticketNo + "?",
      message: "This notifies them to go to the counter." + (ticket.status === "skipped" ? " It doesn't change their countdown." : ""),
      confirmLabel: "Recall",
      tone: "primary",
      run: function () { return recallTickets([ticket.id]); }
    };
  } else {
    options = {
      title: "Are you sure you want to remove ticket " + ticket.ticketNo + "?",
      message: "This immediately voids " + ticket.ownerName + "'s ticket. This can't be undone.",
      confirmLabel: "Remove",
      tone: "danger",
      run: function () { return removeTickets([ticket.id]); }
    };
  }

  showConfirmModal({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    tone: options.tone,
    onConfirm: function () { return options.run(); }
  });
}

function getServingTicket(stationId) {
  return servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
}

// What Call Next does to the ticket still at the counter: completed, or (enrollment) sent on to the next station.
function currentTicketFateText(serving) {
  if (serving.enrollment !== true) return "This marks ticket " + serving.ticketNo + " as completed";
  var nextId = nextEnrollmentStationId(serving);
  return nextId ?
    "This sends " + serving.ticketNo + " on to " + (stationNameById(nextId) || "the next station") :
    "This completes " + serving.ticketNo + "'s enrollment";
}

function confirmCallNext(stationId) {
  if (!getNextWaitingTicket(stationId)) return;

  var serving = getServingTicket(stationId);

  showConfirmModal({
    title: serving ? "Call the next ticket?" : "Call the first ticket?",
    message: serving ?
      currentTicketFateText(serving) + " and calls the next person in line." :
      "This calls the next waiting ticket for this station.",
    confirmLabel: "Call Next",
    tone: "primary",
    onConfirm: function () { return callNextTicket(stationId); }
  });
}

function confirmComplete(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) return;

  showConfirmModal({
    title: "Are you sure you want to end the transaction for " + serving.ticketNo + "?",
    message: "This marks " + serving.ownerName + "'s ticket as completed and clears the serving window. Use Call Next to serve the next person.",
    confirmLabel: "End Transaction",
    tone: "primary",
    onConfirm: function () { return completeCurrentTicket(stationId); }
  });
}

function confirmSkip(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) return;

  showConfirmModal({
    title: "Are you sure you want to put ticket " + serving.ticketNo + " on hold?",
    message: "They'll have " + formatVoidWindow() + " to return to the counter. After that you can give them a last call before the ticket is voided.",
    confirmLabel: "Put On Hold",
    tone: "danger",
    onConfirm: function () { return skipCurrentTicket(stationId); }
  });
}

function confirmRemove(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) return;

  showConfirmModal({
    title: "Are you sure you want to remove ticket " + serving.ticketNo + "?",
    message: "This immediately voids the ticket. This can't be undone.",
    confirmLabel: "Remove",
    tone: "danger",
    onConfirm: function () { return removeCurrentTicket(stationId); }
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
  var now = serverNow();
  var needsRender = false;

  document.querySelectorAll(".void-countdown[data-base-ms]").forEach(function (el) {
    var phase = el.getAttribute("data-phase");
    var remainingMs = AUTO_VOID_WINDOW_MS - (now - Number(el.getAttribute("data-base-ms")));

    if (phase === "initial" && remainingMs <= 0) {
      needsRender = true;
      return;
    }

    if (phase === "final" && remainingMs <= 0) {
      el.textContent = "Expired, voiding now";
      return;
    }

    el.textContent = (phase === "final" ? "Voids in " : "Time left ") + formatCountdown(remainingMs);
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

// The time a ticket was generated, in Philippine time (e.g. "7:42 PM").
function ticketGeneratedTime(ticket) {
  var ms = timestampToMs(ticket.createdAt, 0);
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

// Regular tickets stay plain; the other student types, priority and enrollment get a small tag.
function queueRowTagsHtml(ticket) {
  var tags = "";
  if (ticket.studentType === "transferee" || ticket.studentType === "freshman" || ticket.studentType === "guest") {
    tags += ' <span class="type-tag">' + escapeAdminText(STUDENT_TYPE_SHORT_LABELS[ticket.studentType]) + '</span>';
  }
  if (ticket.enrollment === true) {
    tags += ' <span class="type-tag enrollment-tag">Enrollment · Step ' + ((Number(ticket.enrollmentStep) || 0) + 1) + ' of ' + (ticketEnrollmentFlow(ticket).length || 1) + '</span>';
  }
  return tags;
}

function queueRowClass(ticket) {
  return 'queue-row' + ((ticket.studentType === "transferee" || ticket.studentType === "freshman" || ticket.studentType === "guest") ? ' queue-row-' + ticket.studentType : '');
}

// One list panel: title, count, its own type filter, and the table.
function queueListPanelHtml(title, countText, filter, onFilter, rowsHtml) {
  return '<section class="panel qm-list">' +
    '<div class="qm-list-head">' +
      '<div><h2>' + title + '</h2><p class="qm-list-count">' + countText + '</p></div>' +
      '<label class="qm-filter">' + qmIcon("filter") + queueTypeFilterHtml(filter, onFilter) + '</label>' +
    '</div>' +
    '<div class="table-wrap qm-table-wrap"><table class="queue-table qm-table"><thead><tr>' +
      '<th>Queue No.</th><th>Student</th><th>Status</th><th>Action</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
  '</section>';
}

function renderQueueManagement() {
  var area = document.getElementById("adminQueueArea");
  if (!area) return;

  var visibleStations = manageableStations();
  if (visibleStations.length && !visibleStations.find(function (s) { return s.id === activeQueueStation; })) {
    activeQueueStation = visibleStations[0].id;
  }

  var headerHtml = '<div class="dashboard-header"><div class="header-greeting">Queue Management</div>' + adminHeaderRightHtml() + '</div>';

  var serving = getServingTicket(activeQueueStation);
  // Only enrollment tickets are transferred, and only to the next station of their enrollment; every other ticket
  // ends at this station.
  var isEnrollment = !!serving && serving.enrollment === true;
  var station = activeQueueStation;

  var tabsHtml = visibleStations.map(function (s) {
    var activeClass = s.id === activeQueueStation ? " active" : "";
    return '<button type="button" class="station-tab' + activeClass + '" onclick="selectQueueStation(\'' + s.id + '\')">' +
      escapeAdminText(s.name) + '</button>';
  }).join("");

  /* Left: the person at the counter and what to do with them. */
  var cardHtml =
    '<div class="serving-card qm-serving-card' + (serving && STUDENT_TYPE_LABELS[serving.studentType] ? ' serving-type-' + serving.studentType : '') + '">' +
      '<div class="serving-card-top">' +
        '<span class="serving-live"><span class="live-dot"></span>Currently Serving</span>' +
        (serving && serving.createdAt ?
          '<span class="serving-time" title="When this ticket was generated">' + escapeAdminText(ticketGeneratedTime(serving)) + '</span>' : '') +
      '</div>' +
      '<div class="serving-number' + (serving ? '' : ' serving-empty') + '">' + escapeAdminText(serving ? serving.ticketNo : "--") + '</div>' +
    '</div>';

  var detailsHtml = serving ?
    '<div class="qm-details">' +
      '<div><span class="qm-label">Name</span><span class="qm-value">' + escapeAdminText(serving.ownerName) + '</span>' +
        (serving.studentNumber ? '<span class="qm-sub">' + escapeAdminText(serving.studentNumber) + '</span>' : '') + '</div>' +
      '<div><span class="qm-label">Student Type</span><span class="qm-value">' + escapeAdminText(STUDENT_TYPE_LABELS[serving.studentType] || serving.studentType || "—") + '</span></div>' +
      '<div class="qm-span"><span class="qm-label">Purpose</span><span class="qm-value">' + escapeAdminText(serving.purpose || "—") + '</span></div>' +
      (isEnrollment ? '<div class="qm-span"><span class="qm-label">Enrollment</span><span class="qm-value">' + escapeAdminText(enrollmentStepText(serving)) + '</span></div>' : '') +
    '</div>' :
    '<p class="qm-idle">No ticket is being served. Press Call Next to serve the first person in line.</p>';

  var hasWaiting = !!getNextWaitingTicket(station);
  var mainButton = function (icon, label, onclick, enabled, title) {
    return '<button type="button" class="queue-action-btn qm-main-btn"' + (enabled ? '' : ' disabled' + (title ? ' title="' + title + '"' : '')) +
      ' onclick="' + onclick + '">' + qmIcon(icon) + '<span>' + label + '</span></button>';
  };

  var actionsHtml =
    '<div class="serving-actions qm-actions">' +
      mainButton("call", "Call Next", "confirmCallNext('" + station + "')", hasWaiting, "No one is waiting to be called") +
      mainButton("recall", "Recall", "confirmRecall('" + (serving ? serving.id : '') + "')", !!serving) +
      mainButton("hold", "On Hold", "confirmSkip('" + station + "')", !!serving) +
      mainButton("remove", "Remove", "confirmRemove('" + station + "')", !!serving) +
      (isEnrollment ? '' :
        '<button type="button" class="queue-action-btn queue-action-complete qm-main-btn"' + (serving ? '' : ' disabled') +
          ' onclick="confirmComplete(\'' + station + '\')">' + qmIcon("done") + '<span>End Transaction</span></button>') +
    '</div>';

  var transferHtml = isEnrollment ? enrollmentProceedHtml(station, serving) : "";

  /* Right: the waiting line, and the people on hold. */
  var waiting = queueTicketsWithStatus("waiting");
  var firstId = waiting.length ? waiting[0].id : "";
  var shownWaiting = waiting.filter(function (t) { return ticketMatchesTypeFilter(t, queueTypeFilter); });

  var waitingRows = shownWaiting.map(function (t) {
    var status = t.id === firstId ? '<span class="qm-status is-next">Next</span>' :
      t.prioritizedAt ? '<span class="qm-status is-priority">★ Priority</span>' : '<span class="qm-status">Waiting</span>';
    return '<tr class="' + queueRowClass(t) + '">' +
      '<td class="queue-row-no">' + escapeAdminText(t.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(t.ownerName) + queueRowTagsHtml(t) + '</td>' +
      '<td>' + status + '</td>' +
      '<td><div class="qm-row-actions">' +
        qmRowButton("call", t, "Call now") +
        qmRowButton("prioritize", t, "Prioritize", t.prioritizedAt ? "Already prioritized" : "") +
        qmRowButton("recall", t, "Recall") +
        qmRowButton("remove", t, "Remove") +
      '</div></td></tr>';
  }).join("") || '<tr><td colspan="4" class="empty-row">' + (waiting.length && queueTypeFilter ?
    'No ' + escapeAdminText(queueTypeFilterLabel(queueTypeFilter)) + ' tickets in line.' : 'No one is waiting at this station.') + '</td></tr>';

  var onHold = queueTicketsWithStatus("skipped");
  var shownHold = onHold.filter(function (t) { return ticketMatchesTypeFilter(t, holdTypeFilter); });

  var holdRows = shownHold.map(function (t) {
    var skip = getSkipPhase(t);
    var timer = skip.phase === "initial" ?
      '<span class="void-countdown" data-phase="initial" data-base-ms="' + skip.baseMs + '">Time left ' + formatCountdown(skip.remainingMs) + '</span>' :
      skip.phase === "final" ?
      '<span class="void-countdown" data-phase="final" data-base-ms="' + skip.baseMs + '">' + (skip.remainingMs > 0 ? 'Voids in ' + formatCountdown(skip.remainingMs) : 'Expired, voiding now') + '</span>' :
      '<button type="button" class="last-call-btn" onclick="confirmLastCall(\'' + escapeAdminText(t.id) + '\')">Last Call</button>';
    return '<tr class="' + queueRowClass(t) + '">' +
      '<td class="queue-row-no">' + escapeAdminText(t.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(t.ownerName) + queueRowTagsHtml(t) + '</td>' +
      '<td><span class="qm-status is-hold">On Hold</span></td>' +
      '<td><div class="qm-row-actions">' +
        qmRowButton("call", t, "Call now") +
        qmRowButton("recall", t, "Recall") +
        qmRowButton("remove", t, "Remove") +
        timer +
      '</div></td></tr>';
  }).join("") || '<tr><td colspan="4" class="empty-row">' + (onHold.length && holdTypeFilter ?
    'No ' + escapeAdminText(queueTypeFilterLabel(holdTypeFilter)) + ' tickets on hold.' : 'No one is on hold.') + '</td></tr>';

  var countOf = function (shown, all, word) {
    return (shown.length !== all.length ? shown.length + ' of ' : '') + all.length + ' ' + word;
  };

  area.innerHTML =
    headerHtml +
    '<div class="station-tabs" role="tablist">' + tabsHtml + '</div>' +
    '<div class="queue-mgmt-grid qm-grid">' +
      '<section class="panel serving-panel qm-serving">' + cardHtml + detailsHtml + actionsHtml + transferHtml + '</section>' +
      '<div class="qm-lists">' +
        queueListPanelHtml("Current Queued List", countOf(shownWaiting, waiting, "in Queue"), queueTypeFilter, "setQueueTypeFilter(this.value)", waitingRows) +
        queueListPanelHtml("Current On Hold List", countOf(shownHold, onHold, "on Hold"), holdTypeFilter, "setHoldTypeFilter(this.value)", holdRows) +
      '</div>' +
    '</div>';
}

window.addEventListener('DOMContentLoaded', function () {
  renderQueueManagement();
});
