// Alerts for students while QFicient is open: a chime, a vibration and a message for everything that happens to
// their ticket. (When the page is closed, the push notification does the same job through the service worker.)

/* ---------- Chime and vibration ---------- */

var chimeContext = null;

// Browsers only allow sound after the person has touched the page, so the audio is switched on at the first tap.
function unlockChime() {
  try {
    if (!chimeContext) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      chimeContext = new AudioCtx();
    }
    if (chimeContext.state === "suspended") chimeContext.resume();
  } catch (e) {}
}

document.addEventListener("pointerdown", unlockChime, { passive: true });
document.addEventListener("keydown", unlockChime);

function playChime(urgent) {
  if (!chimeContext || chimeContext.state !== "running") return;

  var notes = urgent ? [880, 1174.66, 1567.98] : [783.99, 1046.5];
  notes.forEach(function (frequency, i) {
    var start = chimeContext.currentTime + i * 0.2;
    var osc = chimeContext.createOscillator();
    var gain = chimeContext.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);

    osc.connect(gain);
    gain.connect(chimeContext.destination);
    osc.start(start);
    osc.stop(start + 0.75);
  });
}

// Vibration patterns (ms on, off, on...). "Go to the counter" alerts buzz about 3 seconds, the rest about 1.5.
// public/firebase-messaging-sw.js uses the same patterns for notifications while the page is closed.
// (iPhones don't support web vibration; there the phone's own notification settings decide.)
var VIBRATE_URGENT = [500, 150, 500, 150, 500, 150, 800];
var VIBRATE_NORMAL = [400, 150, 400, 150, 400];

// Push tags of "go to the counter" messages, as in the service worker.
function isUrgentPushTag(tag) {
  return /:(serving|recall|lastCall|skipped)$/.test(String(tag || ""));
}

function buzz(urgent) {
  if (navigator.vibrate) navigator.vibrate(urgent ? VIBRATE_URGENT : VIBRATE_NORMAL);
}

// For "it's your turn", recall and last call while the page is open: the long buzz repeats every few seconds,
// for up to a minute, until the student touches the screen (or the ticket ends), so it can't go unnoticed.
var INSIST_EVERY_MS = 5 * 1000;
var INSIST_FOR_MS = 60 * 1000;
var insistTimer = null;
var insistStartedAt = 0;

// Stops the repeats. A touch lets the buzz that is already playing finish; when the ticket ends (cutShort) it
// stops at once.
function stopInsistentBuzz(cutShort) {
  if (!insistTimer) return;
  clearInterval(insistTimer);
  insistTimer = null;
  if (cutShort === true && navigator.vibrate) navigator.vibrate(0);
}

function buzzUntilTouched() {
  stopInsistentBuzz();
  buzz(true);
  insistStartedAt = Date.now();
  insistTimer = setInterval(function () {
    if (Date.now() - insistStartedAt >= INSIST_FOR_MS) {
      stopInsistentBuzz();
      return;
    }
    buzz(true);
  }, INSIST_EVERY_MS);
}

["pointerdown", "touchstart", "keydown"].forEach(function (type) {
  document.addEventListener(type, function () { stopInsistentBuzz(false); }, { passive: true });
});

/* ---------- Voice (optional, account menu) ---------- */

// Reads each alert aloud with the phone's own text-to-speech, in English, while QFicient is open (with it closed,
// the push notification's sound does the job). Off unless the student turns it on; remembered on this device.
// The voice, rate and the spelled-out ticket numbers are the Live Board's (speakTv / spokenTicketNo in
// js/tv-announcer.js).
var STUDENT_VOICE_KEY = "qficient.studentVoice";
var studentVoicePrimed = false;

function studentVoiceSupported() {
  return typeof tvSpeechSupported === "function" && tvSpeechSupported();
}

function studentVoiceOn() {
  if (!studentVoiceSupported()) return false;
  try { return localStorage.getItem(STUDENT_VOICE_KEY) === "on"; } catch (e) { return false; }
}

function speakStudent(text) {
  if (!text || !studentVoiceOn()) return;
  window.speechSynthesis.cancel(); // the newest alert replaces one still being read
  speakTv(text);
}

// From the account menu. The tap that turns it on also lets the page speak, so it says so straight away.
function toggleStudentVoice() {
  var on = !studentVoiceOn();
  try { localStorage.setItem(STUDENT_VOICE_KEY, on ? "on" : "off"); } catch (e) {}
  if (on) {
    studentVoicePrimed = true;
    speakStudent("Voice announcements are on. We'll read your ticket alerts aloud.");
  } else if (studentVoiceSupported()) {
    window.speechSynthesis.cancel();
  }
  return on;
}

