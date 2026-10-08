const DAY_MS = 24 * 60 * 60 * 1000;

function startOfTodayMs(tzOffsetMs, now) {
  const t = now === undefined ? Date.now() : now;
  return Math.floor((t + tzOffsetMs) / DAY_MS) * DAY_MS - tzOffsetMs;
}

function dayKey(tzOffsetMs, now) {
  const t = now === undefined ? Date.now() : now;
  return new Date(t + tzOffsetMs).toISOString().slice(0, 10);
}

function toMs(timestamp) {
  return timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;
}

module.exports = { DAY_MS, startOfTodayMs, dayKey, toMs };
