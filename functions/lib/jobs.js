const { toMs, startOfTodayMs, dayKey, DAY_MS } = require("./time");

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
  const staleIds = new Set(stale.map(function (doc) { return doc.id; }));
  const stations = await db.collection("stations").get();
  await Promise.all(stations.docs.map(function (doc) {
    const fix = {};
    if (staleIds.has(doc.data().nowServingId)) fix.nowServingId = null;
    if ("enrollmentServingId" in doc.data()) fix.enrollmentServingId = FieldValue.delete();
    return Object.keys(fix).length ? doc.ref.update(fix) : null;
  }));

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

module.exports = { sweepExpired, cleanStale, dayKey };
