// Enrollment tickets in Queue Management (js/admin-queue.js): while one is being served, End Transaction and Transfer
// give way to Transfer Ticket: sending the student on to the next station of their enrollment process ("Proceed to
// Next Station"), to another station staff pick (a later step, or an extra one), or finishing at the last station
// ("Complete Enrollment").

// The Detour choice (send an enrollee to another station, then back here prioritized) is switched off for now; with
// it off, Transfer Ticket has the station list instead. Setting this to true brings the Detour back: the rules
// (isStationStaffEnrollmentDetour) and detourEnrollmentTicket in js/queue.js are still in place, and a student
// already on a detour still comes back prioritized.
var ENROLLMENT_DETOUR_ENABLED = false;

// "Step 2 of 3 · next: Assessment"
function enrollmentStepText(ticket) {
  var flow = ticketEnrollmentFlow(ticket);
  var step = (Number(ticket.enrollmentStep) || 0) + 1;
  var nextId = nextEnrollmentStationId(ticket);
  return "Step " + step + " of " + (flow.length || step) + (nextId ? " · next: " + (stationNameById(nextId) || "a removed station") : " · last station");
}

// Staff may send an enrollee somewhere else first (a detour), e.g. to Accounting for a balance. Kept here because the
// panel re-renders on every live update. ticketId: the ticket the choice was made for (a new one starts over).
var enrollmentDetour = { on: false, stationId: "", ticketId: "" };

function resetEnrollmentDetour() {
  enrollmentDetour = { on: false, stationId: "", ticketId: "" };
}

function enrollmentDetourFor(serving) {
  if (!serving || enrollmentDetour.ticketId !== serving.id) resetEnrollmentDetour();
  if (serving) enrollmentDetour.ticketId = serving.id;
  return enrollmentDetour;
}

// Stations a detour can go to: any open one other than this one (the student comes back here afterwards, so even the
// next station of their process is a real choice). A station whose daily limit is reached is listed but can't be picked.
function enrollmentDetourChoices(stationId) {
  return getSortedStations().filter(function (s) {
    return s.id !== stationId && s.active !== false;
  }).map(function (s) {
    var limit = stationLimitToday(s);
    return { id: s.id, name: s.name, full: limit > 0 && countStationTicketsToday(s.id) >= limit };
  });
}

function setEnrollmentDetourMode(on) {
  enrollmentDetour.on = !!on;
  renderQueueManagement();
}

function onEnrollmentDetourStation(select) {
  enrollmentDetour.stationId = select.value;
  renderQueueManagement();
}

// Transfer Ticket for an enrollee: staff pick where the student goes. The next step of their process is the default
// (or "Complete enrollment here" at the last station); a later step skips the ones in between, and any other station
// is added as an extra step before the rest of their process (rerouteEnrollmentTicket in js/queue.js). Kept here
// because the panel re-renders on every live update. stationId null = the default; ticketId: the ticket the choice
// was made for (a new one starts over).
var enrollmentHandoff = { ticketId: "", stationId: null, priority: false };

function resetEnrollmentHandoff() {
  enrollmentHandoff = { ticketId: "", stationId: null, priority: false };
}

function enrollmentHandoffFor(serving) {
  if (!serving || enrollmentHandoff.ticketId !== serving.id) resetEnrollmentHandoff();
  if (serving) enrollmentHandoff.ticketId = serving.id;
  return enrollmentHandoff;
}

function stationFullToday(station) {
  var limit = stationLimitToday(station);
  return limit > 0 && countStationTicketsToday(station.id) >= limit;
}

// The choices in the To Station list, in order: [{ value, label, disabled, kind }]. value "" = complete here.
// kind: "complete", "next", "skip" (a later step) or "insert" (another station).
function enrollmentHandoffOptions(stationId, serving) {
  if (!serving) return [];
  var flow = ticketEnrollmentFlow(serving);
  var step = Number(serving.enrollmentStep) || 0;
  var ahead = flow.slice(step + 1);
  var options = [];
  var listed = {};
  listed[stationId] = true;

  if (!ahead.length) {
    options.push({ value: "", label: "Complete enrollment here", disabled: false, kind: "complete" });
  } else {
    var next = stations.find(function (s) { return s.id === ahead[0]; });
    options.push({
      value: ahead[0],
      label: (next ? next.name : "A removed station") + " (next step" +
        (!next ? "" : next.active === false ? ", currently unavailable" : stationFullToday(next) ? ", full today" : "") + ")",
      disabled: !next || next.active === false || stationFullToday(next),
      kind: "next"
    });
    listed[ahead[0]] = true;
  }

  // Sending them anywhere else is a transfer, which System Rules can switch off.
  if (!roleCan("transfer")) return options;

  ahead.slice(1).forEach(function (id, i) {
    if (listed[id]) return;
    listed[id] = true;
    var s = stations.find(function (x) { return x.id === id; });
    if (!s || s.active === false) return;
    var skips = i + 1;
    options.push({
      value: id,
      label: s.name + " (skips " + skips + (skips === 1 ? " step" : " steps") + (stationFullToday(s) ? ", full today" : "") + ")",
      disabled: stationFullToday(s),
      kind: "skip"
    });
  });

  getSortedStations().forEach(function (s) {
    if (listed[s.id] || s.active === false) return;
    options.push({ value: s.id, label: s.name + (stationFullToday(s) ? " (full today)" : ""), disabled: stationFullToday(s), kind: "insert" });
  });
  return options;
}

