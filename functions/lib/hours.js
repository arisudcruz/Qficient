// Window hours (settings/windowHours): one weekly schedule, set in System Settings, for when the windows take
// tickets. Outside it no new tickets can be made, new tickets stop `lastJoinMinutes` before closing, and tickets
// still in line at closing are voided (jobs.js voidAtClose) without a strike.
//
//   { enabled, days: { sun..sat: { open, start, end } }, lastJoinMinutes, updatedAt }
//
// start and end are minutes after midnight, Philippine time (0 <= start < end <= 1440). A missing doc, or
// enabled: false, means no limits. js/window-hours.js has the same logic for the pages; keep the two in step.
const { DAY_MS, startOfTodayMs } = require("./time");

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MINUTE_MS = 60 * 1000;

function isWholeMinute(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

// One day's hours when that day is open (and its times make sense), else null.
function openDayOf(cfg, dayIndex) {
  const day = cfg && cfg.days ? cfg.days[DAY_KEYS[dayIndex]] : null;
  if (!day || day.open !== true) return null;
  if (!isWholeMinute(day.start, 0, 1439) || !isWholeMinute(day.end, 1, 1440) || day.start >= day.end) return null;
  return day;
}

function lastJoinMinutesOf(cfg) {
  return cfg && isWholeMinute(cfg.lastJoinMinutes, 0, 240) ? cfg.lastJoinMinutes : 0;
}

// Where the schedule stands at nowMs:
//   enabled    the hours are switched on (when off, everything below is open)
//   open       the windows are open right now
//   joinOpen   new tickets can be made right now
//   reason     "", "closedDay", "beforeOpen", "afterClose" or "lastJoin"
//   dayIndex   today, 0 = Sunday;  today: today's hours, or null when closed
//   closesAtMs, joinStopsAtMs   today's closing time and the last moment for a new ticket (0 when closed today)
//   nextOpenMs, nextOpenDays, nextOpenMinute   the next opening that is still ahead (days 0 = later today);
//                                              nextOpenDays is -1 when no day is open at all
function hoursState(cfg, tzOffsetMs, nowMs) {
  if (!cfg || cfg.enabled !== true) return { enabled: false, open: true, joinOpen: true, reason: "" };

  const dayIndex = new Date(nowMs + tzOffsetMs).getUTCDay();
  const dayStart = startOfTodayMs(tzOffsetMs, nowMs);
  const intoDay = nowMs - dayStart;
  const today = openDayOf(cfg, dayIndex);
  const state = {
    enabled: true, open: false, joinOpen: false, reason: "closedDay", dayIndex: dayIndex, today: today,
    closesAtMs: 0, joinStopsAtMs: 0, nextOpenMs: 0, nextOpenDays: -1, nextOpenMinute: 0
  };

  if (today) {
    const joinEnd = Math.max(today.start, today.end - lastJoinMinutesOf(cfg));
    state.closesAtMs = dayStart + today.end * MINUTE_MS;
    state.joinStopsAtMs = dayStart + joinEnd * MINUTE_MS;
    if (intoDay < today.start * MINUTE_MS) {
      state.reason = "beforeOpen";
    } else if (intoDay < today.end * MINUTE_MS) {
      state.open = true;
      state.joinOpen = intoDay < joinEnd * MINUTE_MS;
      state.reason = state.joinOpen ? "" : "lastJoin";
    } else {
      state.reason = "afterClose";
    }
  }

  if (state.reason === "beforeOpen") {
    state.nextOpenDays = 0;
    state.nextOpenMinute = today.start;
  } else {
    for (let k = 1; k <= 7; k++) {
      const day = openDayOf(cfg, (dayIndex + k) % 7);
      if (day) {
        state.nextOpenDays = k;
        state.nextOpenMinute = day.start;
        break;
      }
    }
  }
  if (state.nextOpenDays >= 0) state.nextOpenMs = dayStart + state.nextOpenDays * DAY_MS + state.nextOpenMinute * MINUTE_MS;

  return state;
}

// 480 -> "8:00 AM", 1020 -> "5:00 PM", 1440 -> "12:00 AM".
function minutesText(total) {
  const m = ((total % 1440) + 1440) % 1440;
  const hours = Math.floor(m / 60);
  const minutes = m % 60;
  return (hours % 12 === 0 ? 12 : hours % 12) + ":" + (minutes < 10 ? "0" : "") + minutes + (hours < 12 ? " AM" : " PM");
}

// "today", "tomorrow" or "on Monday".
function nextOpenWhen(state) {
  if (state.nextOpenDays === 0) return "today";
  if (state.nextOpenDays === 1) return "tomorrow";
  return "on " + DAY_NAMES[(state.dayIndex + state.nextOpenDays) % 7];
}

// Why a new ticket can't be made right now, or "" when it can.
function hoursClosedText(state) {
  if (!state || !state.enabled || state.joinOpen) return "";
  if (state.reason === "lastJoin") {
    return "The windows have stopped taking new tickets for today. They close at " + minutesText(state.today.end) + ".";
  }
  if (state.nextOpenDays < 0) return "The windows are closed.";
  return "The windows are closed. They open " + nextOpenWhen(state) + " at " + minutesText(state.nextOpenMinute) + ".";
}

async function loadWindowHours(db) {
  const doc = await db.collection("settings").doc("windowHours").get();
  return doc.exists ? doc.data() : null;
}

// The state at deps.now() (or the real time), read fresh from Firestore.
async function windowHoursState(deps) {
  const nowMs = deps.now ? deps.now() : Date.now();
  return hoursState(await loadWindowHours(deps.db), deps.config.tzOffsetMs, nowMs);
}

module.exports = { DAY_KEYS, DAY_NAMES, hoursState, hoursClosedText, minutesText, loadWindowHours, windowHoursState };
