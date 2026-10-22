function ordinal(n) {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
  return n + suffix;
}

// " (step 2 of 3)" for an enrollment ticket.
function stepOf(t) {
  const total = Array.isArray(t.enrollmentFlow) ? t.enrollmentFlow.length : 0;
  return total ? " (step " + ((Number(t.enrollmentStep) || 0) + 1) + " of " + total + ")" : "";
}

function minutes(n) {
  return n + (n === 1 ? " minute" : " minutes");
}

// Each builder returns { title, body }. Keep the wording short: it shows on a lock screen.
module.exports = {
  serving: (t, station) => ({
    title: "It's your turn!",
    body: "Ticket " + t.ticketNo + " is now being served at " + station + ". Please go to the counter."
  }),

  recall: (t, station) => ({
    title: "Please go to the counter",
    body: station + " is calling ticket " + t.ticketNo + "."
  }),

  skipped: (t, station, voidMinutes) => ({
    title: "Your ticket is on hold",
    body: "Return to " + station + " within " + minutes(voidMinutes) + " to keep ticket " + t.ticketNo + "."
  }),

  lastCall: (t, station, voidMinutes) => ({
    title: "Last call",
    body: "Return to " + station + " within " + minutes(voidMinutes) + " or ticket " + t.ticketNo + " will be voided."
  }),

  soon: (t, station, place) => ({
    title: "You're " + (place === 2 ? "2nd" : "3rd") + " in line",
    body: "Ticket " + t.ticketNo + " at " + station + " is almost up. Please stay nearby."
  }),

  manualCreated: (t, station, place) => ({
    title: "Your ticket is " + t.ticketNo,
    body: "You are in line at " + station + (place > 0 ? " (" + ordinal(place) + " in line)" : "") + ". We'll text you when it's almost your turn. Please keep this message."
  }),

  // History only (no push): the student joined, or their transaction finished.
  joined: (t, station, place) => ({
    title: "You're in line",
    body: "Ticket " + t.ticketNo + " at " + station + (place > 0 ? " (" + ordinal(place) + " in line)" : "") + "."
  }),

  completed: (t, station) => ({
    title: "Transaction complete",
    body: "Ticket " + t.ticketNo + " at " + station + " is done. Thank you!"
  }),

  // Enrollment: a student goes through several stations in order.
  enrollmentJoined: (t, station, place) => ({
    title: "Your enrollment has started",
    body: "Ticket " + t.ticketNo + ": please go to " + station + " first" + (place > 0 ? " (" + ordinal(place) + " in line)" : "") + "."
  }),

  enrollmentNext: (t, station) => ({
    title: "Next enrollment step: " + station,
    body: "Please go to " + station + stepOf(t) + ". Your new number is " + t.ticketNo + "."
  }),

  enrollmentCompleted: (t) => ({
    title: "Enrollment complete",
    body: "You've finished every enrollment step. Thank you!"
  }),

  enrollmentManualCreated: (t, station, place) => ({
    title: "Your ticket is " + t.ticketNo,
    body: "Your enrollment starts at " + station + (place > 0 ? " (" + ordinal(place) + " in line)" : "") + ". We'll text you at each step. Please keep this message."
  }),

  next: (t, station) => ({
    title: "You're next in line",
    body: "Ticket " + t.ticketNo + " is next at " + station + ". Please get ready."
  }),

  transferred: (t, station) => ({
    title: "Ticket transferred",
    body: "Your ticket is now " + t.ticketNo + " at " + station + "."
  }),

  voidedAuto: (t) => ({
    title: "Ticket voided",
    body: "Ticket " + t.ticketNo + " was voided because the time ran out."
  }),

  voidedManual: (t) => ({
    title: "Ticket removed",
    body: "Ticket " + t.ticketNo + " was removed by staff."
  })
};
