const { toMs, startOfTodayMs, dayKey, DAY_MS } = require("./time");
const messages = require("./messages");

// Prioritized tickets first (earliest prioritized first), then everyone else by arrival. Mirrors js/queue.js.
function compareQueueOrder(a, b) {
  const aPriority = !!a.prioritizedAt;
  const bPriority = !!b.prioritizedAt;

  if (aPriority !== bPriority) return aPriority ? -1 : 1;
  if (aPriority) return toMs(a.prioritizedAt) - toMs(b.prioritizedAt);
  return toMs(a.createdAt) - toMs(b.createdAt);
}

function isDeadTokenError(err) {
  const code = err && err.code;
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
}

// The service watches today's tickets, sends pushes when something changes for a student, voids
// tickets whose last call ran out, and cleans up leftovers from earlier days.
//
// `sendPush(token, { title, body, data })` is injected so tests can run without Firebase Messaging.
function createService(deps) {
  const { db, FieldValue, Timestamp, sendPush, config } = deps;
  const log = deps.log || function () {};
  const now = deps.now || Date.now;

  const stationNames = new Map();
  const tickets = new Map(); // today's tickets by id
  const known = new Map(); // last seen state of each ticket, to detect what changed
  const notifiedNext = new Set();
  const voiding = new Set();
  const timers = [];
  const unsubscribers = [];

  let voidMinutes = 1;
  let seeded = false;
  let currentDay = null;
  let ticketsUnsubscribe = null;
  let stopped = false;

  function stationName(stationId) {
    return stationNames.get(stationId) || "the counter";
  }

  function remember(ticket) {
    return {
      status: ticket.status,
      stationId: ticket.stationId,
      ticketNo: ticket.ticketNo,
      recallCount: ticket.recallCount || 0,
      lastCalled: !!ticket.lastCalled,
      lastCallMs: toMs(ticket.lastCallAt)
    };
  }

  async function notifyUser(ownerId, message, tag) {
    if (!ownerId) return false;

    try {
      const doc = await db.collection("deviceTokens").doc(ownerId).get();
      const token = doc.exists ? doc.data().token : null;
      if (!token) return false;

      await sendPush(token, {
        title: message.title,
        body: message.body,
        data: { title: message.title, body: message.body, tag: tag }
      });
      log("push sent: " + message.title + " (" + tag + ")");
      return true;
    } catch (err) {
      if (isDeadTokenError(err)) {
        log("removing a dead push token for " + ownerId);
        await db.collection("deviceTokens").doc(ownerId).delete().catch(function () {});
      } else {
        log("push failed for " + ownerId + ": " + (err && err.message ? err.message : err));
      }
      return false;
    }
  }

  // What happened to one ticket between two snapshots, as a list of { type, message }.
  function describeChange(before, after, ticket) {
    const events = [];
    const on = config.notify;

    if (after.stationId !== before.stationId && after.status === "waiting") {
      if (on.transferred) events.push({ type: "transferred", message: messages.transferred(ticket, stationName(ticket.stationId)) });
    } else if (after.status === "serving" && before.status !== "serving") {
      if (on.serving) events.push({ type: "serving", message: messages.serving(ticket, stationName(ticket.stationId)) });
    } else if (after.status === "skipped" && before.status !== "skipped") {
      if (on.skipped) events.push({ type: "skipped", message: messages.skipped(ticket, stationName(ticket.stationId), voidMinutes) });
    } else if (after.status === "void" && before.status !== "void") {
      if (on.voided) events.push({ type: "void", message: ticket.autoVoided ? messages.voidedAuto(ticket) : messages.voidedManual(ticket) });
    } else if (after.lastCalled && after.status === "skipped" && (!before.lastCalled || after.lastCallMs !== before.lastCallMs)) {
      if (on.lastCall) events.push({ type: "lastCall", message: messages.lastCall(ticket, stationName(ticket.stationId), voidMinutes) });
    } else if (after.recallCount > before.recallCount) {
      if (on.recall) events.push({ type: "recall", message: messages.recall(ticket, stationName(ticket.stationId)) });
    }

    return events;
  }

  // The first waiting ticket of a station that has someone being served right now.
  function nextInLine(stationId) {
    const list = Array.from(tickets.values()).filter(function (t) { return t.stationId === stationId; });
    if (!list.some(function (t) { return t.status === "serving"; })) return null;

    return list.filter(function (t) { return t.status === "waiting"; }).sort(compareQueueOrder)[0] || null;
  }

  async function handleTickets(snapshot) {
    const firstSnapshot = !seeded;
    seeded = true;

    const affectedStations = new Set();
    const pending = [];

    snapshot.docChanges().forEach(function (change) {
      const ticket = Object.assign({ id: change.doc.id }, change.doc.data());
      affectedStations.add(ticket.stationId);

      if (change.type === "removed") {
        tickets.delete(ticket.id);
        known.delete(ticket.id);
        return;
      }

      const before = known.get(ticket.id);
      const after = remember(ticket);
      tickets.set(ticket.id, ticket);
      known.set(ticket.id, after);

      if (before && before.stationId !== after.stationId) {
        notifiedNext.delete(ticket.id);
        affectedStations.add(before.stationId);
      }

      // The first snapshot after (re)starting only records the current state; a brand-new ticket has nothing to report yet.
      if (firstSnapshot || !before) return;

      describeChange(before, after, ticket).forEach(function (event) {
        pending.push(notifyUser(ticket.ownerId, event.message, ticket.id + ":" + event.type));
      });
    });

    affectedStations.forEach(function (stationId) {
      const candidate = nextInLine(stationId);
      if (!candidate || notifiedNext.has(candidate.id)) return;

      notifiedNext.add(candidate.id);
      if (!firstSnapshot && config.notify.next) {
        pending.push(notifyUser(candidate.ownerId, messages.next(candidate, stationName(candidate.stationId)), candidate.id + ":next:" + candidate.stationId));
      }
    });

    await Promise.all(pending);
  }

  async function voidIfStillExpired(ticketId, windowMs) {
    return db.runTransaction(async function (transaction) {
      const ref = db.collection("tickets").doc(ticketId);
      const snap = await transaction.get(ref);
      if (!snap.exists) return false;

      const data = snap.data();
      const lastCallMs = toMs(data.lastCallAt);
      if (data.status !== "skipped" || !data.lastCalled || !lastCallMs || now() - lastCallMs < windowMs) return false;

      transaction.update(ref, {
        status: "void",
        voidedAt: FieldValue.serverTimestamp(),
        autoVoided: true
      });
      return true;
    });
  }

  // Voids skipped tickets whose last call has run out. Uses the in-memory list, so it costs no reads.
  async function sweepExpired() {
    const windowMs = voidMinutes * 60 * 1000;
    const nowMs = now();

    const due = Array.from(tickets.values()).filter(function (t) {
      const lastCallMs = toMs(t.lastCallAt);
      return t.status === "skipped" && t.lastCalled && lastCallMs && nowMs - lastCallMs >= windowMs && !voiding.has(t.id);
    });

    for (const ticket of due) {
      voiding.add(ticket.id);
      try {
        if (await voidIfStillExpired(ticket.id, windowMs)) log("auto-voided " + ticket.ticketNo);
      } catch (err) {
        log("could not void " + ticket.ticketNo + ": " + err.message);
      } finally {
        voiding.delete(ticket.id);
      }
    }
  }

  // Voids tickets left over from earlier days and frees any station still pointing at them.
  async function cleanStale() {
    const todayStart = startOfTodayMs(config.tzOffsetMs, now());
    const from = todayStart - config.staleLookbackDays * DAY_MS;

    const snapshot = await db.collection("tickets")
      .where("createdAt", ">=", Timestamp.fromMillis(from))
      .where("createdAt", "<", Timestamp.fromMillis(todayStart))
      .get();

    const active = ["waiting", "serving", "skipped"];
    const stale = snapshot.docs.filter(function (doc) { return active.indexOf(doc.data().status) !== -1; });

    for (let i = 0; i < stale.length; i += 400) {
      const batch = db.batch();
      stale.slice(i, i + 400).forEach(function (doc) {
        batch.update(doc.ref, {
          status: "void",
          voidedAt: FieldValue.serverTimestamp(),
          autoVoided: true,
          staleCleanup: true
        });
      });
      await batch.commit();
    }

    if (stale.length) {
      const staleIds = new Set(stale.map(function (doc) { return doc.id; }));
      const stationsSnapshot = await db.collection("stations").get();
      const fixes = stationsSnapshot.docs.filter(function (doc) { return staleIds.has(doc.data().nowServingId); });
      await Promise.all(fixes.map(function (doc) { return doc.ref.update({ nowServingId: null }); }));
      log("cleaned up " + stale.length + " leftover ticket(s) from earlier days");
    }

    return stale.length;
  }

  function subscribeTickets() {
    currentDay = dayKey(config.tzOffsetMs, now());
    tickets.clear();
    known.clear();
    notifiedNext.clear();
    seeded = false;

    const start = startOfTodayMs(config.tzOffsetMs, now());
    ticketsUnsubscribe = db.collection("tickets")
      .where("createdAt", ">=", Timestamp.fromMillis(start))
      .onSnapshot(function (snapshot) {
        handleTickets(snapshot).catch(function (err) { log("error handling tickets: " + err.message); });
      }, function (err) {
        log("tickets listener error: " + err.message + " (retrying in 10s)");
        if (ticketsUnsubscribe) ticketsUnsubscribe();
        ticketsUnsubscribe = null;
        if (!stopped) timers.push(setTimeout(subscribeTickets, 10 * 1000));
      });
  }

  async function checkNewDay() {
    if (dayKey(config.tzOffsetMs, now()) === currentDay) return;

    log("new queue day started");
    if (ticketsUnsubscribe) ticketsUnsubscribe();
    ticketsUnsubscribe = null;

    try {
      await cleanStale();
    } catch (err) {
      log("cleanup failed: " + err.message);
    }
    if (!stopped) subscribeTickets();
  }

  function heartbeat() {
    return db.collection("serverStatus").doc("notifier").set({
      lastSeen: FieldValue.serverTimestamp(),
      pushEnabled: true,
      version: 1
    }).catch(function (err) {
      log("heartbeat failed: " + err.message);
    });
  }

  async function start() {
    stopped = false;

    unsubscribers.push(db.collection("stations").onSnapshot(function (snapshot) {
      snapshot.docs.forEach(function (doc) { stationNames.set(doc.id, doc.data().name); });
    }, function (err) { log("stations listener error: " + err.message); }));

    unsubscribers.push(db.collection("settings").doc("system").onSnapshot(function (doc) {
      const minutes = doc.exists ? Number(doc.data().autoVoidMinutes) : 1;
      voidMinutes = minutes > 0 ? minutes : 1;
    }, function (err) { log("settings listener error: " + err.message); }));

    try {
      await cleanStale();
    } catch (err) {
      log("cleanup failed: " + err.message);
    }

    subscribeTickets();
    await heartbeat();

    timers.push(setInterval(function () { sweepExpired().catch(function (err) { log("sweep failed: " + err.message); }); }, config.voidCheckMs));
    timers.push(setInterval(function () { checkNewDay().catch(function (err) { log("day check failed: " + err.message); }); }, config.dayCheckMs));
    timers.push(setInterval(heartbeat, config.heartbeatMs));

    log("notifier running for queue day " + currentDay);
  }

  function stop() {
    stopped = true;
    timers.forEach(function (timer) { clearInterval(timer); clearTimeout(timer); });
    timers.length = 0;
    unsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
    unsubscribers.length = 0;
    if (ticketsUnsubscribe) ticketsUnsubscribe();
    ticketsUnsubscribe = null;
  }

  return { start: start, stop: stop, sweepExpired: sweepExpired, cleanStale: cleanStale, compareQueueOrder: compareQueueOrder };
}

module.exports = { createService, compareQueueOrder };
