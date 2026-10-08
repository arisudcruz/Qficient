const { toMs } = require("./time");
const messages = require("./messages");

// Prioritized tickets first (earliest prioritized first), then everyone else by arrival. Mirrors js/queue.js.
function compareQueueOrder(a, b) {
  const aPriority = !!a.prioritizedAt;
  const bPriority = !!b.prioritizedAt;

  if (aPriority !== bPriority) return aPriority ? -1 : 1;
  if (aPriority) return toMs(a.prioritizedAt) - toMs(b.prioritizedAt);
  return toMs(a.createdAt) - toMs(b.createdAt);
}

// What happened to a student's ticket between two versions of it.
// Returns { type, message } for the one thing worth telling them, or null.
// `ctx` supplies stationName(id) and voidMinutes.
function describeChange(before, after, ctx, notify) {
  if (!before || !after) return null;

  const stationName = ctx.stationName(after.stationId);
  const lastCallBefore = toMs(before.lastCallAt);
  const lastCallAfter = toMs(after.lastCallAt);

  if (after.stationId !== before.stationId && after.status === "waiting") {
    return notify.transferred ? { type: "transferred", message: messages.transferred(after, stationName) } : null;
  }
  if (after.status === "serving" && before.status !== "serving") {
    return notify.serving ? { type: "serving", message: messages.serving(after, stationName) } : null;
  }
  if (after.status === "skipped" && before.status !== "skipped") {
    return notify.skipped ? { type: "skipped", message: messages.skipped(after, stationName, ctx.voidMinutes) } : null;
  }
  if (after.status === "void" && before.status !== "void") {
    if (!notify.voided) return null;
    return { type: "void", message: after.autoVoided ? messages.voidedAuto(after) : messages.voidedManual(after) };
  }
  if (after.lastCalled && after.status === "skipped" && (!before.lastCalled || lastCallAfter !== lastCallBefore)) {
    return notify.lastCall ? { type: "lastCall", message: messages.lastCall(after, stationName, ctx.voidMinutes) } : null;
  }
  if ((after.recallCount || 0) > (before.recallCount || 0)) {
    return notify.recall ? { type: "recall", message: messages.recall(after, stationName) } : null;
  }

  return null;
}

// True when only the listed fields differ (used to ignore this code's own bookkeeping writes).
function onlyChanged(before, after, fields) {
  const keys = new Set(Object.keys(before || {}).concat(Object.keys(after || {})));
  for (const key of keys) {
    if (fields.indexOf(key) !== -1) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
  }
  return true;
}

// Whether a write can change who is at the front of a station's queue.
function affectsQueueFront(before, after) {
  if (!before) return true;
  return before.status !== after.status ||
    before.stationId !== after.stationId ||
    toMs(before.prioritizedAt) !== toMs(after.prioritizedAt);
}

module.exports = { compareQueueOrder, describeChange, onlyChanged, affectsQueueFront };
