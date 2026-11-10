const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const config = require("./config");
const { describeChange, onlyChanged, affectsQueueFront } = require("./lib/events");
const { createPusher } = require("./lib/push");
const { sweepExpired, cleanStale } = require("./lib/jobs");
const { joinQueue, JoinError } = require("./lib/join");
const { redeemWalkinPass } = require("./lib/walkin");
const { resetStaffPassword } = require("./lib/staff");
const { createManualTicket } = require("./lib/manual");
const { getAuth } = require("firebase-admin/auth");
const { isNoShow, recordNoShow, isOwnerCancel, recordCancel } = require("./lib/strikes");
const messages = require("./lib/messages");
const audit = require("./lib/audit");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: config.region, maxInstances: config.maxInstances });

const pusher = createPusher({
  db, FieldValue, Timestamp, config,
  messaging: getMessaging(),
  log: function (message) { logger.info(message); }
});

// A station's name and how many windows it has (1 unless set in Settings > Edit Station).
async function stationInfoOf(stationId) {
  const doc = await db.collection("stations").doc(stationId).get();
  const data = doc.exists ? doc.data() : {};
  const windows = Math.floor(Number(data.windows));
  return { name: data.name || "the counter", windows: windows >= 1 && windows <= 10 ? windows : 1 };
}

