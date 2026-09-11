function myTicket() {
  for (var i = 0; i < tickets.length; i++) {
    var ticket = tickets[i];
    if (ticket.ownerId === user.id && (ticket.status === "waiting" || ticket.status === "called")) {
      return ticket;
    }
  }
  return null;
}

function joinQueue(stationId) {
  if (myTicket()) {
    say("You already have an active ticket.");
    return;
  }

  var stationRef = db.collection("stations").doc(stationId);

  db.runTransaction(function (transaction) {
    return transaction.get(stationRef).then(function (doc) {
      var data = doc.data();
      var newCount = (data.count || 0) + 1;
      var letter = data.name.charAt(0);
      var number = String(newCount).padStart(3, "0");
      var ticketNo = letter + "-" + number;

      transaction.update(stationRef, { count: newCount });
      var ticketRef = db.collection("tickets").doc();
      transaction.set(ticketRef, {
        ticketNo: ticketNo,
        stationId: stationId,
        ownerId: user.id,
        ownerName: user.name,
        status: "waiting",
        verified: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      return { ticketNo: ticketNo, stationName: data.name };
    });
  }).then(function (result) {
    say("Ticket " + result.ticketNo + " created for " + result.stationName + "!");
  }).catch(function (err) {
    say("Could not join queue: " + err.message);
  });
}

function cancelTicket() {
  var ticket = myTicket();
  if (ticket) {
    db.collection("tickets").doc(ticket.id).update({ status: "cancelled" });
  }
}