// The option staff have picked: their choice while it is still on the list and usable, else the default (the first).
function enrollmentHandoffChoice(stationId, serving) {
  var options = enrollmentHandoffOptions(stationId, serving);
  var handoff = enrollmentHandoffFor(serving);
  var picked = handoff.stationId === null ? null : options.find(function (o) { return o.value === handoff.stationId && !o.disabled; });
  return picked || options[0] || null;
}

function onEnrollmentToStation(select) {
  enrollmentHandoff.stationId = select.value;
  renderQueueManagement();
}

function onEnrollmentPriority(input) {
  enrollmentHandoff.priority = !!input.checked;
}

// What happens with the chosen option, in one line under the list.
function enrollmentHandoffNote(serving, choice) {
  if (!choice) return "";
  var flow = ticketEnrollmentFlow(serving);
  var step = Number(serving.enrollmentStep) || 0;
  var ahead = flow.slice(step + 1);
  var names = function (ids) { return ids.map(function (id) { return stationNameById(id) || "a removed station"; }).join(", "); };
  if (choice.kind === "complete") return "This is their last enrollment station.";
  if (choice.kind === "next") return "The next step of their enrollment.";
  if (choice.kind === "skip") return "Skips " + names(ahead.slice(0, ahead.indexOf(choice.value))) + ".";
  return "Added as an extra step, then they " +
    (ahead.length ? "continue to " + names([ahead[0]]) + "." : "complete their enrollment there.");
}

// The hand-off box without the Detour: To Station (the next step by default), Prioritize, and the button.
function enrollmentProceedOnlyHtml(stationId, serving) {
  var options = enrollmentHandoffOptions(stationId, serving);
  var choice = enrollmentHandoffChoice(stationId, serving);
  var handoff = enrollmentHandoffFor(serving);
  var canPrioritize = roleCan("prioritize");
  var completing = !!choice && choice.kind === "complete";
  var chosenName = choice && choice.value ? stationNameById(choice.value) : "";

  var optionsHtml = options.length ? options.map(function (o) {
    return '<option value="' + escapeAdminText(o.value) + '"' + (choice && o.value === choice.value ? ' selected' : '') + (o.disabled ? ' disabled' : '') + '>' +
      escapeAdminText(o.label) + '</option>';
  }).join("") : '<option value="">—</option>';

  var label = !serving ? "⇄ Proceed to Next Station" :
    completing ? "✓ Complete Enrollment" :
    choice && choice.kind === "next" ? "⇄ Proceed to Next Station" :
    "⇄ Transfer to " + (chosenName || "…");
  var disabled = !serving || !choice || choice.disabled;
  var title = serving && choice && choice.disabled ? "That station can't take this ticket right now" : "";

  return '<div class="enrollment-proceed">' +
      '<p class="enrollment-proceed-title">Transfer Ticket</p>' +
      '<label class="enrollment-proceed-label" for="enrollmentToStation">To Station</label>' +
      '<select id="enrollmentToStation" class="qm-select enrollment-to-station" onchange="onEnrollmentToStation(this)"' + (serving ? '' : ' disabled') + '>' +
        optionsHtml + '</select>' +
      (serving ? '<p class="enrollment-detour-note">' + escapeAdminText(enrollmentHandoffNote(serving, choice)) + '</p>' : '') +
      '<label class="enforcer-priority qm-transfer-priority enrollment-priority"' + (canPrioritize ? '' : ' title="' + ROLE_RULE_OFF_TITLE + '"') + '>' +
        '<input type="checkbox" id="enrollmentPriority"' + (handoff.priority && canPrioritize && !completing ? ' checked' : '') +
          (serving && canPrioritize && !completing ? '' : ' disabled') + ' onchange="onEnrollmentPriority(this)">' +
        '<span><b>Prioritize</b><small>Front of the next station&#39;s line.</small></span>' +
      '</label>' +
      '<button type="button" class="bigBtn transfer-btn enrollment-proceed-btn' + (completing ? ' is-complete' : '') + '"' +
        (disabled ? ' disabled' : '') + (title ? ' title="' + title + '"' : '') +
        ' onclick="confirmProceed(\'' + escapeAdminText(stationId) + '\')">' + escapeAdminText(label) + '</button>' +
    '</div>';
}

