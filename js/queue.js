var systemSettings = { autoVoidMinutes: 1 };
var AUTO_VOID_WINDOW_MS = systemSettings.autoVoidMinutes * 60 * 1000;
var CANCEL_COOLDOWN_MS = 20 * 1000;
var ACTIVE_TICKET_STATUSES = ["waiting", "serving", "skipped"];

function getTicketPrefix(stationName) {
  return String(stationName).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "TK";
}

function formatVoidWindow() {
  var minutes = systemSettings.autoVoidMinutes;
  return minutes + (minutes === 1 ? " minute" : " minutes");
}

var QUEUE_TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Philippine time (UTC+8), matching firestore.rules
var DAY_MS = 24 * 60 * 60 * 1000;

function queueDayKey(ms) {
  return new Date(ms + QUEUE_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function startOfTodayMs() {
  var now = Date.now();
  return Math.floor((now + QUEUE_TZ_OFFSET_MS) / DAY_MS) * DAY_MS - QUEUE_TZ_OFFSET_MS;
}

// Tickets are a per-day queue: anything created before today is stale.
function isTodayTicket(ticket) {
  var createdMs = (ticket.createdAt && typeof ticket.createdAt.toMillis === "function") ? ticket.createdAt.toMillis() : Date.now();
  return createdMs >= startOfTodayMs();
}

function servingTicketOf(station) {
  if (!station || !station.nowServingId) return null;
  var ticket = tickets.find(function (t) { return t.id === station.nowServingId; });
  return ticket && ticket.status === "serving" && isTodayTicket(ticket) ? ticket : null;
}

function countStationTicketsToday(stationId) {
  return tickets.filter(function (t) {
    if (t.stationId !== stationId || t.status === "cancelled" || t.status === "void") return false;
    return isTodayTicket(t);
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
  if (!user) return null;

  for (var i = 0; i < tickets.length; i++) {
    var ticket = tickets[i];
    if (ticket.ownerId === user.id && ACTIVE_TICKET_STATUSES.indexOf(ticket.status) !== -1 && isTodayTicket(ticket)) {
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

var joiningQueue = false;

function joinQueue(stationId, purpose) {
  if (joiningQueue) return;

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

  joiningQueue = true;

  db.runTransaction(function (transaction) {
    return transaction.get(stationRef).then(function (doc) {
      var data = doc.data();
      var today = queueDayKey(Date.now());

      // Ticket numbers restart at 001 on the first join of each day.
      var isNewDay = data.countDay !== today;
      var newCount = isNewDay ? 1 : (data.count || 0) + 1;
      var number = String(newCount).padStart(3, "0");
      var ticketNo = getTicketPrefix(data.name) + "-" + number;

      transaction.update(stationRef, isNewDay ? { count: newCount, countDay: today } : { count: newCount });
      var ticketRef = db.collection("tickets").doc();
      transaction.set(ticketRef, {
        ticketNo: ticketNo,
        stationId: stationId,
        ownerId: user.id,
        ownerName: user.name,
        studentNumber: user.studentNumber || "",
        studentType: user.type === "guest" ? "guest" : (user.studentType || ""),
        purpose: purpose || "",
        status: "waiting",
        verified: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      return { ticketNo: ticketNo, stationName: data.name };
    });
  }).then(function (result) {
    // Hold the lock briefly so the new ticket reaches the snapshot before another join is allowed.
    setTimeout(function () { joiningQueue = false; }, 1500);
    say("Ticket " + result.ticketNo + " created for " + result.stationName + "!");
  }).catch(function (err) {
    joiningQueue = false;
    say("Could not join queue: " + err.message);
  });
}

function cancelTicket() {
  var ticket = myTicket();
  if (!ticket) return;

  if (ticket.status === "serving") {
    say("You're being served right now. Please speak to the staff at the counter.");
    return;
  }

  db.collection("tickets").doc(ticket.id).update({
    status: "cancelled",
    cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(function (err) {
    say("Could not cancel your ticket: " + err.message);
  });
}

// Prioritized tickets go first (earliest prioritized first), then everyone else in arrival order.
function compareQueueOrder(a, b) {
  var aPriority = !!a.prioritizedAt;
  var bPriority = !!b.prioritizedAt;

  if (aPriority !== bPriority) return aPriority ? -1 : 1;
  if (aPriority) return timestampToMs(a.prioritizedAt, Date.now()) - timestampToMs(b.prioritizedAt, Date.now());

  return timestampToMs(a.createdAt, 0) - timestampToMs(b.createdAt, 0);
}

function getNextWaitingTicket(stationId) {
  return tickets
    .filter(function (t) { return t.stationId === stationId && t.status === "waiting" && isTodayTicket(t); })
    .sort(compareQueueOrder)[0] || null;
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

  // Only a ticket that is still being served gets completed; a cancelled or stale one must keep its status.
  var current = servingTicketOf(station);

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
  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(serving.id).update({
    status: "skipped",
    skippedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not skip ticket: " + err.message);
  });
}

function verifyCurrentTicket(stationId) {
  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(serving.id).update({
    verified: true,
    verifiedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(function (err) {
    say("Could not verify ticket: " + err.message);
  });
}

function removeCurrentTicket(stationId) {
  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  db.collection("tickets").doc(serving.id).update({
    status: "void",
    voidedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not remove ticket: " + err.message);
  });
}

// Moves the ticket being served to another station as a fresh ticket at the back of that queue.
function transferServingTicket(sourceStationId, destStationId, purpose) {
  var serving = servingTicketOf(stations.find(function (s) { return s.id === sourceStationId; }));
  var destStation = stations.find(function (s) { return s.id === destStationId; });

  if (!serving) {
    say("No ticket is currently being served.");
    return Promise.resolve(null);
  }
  if (!destStation || destStation.id === sourceStationId) {
    say("Please choose the station to transfer to.");
    return Promise.resolve(null);
  }
  if (destStation.active === false) {
    say("That station is currently unavailable.");
    return Promise.resolve(null);
  }
  if (destStation.maxQueue > 0 && countStationTicketsToday(destStationId) >= destStation.maxQueue) {
    say("That station has reached its daily queue limit.");
    return Promise.resolve(null);
  }

  var destRef = db.collection("stations").doc(destStationId);
  var ticketRef = db.collection("tickets").doc(serving.id);

  return db.runTransaction(function (transaction) {
    return Promise.all([transaction.get(destRef), transaction.get(ticketRef)]).then(function (docs) {
      var dest = docs[0].data();
      var ticket = docs[1].data();

      if (!dest || dest.active === false) throw new Error("That station is currently unavailable.");
      if (!ticket || ticket.status !== "serving") throw new Error("This ticket is no longer being served.");

      var today = queueDayKey(Date.now());
      var isNewDay = dest.countDay !== today;
      var newCount = isNewDay ? 1 : (dest.count || 0) + 1;
      var ticketNo = getTicketPrefix(dest.name) + "-" + String(newCount).padStart(3, "0");
      var now = firebase.firestore.FieldValue.serverTimestamp();
      var remove = firebase.firestore.FieldValue.delete();

      transaction.update(destRef, isNewDay ? { count: newCount, countDay: today } : { count: newCount });
      transaction.update(ticketRef, {
        stationId: destStationId,
        ticketNo: ticketNo,
        purpose: purpose || ticket.purpose,
        status: "waiting",
        verified: false,
        createdAt: now,
        transferredFrom: sourceStationId,
        previousTicketNo: ticket.ticketNo,
        transferredAt: now,
        servingAt: remove,
        verifiedAt: remove,
        recalledAt: remove,
        recallCount: remove,
        // Back of the queue means back of the queue: priority from the old station must not carry over.
        prioritizedAt: remove,
        nextNotified: remove
      });

      return { ticketNo: ticketNo, stationName: dest.name };
    });
  }).then(function (result) {
    advanceStation(sourceStationId);
    say("Ticket transferred to " + result.stationName + " as " + result.ticketNo + ".");
    return result;
  }).catch(function (err) {
    say("Could not transfer ticket: " + err.message);
    return null;
  });
}

// Staff create a ticket for someone who can't do it on their own device (Queue Enforcer).
// The contact email is kept in an admin-only collection, not on the ticket that every signed-in user can read.
function createManualTicket(details) {
  var station = stations.find(function (s) { return s.id === details.stationId; });

  if (!station || station.active === false) {
    say("That station is currently unavailable.");
    return Promise.resolve(null);
  }
  if (station.maxQueue > 0 && countStationTicketsToday(station.id) >= station.maxQueue) {
    say("This station has reached its daily queue limit.");
    return Promise.resolve(null);
  }

  var stationRef = db.collection("stations").doc(station.id);
  var ticketRef = db.collection("tickets").doc();
  var contactRef = db.collection("ticketContacts").doc(ticketRef.id);
  var createdBy = adminUser ? staffKey(adminUser.email) : "";

  return db.runTransaction(function (transaction) {
    return transaction.get(stationRef).then(function (doc) {
      var data = doc.data();
      if (!data || data.active === false) throw new Error("That station is currently unavailable.");

      var today = queueDayKey(Date.now());
      var isNewDay = data.countDay !== today;
      var newCount = isNewDay ? 1 : (data.count || 0) + 1;
      var ticketNo = getTicketPrefix(data.name) + "-" + String(newCount).padStart(3, "0");
      var now = firebase.firestore.FieldValue.serverTimestamp();

      transaction.update(stationRef, isNewDay ? { count: newCount, countDay: today } : { count: newCount });
      transaction.set(ticketRef, {
        ticketNo: ticketNo,
        stationId: station.id,
        ownerId: "manual:" + ticketRef.id,
        ownerName: details.firstName + " " + details.lastName,
        studentNumber: "",
        studentType: details.studentType,
        purpose: details.purpose,
        status: "waiting",
        verified: false,
        createdAt: now,
        manual: true,
        createdBy: createdBy
      });
      transaction.set(contactRef, { email: details.email, createdBy: createdBy, createdAt: now });

      return { ticketNo: ticketNo, stationName: data.name };
    });
  }).catch(function (err) {
    say("Could not create the ticket: " + err.message);
    return null;
  });
}

/* Actions on tickets picked from the queued list */

function reportQueueAction(promise, errorLabel) {
  return promise.then(function () {
    return true;
  }).catch(function (err) {
    say("Could not " + errorLabel + ": " + err.message);
    return false;
  });
}

function batchUpdateTickets(ticketIds, data) {
  var batch = db.batch();
  ticketIds.forEach(function (id) {
    batch.update(db.collection("tickets").doc(id), data);
  });
  return batch.commit();
}

// Serves a chosen ticket now, ahead of the rest of the queue. A ticket that is still being served is completed first.
function callSelectedTicket(stationId, ticketId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  var ticket = tickets.find(function (t) { return t.id === ticketId; });

  if (!station || !ticket || ticket.stationId !== stationId || (ticket.status !== "waiting" && ticket.status !== "skipped")) {
    say("That ticket can't be called right now.");
    return Promise.resolve(false);
  }

  var now = firebase.firestore.FieldValue.serverTimestamp();
  var remove = firebase.firestore.FieldValue.delete();
  var current = servingTicketOf(station);
  var batch = db.batch();

  if (current) {
    batch.update(db.collection("tickets").doc(current.id), { status: "completed", completedAt: now });
  }
  batch.update(db.collection("tickets").doc(ticket.id), {
    status: "serving",
    servingAt: now,
    skippedAt: remove,
    lastCalled: remove,
    lastCallAt: remove
  });
  batch.update(db.collection("stations").doc(stationId), { nowServingId: ticket.id });

  return reportQueueAction(batch.commit(), "call that ticket");
}

function prioritizeTickets(ticketIds) {
  return reportQueueAction(batchUpdateTickets(ticketIds, {
    prioritizedAt: firebase.firestore.FieldValue.serverTimestamp()
  }), "prioritize the tickets");
}

function recallTickets(ticketIds) {
  return reportQueueAction(batchUpdateTickets(ticketIds, {
    recalledAt: firebase.firestore.FieldValue.serverTimestamp(),
    recallCount: firebase.firestore.FieldValue.increment(1)
  }), "recall the tickets");
}

function removeTickets(ticketIds) {
  return reportQueueAction(batchUpdateTickets(ticketIds, {
    status: "void",
    voidedAt: firebase.firestore.FieldValue.serverTimestamp()
  }), "remove the tickets");
}

function recallTicket(ticketId) {
  if (!ticketId) return;

  db.collection("tickets").doc(ticketId).update({
    recalledAt: firebase.firestore.FieldValue.serverTimestamp(),
    recallCount: firebase.firestore.FieldValue.increment(1)
  }).then(function () {
    say("Recall notification sent.");
  }).catch(function (err) {
    say("Could not recall ticket: " + err.message);
  });
}

function timestampToMs(timestamp, fallbackMs) {
  return (timestamp && typeof timestamp.toMillis === "function") ? timestamp.toMillis() : fallbackMs;
}

function getSkipPhase(ticket) {
  var now = Date.now();

  if (ticket.lastCalled) {
    var lastCallBase = timestampToMs(ticket.lastCallAt, now);
    return { phase: "final", baseMs: lastCallBase, remainingMs: AUTO_VOID_WINDOW_MS - (now - lastCallBase) };
  }

  var skippedBase = timestampToMs(ticket.skippedAt, now);
  var remainingMs = AUTO_VOID_WINDOW_MS - (now - skippedBase);
  return { phase: remainingMs > 0 ? "initial" : "expired", baseMs: skippedBase, remainingMs: remainingMs };
}

function lastCallTicket(ticketId) {
  var ticket = tickets.find(function (t) { return t.id === ticketId; });
  if (!ticket || ticket.status !== "skipped" || getSkipPhase(ticket).phase !== "expired") return;

  db.collection("tickets").doc(ticketId).update({
    lastCalled: true,
    lastCallAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    say("Last call sent.");
  }).catch(function (err) {
    say("Could not send the last call: " + err.message);
  });
}

function checkAutoVoid() {
  var now = Date.now();

  tickets.forEach(function (ticket) {
    if (ticket.status !== "skipped" || !ticket.lastCalled) return;
    if (!ticket.lastCallAt || typeof ticket.lastCallAt.toMillis !== "function") return;

    if (now - ticket.lastCallAt.toMillis() >= AUTO_VOID_WINDOW_MS) {
      db.collection("tickets").doc(ticket.id).update({
        status: "void",
        voidedAt: firebase.firestore.FieldValue.serverTimestamp(),
        autoVoided: true
      });
    }
  });
}
