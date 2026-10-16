const messages = require("./messages");
const { compareQueueOrder } = require("./events");
const { startOfTodayMs } = require("./time");
const { smsText } = require("./sms");

function isDeadTokenError(err) {
  const code = err && err.code;
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
}

// Sends pushes and keeps them from going out twice. In the emulator nothing is really sent: each push is written
// to a `testPushLog` collection so tests can check it.
function createPusher({ db, FieldValue, Timestamp, messaging, config, log, forceReal, sms }) {
  const isEmulator = !forceReal && (process.env.FUNCTIONS_EMULATOR === "true" || !!process.env.FIRESTORE_EMULATOR_HOST);
  const writeLog = log || function () {};

  async function sendPush(token, message, tag) {
    if (isEmulator) {
      await db.collection("testPushLog").add({
        token: token,
        title: message.title,
        body: message.body,
        tag: tag,
        at: FieldValue.serverTimestamp()
      });
      return;
    }

    // Data-only message: the app's service worker shows it, which avoids duplicate notifications.
    await messaging.send({
      token: token,
      data: { title: message.title, body: message.body, tag: tag },
      webpush: { headers: { TTL: String(config.pushTtlSeconds), Urgency: "high" } }
    });
  }

  async function notifyUser(ownerId, message, tag) {
    if (!ownerId) return false;

    try {
      const doc = await db.collection("deviceTokens").doc(ownerId).get();
      const token = doc.exists ? doc.data().token : null;
      if (!token) return false;

      await sendPush(token, message, tag);
      writeLog("push sent: " + message.title + " (" + tag + ")");
      return true;
    } catch (err) {
      if (isDeadTokenError(err)) {
        writeLog("removing a dead push token for " + ownerId);
        await db.collection("deviceTokens").doc(ownerId).delete().catch(function () {});
      } else {
        writeLog("push failed for " + ownerId + ": " + (err && err.message ? err.message : err));
      }
      return false;
    }
  }

  // A walk-in ticket (made by the Queue Enforcer) is told by SMS, at the number kept in ticketContacts.
  async function notifyBySms(ticketId, message, tag) {
    if (!sms) return false;
    try {
      const contact = await db.collection("ticketContacts").doc(ticketId).get();
      const mobile = contact.exists ? contact.data().mobile : null;
      if (!mobile) return false;

      await sms.send(mobile, smsText(message), tag);
      return true;
    } catch (err) {
      writeLog("sms failed for ticket " + ticketId + ": " + (err && err.message ? err.message : err));
      return false;
    }
  }

  // Keeps a copy in the student's notification history (the Notifications tab on their dashboard), whether or not
  // their device can receive pushes. `type` is the kind of event: serving, soon, next, joined, completed...
  async function recordNotification(ticket, message, type) {
    if (!ticket || ticket.manual || !ticket.ownerId) return false;
    try {
      await db.collection("userNotifications").add({
        ownerId: ticket.ownerId,
        ticketId: ticket.id || null,
        ticketNo: ticket.ticketNo || null,
        stationId: ticket.stationId || null,
        type: type,
        title: message.title,
        body: message.body,
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
      return true;
    } catch (err) {
      writeLog("could not save notification history for " + ticket.ownerId + ": " + (err && err.message ? err.message : err));
      return false;
    }
  }

  // Tells a ticket's owner: push to their device, or SMS for a walk-in ticket.
  async function notifyTicket(ticket, message, tag) {
    if (ticket && ticket.manual) return notifyBySms(ticket.id, message, tag);
    await recordNotification(ticket, message, String(tag || "").split(":")[1] || "update");
    return notifyUser(ticket && ticket.ownerId, message, tag);
  }

  // Claims a de-duplication key; false when another delivery of the same event already did.
  async function claim(key, ownerId) {
    try {
      await db.collection("pushEvents").doc(key).create({ at: FieldValue.serverTimestamp(), ownerId: ownerId || null });
      return true;
    } catch (err) {
      if (err && (err.code === 6 || err.code === "already-exists")) return false;
      throw err;
    }
  }

  // History only, no push: for things the student did or saw themselves (joining, a finished transaction).
  async function recordOnce(key, ticket, message, type) {
    if (!(await claim(key, ticket && ticket.ownerId))) return false;
    return recordNotification(ticket, message, type);
  }

  // Cloud Functions may deliver the same event more than once; the first delivery claims the key.
  // `target` is the ticket (or, for older callers, just the owner's id).
  async function pushOnce(key, target, message, tag) {
    const ticket = target && typeof target === "object" ? target : null;
    const ownerId = ticket ? ticket.ownerId : target;

    if (!(await claim(key, ownerId))) return false;
    return ticket ? notifyTicket(ticket, message, tag) : notifyUser(ownerId, message, tag);
  }

  // Where a waiting ticket stands in its station's line (1 = next), or 0 if it isn't waiting.
  async function placeInLine(stationId, ticketId, nowMs) {
    const snap = await db.collection("tickets")
      .where("stationId", "==", stationId)
      .where("createdAt", ">=", Timestamp.fromMillis(startOfTodayMs(config.tzOffsetMs, nowMs)))
      .where("status", "==", "waiting")
      .get();
    const line = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); }).sort(compareQueueOrder);
    return line.findIndex(function (t) { return t.id === ticketId; }) + 1;
  }

  // While someone is being served: tells the 2nd and 3rd in line they're almost up, and the 1st that they're next.
  async function notifyNextInLine(stationId, stationName, nowMs) {
    const base = db.collection("tickets")
      .where("stationId", "==", stationId)
      .where("createdAt", ">=", Timestamp.fromMillis(startOfTodayMs(config.tzOffsetMs, nowMs)));

    const [serving, waiting] = await Promise.all([
      base.where("status", "==", "serving").limit(1).get(),
      base.where("status", "==", "waiting").get()
    ]);
    // Nobody is being served, so the queue isn't moving: no reminders yet.
    if (serving.empty || waiting.empty) return false;

    const line = waiting.docs
      .map(function (doc) { return Object.assign({ id: doc.id, ref: doc.ref }, doc.data()); })
      .sort(compareQueueOrder);

    // 2nd and 3rd in line get one "almost your turn" reminder per ticket number (a transfer gives a new number,
    // so they are reminded again in the new queue).
    for (let i = 1; i < Math.min(3, line.length); i++) {
      const ticket = line[i];
      if (ticket.soonNotified === ticket.ticketNo) continue;

      const claimedSoon = await db.runTransaction(async function (transaction) {
        const snap = await transaction.get(ticket.ref);
        const data = snap.data();
        if (!snap.exists || data.status !== "waiting" || data.soonNotified === data.ticketNo) return false;
        transaction.update(ticket.ref, { soonNotified: data.ticketNo });
        return true;
      });
      if (claimedSoon) await notifyTicket(ticket, messages.soon(ticket, stationName, i + 1), ticket.id + ":soon:" + ticket.ticketNo);
    }

    const first = line[0];

    const claimed = await db.runTransaction(async function (transaction) {
      const snap = await transaction.get(first.ref);
      const data = snap.data();
      if (!snap.exists || data.status !== "waiting" || data.nextNotified === stationId) return false;

      transaction.update(first.ref, { nextNotified: stationId });
      return true;
    });
    if (!claimed) return false;

    return notifyTicket(first, messages.next(first, stationName), first.id + ":next:" + stationId);
  }

  return { notifyUser, notifyTicket, pushOnce, recordOnce, recordNotification, notifyNextInLine, placeInLine };
}

module.exports = { createPusher };
