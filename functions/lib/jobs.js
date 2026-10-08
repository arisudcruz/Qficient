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

  if (stale.length) {
    const staleIds = new Set(stale.map(function (doc) { return doc.id; }));
    const stations = await db.collection("stations").get();
    const fixes = stations.docs.filter(function (doc) { return staleIds.has(doc.data().nowServingId); });
    await Promise.all(fixes.map(function (doc) { return doc.ref.update({ nowServingId: null }); }));
  }

  // Old de-duplication records are no longer needed after a few days.
  const cutoff = Timestamp.fromMillis(nowMs - 3 * DAY_MS);
  const oldEvents = await db.collection("pushEvents").where("at", "<", cutoff).get();
  for (let i = 0; i < oldEvents.docs.length; i += 400) {
    const batch = db.batch();
    oldEvents.docs.slice(i, i + 400).forEach(function (doc) { batch.delete(doc.ref); });
    await batch.commit();
  }

  return stale.length;
}

module.exports = { sweepExpired, cleanStale, dayKey };
