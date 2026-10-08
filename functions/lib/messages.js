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
    title: "You were skipped",
    body: "Return to " + station + " within " + minutes(voidMinutes) + " to keep ticket " + t.ticketNo + "."
  }),

  lastCall: (t, station, voidMinutes) => ({
    title: "Last call",
    body: "Return to " + station + " within " + minutes(voidMinutes) + " or ticket " + t.ticketNo + " will be voided."
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
