const { toMs, startOfTodayMs, dayKey, DAY_MS } = require("./time");
const { windowHoursState } = require("./hours");

// Window hours (lib/hours.js): once the windows have closed, today's tickets still in line (waiting, or On Hold)
// are voided with closedVoid: true, which is not a strike (strikes.js) and gets its own push (events.js). Tickets
// being served are left for the staff to finish. Runs every minute while closed, so it also catches a ticket
// transferred after closing; with nobody in line it changes nothing. Returns how many tickets it voided.
async function voidAtClose({ db, FieldValue, config, now }) {
  const nowMs = now ? now() : Date.now();
  const state = await windowHoursState({ db, config, now: function () { return nowMs; } });
  if (!state.enabled || state.open) return 0;

  const todayStart = startOfTodayMs(config.tzOffsetMs, nowMs);
  const inLine = await db.collection("tickets").where("status", "in", ["waiting", "skipped"]).get();
  const due = inLine.docs.filter(function (doc) { return toMs(doc.data().createdAt) >= todayStart; });

  let voided = 0;
  for (let i = 0; i < due.length; i += 400) {
    const refs = due.slice(i, i + 400).map(function (doc) { return doc.ref; });
    // Re-checked in one transaction, so a ticket the staff call at that moment is not voided, and the whole line
    // goes at once (no "you're next" push to someone voided a moment later).
    voided += await db.runTransaction(async function (transaction) {
      const snaps = await transaction.getAll(...refs);
      let count = 0;
      snaps.forEach(function (snap) {
        if (!snap.exists) return;
        const status = snap.data().status;
        if (status !== "waiting" && status !== "skipped") return;
        transaction.update(snap.ref, {
          status: "void",
          voidedAt: FieldValue.serverTimestamp(),
          autoVoided: true,
          closedVoid: true
        });
        count++;
      });
      return count;
    });
  }
  return voided;
}

// Voids skipped tickets whose last call has run out. Safe to run any time: each ticket is re-checked inside a
// transaction, so a staff action that lands first always wins.
async function sweepExpired({ db, FieldValue, config, now }) {
  const nowMs = now ? now() : Date.now();

  const settings = await db.collection("settings").doc("system").get();
  const minutes = settings.exists ? Number(settings.data().autoVoidMinutes) : 1;
  const windowMs = (minutes > 0 ? minutes : 1) * 60 * 1000;

  const skipped = await db.collection("tickets").where("status", "==", "skipped").get();
  const due = skipped.docs.filter(function (doc) {
    const data = doc.data();
    const lastCallMs = toMs(data.lastCallAt);
    return data.lastCalled && lastCallMs && nowMs - lastCallMs >= windowMs;
  });

  let voided = 0;
  for (const doc of due) {
    const done = await db.runTransaction(async function (transaction) {
      const snap = await transaction.get(doc.ref);
      if (!snap.exists) return false;

      const data = snap.data();
      const lastCallMs = toMs(data.lastCallAt);
      if (data.status !== "skipped" || !data.lastCalled || !lastCallMs || nowMs - lastCallMs < windowMs) return false;

      transaction.update(doc.ref, {
        status: "void",
        voidedAt: FieldValue.serverTimestamp(),
        autoVoided: true
      });
      return true;
    });
    if (done) voided++;
  }

  return voided;
}

// Voids tickets left over from earlier days and frees any station still pointing at them.
async function cleanStale({ db, FieldValue, Timestamp, config, now }) {
  const nowMs = now ? now() : Date.now();
  const todayStart = startOfTodayMs(config.tzOffsetMs, nowMs);
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

  // "Now serving" pointers at a voided ticket are cleared. The old separate enrollment line's pointer
  // (enrollmentServingId) is removed: enrollment tickets now share each station's one line.
  // Limits approved for one date (dayLimits) are dropped once that date has passed.
  const staleIds = new Set(stale.map(function (doc) { return doc.id; }));
  const today = dayKey(config.tzOffsetMs, nowMs);
  const stations = await db.collection("stations").get();
  await Promise.all(stations.docs.map(function (doc) {
    const fix = {};
    if (staleIds.has(doc.data().nowServingId)) fix.nowServingId = null;
    if ("enrollmentServingId" in doc.data()) fix.enrollmentServingId = FieldValue.delete();
    const dayLimits = doc.data().dayLimits;
    if (dayLimits && typeof dayLimits === "object") {
      Object.keys(dayLimits).filter(function (day) { return day < today; }).forEach(function (day) {
        fix["dayLimits." + day] = FieldValue.delete();
      });
    }
    return Object.keys(fix).length ? doc.ref.update(fix) : null;
  }));

  // Daily limit requests are kept for 30 days after their date.
  const oldRequests = await db.collection("limitRequests").where("day", "<", dayKey(config.tzOffsetMs, nowMs - 30 * DAY_MS)).get();
  for (let i = 0; i < oldRequests.docs.length; i += 400) {
    const batch = db.batch();
    oldRequests.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  // Device registrations that haven't been refreshed in a month belong to guests who never came back
  // or browsers that were uninstalled. (An active student's page re-saves theirs on every visit.)
  const staleTokens = await db.collection("deviceTokens")
    .where("updatedAt", "<", Timestamp.fromMillis(nowMs - 30 * DAY_MS))
    .get();
  for (let i = 0; i < staleTokens.docs.length; i += 400) {
    const batch = db.batch();
    staleTokens.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  // Old de-duplication records are no longer needed after a few days.
  const cutoff = Timestamp.fromMillis(nowMs - 3 * DAY_MS);
  const oldEvents = await db.collection("pushEvents").where("at", "<", cutoff).get();
  for (let i = 0; i < oldEvents.docs.length; i += 400) {
    const batch = db.batch();
    oldEvents.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  // Students' notification history is kept for a week, like the admin inbox.
  const historyCutoff = Timestamp.fromMillis(nowMs - (config.notificationHistoryDays || 7) * DAY_MS);
  const oldHistory = await db.collection("userNotifications").where("createdAt", "<", historyCutoff).get();
  for (let i = 0; i < oldHistory.docs.length; i += 400) {
    const batch = db.batch();
    oldHistory.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  // The audit trail is kept for config.auditRetentionDays (90 days).
  const auditCutoff = Timestamp.fromMillis(nowMs - (config.auditRetentionDays || 90) * DAY_MS);
  const oldAudit = await db.collection("auditLogs").where("at", "<", auditCutoff).get();
  for (let i = 0; i < oldAudit.docs.length; i += 400) {
    const batch = db.batch();
    oldAudit.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  // Walk-in QR passes only matter on the day they were made. The old SMS walk-in records (mobile numbers in
  // ticketContacts, the smsLog test log) are no longer used and are personal data, so they go too.
  const oldPasses = await db.collection("walkinPasses").where("createdAt", "<", Timestamp.fromMillis(todayStart)).get();
  const leftovers = oldPasses.docs
    .concat((await db.collection("ticketContacts").get()).docs)
    .concat((await db.collection("smsLog").get()).docs);
  for (let i = 0; i < leftovers.length; i += 400) {
    const batch = db.batch();
    leftovers.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  return stale.length;
}

module.exports = { sweepExpired, voidAtClose, cleanStale, dayKey };
