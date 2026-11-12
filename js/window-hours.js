// Window hours (System Settings > Window Hours, settings/windowHours): one weekly schedule for when the windows take
// tickets. The same logic as functions/lib/hours.js, which is what really decides; keep the two in step. The pages
// use it to turn off the queue buttons and show "closed" before anyone even tries.
//
//   { enabled, days: { sun..sat: { open, start, end } }, lastJoinMinutes }   start/end: minutes after midnight, PH time

var HOURS_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
var HOURS_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var HOURS_DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var HOURS_MINUTE_MS = 60 * 1000;

// The saved schedule (null = none saved: no limits). Set by the listener in js/firebase.js.
var windowHours = null;

function hoursWholeMinute(n, min, max) {
  return typeof n === "number" && Math.floor(n) === n && n >= min && n <= max;
}

function hoursOpenDayOf(cfg, dayIndex) {
  var day = cfg && cfg.days ? cfg.days[HOURS_DAY_KEYS[dayIndex]] : null;
  if (!day || day.open !== true) return null;
  if (!hoursWholeMinute(day.start, 0, 1439) || !hoursWholeMinute(day.end, 1, 1440) || day.start >= day.end) return null;
  return day;
}

function hoursLastJoinMinutesOf(cfg) {
  return cfg && hoursWholeMinute(cfg.lastJoinMinutes, 0, 240) ? cfg.lastJoinMinutes : 0;
}

// Same fields as hoursState() in functions/lib/hours.js: enabled, open, joinOpen, reason ("", "closedDay",
// "beforeOpen", "afterClose", "lastJoin"), dayIndex, today, closesAtMs, joinStopsAtMs, nextOpenMs, nextOpenDays,
// nextOpenMinute.
function hoursState(cfg, nowMs) {
  if (!cfg || cfg.enabled !== true) return { enabled: false, open: true, joinOpen: true, reason: "" };

  var dayIndex = new Date(nowMs + QUEUE_TZ_OFFSET_MS).getUTCDay();
  var dayStart = Math.floor((nowMs + QUEUE_TZ_OFFSET_MS) / DAY_MS) * DAY_MS - QUEUE_TZ_OFFSET_MS;
  var intoDay = nowMs - dayStart;
  var today = hoursOpenDayOf(cfg, dayIndex);
  var state = {
    enabled: true, open: false, joinOpen: false, reason: "closedDay", dayIndex: dayIndex, today: today,
    closesAtMs: 0, joinStopsAtMs: 0, nextOpenMs: 0, nextOpenDays: -1, nextOpenMinute: 0
  };

  if (today) {
    var joinEnd = Math.max(today.start, today.end - hoursLastJoinMinutesOf(cfg));
    state.closesAtMs = dayStart + today.end * HOURS_MINUTE_MS;
    state.joinStopsAtMs = dayStart + joinEnd * HOURS_MINUTE_MS;
    if (intoDay < today.start * HOURS_MINUTE_MS) {
      state.reason = "beforeOpen";
    } else if (intoDay < today.end * HOURS_MINUTE_MS) {
      state.open = true;
      state.joinOpen = intoDay < joinEnd * HOURS_MINUTE_MS;
      state.reason = state.joinOpen ? "" : "lastJoin";
    } else {
      state.reason = "afterClose";
    }
  }

  if (state.reason === "beforeOpen") {
    state.nextOpenDays = 0;
    state.nextOpenMinute = today.start;
  } else {
    for (var k = 1; k <= 7; k++) {
      var day = hoursOpenDayOf(cfg, (dayIndex + k) % 7);
      if (day) {
        state.nextOpenDays = k;
        state.nextOpenMinute = day.start;
        break;
      }
    }
  }
  if (state.nextOpenDays >= 0) state.nextOpenMs = dayStart + state.nextOpenDays * DAY_MS + state.nextOpenMinute * HOURS_MINUTE_MS;

  return state;
}

// 480 -> "8:00 AM", 1020 -> "5:00 PM".
function hoursMinutesText(total) {
  var m = ((total % 1440) + 1440) % 1440;
  var hours = Math.floor(m / 60);
  var minutes = m % 60;
  return (hours % 12 === 0 ? 12 : hours % 12) + ":" + (minutes < 10 ? "0" : "") + minutes + (hours < 12 ? " AM" : " PM");
}

// "08:00" (an <input type="time"> value) <-> 480.
function hoursInputValue(total) {
  var m = Math.min(Math.max(total, 0), 1439);
  var h = Math.floor(m / 60);
  var min = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (min < 10 ? "0" : "") + min;
}

function hoursFromInput(value) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  var h = Number(match[1]);
  var m = Number(match[2]);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}

function hoursNextOpenWhen(state) {
  if (state.nextOpenDays === 0) return "today";
  if (state.nextOpenDays === 1) return "tomorrow";
  return "on " + HOURS_DAY_NAMES[(state.dayIndex + state.nextOpenDays) % 7];
}

// Why a new ticket can't be made right now, or "" when it can. Same wording as the server's.
function hoursClosedText(state) {
  if (!state || !state.enabled || state.joinOpen) return "";
  if (state.reason === "lastJoin") {
    return "The windows have stopped taking new tickets for today. They close at " + hoursMinutesText(state.today.end) + ".";
  }
  if (state.nextOpenDays < 0) return "The windows are closed.";
  return "The windows are closed. They open " + hoursNextOpenWhen(state) + " at " + hoursMinutesText(state.nextOpenMinute) + ".";
}

// The schedule right now, on the server's clock.
function windowHoursNow() {
  return hoursState(windowHours, serverNow());
}

// Changes only when the schedule flips (opens, stops new tickets, closes), so pages know when to redraw.
function windowHoursKey() {
  var state = windowHoursNow();
  return state.enabled ? [state.open, state.joinOpen, state.reason, state.nextOpenMs].join("|") : "off";
}

// "" when tickets can be made, else why not.
function windowHoursClosedText() {
  return hoursClosedText(windowHoursNow());
}

// A short line for the student dashboard: "Windows open today 8:00 AM – 5:00 PM", or "" when the hours are off.
function todayHoursText() {
  var state = windowHoursNow();
  if (!state.enabled) return "";
  if (!state.today) return "The windows are closed today.";
  return "Windows open today " + hoursMinutesText(state.today.start) + " – " + hoursMinutesText(state.today.end);
}

// For the TV board: "Opens Mon 8:00 AM" / "Opens 8:00 AM" (later today), or "" when nothing is open.
function nextOpenShortText(state) {
  if (!state || state.nextOpenDays < 0) return "";
  var when = state.nextOpenDays === 0 ? "" : state.nextOpenDays === 1 ? "tomorrow " : HOURS_DAY_SHORT[(state.dayIndex + state.nextOpenDays) % 7] + " ";
  return "Opens " + when + hoursMinutesText(state.nextOpenMinute);
}

// Pages that show the schedule redraw when it flips at opening or closing, without a reload.
var windowHoursLastKey = null;

function checkWindowHoursFlip() {
  var key = windowHoursKey();
  if (key === windowHoursLastKey) return;
  windowHoursLastKey = key;
  onWindowHoursChanged();
}

function onWindowHoursChanged() {
  if (typeof updateDashboard === "function") updateDashboard();
  if (typeof renderTvBoard === "function") renderTvBoard();
  if (typeof refreshEnforcerList === "function") refreshEnforcerList();
  // The Walk-in Form says when the windows are closed.
  if (typeof enforcerFormNeedsFlows === "function" && enforcerFormNeedsFlows()) renderEnforcer();
}

setInterval(checkWindowHoursFlip, 15 * 1000);
