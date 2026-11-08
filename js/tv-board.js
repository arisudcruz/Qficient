// The TV Live Board (#/tv/<preset id>): a full-screen display of up to 4 stations' queues, meant for a smart TV in
// the waiting area. It needs a staff sign-in on that browser (any console role), because tickets are only readable
// when signed in. Which stations it shows comes from a Live Board preset (settings/liveBoard), which admins manage
// on the console's Live Board page; that page opens the board in its own window.

var TV_MAX_COLUMNS = 4;        // a preset shows at most this many stations, each as a full column
var TV_MAX_PRESETS = 20;
var TV_PRESET_NAME_MAX = 40;
var TV_DEFAULT_STATIONS = ["admission", "cashier", "registrar"]; // listed first when picking stations for a preset
var TV_WAITING_ROWS = 4;
var TV_IDLE_MS = 3 * 1000;
var TV_PRESET_ID_PATTERN = /^[a-z0-9]{4,24}$/;

var liveBoardPresets = [];     // [{ id, name, stations: [stationId, ...] }], kept up to date by js/firebase.js
var tvPresetId = "";           // the preset on screen, from #/tv/<id>
var tvShownKey = null;         // the preset (and its stations) last drawn, so a change starts the announcements afresh
var tvClockTimer = null;
var tvIdleTimer = null;
var tvLastServing = {};

/* ---------- Presets ---------- */

function cleanLiveBoardPreset(preset) {
  if (!preset || typeof preset !== "object" || !TV_PRESET_ID_PATTERN.test(String(preset.id || ""))) return null;
  var name = String(preset.name || "").trim();
  var seen = {};
  var list = (Array.isArray(preset.stations) ? preset.stations : []).filter(function (id) {
    if (typeof id !== "string" || !id || seen[id]) return false;
    seen[id] = true;
    return true;
  }).slice(0, TV_MAX_COLUMNS);
  if (!name || !list.length) return null;
  return { id: preset.id, name: name.slice(0, TV_PRESET_NAME_MAX), stations: list };
}

function cleanLiveBoardPresets(list) {
  return (Array.isArray(list) ? list : []).map(cleanLiveBoardPreset).filter(Boolean);
}

// js/firebase.js calls this whenever settings/liveBoard changes.
function onLiveBoardPresetsChanged(list) {
  liveBoardPresets = cleanLiveBoardPresets(list);
  renderTvBoard();
  refreshLiveBoardLauncher();
}

function tvPresetOf(id) {
  if (!id) return null;
  return liveBoardPresets.find(function (preset) { return preset.id === id; }) || null;
}

function tvStationById(id) {
  return (stations || []).find(function (station) { return station.id === id; }) || null;
}

// Stations in the order they are offered when picking a preset's columns: the usual main ones first, then by name.
function tvStationChoices() {
  function rank(station) {
    var i = TV_DEFAULT_STATIONS.indexOf(station.id);
    return i === -1 ? TV_DEFAULT_STATIONS.length : i;
  }
  return (stations || []).slice().sort(function (a, b) {
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });
}

function tvPresetStationNames(preset) {
  return preset.stations.map(function (id) {
    var station = tvStationById(id);
    return station ? station.name : "Deleted station";
  });
}

function newLiveBoardPresetId(list) {
  var id;
  do {
    id = Math.random().toString(36).slice(2, 10);
  } while (id.length < 4 || list.some(function (preset) { return preset.id === id; }));
  return id;
}