// After a reload the page may not speak until it is touched; the first tap primes it with a silent word.
document.addEventListener("pointerdown", function () {
  if (studentVoicePrimed || !studentVoiceOn()) return;
  studentVoicePrimed = true;
  try {
    var silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
  } catch (e) {}
}, { passive: true });

// "Ticket C A, 0 1 2." in front of a spoken message.
function spokenTicketPrefix(ticket) {
  return ticket && ticket.ticketNo ? "Ticket " + spokenTicketNo(ticket.ticketNo) + ". " : "";
}

// tone: "alert" (red), "info" (blue) or "good" (green). insist: keep buzzing until the student touches the screen.
// icon: the matching notification icon (NOTIF_ICON_PATHS in js/notif-dropdown.js). spoken: what the voice says, when
// it should differ from the text (e.g. a ticket number spelled out); defaults to the text.
function studentAlert(text, tone, urgent, insist, icon, spoken) {
  showStudentToast(text, tone, icon);
  playChime(!!urgent);
  if (insist) buzzUntilTouched();
  else buzz(!!urgent);
  speakStudent(spoken || text);
}

/* ---------- What changed on the student's ticket ---------- */

var END_NOTICE_KEY = "qficient.endNotice.";
var ticketWatch = null;         // what the student has already been told about their live ticket
var missedNoticeChecked = false;

function ordinalWord(n) {
  return ({ 1: "1st", 2: "2nd", 3: "3rd" })[n] || n + "th";
}

function placeInLine(ticket) {
  if (ticket.status !== "waiting") return 0;
  return waitingTicketsOf(ticket.stationId).findIndex(function (item) { return item.id === ticket.id; }) + 1;
}

function stationNameOf(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station ? station.name : "the counter";
}

// The closest "almost your turn" place already announced (3, then 2), or 99 for none yet. Where the ticket stands
// when the page first sees it counts as announced (the join message, or the student already knows), so only moving
// up from there alerts. The server's push follows the same rule (functions/lib/push.js); with the page open and in
// view, the page's own alert is the one the student gets.
function soonPlaceSeen(place, someoneServed) {
  if (place === 1) return someoneServed ? 1 : 2;
  return place >= 2 && place <= 3 ? place : 99;
}

// Called on every dashboard update while the student has a live ticket.
function watchTicketEvents(ticket) {
  var place = placeInLine(ticket);
  var stationName = stationNameOf(ticket.stationId);
  var station = stations.find(function (s) { return s.id === ticket.stationId; });
  var someoneServed = servingTicketsOf(station).length > 0;

  // First look at this ticket (just joined, or the page was reopened): note where it stands, without alerts.
  if (!ticketWatch || ticketWatch.id !== ticket.id) {
    ticketWatch = { id: ticket.id, ticketNo: ticket.ticketNo, stationId: ticket.stationId, status: ticket.status,
                    soonPlace: soonPlaceSeen(place, someoneServed), next: place === 1 && someoneServed };
    return;
  }

  var w = ticketWatch;

  if (ticket.stationId !== w.stationId || ticket.ticketNo !== w.ticketNo) {
    if (ticket.enrollment === true) {
      studentAlert("Next enrollment step: please go to " + stationName + ". Your new number is " + ticket.ticketNo + ".", "info", true, false, "nextStation",
        "Next enrollment step. Please go to " + stationName + ". Your new number is " + spokenTicketNo(ticket.ticketNo) + ".");
    } else {
      studentAlert("Your ticket moved to " + stationName + ". Your new number is " + ticket.ticketNo + ".", "info", false, false, "transfer",
        "Your ticket moved to " + stationName + ". Your new number is " + spokenTicketNo(ticket.ticketNo) + ".");
    }
    // A new queue: start counting again from where they are now, without a second message straight away.
    w.soonPlace = soonPlaceSeen(place, someoneServed);
    w.next = place === 1 && someoneServed;
  } else if (ticket.status !== w.status) {
    if (ticket.status === "serving") {
      var windowText = windowLabel(station, ticketWindow(ticket));
      studentAlert("It's your turn! Please go to " + stationName + (windowText ? ", " + windowText : "") + " now.", "good", true, true, "bellRing",
        spokenTicketPrefix(ticket) + "It's your turn. Please go to " + stationName + (windowText ? ", " + windowText : "") + ", now.");
    } else if (ticket.status === "skipped") {
      studentAlert("Your ticket is on hold. Proceed immediately to " + stationName + " within " + formatVoidWindow() + " to keep it.", "alert", true, false, "pause",
        spokenTicketPrefix(ticket) + "Your ticket is on hold. Please proceed immediately to " + stationName + " within " + formatVoidWindow() + " to keep it.");
    }
  }

  if (ticket.status === "waiting") {
    if (place === 1 && someoneServed && !w.next) {
      studentAlert("You're next at " + stationName + ". Please get ready.", "info", true, false, "next");
      w.next = true;
      w.soonPlace = 1;
    } else if (place >= 2 && place <= 3 && place < w.soonPlace) {
      // Once at 3rd and once at 2nd (not again if someone is prioritized ahead and they slip back).
      studentAlert("You're " + ordinalWord(place) + " in line at " + stationName + ". Please stay nearby.", "info", false, false, "hourglass");
      w.soonPlace = place;
    }
  }

  w.ticketNo = ticket.ticketNo;
  w.stationId = ticket.stationId;
  w.status = ticket.status;
}

