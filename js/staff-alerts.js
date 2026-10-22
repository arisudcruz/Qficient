// Sound (and vibration on phones) for staff while the admin console is open:
//   - a ticket joins, or is transferred into, a station they look after: a short chime; a brighter one when
//     that station's line was empty, since that is when someone has to call
//   - a ticket's last call runs out and it is voided automatically: a low chime
// Which stations count follows the role: admins and the Queue Enforcer hear every station, Queue Management
// staff only their own. Walk-ins the Queue Enforcer makes themselves don't chime for them.
// Browsers allow sound only after the first click on the page; the speaker button in the header shows whether
// sound is on, and mutes it (remembered on this device).

var STAFF_SOUND_KEY = "qficient.staffSound";

var staffSoundWanted = true;
var staffAlertSeen = null;   // { owner, tickets: { id: { status, stationId } } }; null until the first look

try { staffSoundWanted = localStorage.getItem(STAFF_SOUND_KEY) !== "off"; } catch (e) {}

function staffSoundUnlocked() {
  if (navigator.userActivation) return navigator.userActivation.hasBeenActive;
  return !!chimeContext && chimeContext.state === "running";
}

/* ---------- Tones ---------- */

function playStaffTones(notes, gap, volume) {
  unlockChime();
  if (!chimeContext || chimeContext.state !== "running") return;

  notes.forEach(function (frequency, i) {
    var start = chimeContext.currentTime + i * gap;
    var osc = chimeContext.createOscillator();
    var gain = chimeContext.createGain();

    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);

    osc.connect(gain);
    gain.connect(chimeContext.destination);
    osc.start(start);
    osc.stop(start + 0.65);
  });
}

var STAFF_TONES = {
  arrival: function () { playStaffTones([587.33, 880], 0.16, 0.25); },
  firstInLine: function () { playStaffTones([587.33, 739.99, 987.77], 0.16, 0.32); },
  voided: function () { playStaffTones([440, 329.63], 0.22, 0.25); }
};

var STAFF_BUZZ = {
  arrival: [150],
  firstInLine: [200, 100, 200],
  voided: [120, 80, 120]
};

// One sound per update, the most important first, so a burst of changes doesn't pile up.
function staffAlert(kind) {
  if (!staffSoundWanted) return;
  STAFF_TONES[kind]();
  if (navigator.vibrate) navigator.vibrate(STAFF_BUZZ[kind]);
}

/* ---------- What changed ---------- */

function staffWatchesStation(stationId) {
  var kind = adminKind();
  if (kind === "station") return stationId === adminRole;
  return kind === "admin" || kind === "enforcer";
}

// Called after every tickets update.
function checkStaffAlerts() {
  var page = document.body.getAttribute("data-page");
  if (typeof adminUser === "undefined" || !adminUser || !ticketsLoaded || page !== "pageAdmin") {
    // Off the console (or signed out) the next look starts fresh, so returning doesn't replay what was missed.
    staffAlertSeen = null;
    return;
  }

  var me = staffKey(adminUser.email);
  var known = staffAlertSeen && staffAlertSeen.owner === me ? staffAlertSeen.tickets : null;
  var now = {};
  var heard = { arrival: false, firstInLine: false, voided: false };

  tickets.forEach(function (ticket) {
    if (!isTodayTicket(ticket)) return;
    now[ticket.id] = { status: ticket.status, stationId: ticket.stationId, lane: ticketLane(ticket) };
    if (!known || !staffWatchesStation(ticket.stationId)) return;

    var before = known[ticket.id];
    var arrived = ticket.status === "waiting" && (!before || before.stationId !== ticket.stationId);
    var mine = ticket.manual && ticket.createdBy === me;

    if (arrived && !mine) {
      // Was anyone already waiting there before this update?
      // (Each line counts on its own: a station's regular line and its enrollment line.)
      var othersWaiting = Object.keys(known).some(function (id) {
        return id !== ticket.id && known[id].status === "waiting" && known[id].stationId === ticket.stationId &&
          known[id].lane === ticketLane(ticket);
      });
      if (othersWaiting) heard.arrival = true;
      else heard.firstInLine = true;
    }

    if (before && before.status !== "void" && ticket.status === "void" && ticket.autoVoided && !ticket.staleCleanup) {
      heard.voided = true;
    }
  });

  staffAlertSeen = { owner: me, tickets: now };

  if (heard.firstInLine) staffAlert("firstInLine");
  else if (heard.arrival) staffAlert("arrival");
  else if (heard.voided) staffAlert("voided");
}

/* ---------- The speaker button ---------- */

var STAFF_SPEAKER_ON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
var STAFF_SPEAKER_OFF_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';

function staffSoundState() {
  if (!staffSoundWanted) return "off";
  return staffSoundUnlocked() ? "on" : "needs-tap";
}

function staffSoundTitle(state) {
  if (state === "off") return "Alert sounds are off. Click to turn them on.";
  if (state === "needs-tap") return "Click to turn on alert sounds";
  return "Alert sounds are on. Click to mute.";
}

// Used by adminHeaderRightHtml().
function staffSoundButtonHtml() {
  var state = staffSoundState();
  return '<button type="button" class="admin-sound-btn is-' + state + '" data-staff-sound title="' + staffSoundTitle(state) + '" aria-label="' + staffSoundTitle(state) + '" onclick="toggleStaffSound()">' +
    (state === "off" ? STAFF_SPEAKER_OFF_SVG : STAFF_SPEAKER_ON_SVG) +
  '</button>';
}

function refreshStaffSoundButtons() {
  var state = staffSoundState();
  document.querySelectorAll("[data-staff-sound]").forEach(function (btn) {
    if (btn.classList.contains("is-" + state)) return;
    btn.className = "admin-sound-btn is-" + state;
    btn.title = staffSoundTitle(state);
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = state === "off" ? STAFF_SPEAKER_OFF_SVG : STAFF_SPEAKER_ON_SVG;
  });
}

function toggleStaffSound() {
  unlockChime();

  // A click while it still waits for one only switches the sound on.
  var waiting = document.querySelector("[data-staff-sound].is-needs-tap");
  if (!(staffSoundWanted && waiting)) {
    staffSoundWanted = !staffSoundWanted;
    try { localStorage.setItem(STAFF_SOUND_KEY, staffSoundWanted ? "on" : "off"); } catch (e) {}
  }

  refreshStaffSoundButtons();
  if (staffSoundWanted) setTimeout(function () { STAFF_TONES.arrival(); }, 50); // so they hear what it sounds like
}

// Any click in the console unlocks sound; the button follows.
document.addEventListener("pointerdown", function (event) {
  if (document.body.getAttribute("data-page") !== "pageAdmin") return;
  if (event.target.closest && event.target.closest("[data-staff-sound]")) return;
  setTimeout(refreshStaffSoundButtons, 0);
});
