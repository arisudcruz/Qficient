const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const config = require("./config");
const { describeChange, onlyChanged, affectsQueueFront } = require("./lib/events");
const { createPusher } = require("./lib/push");
const { sweepExpired, cleanStale } = require("./lib/jobs");
const { joinQueue, JoinError } = require("./lib/join");
const { createSmsSender, SMS_SECRETS } = require("./lib/sms");
const messages = require("./lib/messages");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: config.region, maxInstances: config.maxInstances });

// SMS secrets are only needed (and only asked for at deploy time) once a real provider is switched on.
const smsSecrets = (SMS_SECRETS[config.sms && config.sms.provider] || []).map(function (name) { return defineSecret(name); });

const sms = createSmsSender({
  db, FieldValue, config,
  secret: function (name) {
    const param = smsSecrets.find(function (s) { return s.name === name; });
    return param ? param.value() : "";
  },
  log: function (message) { logger.info(message); }
});

const pusher = createPusher({
  db, FieldValue, Timestamp, config, sms,
  messaging: getMessaging(),
  log: function (message) { logger.info(message); }
});

async function stationNameOf(stationId) {
  const doc = await db.collection("stations").doc(stationId).get();
  return doc.exists && doc.data().name ? doc.data().name : "the counter";
}

async function voidMinutes() {
  const doc = await db.collection("settings").doc("system").get();
  const minutes = doc.exists ? Number(doc.data().autoVoidMinutes) : 1;
  return minutes > 0 ? minutes : 1;
}

// Runs whenever a ticket is created or changed: tells the student what happened and, when the front of a
// queue may have changed, tells the next student in line.
exports.onTicketWritten = onDocumentWritten(Object.assign({ document: "tickets/{ticketId}" }, smsSecrets.length ? { secrets: smsSecrets } : {}), async function (event) {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;

  // Our own bookkeeping write (marking "next in line" as sent) must not trigger anything.
  if (before && onlyChanged(before, after, ["nextNotified", "soonNotified"])) return;

  const ticket = Object.assign({ id: event.params.ticketId }, after);

  // A walk-in ticket made by the Queue Enforcer: text them their ticket number.
  if (!before && after.manual && after.status === "waiting" && config.notify.manualCreated) {
    const place = await pusher.placeInLine(after.stationId, ticket.id, Date.now());
    const message = messages.manualCreated(ticket, await stationNameOf(after.stationId), place);
    await pusher.pushOnce(event.id + ":created", ticket, message, ticket.id + ":created");
  }

  if (before) {
    const names = {};
    names[after.stationId] = await stationNameOf(after.stationId);
    const change = describeChange(before, after, {
      stationName: function (id) { return names[id] || "the counter"; },
      voidMinutes: await voidMinutes()
    }, config.notify);

    if (change) {
      await pusher.pushOnce(event.id + ":" + change.type, ticket, change.message, ticket.id + ":" + change.type);
    }
  }

  if (config.notify.next && affectsQueueFront(before, after)) {
    const stationIds = [after.stationId];
    if (before && before.stationId !== after.stationId) stationIds.push(before.stationId);

    for (const stationId of stationIds) {
      await pusher.notifyNextInLine(stationId, await stationNameOf(stationId), Date.now());
    }
  }
});

// Every minute: void tickets whose last call has run out, and report that the scheduler is alive.
exports.sweepExpiredTickets = onSchedule({ schedule: "every 1 minutes", timeZone: "Asia/Manila" }, async function () {
  const voided = await sweepExpired({ db, FieldValue, config });
  if (voided) logger.info("auto-voided " + voided + " ticket(s)");

  await db.collection("serverStatus").doc("notifier").set({
    lastSeen: FieldValue.serverTimestamp(),
    pushEnabled: true,
    version: 2
  });
});

// Just after midnight Philippine time: void leftovers from earlier days.
exports.dailyCleanup = onSchedule({ schedule: "5 0 * * *", timeZone: "Asia/Manila" }, async function () {
  const cleaned = await cleanStale({ db, FieldValue, Timestamp, config });
  logger.info("daily cleanup voided " + cleaned + " leftover ticket(s)");
});

// Students and guests join the queue through this function instead of writing tickets themselves, so the
// one-ticket-per-person and rate limits can't be skipped from the browser.
exports.joinQueue = onCall(async function (request) {
  try {
    return await joinQueue({ db, FieldValue, config }, request.auth, request.data);
  } catch (error) {
    if (error instanceof JoinError) throw new HttpsError(error.code, error.message);
    logger.error("joinQueue failed: " + (error && error.stack ? error.stack : error));
    throw new HttpsError("internal", "Something went wrong while joining the queue. Please try again.");
  }
});
