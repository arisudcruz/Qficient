// Sound for the TV Live Board: a ding-dong and a spoken announcement ("Now serving ticket C A 0 1 2 at Cashier")
// when a station calls a number, recalls one or gives a last call. The voice is the browser's own text-to-speech;
// where a TV browser has none, the board still chimes.
//
// Browsers only play sound after someone has touched the page, so the board shows "Tap to turn on sound" until
// then. The on/off choice is remembered on this device.

var TV_SOUND_KEY = "qficient.tvSound";
var TV_SPEECH_TIMEOUT_MS = 15 * 1000;  // in case a browser never reports that it finished speaking

var tvSoundWanted = true;
var tvAnnounceQueue = [];
var tvAnnouncing = false;
var tvAnnounceSeen = null;   // what the board has already announced; null until the first look after loading
var tvVoice = null;

try { tvSoundWanted = localStorage.getItem(TV_SOUND_KEY) !== "off"; } catch (e) {}

function tvSpeechSupported() {
  return typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance !== "undefined";
}

// Whether the browser will let the page make sound yet.
function tvSoundUnlocked() {
  if (navigator.userActivation) return navigator.userActivation.hasBeenActive;
  return !!chimeContext && chimeContext.state === "running";
}

/* ---------- Voice ---------- */

// Prefers a Philippine English voice, then a natural-sounding English one, then any English voice.
function pickTvVoice() {
  if (!tvSpeechSupported()) return null;
  var voices = window.speechSynthesis.getVoices() || [];
  var english = voices.filter(function (v) { return /^en[-_]/i.test(v.lang) || v.lang === "en"; });
  var byLang = function (lang) { return english.find(function (v) { return v.lang.replace("_", "-").toLowerCase() === lang; }); };
  var natural = english.find(function (v) { return /natural|online|google/i.test(v.name); });

  return byLang("en-ph") || natural || byLang("en-us") || byLang("en-gb") || english[0] || null;
}

if (tvSpeechSupported()) {
  tvVoice = pickTvVoice();
  window.speechSynthesis.addEventListener("voiceschanged", function () { tvVoice = pickTvVoice(); });
}

// "CA-012" is read as "C A, 0 1 2" instead of "ca twelve".
function spokenTicketNo(ticketNo) {
  return String(ticketNo || "").split("-").map(function (part) {
    return part.split("").join(" ");
  }).join(", ");
}

