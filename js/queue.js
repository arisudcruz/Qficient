var systemSettings = { autoVoidMinutes: 1 };
var AUTO_VOID_WINDOW_MS = systemSettings.autoVoidMinutes * 60 * 1000;
var CANCEL_COOLDOWN_MS = 20 * 1000;
var ACTIVE_TICKET_STATUSES = ["waiting", "serving", "skipped"];

function getTicketPrefix(stationName) {
  return String(stationName).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "TK";
}

// Each station has a ticket code: two letters from its name plus a number, so stations whose names start alike
// stay apart (Admission AD1, Admission2 AD2, Advising AD3). Tickets read AD1-001, AD1-002...
// The code is saved on the station when it is created and kept if it is renamed. A station from before codes
// existed gets the next free number for its letters, in order of station id; functions/lib/join.js does the
// same, so the app and the server always agree.
function assignStationCodes(list) {
  var codes = {};
  var used = {};

  list.forEach(function (station) {
    if (station.code) {
      codes[station.id] = String(station.code);
      used[String(station.code).toUpperCase()] = true;
    }
  });

  list.filter(function (station) { return !station.code; })
    .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
    .forEach(function (station) {
      codes[station.id] = nextStationCode(station.name, used);
      used[codes[station.id]] = true;
    });

  return codes;
}

// The first free code for a name: AD1, then AD2 if AD1 is taken... `used` maps codes already in use to true.
function nextStationCode(name, used) {
  var prefix = getTicketPrefix(name);
  var n = 1;
  while (used[prefix + n]) n++;
  return prefix + n;
}

function stationCodeOf(stationId) {
  return assignStationCodes(stations)[stationId] || "TK1";
}

function formatTicketNo(code, count) {
  return code + "-" + String(count).padStart(3, "0");
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

/* ---------- Enrollment: one ticket that moves through several stations ---------- */

// Enrollment tickets move through several stations in an order set per student type (Enrollment Settings). At each
// station they wait in the same line as everyone else and get a new number there. A ticket keeps the order of
// stations it started with.
var ENROLLMENT_PURPOSE = "Enrollment";
var ENROLLMENT_TYPES = ["regular", "transferee", "freshman"];
var enrollmentSettings = { flows: {} }; // settings/enrollment, kept current by js/firebase.js

// The stations a student type goes through, in order, as set now.
function enrollmentFlowFor(studentType) {
  var flow = (enrollmentSettings.flows || {})[studentType];
  return Array.isArray(flow) ? flow : [];
}

// Every station that is part of some enrollment process.
function enrollmentStationIds() {
  var ids = {};
  ENROLLMENT_TYPES.forEach(function (type) {
    enrollmentFlowFor(type).forEach(function (id) { ids[id] = true; });
  });
  return Object.keys(ids);
}

function ticketEnrollmentFlow(ticket) {
  return ticket && Array.isArray(ticket.enrollmentFlow) ? ticket.enrollmentFlow : [];
}

// The station an enrollment ticket goes to next, or "" at its last step.
function nextEnrollmentStationId(ticket) {
  var flow = ticketEnrollmentFlow(ticket);
  var step = Number(ticket.enrollmentStep) || 0;
  return step + 1 < flow.length ? flow[step + 1] : "";
}

function stationNameById(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station ? station.name : "";
}

// The ticket a station is serving. The pointer alone isn't trusted: the ticket must still be serving, today,
// at this station.
function servingTicketOf(station) {
  var id = station ? station.nowServingId : null;
  if (!id) return null;
  var ticket = tickets.find(function (t) { return t.id === id; });
  return ticket && ticket.status === "serving" && ticket.stationId === station.id && isTodayTicket(ticket) ? ticket : null;
}

function countStationTicketsToday(stationId) {
  return tickets.filter(function (t) {
    if (t.stationId !== stationId || t.status === "cancelled" || t.status === "void") return false;
    return isTodayTicket(t);
  }).length;
}

// Countdowns are measured from times the server wrote, so they must use the server's clock, not this device's
// (a phone or PC that is a minute off would otherwise show, and act on, the wrong time). The offset comes from
// the Date header of our own site, corrected for the round trip and for any time spent in a cache.
var serverOffsetMs = 0;
var SERVER_CLOCK_MAX_OFFSET_MS = 60 * 60 * 1000; // a device clock off by more than an hour is not believable

function serverNow() {
  return Date.now() + serverOffsetMs;
}

function syncServerClock() {
  var sentAt = Date.now();

  return fetch(window.location.pathname || "/", { method: "HEAD", cache: "no-store" }).then(function (response) {
    var receivedAt = Date.now();
    var header = response.headers.get("Date");
    var serverMs = header ? Date.parse(header) : NaN;
    if (isNaN(serverMs)) return;

    // Vercel stamps Date when it answers, even for a cached page, so the cache's Age header must NOT be added:
    // it is how old the cached copy is (often a day), not how stale the Date is.
    // The header is whole seconds, so the true time is about half a second later.
    var offset = serverMs + 500 - (sentAt + (receivedAt - sentAt) / 2);

    // A small gap is rounding; an implausibly large one means the header can't be trusted, so keep the device clock.
    if (Math.abs(offset) < 1500 || Math.abs(offset) > SERVER_CLOCK_MAX_OFFSET_MS) offset = 0;
    serverOffsetMs = Math.round(offset);
  }).catch(function () {});
}

syncServerClock();
setInterval(syncServerClock, 10 * 60 * 1000);
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") syncServerClock();
});