// The hand-off box with the Detour (ENROLLMENT_DETOUR_ENABLED): Proceed to the next station of the process (or
// Complete at the last), or a detour to another station first, after which the student comes back here.
function enrollmentProceedHtml(stationId, serving) {
  if (!ENROLLMENT_DETOUR_ENABLED) return enrollmentProceedOnlyHtml(stationId, serving);

  var nextId = serving ? nextEnrollmentStationId(serving) : "";
  var nextStation = nextId ? stations.find(function (s) { return s.id === nextId; }) : null;
  var detour = enrollmentDetourFor(serving);
  var canDetour = roleCan("transfer");
  var detouring = !!serving && detour.on && canDetour;
  var sid = escapeAdminText(stationId);

  var proceedText = !serving ? "Proceed to the next station" :
    !nextId ? "Complete enrollment here" :
    !nextStation ? "Proceed to a station that no longer exists" :
    "Proceed to " + nextStation.name + (nextStation.active === false ? " (currently unavailable)" : "");
  var proceedBlocked = !!serving && !!nextId && (!nextStation || nextStation.active === false);

  var choices = enrollmentDetourChoices(stationId);
  var picked = choices.find(function (c) { return c.id === detour.stationId && !c.full; });
  var hereName = stationNameById(stationId) || "this station";
  var thenText = "then they come back here to " + hereName + ", also at the front of the line" +
    (nextId ? ", before going on to " + (stationNameById(nextId) || "the next station") + "." : ", to finish their enrollment.");

  var detourOptions = '<option value="">Choose a station</option>' + choices.map(function (c) {
    return '<option value="' + escapeAdminText(c.id) + '"' + (c.id === detour.stationId && !c.full ? ' selected' : '') + (c.full ? ' disabled' : '') + '>' +
      escapeAdminText(c.name + (c.full ? " (full today)" : "")) + '</option>';
  }).join("");

  var label = detouring ? "⇄ Detour to " + (picked ? picked.name : "…") :
    serving && !nextId ? "✓ Complete Enrollment" : "⇄ Proceed to Next Station";
  var disabled = !serving || (detouring ? !picked : proceedBlocked);
  var title = detouring && !picked ? "Choose the station for the detour" : proceedBlocked && !detouring ? "The next station is unavailable" : "";

  return '<div class="enrollment-proceed">' +
      '<p class="enrollment-proceed-title">Transfer Ticket</p>' +
      '<div class="enrollment-routes">' +
      '<label class="enrollment-route">' +
        '<input type="radio" name="enrollmentRoute"' + (detouring ? '' : ' checked') + (serving ? '' : ' disabled') +
          ' onchange="setEnrollmentDetourMode(false)"><span>' + escapeAdminText(proceedText) + '</span>' +
      '</label>' +
      '<label class="enrollment-route"' + (canDetour ? '' : ' title="' + ROLE_RULE_OFF_TITLE + '"') + '>' +
        '<input type="radio" name="enrollmentRoute"' + (detouring ? ' checked' : '') + (serving && canDetour && choices.length ? '' : ' disabled') +
          ' onchange="setEnrollmentDetourMode(true)"><span>Detour</span>' +
      '</label>' +
      '</div>' +
      (detouring ?
        '<div class="enrollment-detour">' +
          '<label class="enrollment-proceed-label" for="enrollmentDetourStation">Detour To</label>' +
          '<select id="enrollmentDetourStation" class="qm-select" onchange="onEnrollmentDetourStation(this)">' + detourOptions + '</select>' +
          '<p class="enrollment-detour-note">' + escapeAdminText((picked ? picked.name : "The station") + " is added at the front of its line, " + thenText) + '</p>' +
        '</div>' : '') +
      '<button type="button" class="bigBtn transfer-btn enrollment-proceed-btn' + (serving && !nextId && !detouring ? ' is-complete' : '') + '"' +
        (disabled ? ' disabled' : '') + (title ? ' title="' + title + '"' : '') +
        ' onclick="confirmProceed(\'' + sid + '\')">' + escapeAdminText(label) + '</button>' +
    '</div>';
}