// Reads the saved presets, applies `change` (which returns the new list, or throws an Error to refuse) and saves,
// all in one transaction so two admins editing at once don't overwrite each other.
function updateLiveBoardPresets(change) {
  var ref = db.collection("settings").doc("liveBoard");
  return db.runTransaction(function (tx) {
    return tx.get(ref).then(function (snap) {
      var current = cleanLiveBoardPresets(snap.exists ? snap.data().presets : []);
      var next = change(current);
      tx.set(ref, {
        presets: next.map(function (preset) { return { id: preset.id, name: preset.name, stations: preset.stations.slice() }; }),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  });
}

/* ---------- Admin console: Live Board page ---------- */

var TV_PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 8.5v6l5-3z"/></svg>';

function liveBoardLauncherShown() {
  var page = document.getElementById("pageAdmin");
  var area = document.getElementById("adminLiveBoardArea");
  return !!(page && area && page.classList.contains("show") && area.style.display !== "none");
}

function refreshLiveBoardLauncher() {
  if (liveBoardLauncherShown()) renderLiveBoardLauncher();
}

function liveBoardPresetCardHtml(preset, canEdit) {
  var id = escapeAdminText(preset.id);
  var chips = preset.stations.map(function (stationId, i) {
    var station = tvStationById(stationId);
    var note = !station ? '<em>Deleted</em>' : station.active === false ? '<em>Disabled</em>' : '';
    return '<li class="' + (station && station.active !== false ? '' : 'is-off') + '"><b>' + (i + 1) + '</b>' +
      escapeAdminText(station ? station.name : "Deleted station") + note + '</li>';
  }).join("");

  return '<article class="lb-preset">' +
    '<div class="lb-preset-head">' +
      '<h3>' + escapeAdminText(preset.name) + '</h3>' +
      '<span>' + preset.stations.length + (preset.stations.length === 1 ? ' station' : ' stations') + '</span>' +
    '</div>' +
    '<ol class="lb-preset-stations">' + chips + '</ol>' +
    '<div class="lb-preset-actions">' +
      '<button type="button" class="lb-launch-btn" onclick="openTvBoard(\'' + id + '\')">' + TV_PLAY_ICON + 'Open</button>' +
      (canEdit ?
        '<button type="button" class="settings-btn settings-btn-blue" onclick="openLiveBoardPresetEditor(\'' + id + '\')">Edit</button>' +
        '<button type="button" class="settings-btn settings-btn-red" onclick="confirmDeleteLiveBoardPreset(\'' + id + '\')">Delete</button>' : '') +
    '</div>' +
  '</article>';
}

function renderLiveBoardLauncher() {
  var area = document.getElementById("adminLiveBoardArea");
  if (!area) return;

  var canEdit = isFullAdmin();
  var full = liveBoardPresets.length >= TV_MAX_PRESETS;
  var body;

  if (!liveBoardPresets.length) {
    body = '<div class="lb-empty">' +
      '<p><b>No presets yet.</b></p>' +
      '<p>' + (canEdit ?
        'Add a preset to choose which stations (up to ' + TV_MAX_COLUMNS + ') a TV shows.' :
        'Ask an admin to add a Live Board preset, then open it here.') + '</p>' +
    '</div>';
  } else {
    body = '<div class="lb-presets">' + liveBoardPresets.map(function (preset) {
      return liveBoardPresetCardHtml(preset, canEdit);
    }).join("") + '</div>';
  }

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Live Board</div>' +
      adminHeaderRightHtml() +
    '</div>' +
    '<div class="lb-page">' +
      '<div class="lb-top">' +
        '<p>Pick a preset to open the Live Board with its stations. Each preset shows up to ' + TV_MAX_COLUMNS + ' stations, side by side.</p>' +
        (canEdit ?
          '<button type="button" class="settings-btn settings-btn-primary" onclick="openLiveBoardPresetEditor(\'\')"' +
            (full ? ' disabled title="You can have up to ' + TV_MAX_PRESETS + ' presets."' : '') + '>+ Add Preset</button>' : '') +
      '</div>' +
      body +
      '<p class="lb-launch-help">For the TV: open QFicient in the TV\'s browser, sign in with a staff account, go to Live Board, pick a preset and press Open. Then use the full-screen button at the top of the board, and tap "Tap to turn on sound" once so the board can chime and announce each call.</p>' +
    '</div>';
}

function liveBoardSlotOptionsHtml(selectedId) {
  return '<option value="">— None —</option>' + tvStationChoices().map(function (station) {
    return '<option value="' + escapeAdminText(station.id) + '"' + (station.id === selectedId ? ' selected' : '') + '>' +
      escapeAdminText(station.name) + (station.active === false ? ' (disabled)' : '') + '</option>';
  }).join("");
}

// The Add / Edit form. A new preset starts with the first open stations filled in.
function openLiveBoardPresetEditor(presetId) {
  if (!isFullAdmin()) return;
  var preset = presetId ? tvPresetOf(presetId) : null;
  if (presetId && !preset) {
    say("That preset no longer exists.");
    return;
  }
  if (!preset && liveBoardPresets.length >= TV_MAX_PRESETS) {
    say("You can have up to " + TV_MAX_PRESETS + " presets. Delete one to add another.");
    return;
  }

  var chosen = preset ? preset.stations.slice() : tvStationChoices().filter(function (station) {
    return station.active !== false;
  }).slice(0, TV_MAX_COLUMNS).map(function (station) { return station.id; });

  var slots = "";
  for (var i = 0; i < TV_MAX_COLUMNS; i++) {
    slots += '<label class="lb-slot"><span>Column ' + (i + 1) + '</span>' +
      '<select class="modal-input lb-slot-select">' + liveBoardSlotOptionsHtml(chosen[i] || "") + '</select></label>';
  }

  showFormModal(preset ? "Edit Live Board Preset" : "New Live Board Preset",
    '<div class="modal-field"><label for="lbPresetName">Preset Name</label>' +
      '<input type="text" id="lbPresetName" class="modal-input" maxlength="' + TV_PRESET_NAME_MAX + '" placeholder="e.g. Lobby TV" value="' +
        escapeAdminText(preset ? preset.name : "") + '"></div>' +
    '<div class="modal-field"><label>Stations <span class="lb-field-note">shown left to right, up to ' + TV_MAX_COLUMNS + '</span></label>' +
      '<div class="lb-slots">' + slots + '</div></div>' +
    '<div class="settings-actions">' +
      '<button type="button" class="settings-btn settings-btn-primary" id="lbPresetSave" onclick="saveLiveBoardPreset(\'' + escapeAdminText(presetId || "") + '\')">Save Preset</button>' +
      '<button type="button" class="settings-btn settings-btn-blue" onclick="closeFormModal()">Cancel</button>' +
    '</div>');

  var nameInput = document.getElementById("lbPresetName");
  if (nameInput) nameInput.focus();
}

// What is wrong with a preset about to be saved into `list`, or "" when it is fine.
function liveBoardPresetProblem(list, presetId, name, stationIds) {
  if (!name) return "Please enter a preset name.";
  if (!stationIds.length) return "Please choose at least one station.";
  var seen = {};
  for (var i = 0; i < stationIds.length; i++) {
    if (seen[stationIds[i]]) return "Each station can only be in a preset once.";
    seen[stationIds[i]] = true;
  }
  var lower = name.toLowerCase();
  if (list.some(function (preset) { return preset.id !== presetId && preset.name.toLowerCase() === lower; })) {
    return "A preset with that name already exists.";
  }
  if (!presetId && list.length >= TV_MAX_PRESETS) return "You can have up to " + TV_MAX_PRESETS + " presets. Delete one to add another.";
  return "";
}

function saveLiveBoardPreset(presetId) {
  if (!isFullAdmin()) return;
  var nameInput = document.getElementById("lbPresetName");
  var name = nameInput ? nameInput.value.replace(/\s+/g, " ").trim().slice(0, TV_PRESET_NAME_MAX) : "";
  var stationIds = [];
  document.querySelectorAll("#formModal .lb-slot-select").forEach(function (select) {
    if (select.value) stationIds.push(select.value);
  });

  var problem = liveBoardPresetProblem(liveBoardPresets, presetId, name, stationIds);
  if (problem) {
    say(problem);
    return;
  }

  var button = document.getElementById("lbPresetSave");
  if (button) button.disabled = true;

  updateLiveBoardPresets(function (current) {
    if (presetId && !current.some(function (preset) { return preset.id === presetId; })) throw new Error("That preset was deleted in the meantime.");
    var again = liveBoardPresetProblem(current, presetId, name, stationIds);
    if (again) throw new Error(again);
    if (presetId) {
      return current.map(function (preset) {
        return preset.id === presetId ? { id: presetId, name: name, stations: stationIds } : preset;
      });
    }
    return current.concat([{ id: newLiveBoardPresetId(current), name: name, stations: stationIds }]);
  }).then(function () {
    closeFormModal();
    sayDone(presetId ? "Preset saved." : "Preset added.");
  }).catch(function (error) {
    if (button) button.disabled = false;
    say("Could not save the preset: " + error.message);
  });
}

function confirmDeleteLiveBoardPreset(presetId) {
  if (!isFullAdmin()) return;
  var preset = tvPresetOf(presetId);
  if (!preset) return;

  showConfirmModal({
    title: "Delete preset?",
    message: "\"" + preset.name + "\" will be removed. A TV showing it will ask for another preset.",
    confirmLabel: "Delete",
    tone: "danger",
    onConfirm: function () {
      return updateLiveBoardPresets(function (current) {
        return current.filter(function (item) { return item.id !== presetId; });
      }).then(function () {
        sayDone("Preset deleted.");
      }).catch(function (error) {
        say("Could not delete the preset: " + error.message);
      });
    }
  });
}

function openTvBoard(presetId) {
  var url = window.location.pathname + window.location.search + "#/tv" + (presetId ? "/" + encodeURIComponent(presetId) : "");
  var opened = window.open(url, "qficient-live-board");
  // A blocked pop-up (or a TV browser without windows) just shows the board here.
  if (!opened) {
    tvPresetId = presetId || "";
    window.location.hash = "#/tv" + (presetId ? "/" + encodeURIComponent(presetId) : "");
  }
}

/* ---------- The board ---------- */

function tvClockText() {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());
  } catch (e) {
    return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

// "9:41 AM" with the colon in its own span, so it can blink like a digital clock (css/tvboard.css). Redrawn only
// when the minute changes, so the blink keeps its rhythm.
function tickTvClock() {
  var el = document.getElementById("tvClock");
  if (!el) return;
  var text = tvClockText();
  if (el.getAttribute("data-time") === text) return;
  el.setAttribute("data-time", text);
  var colon = text.indexOf(":");
  el.innerHTML = colon === -1 ? escapeHtml(text) :
    escapeHtml(text.slice(0, colon)) + '<span class="tv-colon">:</span>' + escapeHtml(text.slice(colon + 1));
}

function tvRowHtml(ticket, position) {
  return '<b>' + escapeHtml(ticket.ticketNo) + '</b><i>→</i><b>' + position + '</b>';
}

// "Now Serving": one big number, or at a station with several windows, each window and its number.
function tvNowHtml(station) {
  var count = stationWindows(station);
  if (count < 2) {
    var serving = latestServingOf(station);
    return '<b>' + escapeHtml(serving ? serving.ticketNo : "—") + '</b>';
  }
  var rows = [];
  for (var w = 1; w <= count; w++) {
    var atWindow = servingTicketAt(station, w);
    rows.push('<li><span>Window ' + w + '</span><b>' + escapeHtml(atWindow ? atWindow.ticketNo : "—") + '</b></li>');
  }
  return '<ul class="tv-now-windows">' + rows.join("") + '</ul>';
}

function tvColumnHtml(station) {
  var line = waitingTicketsOf(station.id);
  var next = line[0];
  // Each window past the second takes a row's worth of space in "Now Serving", so fewer waiting rows fit.
  var rows = Math.max(1, TV_WAITING_ROWS - Math.max(0, stationWindows(station) - 2));
  var waiting = line.slice(1, 1 + rows);
  var more = line.length - 1 - waiting.length;

  return '<section class="tv-col">' +
    '<div class="tv-col-tab">' + escapeHtml(station.name) + '</div>' +
    '<div class="tv-col-body">' +
      '<div class="tv-now' + (stationWindows(station) > 1 ? ' has-windows' : '') + '" data-station="' + escapeHtml(station.id) + '"><span>Now Serving</span>' + tvNowHtml(station) + '</div>' +
      '<p class="tv-label">Next in Line</p>' +
      (next ? '<div class="tv-row tv-next">' + tvRowHtml(next, 1) + '</div>' : '<p class="tv-none">No one is waiting.</p>') +
      (waiting.length ?
        '<p class="tv-label">Waiting</p>' +
        '<ul class="tv-wait">' + waiting.map(function (ticket, i) {
          return '<li class="tv-row">' + tvRowHtml(ticket, i + 2) + '</li>';
        }).join("") + '</ul>' : '') +
      (more > 0 ? '<p class="tv-more">+' + more + ' more waiting</p>' : '') +
    '</div>' +
  '</section>';
}

// A disabled station keeps its column, so the board doesn't shift around.
function tvClosedColumnHtml(station) {
  return '<section class="tv-col is-closed">' +
    '<div class="tv-col-tab">' + escapeHtml(station.name) + '</div>' +
    '<div class="tv-col-body"><p class="tv-closed">Closed right now</p></div>' +
  '</section>';
}

// Shown when the board has no preset (or its preset was deleted): one big button per preset.
function tvPickerHtml() {
  if (!liveBoardPresets.length) {
    return '<div class="tv-pick"><h2>No Live Board presets yet</h2>' +
      '<p>An admin can add them on the Live Board page of the admin console.</p></div>';
  }
  return '<div class="tv-pick">' +
    '<h2>Choose a preset</h2>' +
    '<p>' + (tvPresetId ? 'That preset no longer exists. ' : '') + 'Pick which stations this screen shows.</p>' +
    '<div class="tv-pick-list">' + liveBoardPresets.map(function (preset) {
      return '<button type="button" class="tv-pick-btn" onclick="selectTvPreset(\'' + escapeHtml(preset.id) + '\')">' +
        '<b>' + escapeHtml(preset.name) + '</b>' +
        '<span>' + escapeHtml(tvPresetStationNames(preset).join(" · ")) + '</span>' +
      '</button>';
    }).join("") + '</div>' +
  '</div>';
}

function renderTvHeader(preset) {
  var name = document.getElementById("tvPresetName");
  if (name) {
    name.textContent = preset ? preset.name : "";
    name.hidden = !preset;
  }
  var change = document.getElementById("tvChangeBtn");
  if (change) change.hidden = !preset || liveBoardPresets.length < 2;
}

function renderTvBoard() {
  var board = document.getElementById("tvBoard");
  var page = document.getElementById("pageTvBoard");
  if (!board || !page || !page.classList.contains("show")) return;

  tickTvClock();

  var preset = tvPresetOf(tvPresetId);
  renderTvHeader(preset);

  // A different preset (or the same one with other stations): what is already being served is not news.
  var key = preset ? preset.id + ":" + preset.stations.join(",") : "";
  if (key !== tvShownKey) {
    tvShownKey = key;
    tvLastServing = {};
    resetTvAnnouncements();
  }

  if (!preset) {
    board.removeAttribute("data-columns");
    board.style.gridTemplateColumns = "";
    var picker = tvPickerHtml();
    if (board.getAttribute("data-html") !== picker) {   // not redrawn on every ticket change, so a tap isn't lost
      board.setAttribute("data-html", picker);
      board.innerHTML = picker;
    }
    return;
  }
  board.removeAttribute("data-html");

  var shown = preset.stations.map(tvStationById).filter(Boolean);
  var open = shown.filter(function (station) { return station.active !== false; });
  checkTvAnnouncements(open);

  if (!shown.length) {
    board.removeAttribute("data-columns");
    board.style.gridTemplateColumns = "";
    board.innerHTML = '<p class="tv-empty">This preset\'s stations no longer exist. Ask an admin to edit it.</p>';
    return;
  }

  board.setAttribute("data-columns", String(shown.length));
  board.style.gridTemplateColumns = "repeat(" + shown.length + ", minmax(0, 1fr))";
  board.innerHTML = shown.map(function (station) {
    return station.active === false ? tvClosedColumnHtml(station) : tvColumnHtml(station);
  }).join("");

  // Flash a station's "Now Serving" when it calls a new number.
  open.forEach(function (station) {
    // Every window's number, so a call at any window flashes the box.
    var number = servingTicketsOf(station).map(function (t) { return t.ticketNo; }).join(",");
    if (tvLastServing[station.id] !== undefined && tvLastServing[station.id] !== number && number) {
      var box = board.querySelector('[data-station="' + station.id.replace(/"/g, "") + '"]');
      if (box) box.classList.add("tv-flash");
    }
    tvLastServing[station.id] = number;
  });
}

function selectTvPreset(presetId) {
  if (!tvPresetOf(presetId)) return;
  tvPresetId = presetId;
  renderTvBoard();
  if (typeof syncRoute === "function") syncRoute(false);
}

// Back to the preset picker.
function changeTvPreset() {
  tvPresetId = "";
  renderTvBoard();
  if (typeof syncRoute === "function") syncRoute(false);
}

function markTvActive() {
  var page = document.getElementById("pageTvBoard");
  if (!page) return;
  page.classList.remove("tv-idle");
  clearTimeout(tvIdleTimer);
  tvIdleTimer = setTimeout(function () { page.classList.add("tv-idle"); }, TV_IDLE_MS);
}

function toggleTvFullscreen() {
  var page = document.getElementById("pageTvBoard");
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(function () {});
  } else if (page && page.requestFullscreen) {
    page.requestFullscreen().catch(function () {
      say("This browser did not allow full screen. Use the TV browser's own full-screen option.");
    });
  }
}

// goTo() calls these when the board is shown or left.
function startTvBoard() {
  tvShownKey = null;
  tvLastServing = {};
  resetTvAnnouncements();
  renderTvSoundButton();
  renderTvBoard();
  markTvActive();
  if (!tvClockTimer) tvClockTimer = setInterval(tickTvClock, 1000);
}

function stopTvBoard() {
  if (tvClockTimer) {
    clearInterval(tvClockTimer);
    tvClockTimer = null;
  }
  clearTimeout(tvIdleTimer);
  resetTvAnnouncements();
}

document.addEventListener("mousemove", function () {
  if (document.body.getAttribute("data-page") === "pageTvBoard") markTvActive();
});
