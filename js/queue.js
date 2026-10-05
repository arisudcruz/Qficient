var systemSettings = { autoVoidMinutes: 1 };
var AUTO_VOID_WINDOW_MS = systemSettings.autoVoidMinutes * 60 * 1000;
var CANCEL_COOLDOWN_MS = 20 * 1000;
var ACTIVE_TICKET_STATUSES = ["waiting", "serving", "skipped"];

function formatVoidWindow() {
  var minutes = systemSettings.autoVoidMinutes;
  return minutes + (minutes === 1 ? " minute" : " minutes");
}

function countStationTicketsToday(stationId) {
  var startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return tickets.filter(function (t) {
    if (t.stationId !== stationId || t.status === "cancelled" || t.status === "void") return false;
    var createdMs = (t.createdAt && typeof t.createdAt.toMillis === "function") ? t.createdAt.toMillis() : Date.now();
    return createdMs >= startOfToday.getTime();
  }).length;
}

function getCancelCooldownRemaining() {
  if (!user) return 0;

  var lastCancelMs = 0;
  tickets.forEach(function (t) {
    if (t.ownerId !== user.id || t.status !== "cancelled") return;
    var ms = (t.cancelledAt && typeof t.cancelledAt.toMillis === "function") ? t.cancelledAt.toMillis() : 0;
    if (ms > lastCancelMs) lastCancelMs = ms;
  });

  if (!lastCancelMs) return 0;

  var remaining = CANCEL_COOLDOWN_MS - (Date.now() - lastCancelMs);
  return remaining > 0 ? remaining : 0;
}

function myTicket() {
  for (var i = 0; i < tickets.length; i++) {
    var ticket = tickets[i];
    if (ticket.ownerId === user.id && ACTIVE_TICKET_STATUSES.indexOf(ticket.status) !== -1) {
      return ticket;
    }
  }
  return null;
}

function formatCountdown(ms) {
  var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function joinQueue(stationId, purpose) {
  if (myTicket()) {
    say("You already have an active ticket.");
    return;
  }

  var cooldownMs = getCancelCooldownRemaining();
  if (cooldownMs > 0) {
    say("Please wait " + formatCountdown(cooldownMs) + " before joining again.");
    return;
  }

  var station = stations.find(function (s) { return s.id === stationId; });
  if (station && station.active === false) {
    say("This station is currently unavailable.");
    return;
  }
  if (station && station.maxQueue > 0 && countStationTicketsToday(stationId) >= station.maxQueue) {
    say("This station has reached its daily queue limit. Please try again tomorrow.");
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
        studentNumber: user.studentNumber || "",
        studentType: user.studentType || "",
        fcmToken: user.fcmToken || "",
        purpose: purpose || "",
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
    db.collection("tickets").doc(ticket.id).update({
      status: "cancelled",
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
}

function getNextWaitingTicket(stationId) {
  return tickets
    .filter(function (t) { return t.stationId === stationId && t.status === "waiting"; })
    .sort(function (a, b) {
      var aMs = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      var bMs = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return aMs - bMs;
    })[0] || null;
}

function advanceStation(stationId) {
  var next = getNextWaitingTicket(stationId);
  var stationRef = db.collection("stations").doc(stationId);

  if (next) {
    stationRef.update({ nowServingId: next.id });
    db.collection("tickets").doc(next.id).update({
      status: "serving",
      servingAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    stationRef.update({ nowServingId: null });
  }
}

function callNextTicket(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  var current = station.nowServingId ? tickets.find(function (t) { return t.id === station.nowServingId; }) : null;

  var finish = current ?
    db.collection("tickets").doc(current.id).update({
      status: "completed",
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    }) :
    Promise.resolve();

  finish.then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not call next ticket: " + err.message);
  });
}

function skipCurrentTicket(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station || !station.nowServingId) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(station.nowServingId).update({
    status: "skipped",
    skippedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not skip ticket: " + err.message);
  });
}

function verifyCurrentTicket(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station || !station.nowServingId) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(station.nowServingId).update({
    verified: true,
    verifiedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(function (err) {
    say("Could not verify ticket: " + err.message);
  });
}

function removeCurrentTicket(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station || !station.nowServingId) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(station.nowServingId).update({
    status: "void",
    voidedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not remove ticket: " + err.message);
  });
}

function recallTicket(ticketId) {
  if (!ticketId) return;

  db.collection("tickets").doc(ticketId).update({
    recalledAt: firebase.firestore.FieldValue.serverTimestamp(),
    skippedAt: firebase.firestore.FieldValue.serverTimestamp(),
    recallCount: firebase.firestore.FieldValue.increment(1)
  }).then(function () {
    say("Recall notification sent.");
  }).catch(function (err) {
    say("Could not recall ticket: " + err.message);
  });
}

function checkAutoVoid() {
  var now = Date.now();

  tickets.forEach(function (ticket) {
    if (ticket.status !== "skipped") return;
    if (!ticket.skippedAt || typeof ticket.skippedAt.toMillis !== "function") return;

    if (now - ticket.skippedAt.toMillis() >= AUTO_VOID_WINDOW_MS) {
      db.collection("tickets").doc(ticket.id).update({
        status: "void",
        voidedAt: firebase.firestore.FieldValue.serverTimestamp(),
        autoVoided: true
      });
    }
  });
}
