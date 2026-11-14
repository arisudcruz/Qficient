// Enrollment tickets in Queue Management (js/admin-queue.js): while one is being served, End Transaction and Transfer
// give way to sending the student on to the next station of their enrollment process ("Proceed to Next Station"),
// finishing at the last one ("Complete Enrollment"), or a detour to another station first.

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

// The hand-off box under the serving buttons: Proceed to the next station of the process (or Complete at the last),
// or a detour to another station first, after which the student carries on with the step that was next.
function enrollmentProceedHtml(stationId, serving) {
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
  if (detour.on && roleCan("transfer")) return confirmEnrollmentDetour(stationId, serving, detour.stationId);

  var nextId = nextEnrollmentStationId(serving);
  var nextName = stationNameById(nextId);
  var back = serving.detourReturn === true; // back from a detour: front of the line again

  showConfirmModal(nextId ? {
    title: "Send " + serving.ticketNo + " to " + (nextName || "the next station") + "?",
    message: serving.ownerName + " joins the " + (back ? "front" : "back") + " of " + (nextName || "the next station") + "'s line with a new number there" +
      (back ? " (back from a detour)" : "") + ". They are told where to go next.",
    confirmLabel: "Proceed",
    tone: "primary",
    onConfirm: function () { return proceedEnrollmentTicket(stationId); }
  } : {
    title: "Complete the enrollment of " + serving.ticketNo + "?",
    message: "This is " + serving.ownerName + "'s last enrollment station. Their ticket is marked completed.",
    confirmLabel: "Complete Enrollment",
    tone: "primary",
    onConfirm: function () { return proceedEnrollmentTicket(stationId); }
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
