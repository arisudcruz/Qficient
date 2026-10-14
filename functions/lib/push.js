const messages = require("./messages");
const { compareQueueOrder } = require("./events");
const { startOfTodayMs } = require("./time");

function isDeadTokenError(err) {
  const code = err && err.code;
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
}

// Sends pushes and keeps them from going out twice. In the emulator nothing is really sent: each push is written
// to a `testPushLog` collection so tests can check it.
function createPusher({ db, FieldValue, Timestamp, messaging, config, log, forceReal }) {
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

  // Cloud Functions may deliver the same event more than once; the first delivery claims the key.
  async function pushOnce(key, ownerId, message, tag) {
    try {
      await db.collection("pushEvents").doc(key).create({ at: FieldValue.serverTimestamp(), ownerId: ownerId || null });
    } catch (err) {
      if (err && (err.code === 6 || err.code === "already-exists")) return false;
      throw err;
    }
    return notifyUser(ownerId, message, tag);
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
      if (claimedSoon) await notifyUser(ticket.ownerId, messages.soon(ticket, stationName, i + 1), ticket.id + ":soon:" + ticket.ticketNo);
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

    return notifyUser(first.ownerId, messages.next(first, stationName), first.id + ":next:" + stationId);
  }

  return { notifyUser, pushOnce, notifyNextInLine };
}

module.exports = { createPusher };