function getCancelCooldownRemaining() {
  if (!user) return 0;

  var lastCancelMs = 0;
  tickets.forEach(function (t) {
    if (t.ownerId !== user.id || t.status !== "cancelled") return;
    var ms = (t.cancelledAt && typeof t.cancelledAt.toMillis === "function") ? t.cancelledAt.toMillis() : 0;
    if (ms > lastCancelMs) lastCancelMs = ms;
  });

  if (!lastCancelMs) return 0;

  var remaining = CANCEL_COOLDOWN_MS - (serverNow() - lastCancelMs);
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

// Who may act on which station. Admins on any; Queue Management staff only on their own; an enforcer never
// serves, but tidies the queue (prioritize, recall, remove) at every station. These mirror firestore.rules.
function canServeStation(stationId) {
  return adminRole === "admin" || (!!adminRole && adminRole === stationId);
}

function canTidyStation(stationId) {
  return canServeStation(stationId) || adminRole === "enforcer";
}

function stationOfTicket(ticketId) {
  var ticket = tickets.find(function (t) { return t.id === ticketId; });
  return ticket ? ticket.stationId : null;
}

function refuseStation() {
  say("You can only manage your own station.");
}

function manilaDateTimeText(ms) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toLocaleString();
  }
}

// A student blocked for missing their turn too often (functions/lib/strikes.js) can't join until then.
function blockedJoinText() {
  var until = typeof studentBlockedUntilMs === "function" ? studentBlockedUntilMs() : 0;
  return until ? "You missed your turn 3 times in 7 days, so you can join again on " + manilaDateTimeText(until) +
    ". Please see the front desk if this is a mistake." : "";
}