async function stationNameOf(stationId) {
  return (await stationInfoOf(stationId)).name;
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
  if (before && onlyChanged(before, after, ["nextNotified", "soonNotified", "soonPlace"])) return;

  const ticket = Object.assign({ id: event.params.ticketId }, after);

  const enrolling = after.enrollment === true;

  // A manual (no-phone) ticket has nobody to push to or keep a history for, and no account to give strikes to;
  // only the people behind it in the line are told when they move up.
  if (after.noPhone === true) {
    if (config.notify.next && affectsQueueFront(before, after)) {
      const lineIds = [after.stationId];
      if (before && before.stationId !== after.stationId) lineIds.push(before.stationId);
      for (const stationId of lineIds) {
        await pusher.notifyNextInLine(stationId, await stationNameOf(stationId), Date.now());
      }
    }
    return;
  }

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
    const info = await stationInfoOf(after.stationId);
    const change = describeChange(before, after, {
      stationName: function (id) { return id === after.stationId ? info.name : "the counter"; },
      stationWindows: function (id) { return id === after.stationId ? info.windows : 1; },
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

  // The student cancelled: counted per queue day, and at the limit they can't join again until the day ends. The
  // block is pushed; a warning only goes in the history (they're looking at the screen, they just cancelled).
  if (isOwnerCancel(before, after)) {
    const rules = config.cancelBlock;
    const result = await recordCancel({ db, Timestamp, config }, ticket, Date.now());
    if (result.counted && result.blockedUntilMs) {
      await pusher.pushOnce(event.id + ":cancelBlocked", ticket,
        messages.cancelBlocked(result.blockedUntilMs, rules.limit), ticket.id + ":cancelBlocked");
    } else if (result.counted && result.count >= rules.warnFrom && result.count < rules.limit) {
      await pusher.recordOnce(event.id + ":cancelWarning", ticket,
        messages.cancelWarning(ticket, result.count, rules.limit), "cancelWarning");
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
// The Queue Enforcer (or an admin) makes a ticket for a walk-in without a phone (Walk-in Form > Manual Ticket).
exports.createManualTicket = onCall(async function (request) {
  try {
    const result = await createManualTicket({ db, FieldValue, config }, request.auth, request.data);
    const data = request.data || {};
    await logAudit(request.auth && request.auth.uid, "app_user", {
      category: "walkin", action: "manualTicket",
      summary: "Made a " + (result.priority ? "priority " : "") + "manual ticket " + result.ticketNo + " for " + result.ownerName +
        " (" + (result.enrollment ? "Enrollment, starting at " + result.stationName : result.stationName + ", " + (data.purpose || "")) + ")",
      targetId: result.ticketNo
    });
    return result;
  } catch (error) {
    if (error instanceof JoinError) throw new HttpsError(error.code, error.message);
    logger.error("createManualTicket failed: " + (error && error.stack ? error.stack : error));
    throw new HttpsError("internal", "Something went wrong while making the ticket. Please try again.");
  }
});

// An administrator sets a new password for a staff account (Settings > Edit Staff), without the old one.
exports.resetStaffPassword = onCall(async function (request) {
  try {
    const result = await resetStaffPassword({ db, adminAuth: getAuth() }, request.auth, request.data);
    await logAudit(request.auth && request.auth.uid, "app_user", {
      category: "staff", action: "passwordReset", summary: "Reset the password of " + result.username, targetId: result.username
    });
    return result;
  } catch (error) {
    if (error instanceof JoinError) throw new HttpsError(error.code, error.message);
    logger.error("resetStaffPassword failed: " + (error && error.stack ? error.stack : error));
    throw new HttpsError("internal", "Something went wrong while resetting the password. Please try again.");
  }
});

exports.redeemWalkinPass = onCall(async function (request) {
  try {
    return await redeemWalkinPass({ db, FieldValue, config }, request.auth, request.data);
  } catch (error) {
    if (error instanceof JoinError) throw new HttpsError(error.code, error.message);
    logger.error("redeemWalkinPass failed: " + (error && error.stack ? error.stack : error));
    throw new HttpsError("internal", "Something went wrong while getting your ticket. Please try again.");
  }
});

/* ---------- Audit trail (lib/audit.js) ---------- */
// What admins and staff do is recorded here, on the server, from the account that made each change (the auth
// context of the write), so it can't be skipped or faked from a browser. Changes the server makes itself, and
// students' or walk-ins' own actions, are not recorded. An audit problem never affects the queue.

const auditStationCache = { at: 0, byId: {} };

async function auditStationList() {
  if (Date.now() - auditStationCache.at > 60 * 1000) {
    const snap = await db.collection("stations").get();
    const byId = {};
    snap.docs.forEach(function (doc) {
      const d = doc.data();
      const windows = Math.floor(Number(d.windows));
      byId[doc.id] = { name: d.name || doc.id, windows: windows >= 1 && windows <= 10 ? windows : 1 };
    });
    auditStationCache.byId = byId;
    auditStationCache.at = Date.now();
  }
  return auditStationCache.byId;
}

async function logAudit(authId, authType, item) {
  if (!item) return;
  try {
    const actor = await audit.actorOf({ db, adminAuth: getAuth() }, authType, authId);
    if (!actor) return;
    const stationsById = await auditStationList();
    await audit.writeAudit({
      db, FieldValue,
      stationName: async function (id) { return (stationsById[id] || {}).name || id; }
    }, actor, item);
  } catch (error) {
    logger.error("audit entry failed: " + (error && error.stack ? error.stack : error));
  }
}

function auditTrigger(path, describe) {
  return onDocumentWrittenWithAuthContext({ document: path }, async function (event) {
    if (event.authType !== "app_user") return; // the server's own writes
    const before = event.data && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after.exists ? event.data.after.data() : null;
    try {
      const stationsById = await auditStationList();
      const station = function (id) { return stationsById[id] || { name: id || "a station", windows: 1 }; };
      const roleName = function (role) { return audit.roleLabel(role, station(role).name); };
      const item = describe(before, after, event.params, station, roleName);
      await logAudit(event.authId, event.authType, item);
    } catch (error) {
      logger.error("audit of " + path + " failed: " + (error && error.stack ? error.stack : error));
    }
  });
}

exports.auditTickets = auditTrigger("tickets/{ticketId}", function (before, after, params, station) {
  return audit.describeTicketAction(before, after, station);
});

exports.auditStations = auditTrigger("stations/{stationId}", function (before, after, params) {
  return audit.describeStationChange(before, after, params.stationId);
});

exports.auditStaff = auditTrigger("staff/{staffEmail}", function (before, after, params, station, roleName) {
  return audit.describeStaffChange(before, after, params.staffEmail, roleName);
});

exports.auditSettings = auditTrigger("settings/{docId}", function (before, after, params, station, roleName) {
  return audit.describeSettingsChange(params.docId, before, after, roleName, function (id) { return station(id).name; });
});

exports.auditWalkinPasses = auditTrigger("walkinPasses/{passId}", function (before, after, params, station) {
  return audit.describeWalkinPass(before, after, station);
});

exports.auditJoinState = auditTrigger("joinState/{uid}", function (before, after) {
  return audit.describeJoinStateChange(before, after);
});

exports.auditLimitRequests = auditTrigger("limitRequests/{requestId}", function (before, after, params, station) {
  return audit.describeLimitRequest(before, after, station);
});
