var queueMgmtPurposes = [
  "Certificate of Registration",
  "Transcript of Records",
  "Enrollment Verification",
  "Good Moral Certificate"
];

var activeQueueStation = "cashier";
var autoVoidIntervalId = null;

// The transfer form lives inside a panel that re-renders on every live update, so its state is kept here.
// purpose: "" keeps the ticket's current purpose, TRANSFER_OTHER_PURPOSE uses the typed `other`.
var TRANSFER_OTHER_PURPOSE = "__other__";
var queueTransfer = { stationId: "", purpose: "", other: "", open: false, priority: false };

function resetQueueTransfer() {
  queueTransfer = { stationId: "", purpose: "", other: "", open: false, priority: false };
  if (typeof resetEnrollmentDetour === "function") resetEnrollmentDetour();
}

// The Transfer Ticket form stays folded away behind its button until staff need it.
function toggleQueueTransfer() {
  queueTransfer.open = !queueTransfer.open;
  renderQueueManagement();
}

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
  resetQueueTransfer();
  renderQueueManagement();
}

// Today's tickets at the open station with one status ("waiting" or "skipped"), in queue order.
function queueTicketsWithStatus(status) {
  var serving = getServingTicket(activeQueueStation);
  return tickets.filter(function (t) {
    return t.stationId === activeQueueStation && t.status === status && isTodayTicket(t) && (!serving || t.id !== serving.id);
  }).sort(compareQueueOrder);
}

// Icons for the buttons (24x24, drawn with the text colour).
var QM_ICONS = {
  call: '<path d="M3 5h18v12H3z"/><circle cx="9" cy="10" r="2"/><path d="M5.5 15c.7-1.6 2-2.3 3.5-2.3s2.8.7 3.5 2.3M15 9h3M15 12h3M8 21h8"/>',
  prioritize: '<path d="M4 6h10M4 12h7M4 18h10M17 9l3 3-3 3"/>',
  recall: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5 1.2 0 2.3.3 3.2.9"/><path d="M21 14a3.5 3.5 0 1 1-1-2.5M21 10.5V12h-1.5"/>',
  remove: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  hold: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6 7-2.5 0-4-1.2-5.2-3.2L4 14.6a1.4 1.4 0 0 1 2.3-1.6L8 15"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  transfer: '<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>'
};

function qmIcon(name) {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + QM_ICONS[name] + '</svg>';
}

// One icon button in a list row. `handler` is the function it calls with (kind, ticket id): confirmTicketAction
// here in Queue Management, confirmEnforcerTicketAction in the Queue Enforcer's list.
// The System Rules permission behind each row button (js/admin-rules.js); Call now is always allowed.
var QM_ROW_ROLE_RULES = { prioritize: "prioritize", recall: "recall", remove: "remove" };

function qmRowButton(kind, ticket, label, disabledTitle, handler) {
  if (!disabledTitle && QM_ROW_ROLE_RULES[kind] && !roleCan(QM_ROW_ROLE_RULES[kind])) disabledTitle = ROLE_RULE_OFF_TITLE;
  return '<button type="button" class="qm-row-btn' + (kind === "remove" ? ' is-danger' : '') + '" title="' + escapeAdminText(disabledTitle || label) + '"' +
    ' aria-label="' + escapeAdminText(label + " " + ticket.ticketNo) + '"' + (disabledTitle ? ' disabled' : '') +
    ' onclick="' + (handler || "confirmTicketAction") + '(\'' + kind + '\', \'' + escapeAdminText(ticket.id) + '\')">' + qmIcon(kind) + '</button>';
}