function confirmProceed(stationId) {
  var serving = myServingTicket(stationId);
  if (!serving || serving.enrollment !== true) return;

  var detour = enrollmentDetourFor(serving);
  if (ENROLLMENT_DETOUR_ENABLED && detour.on && roleCan("transfer")) return confirmEnrollmentDetour(stationId, serving, detour.stationId);

  // The station picked in Transfer Ticket (with the Detour switched on, the panel only proceeds to the next step).
  var choice = ENROLLMENT_DETOUR_ENABLED ? null : enrollmentHandoffChoice(stationId, serving);
  var priority = !ENROLLMENT_DETOUR_ENABLED && enrollmentHandoffFor(serving).priority && roleCan("prioritize");
  if (choice && choice.disabled) {
    say("That station can't take this ticket right now. Please choose another one.");
    return;
  }
  if (choice && (choice.kind === "skip" || choice.kind === "insert")) return confirmEnrollmentReroute(stationId, serving, choice, priority);

  var nextId = nextEnrollmentStationId(serving);
  var nextName = stationNameById(nextId);
  var back = serving.detourReturn === true; // back from a detour: front of the line again
  var front = back || priority;

  showConfirmModal(nextId ? {
    title: "Send " + serving.ticketNo + " to " + (nextName || "the next station") + "?",
    message: serving.ownerName + " joins the " + (front ? "front" : "back") + " of " + (nextName || "the next station") + "'s line with a new number there" +
      (back ? " (back from a detour)" : priority ? " (prioritized)" : "") + ". They are told where to go next.",
    confirmLabel: "Proceed",
    tone: "primary",
    onConfirm: function () {
      return proceedEnrollmentTicket(stationId, { priority: priority }).then(function (done) {
        if (done) resetEnrollmentHandoff();
      });
    }
  } : {
    title: "Complete the enrollment of " + serving.ticketNo + "?",
    message: "This is " + serving.ownerName + "'s last enrollment station. Their ticket is marked completed.",
    confirmLabel: "Complete Enrollment",
    tone: "primary",
    onConfirm: function () { return proceedEnrollmentTicket(stationId); }
  });
}

// Sending an enrollee to a station other than their next step: a later step (skipping the ones in between) or another
// station (an extra step, then the rest of their process).
function confirmEnrollmentReroute(stationId, serving, choice, priority) {
  var destName = stationNameById(choice.value) || "that station";
  var flow = ticketEnrollmentFlow(serving);
  var ahead = flow.slice((Number(serving.enrollmentStep) || 0) + 1);
  var after = choice.kind === "skip" ?
    ", skipping " + ahead.slice(0, ahead.indexOf(choice.value)).map(function (id) { return stationNameById(id) || "a removed station"; }).join(", ") :
    ahead.length ? ", then continue to " + (stationNameById(ahead[0]) || "the next station") : ", and complete their enrollment there";

  showConfirmModal({
    title: "Send " + serving.ticketNo + " to " + destName + "?",
    message: serving.ownerName + " joins the " + (priority ? "front" : "back") + " of " + destName + "'s line with a new number there" + after +
      ". Only this student's enrollment steps change; Enrollment Settings stay the same.",
    confirmLabel: "Transfer",
    tone: "primary",
    onConfirm: function () {
      return rerouteEnrollmentTicket(stationId, choice.value, priority).then(function (done) {
        if (done) resetEnrollmentHandoff();
      });
    }
  });
}

function confirmEnrollmentDetour(stationId, serving, destId) {
  var dest = stations.find(function (s) { return s.id === destId; });
  if (!dest) {
    say("Please choose the station for the detour.");
    return;
  }
  var nextId = nextEnrollmentStationId(serving);
  var hereName = stationNameById(stationId) || "this station";
  var after = "then they come back to " + hereName + " at the front of the line" +
    (nextId ? " and continue to " + (stationNameById(nextId) || "the next station") + " after that" : " to finish their enrollment");

  showConfirmModal({
    title: "Send " + serving.ticketNo + " to " + dest.name + " first?",
    message: serving.ownerName + " joins the front of " + dest.name + "'s line with a new number there, " + after +
      ". Only this student's enrollment steps change; Enrollment Settings stay the same.",
    confirmLabel: "Detour",
    tone: "primary",
    onConfirm: function () {
      return detourEnrollmentTicket(stationId, dest.id).then(function (done) {
        if (done) resetEnrollmentDetour();
      });
    }
  });
}