function endNoticeSeen(ticketId) {
  try { return !!localStorage.getItem(END_NOTICE_KEY + ticketId); } catch (e) { return false; }
}

function markEndNoticeSeen(ticketId) {
  try { localStorage.setItem(END_NOTICE_KEY + ticketId, "1"); } catch (e) {}
}

// Tells the student how their ticket ended: removed by the station, expired, or done.
function showEndNotice(ticket) {
  if (!ticket || endNoticeSeen(ticket.id)) return;

  if (ticket.status === "void") {
    markEndNoticeSeen(ticket.id);
    playChime(true);
    buzz(true);

    var expired = !!ticket.autoVoided;
    var closedAtHours = ticket.closedVoid === true; // still in line when the window hours closed
    var title = closedAtHours ? "The windows have closed" : expired ? "Your ticket expired" : "Your ticket was removed";
    var text = closedAtHours ?
      "The windows closed for today, so ticket " + ticket.ticketNo + " was voided. This doesn't count against you." :
      expired ?
      "Ticket " + ticket.ticketNo + " was voided because the last call ran out. You can get a new ticket anytime." :
      "Ticket " + ticket.ticketNo + " was removed by " + stationNameOf(ticket.stationId) + ". If you think this is a mistake, please ask the staff at the counter.";
    speakStudent(closedAtHours ?
      spokenTicketPrefix(ticket) + "The windows have closed for today, so your ticket was voided." :
      expired ?
      spokenTicketPrefix(ticket) + "Your ticket expired because the last call ran out. You can get a new ticket anytime." :
      spokenTicketPrefix(ticket) + "Your ticket was removed by " + stationNameOf(ticket.stationId) + ".");

    if (typeof Swal !== "undefined") {
      Swal.fire({ icon: "warning", title: title, text: text, confirmButtonText: "OK", confirmButtonColor: "#0054A6" });
    } else {
      say(title + ". " + text);
    }
  } else if (ticket.status === "completed") {
    markEndNoticeSeen(ticket.id);
    var enrolled = ticket.enrollment === true;
    studentAlert(enrolled ?
      "Your enrollment is complete. Thank you!" :
      "Your transaction for ticket " + ticket.ticketNo + " is complete. Thank you!", "good", false, false, enrolled ? "graduate" : "done",
      enrolled ? "Your enrollment is complete. Thank you!" : "Your transaction is complete. Thank you!");
  }
}

// Called when the student no longer has a live ticket.
function ticketEnded() {
  stopInsistentBuzz(true);
  if (ticketWatch) {
    var ended = tickets.find(function (t) { return t.id === ticketWatch.id; });
    ticketWatch = null;
    if (ended) showEndNotice(ended);
  }

  // A ticket removed while the page was closed is still worth telling them about, once.
  if (!missedNoticeChecked && user && ticketsLoaded) {
    missedNoticeChecked = true;
    var cutoff = serverNow() - 3 * 60 * 60 * 1000;
    var latest = tickets.filter(function (t) {
      return t.ownerId === user.id && t.status === "void" && timestampToMs(t.voidedAt, 0) >= cutoff;
    }).sort(function (a, b) { return timestampToMs(b.voidedAt, 0) - timestampToMs(a.voidedAt, 0); })[0];
    if (latest) showEndNotice(latest);
  }
}

function resetTicketWatch() {
  stopInsistentBuzz(true);
  ticketWatch = null;
  missedNoticeChecked = false;
}

/* ---------- Ask for background alerts after joining ---------- */

function offerBackgroundAlerts() {
  if (!user || typeof isFcmSupported !== "function" || !isFcmSupported()) return;
  if (Notification.permission !== "default") return;

  showConfirmModal({
    title: "Turn on alerts for this phone?",
    message: "We'll ring and vibrate your phone when you're almost up and when it's your turn, even if QFicient is closed.",
    confirmLabel: "Turn On Alerts",
    tone: "primary",
    onConfirm: function () { enableNotifications(); }
  });
}