// The buttons in each list row: call this ticket now, prioritize it, recall it, or remove it.
function confirmTicketAction(kind, ticketId) {
  var ticket = tickets.find(function (t) { return t.id === ticketId; });
  if (!ticket || ticket.stationId !== activeQueueStation || (ticket.status !== "waiting" && ticket.status !== "skipped")) {
    say("That ticket is no longer in this queue.");
    return;
  }

  if (QM_ROW_ROLE_RULES[kind] && roleRuleBlocks(QM_ROW_ROLE_RULES[kind], kind + " tickets")) return;

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

// The ticket at this staff member's window (js/queue.js myWindow): every action on this page works on it.
function getServingTicket(stationId) {
  return myServingTicket(stationId);
}

function selectQueueWindow(windowNo) {
  setMyWindow(activeQueueStation, windowNo);
  renderQueueManagement();
}

// For a station with several windows: which one this staff member is at, with what each window is serving.
function queueWindowPickerHtml(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  var count = stationWindows(station);
  if (count < 2) return "";

  var mine = myWindow(stationId);
  var buttons = [];
  for (var w = 1; w <= count; w++) {
    var serving = servingTicketAt(station, w);
    buttons.push('<button type="button" class="qm-window' + (w === mine ? ' active' : '') + '" role="tab" aria-selected="' + (w === mine) + '" onclick="selectQueueWindow(' + w + ')">' +
      '<span class="qm-window-name">Window ' + w + '</span>' +
      '<span class="qm-window-now">' + escapeAdminText(serving ? serving.ticketNo : "Free") + '</span>' +
    '</button>');
  }
  return '<div class="qm-windows">' +
    '<span class="qm-windows-label">Your window</span>' +
    '<div class="qm-window-list" role="tablist" aria-label="Your window">' + buttons.join("") + '</div>' +
  '</div>';
}

/* ---------- Transfer: send the ticket being served to another station ---------- */

function getTransferPurposes(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && Array.isArray(station.purposes) ? station.purposes : [];
}

// "Keep current purpose: Pay tuition" (first, the default), the receiving station's purposes, then "Others".
function transferPurposeOptionsHtml(stationId, currentPurpose) {
  var current = String(currentPurpose || "").trim();
  if (current.length > 40) current = current.slice(0, 39) + "…";
  var purposes = getTransferPurposes(stationId);

  return '<option value="">' + escapeAdminText(current ? "Keep current purpose: " + current : "Keep current purpose") + '</option>' +
    purposes.map(function (purpose) {
      return '<option value="' + escapeAdminText(purpose) + '"' + (purpose === queueTransfer.purpose ? ' selected' : '') + '>' + escapeAdminText(purpose) + '</option>';
    }).join("") +
    '<option value="' + TRANSFER_OTHER_PURPOSE + '"' + (queueTransfer.purpose === TRANSFER_OTHER_PURPOSE ? ' selected' : '') + '>Others, please specify</option>';
}

// The purpose shows once a station is picked; the list follows that station's own purposes.
function onTransferStationChange(select) {
  queueTransfer.stationId = select.value;
  queueTransfer.purpose = "";
  queueTransfer.other = "";

  var serving = getServingTicket(activeQueueStation);
  var field = document.getElementById("queueTransferPurposeField");
  var purposeSelect = document.getElementById("queueTransferPurpose");
  var other = document.getElementById("queueTransferOther");
  if (field) field.hidden = !queueTransfer.stationId;
  if (purposeSelect) purposeSelect.innerHTML = transferPurposeOptionsHtml(queueTransfer.stationId, serving && serving.purpose);
  if (other) {
    other.hidden = true;
    other.value = "";
  }
}

function onTransferPurposeChange(select) {
  queueTransfer.purpose = select.value;
  var other = document.getElementById("queueTransferOther");
  if (other) {
    other.hidden = select.value !== TRANSFER_OTHER_PURPOSE;
    if (!other.hidden) other.focus();
  }
}

function onTransferOtherInput(value) {
  queueTransfer.other = value;
}

// The purpose the ticket gets: "" keeps its current one, otherwise the picked or typed one ({ error } if empty).
function transferFinalPurpose() {
  if (queueTransfer.purpose !== TRANSFER_OTHER_PURPOSE) return { purpose: queueTransfer.purpose };
  var typed = String(queueTransfer.other || "").trim().replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]/u.test(typed)) return { error: "Please specify the purpose." };
  return { purpose: typed.slice(0, 100) };
}

function onTransferPriorityChange(input) {
  queueTransfer.priority = !!input.checked;
}

