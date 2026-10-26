const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const config = require("./config");
const { describeChange, onlyChanged, affectsQueueFront } = require("./lib/events");
const { createPusher } = require("./lib/push");
const { sweepExpired, cleanStale } = require("./lib/jobs");
const { joinQueue, JoinError } = require("./lib/join");
const { redeemWalkinPass } = require("./lib/walkin");
const { isNoShow, recordNoShow } = require("./lib/strikes");
const messages = require("./lib/messages");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: config.region, maxInstances: config.maxInstances });

const pusher = createPusher({
  db, FieldValue, Timestamp, config,
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
// secrets: [] explicitly detaches the old SMS_API_KEY from the deployed function (a plain redeploy kept it attached).
exports.onTicketWritten = onDocumentWritten({ document: "tickets/{ticketId}", secrets: [] }, async function (event) {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;

  // Our own bookkeeping write (marking "next in line" as sent) must not trigger anything.
  if (before && onlyChanged(before, after, ["nextNotified", "soonNotified"])) return;

  const ticket = Object.assign({ id: event.params.ticketId }, after);

  const enrolling = after.enrollment === true;

  // The student's (or walk-in's) own history: they joined, or their transaction (or whole enrollment) is done.
  // (No push; they saw it happen.)
  if (!before && after.status === "waiting") {
    const place = await pusher.placeInLine(after.stationId, ticket.id, Date.now());
    const station = await stationNameOf(after.stationId);
    await pusher.recordOnce(event.id + ":joined", ticket,
      enrolling ? messages.enrollmentJoined(ticket, station, place) : messages.joined(ticket, station, place), "joined");
  }
  if (before && after.status === "completed" && before.status !== "completed") {
    if (enrolling && config.notify.enrollmentNext) {
      await pusher.pushOnce(event.id + ":enrollmentCompleted", ticket, messages.enrollmentCompleted(ticket), ticket.id + ":enrollmentCompleted");
    } else {
      await pusher.recordOnce(event.id + ":completed", ticket, messages.completed(ticket, await stationNameOf(after.stationId)), "completed");
    }
  }

  if (before) {
    const names = {};
    names[after.stationId] = await stationNameOf(after.stationId);
    const change = describeChange(before, after, {
      stationName: function (id) { return names[id] || "the counter"; },
      voidMinutes: await voidMinutes()
    }, config.notify);

    if (change) {
      // Each enrollment step is its own alert (the same tag would replace the previous one on the phone).
      const tag = ticket.id + ":" + change.type + (change.type === "enrollmentNext" ? ":" + after.enrollmentStep : "");
      await pusher.pushOnce(event.id + ":" + change.type, ticket, change.message, tag);
    }
  }

  // A no-show (the Last Call ran out): a strike, and at the limit a block from joining. The void itself was
  // already pushed above, so a strike is only noted in the history; a block is pushed too.
  if (isNoShow(before, after)) {
    const rules = config.noShow;
    const result = await recordNoShow({ db, Timestamp, config }, ticket, Date.now());
    if (result.counted && result.blockedUntilMs) {
      await pusher.pushOnce(event.id + ":noShowBlocked", ticket,
        messages.noShowBlocked(result.blockedUntilMs, rules.limit, rules.windowDays), ticket.id + ":noShowBlocked");
    } else if (result.counted) {
      await pusher.recordOnce(event.id + ":noShowStrike", ticket,
        messages.noShowStrike(ticket, result.strikes, rules.limit, rules.windowDays, rules.blockHours), "noShowStrike");
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

// Students join the queue through this function instead of writing tickets themselves, so the
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

// A walk-in's phone opens the Queue Enforcer's QR code: this checks the one-time pass and creates their ticket.
exports.redeemWalkinPass = onCall(async function (request) {
  try {
    return await redeemWalkinPass({ db, FieldValue, config }, request.auth, request.data);
  } catch (error) {
    if (error instanceof JoinError) throw new HttpsError(error.code, error.message);
    logger.error("redeemWalkinPass failed: " + (error && error.stack ? error.stack : error));
    throw new HttpsError("internal", "Something went wrong while getting your ticket. Please try again.");
  }
});