function speakTv(text) {
  return new Promise(function (resolve) {
    if (!tvSpeechSupported()) {
      resolve();
      return;
    }

    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    var timer = setTimeout(finish, TV_SPEECH_TIMEOUT_MS);

    var utterance = new SpeechSynthesisUtterance(text);
    if (tvVoice) utterance.voice = tvVoice;
    utterance.lang = tvVoice ? tvVoice.lang : "en-US";
    utterance.rate = 0.9;
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

/* ---------- Chime ---------- */

// A two-note ding-dong, louder and lower than the students' phone chime. Resolves when it has rung out.
function playTvChime() {
  unlockChime();
  if (!chimeContext || chimeContext.state !== "running") return Promise.resolve();

  [659.25, 523.25].forEach(function (frequency, i) {
    var start = chimeContext.currentTime + i * 0.45;
    var osc = chimeContext.createOscillator();
    var gain = chimeContext.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);

    osc.connect(gain);
    gain.connect(chimeContext.destination);
    osc.start(start);
    osc.stop(start + 1.15);
  });

  return new Promise(function (resolve) { setTimeout(resolve, 1300); });
}

/* ---------- Announcements, one at a time ---------- */

function queueTvAnnouncement(text) {
  if (!tvSoundWanted) return;
  tvAnnounceQueue.push(text);
  if (tvAnnounceQueue.length > 6) tvAnnounceQueue.shift(); // a burst of calls: keep the latest few
  runTvAnnouncements();
}

function runTvAnnouncements() {
  if (tvAnnouncing || !tvAnnounceQueue.length) return;
  if (!tvSoundUnlocked()) {
    tvAnnounceQueue = []; // nobody has tapped yet: these calls are shown on screen only
    return;
  }

  tvAnnouncing = true;
  var text = tvAnnounceQueue.shift();

  playTvChime()
    .then(function () { return speakTv(text); })
    .then(function () {
      tvAnnouncing = false;
      setTimeout(runTvAnnouncements, 600);
    });
}

function tvServingText(ticket, stationName) {
  var number = spokenTicketNo(ticket.ticketNo);
  return "Now serving, ticket " + number + ", at " + stationName + ". Ticket " + number + ", please proceed to " + stationName + ".";
}

function tvRecallText(ticket, stationName) {
  return "Calling again, ticket " + spokenTicketNo(ticket.ticketNo) + ", please proceed to " + stationName + ".";
}

function tvLastCallText(ticket, stationName) {
  return "Last call for ticket " + spokenTicketNo(ticket.ticketNo) + ". Please proceed to " + stationName + " now.";
}

// Called after every board update. Compares with what was already announced, so a refresh or a reconnect is quiet.
function checkTvAnnouncements(list) {
  if (!ticketsLoaded || !stations.length) return;

  var seen = { serving: {}, recalls: {}, lastCalls: {} };
  var firstLook = tvAnnounceSeen === null;
  var before = tvAnnounceSeen || seen;
  var names = {};
  list.forEach(function (station) { names[station.id] = station.name; });

  list.forEach(function (station) {
    var serving = servingTicketOf(station);
    seen.serving[station.id] = serving ? serving.id : (before.serving[station.id] || null);
    if (!firstLook && serving && before.serving[station.id] !== serving.id) {
      queueTvAnnouncement(tvServingText(serving, station.name));
    }
  });

  tickets.forEach(function (ticket) {
    if (!names[ticket.stationId] || !isTodayTicket(ticket)) return;
    var stationName = names[ticket.stationId];

    var recalls = ticket.recallCount || 0;
    seen.recalls[ticket.id] = recalls;
    if (!firstLook && recalls > (before.recalls[ticket.id] || 0) && (ticket.status === "serving" || ticket.status === "skipped")) {
      queueTvAnnouncement(tvRecallText(ticket, stationName));
    }

    var lastCallMs = ticket.lastCalled ? timestampToMs(ticket.lastCallAt, 0) : 0;
    seen.lastCalls[ticket.id] = lastCallMs || before.lastCalls[ticket.id] || 0;
    if (!firstLook && lastCallMs && ticket.status === "skipped" && lastCallMs !== (before.lastCalls[ticket.id] || 0)) {
      queueTvAnnouncement(tvLastCallText(ticket, stationName));
    }
  });

  tvAnnounceSeen = seen;
}

function resetTvAnnouncements() {
  tvAnnounceSeen = null;
  tvAnnounceQueue = [];
  if (tvSpeechSupported()) window.speechSynthesis.cancel();
}

/* ---------- The sound button ---------- */

var TV_SPEAKER_ON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
var TV_SPEAKER_OFF_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';

function renderTvSoundButton() {
  var btn = document.getElementById("tvSoundBtn");
  if (!btn) return;

  var ready = tvSoundWanted && tvSoundUnlocked();
  var voiceNote = tvSpeechSupported() ? "" : " (chime only: this browser has no voice)";

  btn.classList.toggle("is-off", !tvSoundWanted);
  btn.classList.toggle("needs-tap", tvSoundWanted && !ready);
  btn.innerHTML = (tvSoundWanted ? TV_SPEAKER_ON_SVG : TV_SPEAKER_OFF_SVG) +
    (tvSoundWanted && !ready ? '<span>Tap to turn on sound</span>' : (!tvSoundWanted ? '<span>Sound off</span>' : ''));
  btn.title = ready ? "Sound is on" + voiceNote + ". Click to mute." : (tvSoundWanted ? "Tap to turn on sound" : "Sound is off. Click to turn it on.");
  btn.setAttribute("aria-label", btn.title);
}

function toggleTvSound() {
  unlockChime();

  // The first tap only switches the sound on (the page is now allowed to play it).
  if (tvSoundWanted && btnNeedsTap()) {
    renderTvSoundButton();
    tvSoundTest();
    return;
  }

  tvSoundWanted = !tvSoundWanted;
  try { localStorage.setItem(TV_SOUND_KEY, tvSoundWanted ? "on" : "off"); } catch (e) {}

  if (!tvSoundWanted) {
    tvAnnounceQueue = [];
    if (tvSpeechSupported()) window.speechSynthesis.cancel();
  } else {
    tvSoundTest();
  }
  renderTvSoundButton();
}

function btnNeedsTap() {
  var btn = document.getElementById("tvSoundBtn");
  return !!btn && btn.classList.contains("needs-tap");
}

// A short confirmation that the speakers work.
function tvSoundTest() {
  queueTvAnnouncement("Sound is on.");
}

// Any tap on the board counts: the button switches from "Tap to turn on sound" to the speaker icon.
// (A tap on the button itself is handled by toggleTvSound.)
document.addEventListener("pointerdown", function (event) {
  if (document.body.getAttribute("data-page") !== "pageTvBoard") return;
  if (event.target.closest && event.target.closest("#tvSoundBtn")) return;
  setTimeout(renderTvSoundButton, 0);
});