function confirmTransfer(stationId) {
  var serving = getServingTicket(stationId);
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }
  if (roleRuleBlocks("transfer", "transfer tickets")) return;

  var dest = stations.find(function (s) { return s.id === queueTransfer.stationId; });
  if (!dest) {
    say("Please choose the station to transfer to.");
    return;
  }
  var chosen = transferFinalPurpose();
  if (chosen.error) {
    say(chosen.error);
    return;
  }
  var purposeText = chosen.purpose || serving.purpose || "";

  var priority = queueTransfer.priority && roleCan("prioritize");
  showConfirmModal({
    title: "Transfer ticket " + serving.ticketNo + "?",
    message: "This sends " + serving.ownerName + "'s ticket to " + dest.name + (priority ? " at the front of its line (prioritized)" : " at the back of its line") +
      (purposeText ? ", for " + purposeText : "") +
      ". They get a new queue number there, and the next person is called to your window.",
    confirmLabel: "Transfer",
    tone: "primary",
    onConfirm: function () {
      return transferServingTicket(stationId, dest.id, chosen.purpose, priority).then(function (result) {
        if (!result) return;
        resetQueueTransfer();
        renderQueueManagement();
      });
    }
  });
}

// The Transfer panel under the actions, for a ticket that isn't an enrollment (those use Proceed to Next Station).
function queueTransferHtml(station, serving) {
  var allowed = roleCan("transfer");
  var stationOptionsHtml = '<option value="">Station</option>' + getSortedStations().filter(function (s) {
    return s.id !== station && s.active !== false;
  }).map(function (s) {
    return '<option value="' + escapeAdminText(s.id) + '"' + (s.id === queueTransfer.stationId ? ' selected' : '') + '>' + escapeAdminText(s.name) + '</option>';
  }).join("");
  var off = !serving || !allowed;
  var title = !allowed ? ROLE_RULE_OFF_TITLE : "Transfer is available while a ticket is being served";

  var open = queueTransfer.open;
  var toggleHtml = '<button type="button" class="qm-transfer-toggle' + (open ? ' is-open' : '') + '" aria-expanded="' + open + '" aria-controls="queueTransferBody" onclick="toggleQueueTransfer()">' +
    qmIcon("transfer") + '<span>Transfer Ticket</span>' +
    '<svg class="qm-transfer-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
  '</button>';
  if (!open) return '<div class="qm-transfer">' + toggleHtml + '</div>';

  return '<div class="qm-transfer">' + toggleHtml +
    '<div class="qm-transfer-body" id="queueTransferBody">' +
    '<label class="qm-label" for="queueTransferStation">To Station</label>' +
    '<select id="queueTransferStation" class="qm-select" onchange="onTransferStationChange(this)"' + (off ? ' disabled' : '') + '>' + stationOptionsHtml + '</select>' +
    '<div id="queueTransferPurposeField"' + (queueTransfer.stationId ? '' : ' hidden') + '>' +
      '<label class="qm-label" for="queueTransferPurpose">Purpose</label>' +
      '<select id="queueTransferPurpose" class="qm-select" onchange="onTransferPurposeChange(this)"' + (off ? ' disabled' : '') + '>' +
        transferPurposeOptionsHtml(queueTransfer.stationId, serving && serving.purpose) + '</select>' +
      '<input type="text" id="queueTransferOther" class="qm-select qm-transfer-other" maxlength="100" placeholder="Please specify the purpose" aria-label="Specify the purpose"' +
        ' value="' + escapeAdminText(queueTransfer.other) + '" oninput="onTransferOtherInput(this.value)"' +
        (queueTransfer.purpose === TRANSFER_OTHER_PURPOSE ? '' : ' hidden') + (off ? ' disabled' : '') + '>' +
    '</div>' +
    // Prioritize: front of the new station's line (PWD, senior citizens, ...). Follows the Prioritize permission.
    '<label class="enforcer-priority qm-transfer-priority"' + (roleCan("prioritize") ? '' : ' title="' + ROLE_RULE_OFF_TITLE + '"') + '>' +
      '<input type="checkbox" id="queueTransferPriority"' + (queueTransfer.priority && roleCan("prioritize") ? ' checked' : '') +
        (roleCan("prioritize") && !off ? '' : ' disabled') + ' onchange="onTransferPriorityChange(this)">' +
      '<span><b>Prioritize</b><small>Front of the new station&#39;s line.</small></span>' +
    '</label>' +
    '<button type="button" class="queue-action-btn qm-main-btn qm-transfer-btn"' + (off ? ' disabled title="' + title + '"' : '') +
      ' onclick="confirmTransfer(\'' + station + '\')">' + qmIcon("transfer") + '<span>Transfer</span></button>' +
    '</div>' +
  '</div>';
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
  if (roleRuleBlocks("hold", "put tickets on hold")) return;

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
  if (roleRuleBlocks("remove", "remove tickets")) return;

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
  if (roleRuleBlocks("recall", "recall tickets")) return;
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
  if (roleRuleBlocks("lastCall", "give a last call")) return;

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
  if (ticket.studentType === "transferee" || ticket.studentType === "freshman") {
    tags += ' <span class="type-tag">' + escapeAdminText(STUDENT_TYPE_SHORT_LABELS[ticket.studentType]) + '</span>';
  }
  if (ticket.enrollment === true) {
    tags += ' <span class="type-tag enrollment-tag">Enrollment · Step ' + ((Number(ticket.enrollmentStep) || 0) + 1) + ' of ' + (ticketEnrollmentFlow(ticket).length || 1) + '</span>';
  }
  // A manual ticket: the walk-in has no phone, so call the number out loud.
  if (ticket.noPhone === true) tags += ' <span class="type-tag nophone-tag" title="Manual ticket: call the number out loud">No phone</span>';
  return tags;
}

