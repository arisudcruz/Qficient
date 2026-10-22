// The Enrollment page (#/admin/enrollment). It is the Queue Management page (js/admin-queue.js) running the
// stations' enrollment lines: instead of End Transaction, the student being served is sent on to the next station
// of their enrollment process ("Proceed to Next Station"), or finishes at the last one ("Complete Enrollment").

// "Step 2 of 3 · next: Assessment"
function enrollmentStepText(ticket) {
  var flow = ticketEnrollmentFlow(ticket);
  var step = (Number(ticket.enrollmentStep) || 0) + 1;
  var nextId = nextEnrollmentStationId(ticket);
  return "Step " + step + " of " + (flow.length || step) + (nextId ? " · next: " + (stationNameById(nextId) || "a removed station") : " · last station");
}

// The hand-off box under the serving buttons: where the student goes next, and the button that sends them there.
function enrollmentProceedHtml(stationId, serving) {
  var nextId = serving ? nextEnrollmentStationId(serving) : "";
  var nextStation = nextId ? stations.find(function (s) { return s.id === nextId; }) : null;

  var destText = !serving ? "—" :
    !nextId ? "None. This is their last station." :
    !nextStation ? "A station that no longer exists" :
    nextStation.name + (nextStation.active === false ? " (currently unavailable)" : "");

  var blocked = !!serving && !!nextId && (!nextStation || nextStation.active === false);
  var label = serving && !nextId ? "✓ Complete Enrollment" : "⇄ Proceed to Next Station";

  return '<div class="enrollment-proceed">' +
      '<p class="enrollment-proceed-title">Transfer Ticket</p>' +
      '<label class="enrollment-proceed-label" for="enrollmentNextStation">To Station</label>' +
      '<input type="text" id="enrollmentNextStation" class="enrollment-proceed-dest" value="' + escapeAdminText(destText) + '" readonly>' +
      '<button type="button" class="bigBtn transfer-btn enrollment-proceed-btn' + (serving && !nextId ? ' is-complete' : '') + '"' +
        (serving && !blocked ? '' : ' disabled') +
        (blocked ? ' title="The next station is unavailable"' : '') +
        ' onclick="confirmProceed(\'' + escapeAdminText(stationId) + '\')">' + label + '</button>' +
    '</div>';
}

function confirmProceed(stationId) {
  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }), "enrollment");
  if (!serving) return;

  var nextId = nextEnrollmentStationId(serving);
  var nextName = stationNameById(nextId);

  showConfirmModal(nextId ? {
    title: "Send " + serving.ticketNo + " to " + (nextName || "the next station") + "?",
    message: serving.ownerName + " joins the back of " + (nextName || "the next station") + "'s enrollment line with a new number there. They are told where to go next.",
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