function formatCountdown(ms) {
  var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

var JOIN_FUNCTION_REGION = "asia-east2"; // keep in step with functions/config.js
var joiningQueue = false;

// Starts the student's enrollment at the first station of their student type's process.
function joinEnrollment() {
  if (!user) return;
  var flow = enrollmentFlowFor(user.studentType);
  if (!flow.length) {
    say("Enrollment isn't open for your student type yet.");
    return;
  }
  return joinQueue(flow[0], ENROLLMENT_PURPOSE, { enrollment: true });
}

function joinQueue(stationId, purpose, options) {
  options = options || {};
  if (joiningQueue) return;

  if (myTicket()) {
    say("You already have an active ticket.");
    return;
  }

  var blocked = blockedJoinText();
  if (blocked) {
    sayProblem("You can't join the queue right now", blocked, "warning");
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

  joiningQueue = true;

  // The server creates the ticket (and enforces one live ticket per person and the join limits), so the
  // browser can't skip those checks by writing to the database directly.
  return firebase.app().functions(JOIN_FUNCTION_REGION).httpsCallable("joinQueue")({
    stationId: stationId,
    purpose: purpose,
    enrollment: !!options.enrollment
  }).then(function (response) {
    var result = response.data || {};
    // Hold the lock briefly so the new ticket reaches the snapshot before another join is allowed.
    setTimeout(function () { joiningQueue = false; }, 1500);
    var text = options.enrollment ?
      "Your enrollment has started. Ticket " + result.ticketNo + ": please go to " + result.stationName + " first." :
      "Ticket " + result.ticketNo + " created for " + result.stationName + "!";
    return Promise.resolve(sayDone(text)).then(function () { return true; });
  }).catch(function (err) {
    joiningQueue = false;
    var code = String(err && err.code || "").replace("functions/", "");
    var message = String(err && err.message || "").replace(/\s*\[\d{3}\]\s*$/, ""); // the SDK may add the HTTP status
    var known = ["failed-precondition", "resource-exhausted", "invalid-argument", "not-found", "permission-denied", "unauthenticated"];
    // Waiting a little or picking a purpose is a warning; everything else means the join did not happen.
    var softCodes = ["failed-precondition", "resource-exhausted", "invalid-argument"];

    sayProblem("Couldn't join the queue",
      known.indexOf(code) !== -1 && message ? message : "Something went wrong while joining the queue. Please try again.",
      softCodes.indexOf(code) !== -1 ? "warning" : "error");
  });
}

function cancelTicket() {
  var ticket = myTicket();
  if (!ticket) return;

  if (ticket.status === "serving") {
    say("You're being served right now. Please speak to the staff at the counter.");
    return;
  }

  return db.collection("tickets").doc(ticket.id).update({
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

// Calls the next waiting ticket (or empties the serving window), in one write.
function advanceStation(stationId) {
  var next = getNextWaitingTicket(stationId);
  var batch = db.batch();

  batch.update(db.collection("stations").doc(stationId), { nowServingId: next ? next.id : null });
  if (next) {
    batch.update(db.collection("tickets").doc(next.id), {
      status: "serving",
      servingAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  return batch.commit().catch(function (err) {
    say("Could not call the next ticket: " + err.message);
  });
}

function callNextTicket(stationId) {
  if (!canServeStation(stationId)) return refuseStation();

  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station) return;

  // Only a ticket that is still being served gets completed; a cancelled or stale one must keep its status.
  var current = servingTicketOf(station);

  // An enrollment student at the counter is sent on to their next station (or finishes) instead.
  if (current && current.enrollment === true) {
    return proceedEnrollmentTicket(stationId, { quiet: true }).then(function (ok) {
      if (ok) return advanceStation(stationId);
    });
  }

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
  if (!canServeStation(stationId)) return refuseStation();

  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  return db.collection("tickets").doc(serving.id).update({
    status: "skipped",
    skippedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    advanceStation(stationId);
  }).catch(function (err) {
    say("Could not put the ticket on hold: " + err.message);
  });
}

// Finishes the transaction at the counter: the ticket is marked completed and the serving window is cleared,
// so nobody is being served until the next call.
function completeCurrentTicket(stationId) {
  if (!canServeStation(stationId)) return refuseStation();

  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }
  if (serving.enrollment === true) {
    say("Enrollment tickets are sent on with Proceed to Next Station.");
    return;
  }

  var batch = db.batch();
  batch.update(db.collection("tickets").doc(serving.id), {
    status: "completed",
    completedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.update(db.collection("stations").doc(stationId), { nowServingId: null });

  return batch.commit().catch(function (err) {
    say("Could not end the transaction: " + err.message);
  });
}

// Sends the enrollment student being served at this station on to the next station of their process, with a new
// number there at the back of its line, or finishes their enrollment at the last station. The serving
// window is left empty (Call Next fills it). Resolves true when it went through.
function proceedEnrollmentTicket(sourceStationId, opts) {
  opts = opts || {};
  if (!canServeStation(sourceStationId)) {
    refuseStation();
    return Promise.resolve(false);
  }

  var station = stations.find(function (s) { return s.id === sourceStationId; });
  var serving = servingTicketOf(station);
  if (!serving || serving.enrollment !== true) {
    say("No enrollment ticket is currently being served.");
    return Promise.resolve(false);
  }

  var stationRef = db.collection("stations").doc(sourceStationId);
  var ticketRef = db.collection("tickets").doc(serving.id);
  var now = firebase.firestore.FieldValue.serverTimestamp();
  var nextId = nextEnrollmentStationId(serving);

  // Last station: the enrollment is done.
  if (!nextId) {
    var batch = db.batch();
    batch.update(ticketRef, { status: "completed", completedAt: now });
    batch.update(stationRef, { nowServingId: null });
    return batch.commit().then(function () {
      if (!opts.quiet) sayDone("Enrollment complete for " + serving.ticketNo + ".");
      return true;
    }).catch(function (err) {
      say("Could not complete the enrollment: " + err.message);
      return false;
    });
  }

  var dest = stations.find(function (s) { return s.id === nextId; });
  if (!dest) {
    say("The next station of this enrollment no longer exists. Ask an administrator to check Enrollment Settings.");
    return Promise.resolve(false);
  }
  if (dest.active === false) {
    say(dest.name + " is currently unavailable, so " + serving.ticketNo + " can't move on yet. Keep serving them or put them on hold.");
    return Promise.resolve(false);
  }

  var destRef = db.collection("stations").doc(nextId);
  var remove = firebase.firestore.FieldValue.delete();
  var step = Number(serving.enrollmentStep) || 0;

  return db.runTransaction(function (transaction) {
    return Promise.all([transaction.get(destRef), transaction.get(ticketRef)]).then(function (docs) {
      var destData = docs[0].data();
      var ticket = docs[1].data();

      if (!destData || destData.active === false) throw new Error(dest.name + " is currently unavailable.");
      if (!ticket || ticket.status !== "serving" || ticket.stationId !== sourceStationId || ticket.enrollment !== true) {
        throw new Error("This ticket is no longer being served here.");
      }
      if ((Number(ticket.enrollmentStep) || 0) !== step) throw new Error("This ticket has already moved on.");

      var today = queueDayKey(Date.now());
      var isNewDay = destData.countDay !== today;
      var newCount = isNewDay ? 1 : (destData.count || 0) + 1;
      var ticketNo = formatTicketNo(destData.code || stationCodeOf(nextId), newCount);

      transaction.update(destRef, isNewDay ? { count: newCount, countDay: today } : { count: newCount });
      transaction.update(ticketRef, {
        stationId: nextId,
        ticketNo: ticketNo,
        status: "waiting",
        verified: false,
        createdAt: now,
        enrollmentStep: step + 1,
        transferredFrom: sourceStationId,
        previousTicketNo: ticket.ticketNo,
        transferredAt: now,
        servingAt: remove,
        verifiedAt: remove,
        recalledAt: remove,
        recallCount: remove,
        prioritizedAt: remove,
        nextNotified: remove
      });
      transaction.update(stationRef, { nowServingId: null });

      return { ticketNo: ticketNo, stationName: destData.name };
    });
  }).then(function (result) {
    if (!opts.quiet) sayDone(serving.ticketNo + " moves on to " + result.stationName + " as " + result.ticketNo + ".");
    return true;
  }).catch(function (err) {
    say("Could not send the ticket on: " + err.message);
    return false;
  });
}

function removeCurrentTicket(stationId) {
  if (!canServeStation(stationId)) return refuseStation();

  var serving = servingTicketOf(stations.find(function (s) { return s.id === stationId; }));
  if (!serving) {
    say("No ticket is currently being served.");
    return;
  }

  return db.collection("tickets").doc(serving.id).update({
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
  if (!canServeStation(sourceStationId)) {
    refuseStation();
    return Promise.resolve(null);
  }

  var serving = servingTicketOf(stations.find(function (s) { return s.id === sourceStationId; }));
  var destStation = stations.find(function (s) { return s.id === destStationId; });

  if (!serving) {
    say("No ticket is currently being served.");
    return Promise.resolve(null);
  }
  if (serving.enrollment) {
    say("Enrollment tickets are sent on with Proceed to Next Station.");
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
      if (ticket.enrollment) throw new Error("Enrollment tickets are sent on with Proceed to Next Station.");

      var today = queueDayKey(Date.now());
      var isNewDay = dest.countDay !== today;
      var newCount = isNewDay ? 1 : (dest.count || 0) + 1;
      var ticketNo = formatTicketNo(dest.code || stationCodeOf(destStationId), newCount);
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
    sayDone("Ticket transferred to " + result.stationName + " as " + result.ticketNo + ".");
    return result;
  }).catch(function (err) {
    say("Could not transfer ticket: " + err.message);
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
  if (!canServeStation(stationId)) {
    refuseStation();
    return Promise.resolve(false);
  }

  var station = stations.find(function (s) { return s.id === stationId; });
  var ticket = tickets.find(function (t) { return t.id === ticketId; });

  if (!station || !ticket || ticket.stationId !== stationId ||
      (ticket.status !== "waiting" && ticket.status !== "skipped")) {
    say("That ticket can't be called right now.");
    return Promise.resolve(false);
  }

  var current = servingTicketOf(station);
  var enrolling = !!current && current.enrollment === true;

  // An enrollment student still at the counter is sent on (or finishes) first, never just closed.
  var before = enrolling ? proceedEnrollmentTicket(stationId, { quiet: true }) : Promise.resolve(true);

  return before.then(function (ok) {
    if (!ok) return false;

    var now = firebase.firestore.FieldValue.serverTimestamp();
    var remove = firebase.firestore.FieldValue.delete();
    var batch = db.batch();

    if (current && !enrolling) {
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
  });
}

// Bulk actions: every selected ticket must be at a station the person is allowed to tidy.
function mayTidyTickets(ticketIds) {
  var allowed = ticketIds.every(function (id) { return canTidyStation(stationOfTicket(id)); });
  if (!allowed) refuseStation();
  return allowed;
}

function prioritizeTickets(ticketIds) {
  if (!mayTidyTickets(ticketIds)) return Promise.resolve(false);

  return reportQueueAction(batchUpdateTickets(ticketIds, {
    prioritizedAt: firebase.firestore.FieldValue.serverTimestamp()
  }), "prioritize the tickets");
}

function recallTickets(ticketIds) {
  if (!mayTidyTickets(ticketIds)) return Promise.resolve(false);

  return reportQueueAction(batchUpdateTickets(ticketIds, {
    recalledAt: firebase.firestore.FieldValue.serverTimestamp(),
    recallCount: firebase.firestore.FieldValue.increment(1)
  }), "recall the tickets");
}

function removeTickets(ticketIds) {
  if (!mayTidyTickets(ticketIds)) return Promise.resolve(false);

  return reportQueueAction(batchUpdateTickets(ticketIds, {
    status: "void",
    voidedAt: firebase.firestore.FieldValue.serverTimestamp()
  }), "remove the tickets");
}

function recallTicket(ticketId) {
  if (!ticketId) return;
  if (!canTidyStation(stationOfTicket(ticketId))) return refuseStation();

  db.collection("tickets").doc(ticketId).update({
    recalledAt: firebase.firestore.FieldValue.serverTimestamp(),
    recallCount: firebase.firestore.FieldValue.increment(1)
  }).then(function () {
    sayDone("Recall notification sent.");
  }).catch(function (err) {
    say("Could not recall ticket: " + err.message);
  });
}

function timestampToMs(timestamp, fallbackMs) {
  return (timestamp && typeof timestamp.toMillis === "function") ? timestamp.toMillis() : fallbackMs;
}

function getSkipPhase(ticket) {
  var now = serverNow();

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
  if (!canServeStation(ticket.stationId)) return refuseStation();

  db.collection("tickets").doc(ticketId).update({
    lastCalled: true,
    lastCallAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () {
    sayDone("Last call sent.");
  }).catch(function (err) {
    say("Could not send the last call: " + err.message);
  });
}

// Tickets already sent off to be voided, so the once-a-second check doesn't send the same void again
// while the first one is still on its way.
var autoVoidRequested = {};
var AUTO_VOID_RETRY_MS = 15 * 1000;

function checkAutoVoid() {
  var now = serverNow();

  tickets.forEach(function (ticket) {
    if (!canServeStation(ticket.stationId)) return;
    if (ticket.status !== "skipped" || !ticket.lastCalled) return;
    if (!ticket.lastCallAt || typeof ticket.lastCallAt.toMillis !== "function") return;

    if (now - ticket.lastCallAt.toMillis() < AUTO_VOID_WINDOW_MS) return;

    var key = ticket.id + ":" + ticket.lastCallAt.toMillis();
    if (autoVoidRequested[key] && Date.now() - autoVoidRequested[key] < AUTO_VOID_RETRY_MS) return;
    autoVoidRequested[key] = Date.now();

    // Re-read the ticket first: staff may have called it again in the same moment, and a ticket that is
    // being served must never be voided by a stale copy.
    var ref = db.collection("tickets").doc(ticket.id);
    var lastCallMs = ticket.lastCallAt.toMillis();

    db.runTransaction(function (transaction) {
      return transaction.get(ref).then(function (doc) {
        var current = doc.exists ? doc.data() : null;
        var currentLastCall = current && current.lastCallAt && typeof current.lastCallAt.toMillis === "function" ? current.lastCallAt.toMillis() : 0;

        if (!current || current.status !== "skipped" || !current.lastCalled || currentLastCall !== lastCallMs) return false;
        if (serverNow() - currentLastCall < AUTO_VOID_WINDOW_MS) return false;

        transaction.update(ref, {
          status: "void",
          voidedAt: firebase.firestore.FieldValue.serverTimestamp(),
          autoVoided: true
        });
        return true;
      });
    }).catch(function (err) {
      // Usually the server voided it first; try again later in case it really failed.
      console.error("Auto-void of " + ticket.ticketNo + " did not go through: " + err.message);
    });
  });
}