// Student-type colours mark enrollees only (their process depends on the type); every other ticket looks the same.
function enrolleeTypeOf(ticket) {
  return ticket && ticket.enrollment === true && STUDENT_TYPE_LABELS[ticket.studentType] ? ticket.studentType : "";
}

function queueRowClass(ticket) {
  var type = enrolleeTypeOf(ticket);
  return 'queue-row' + (type && type !== "regular" ? ' queue-row-' + type : '');
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
  // An enrollment ticket is sent on to the next station of its process; any other ticket can be transferred freely.
  var isEnrollment = !!serving && serving.enrollment === true;
  var station = activeQueueStation;

  var tabsHtml = visibleStations.map(function (s) {
    var activeClass = s.id === activeQueueStation ? " active" : "";
    return '<button type="button" class="station-tab' + activeClass + '" onclick="selectQueueStation(\'' + s.id + '\')">' +
      escapeAdminText(s.name) + '</button>';
  }).join("");

  /* Left: the person at the counter and what to do with them. */
  var cardHtml =
    '<div class="serving-card qm-serving-card' + (enrolleeTypeOf(serving) ? ' serving-type-' + enrolleeTypeOf(serving) : '') + '">' +
      '<div class="serving-card-top">' +
        '<span class="serving-live"><span class="live-dot"></span>' + (serving ? 'Currently Serving' : 'No Serving') +
          (windowLabel(stations.find(function (s) { return s.id === station; }), myWindow(station)) ?
            ' · ' + windowLabel(stations.find(function (s) { return s.id === station; }), myWindow(station)) : '') + '</span>' +
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
      mainButton("recall", "Recall", "confirmRecall('" + (serving ? serving.id : '') + "')", !!serving && roleCan("recall"), roleCan("recall") ? "" : ROLE_RULE_OFF_TITLE) +
      mainButton("hold", "On Hold", "confirmSkip('" + station + "')", !!serving && roleCan("hold"), roleCan("hold") ? "" : ROLE_RULE_OFF_TITLE) +
      mainButton("remove", "Remove", "confirmRemove('" + station + "')", !!serving && roleCan("remove"), roleCan("remove") ? "" : ROLE_RULE_OFF_TITLE) +
      (isEnrollment ? '' :
        '<button type="button" class="queue-action-btn queue-action-complete qm-main-btn"' + (serving ? '' : ' disabled') +
          ' onclick="confirmComplete(\'' + station + '\')">' + qmIcon("done") + '<span>End Transaction</span></button>') +
    '</div>';

  var transferHtml = isEnrollment ? enrollmentProceedHtml(station, serving) : queueTransferHtml(station, serving);

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
      '<button type="button" class="last-call-btn"' + (roleCan("lastCall") ? '' : ' disabled title="' + ROLE_RULE_OFF_TITLE + '"') +
        ' onclick="confirmLastCall(\'' + escapeAdminText(t.id) + '\')">Last Call</button>';
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
    queueWindowPickerHtml(activeQueueStation) +
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
