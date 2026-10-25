// "freshman" (Incoming Freshman) is only given by the Queue Enforcer's walk-in form; students pick Regular or
// Transferee / Irregular for themselves.
var STUDENT_TYPE_LABELS = {
  regular: "Regular",
  transferee: "Transferee / Irregular",
  freshman: "Incoming Freshman",
  guest: "Guest"
};

var STUDENT_TYPE_SHORT_LABELS = {
  regular: "Regular",
  transferee: "Transferee",
  freshman: "Freshman",
  guest: "Guest"
};

function closeStudentTypeModal() {
  var overlay = document.getElementById("studentTypeModal");
  if (overlay) overlay.remove();
}

function selectStudentType(type) {
  db.collection("students").doc(user.id).set({
    studentType: type,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true })
    .then(function () {
      user.studentType = type;
      closeStudentTypeModal();
      updateDashboard();
      sayDone("Student type set to " + STUDENT_TYPE_LABELS[type] + ".");
    })
    .catch(function (err) {
      say("Could not save student type: " + err.message);
    });
}

function promptStudentType(isFirstTime) {
  closeStudentTypeModal();

  var overlay = document.createElement("div");
  overlay.className = "app-modal-backdrop";
  overlay.id = "studentTypeModal";
  overlay.innerHTML =
    '<div class="app-modal-sheet">' +
      '<p class="app-modal-title">' + (isFirstTime ? "Welcome! What's your student type?" : "Update Student Type") + '</p>' +
      '<p class="app-modal-sub">' + (isFirstTime ? "This helps front-desk staff serve you correctly. You can change this anytime." : "You can change this anytime from your dashboard.") + '</p>' +
      '<button type="button" class="role-card" onclick="selectStudentType(\'regular\')">' +
        '<span class="role-icon role-icon-student">🎓</span>' +
        '<span class="role-copy"><span class="role-title">Regular</span><span class="role-desc">Standard enrollment, on-track curriculum.</span></span>' +
      '</button>' +
      '<button type="button" class="role-card" onclick="selectStudentType(\'transferee\')">' +
        '<span class="role-icon role-icon-guest">🔀</span>' +
        '<span class="role-copy"><span class="role-title">Transferee / Irregular</span><span class="role-desc">Transferred or non-standard course load.</span></span>' +
      '</button>' +
      (isFirstTime ? '' : '<button type="button" class="app-btn app-btn-outline" onclick="closeStudentTypeModal()">Cancel</button>') +
    '</div>';

  var host = document.getElementById("pageDashboard") || document.body;
  host.appendChild(overlay);
}

// What the student has already been told about their current ticket. The first time a ticket is seen, any
// recall or last call it already has is only recorded, so an old one doesn't pop up again after a refresh;
// a message shows only for a change after that, or for one that happened moments ago.
var FRESH_ALERT_MS = 30 * 1000;
var alertBaseline = { ticketId: null, recallMs: 0, lastCallMs: 0 };

function checkTicketAlerts(ticket) {
  var recallMs = timestampToMs(ticket.recalledAt, 0);
  var lastCallMs = timestampToMs(ticket.lastCallAt, 0);
  var firstSight = alertBaseline.ticketId !== ticket.id;
  var now = serverNow();

  if (firstSight) alertBaseline = { ticketId: ticket.id, recallMs: 0, lastCallMs: 0 };

  if (recallMs && recallMs !== alertBaseline.recallMs && (!firstSight || now - recallMs < FRESH_ALERT_MS)) notifyRecall();
  if (lastCallMs && lastCallMs !== alertBaseline.lastCallMs && (!firstSight || now - lastCallMs < FRESH_ALERT_MS)) notifyLastCall();

  alertBaseline.recallMs = recallMs;
  alertBaseline.lastCallMs = lastCallMs;
}

var skipCountdownIntervalId = null;

var TOAST_COLORS = { alert: "#E5484D", info: "#0054A6", good: "#1F9D55" };

function showStudentToast(text, tone) {
  if (typeof Toastify === "undefined") return;
  Toastify({
    text: text,
    duration: 9000,
    gravity: "top",
    position: "center",
    close: true,
    style: { background: TOAST_COLORS[tone] || TOAST_COLORS.alert }
  }).showToast();
}

function notifyRecall() {
  studentAlert("⏰ Please go to the counter. You're being called.", "alert", true, true);
}

function notifyLastCall() {
  studentAlert("🚨 Last call! Return to the counter within " + formatVoidWindow() + " or your ticket will be voided.", "alert", true, true);
}

function ticketCountdownText(phase, remainingMs) {
  if (phase === "final") {
    return remainingMs > 0 ?
      "🚨 Last call! Return to the counter within " + formatCountdown(remainingMs) + " or your ticket will be voided." :
      "⌛ Your ticket has expired. It will be removed from the queue shortly.";
  }
  return "⚠️ Please return to the counter. " + formatCountdown(remainingMs) + " left.";
}

function tickTicketCountdown() {
  var el = document.getElementById("ticketCountdownText");
  if (!el) return;

  var phase = el.getAttribute("data-phase");
  var remaining = AUTO_VOID_WINDOW_MS - (serverNow() - Number(el.getAttribute("data-base-ms")));

  if (phase === "initial" && remaining <= 0) {
    clearInterval(skipCountdownIntervalId);
    skipCountdownIntervalId = null;
    updateDashboard();
    return;
  }
  el.textContent = ticketCountdownText(phase, remaining);
}

function ensureSkipCountdownWatcher(needsTimer) {
  if (needsTimer && !skipCountdownIntervalId) {
    skipCountdownIntervalId = setInterval(tickTicketCountdown, 1000);
  } else if (!needsTimer && skipCountdownIntervalId) {
    clearInterval(skipCountdownIntervalId);
    skipCountdownIntervalId = null;
  }
}

var joinCooldownIntervalId = null;

function tickJoinCooldown() {
  var el = document.getElementById("joinCooldownText");
  if (!el) return;

  var remaining = getCancelCooldownRemaining();
  if (remaining <= 0) {
    clearInterval(joinCooldownIntervalId);
    joinCooldownIntervalId = null;
    updateDashboard();
    return;
  }
  el.textContent = "You can join again in " + formatCountdown(remaining);
}

function ensureJoinCooldownWatcher(active) {
  if (active && !joinCooldownIntervalId) {
    joinCooldownIntervalId = setInterval(tickJoinCooldown, 1000);
  } else if (!active && joinCooldownIntervalId) {
    clearInterval(joinCooldownIntervalId);
    joinCooldownIntervalId = null;
  }
}

var JOIN_OTHER_PURPOSE = "__other__";

var dashView = "stations";
var dashStationId = "";
var dashHadTicket = false;
var dashBrowsing = false; // looking at the station list while holding a ticket
var joinDraft = { stationId: "", purpose: "", other: "" };
var lastStationsHtml = null;
var lastJoinCardKey = null;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Microsoft gives names as "Dela Cruz, John Aris (STI Malolos)"; show them as "John Aris Dela Cruz".
function friendlyName(name) {
  var cleaned = String(name || "").replace(/\s*\([^)]*\)?\s*$/, "").trim();
  var comma = cleaned.indexOf(",");
  if (comma > 0 && comma < cleaned.length - 1) {
    cleaned = (cleaned.slice(comma + 1).trim() + " " + cleaned.slice(0, comma).trim()).trim();
  }
  return cleaned.replace(/\s+/g, " ");
}

function getInitials(name) {
  var trimmed = friendlyName(name);
  if (!trimmed) return "?";
  var parts = trimmed.split(/\s+/);
  var initials = parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "");
  return initials.toUpperCase();
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function ordinalLabel(n) {
  var rest = n % 100;
  var suffix = "TH";
  if (rest < 11 || rest > 13) suffix = ({ 1: "ST", 2: "ND", 3: "RD" })[n % 10] || "TH";
  return n + suffix;
}

function joinPurposesFor(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && Array.isArray(station.purposes) && station.purposes.length ? station.purposes : queueMgmtPurposes;
}

// A station's waiting line, in queue order.
function waitingTicketsOf(stationId) {
  return tickets.filter(function (item) {
    return item.stationId === stationId && item.status === "waiting" && isTodayTicket(item);
  }).sort(compareQueueOrder);
}

/* ---------- Account menu ---------- */

function closeUserMenu() {
  var menu = document.getElementById("udUserMenu");
  var button = document.getElementById("udUserButton");
  if (menu) menu.hidden = true;
  if (button) button.setAttribute("aria-expanded", "false");
}

function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  var menu = document.getElementById("udUserMenu");
  var button = document.getElementById("udUserButton");
  if (!menu) return;

  menu.hidden = !menu.hidden;
  if (button) button.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
}

function enableAlertsFromMenu() {
  closeUserMenu();
  enableNotifications();
}

// Plays the long "go to the counter" buzz once, so a student (or staff checking a phone) can tell whether this
// phone vibrates for QFicient at all. iPhones and some browsers can't vibrate from a website.
function testVibrationFromMenu() {
  closeUserMenu();
  var played = !!navigator.vibrate && navigator.vibrate(VIBRATE_URGENT);
  if (played) {
    showStudentToast("📳 Testing vibration: you should feel a long buzz of about 3 seconds.", "info");
  } else {
    sayProblem("This phone can't vibrate for QFicient",
      "This browser doesn't let websites vibrate the phone (iPhones never do). You'll still get the sound and the on-screen alert, and notifications follow the phone's own settings.",
      "info");
  }
}

function changeStudentTypeFromMenu() {
  closeUserMenu();
  promptStudentType(false);
}

function toggleThemeFromMenu() {
  closeUserMenu();
  toggleTheme();
  renderHeader();
}

function logoutFromMenu() {
  closeUserMenu();

  // A walk-in with a live ticket has its own warning (their ticket is cancelled when they leave).
  if (user && user.type === "walkin" && myTicket()) {
    studentLogout();
    return;
  }

  var hasTicket = !!(user && myTicket());
  showConfirmModal({
    title: "Are you sure you want to log out?",
    message: hasTicket ?
      "Your ticket stays in the queue, but this device stops getting alerts for it until you sign back in." :
      "You'll be signed out of QFicient on this device.",
    confirmLabel: "Log Out",
    tone: "danger",
    onConfirm: function () { studentLogout(); }
  });
}

document.addEventListener("click", function (event) {
  if (!event.target.closest || !event.target.closest(".ud-user-wrap")) closeUserMenu();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeUserMenu();
});

/* ---------- Navigation inside the dashboard ---------- */

var DASHBOARD_TABS = {
  queue: { panel: "dashboardTabQueue", button: "tabBtnQueue" },
  board: { panel: "dashboardTabBoard", button: "tabBtnBoard" },
  notifications: { panel: "dashboardTabNotifications", button: "udNotifBell" }  // opened from the header bell
};

function currentDashboardTab() {
  var names = Object.keys(DASHBOARD_TABS);
  for (var i = 0; i < names.length; i++) {
    var panel = document.getElementById(DASHBOARD_TABS[names[i]].panel);
    if (panel && !panel.hidden) return names[i];
  }
  return "queue";
}

function setDashboardTab(tab) {
  if (!DASHBOARD_TABS[tab]) tab = "queue";

  Object.keys(DASHBOARD_TABS).forEach(function (name) {
    var panel = document.getElementById(DASHBOARD_TABS[name].panel);
    var btn = document.getElementById(DASHBOARD_TABS[name].button);
    if (panel) panel.hidden = name !== tab;
    if (btn) btn.classList.toggle("active", name === tab);
  });

  if (tab === "notifications") renderUserNotifications();

  syncRoute(false);
  updateDashboard();
}

function viewMyTicket() {
  var mine = myTicket();
  dashBrowsing = false;
  if (mine) {
    dashView = "station";
    dashStationId = mine.stationId;
  }
  syncRoute(false);
  updateDashboard();
  window.scrollTo(0, 0);
}

function openStation(stationId) {
  if (!user || myTicket()) return;

  var cooldownMs = getCancelCooldownRemaining();
  if (cooldownMs > 0) {
    say("Please wait " + formatCountdown(cooldownMs) + " before joining again.");
    return;
  }

  dashStationId = stationId;
  dashView = "station";

  if (joinDraft.stationId !== stationId) {
    joinDraft = { stationId: stationId, purpose: "", other: "" };
  }
  lastJoinCardKey = null;
  syncRoute(false);
  updateDashboard();
  window.scrollTo(0, 0);
}

// The Enrollment card opens this screen (dashStationId = ENROLLMENT_VIEW) to start an enrollment.
var ENROLLMENT_VIEW = "enrollment";

function openEnrollment() {
  if (!user || myTicket()) return;

  if (user.type !== "student") {
    say("Enrollment is for students. Please sign in with your school account.");
    return;
  }
  if (!user.studentType) {
    promptStudentType(false);
    return;
  }

  var cooldownMs = getCancelCooldownRemaining();
  if (cooldownMs > 0) {
    say("Please wait " + formatCountdown(cooldownMs) + " before joining again.");
    return;
  }

  dashStationId = ENROLLMENT_VIEW;
  dashView = "station";
  lastJoinCardKey = null;
  syncRoute(false);
  updateDashboard();
  window.scrollTo(0, 0);
}

function startEnrollment() {
  var button = document.querySelector("#udJoinCard .ud-generate");
  var pending = joinEnrollment();
  if (pending) {
    setButtonLoading(button, true);
    pending.then(function (created) {
      setButtonLoading(button, false);
      if (created) offerBackgroundAlerts();
    });
  }
}

function backToStations() {
  if (user && user.type === "walkin") return viewMyTicket(); // a walk-in only follows their own ticket
  dashBrowsing = !!(user && myTicket());
  dashView = "stations";
  dashStationId = "";
  syncRoute(false);
  updateDashboard();
  window.scrollTo(0, 0);
}

/* ---------- Joining ---------- */

function onPurposeChange(value) {
  joinDraft.purpose = value;
  var other = document.getElementById("udPurposeOther");
  if (other) {
    other.hidden = value !== JOIN_OTHER_PURPOSE;
    if (value === JOIN_OTHER_PURPOSE) other.focus();
  }
}

function onPurposeOtherInput(value) {
  joinDraft.other = value;
}

function generateTicket() {
  if (!dashStationId) return;

  if (!joinDraft.purpose) {
    say("Please select your purpose before generating a ticket.");
    return;
  }

  var purpose = joinDraft.purpose === JOIN_OTHER_PURPOSE ? joinDraft.other.trim().replace(/\s+/g, " ") : joinDraft.purpose;
  if (!/[\p{L}\p{N}]/u.test(purpose)) {
    say("Please specify your purpose.");
    return;
  }

  var button = document.querySelector("#udJoinCard .ud-generate");
  var pending = joinQueue(dashStationId, purpose);
  if (pending) {
    setButtonLoading(button, true);
    pending.then(function (created) {
      setButtonLoading(button, false);
      if (created) offerBackgroundAlerts();
    });
  }
}

function confirmCancelTicket() {
  var ticket = myTicket();
  if (!ticket) return;

  showConfirmModal({
    title: "Are you sure you want to cancel your queue?",
    message: "Ticket " + ticket.ticketNo + " will leave the line. You'll have to wait a moment before you can join again.",
    confirmLabel: "Cancel Queue",
    tone: "danger",
    onConfirm: function () { return cancelTicket(); }
  });
}

/* ---------- Rendering ---------- */

var STATION_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>';

/* ---------- Live board ---------- */

var BOARD_PAGE_SIZE = 5;
var boardStationId = "";
var boardPage = 0;
var boardShellKey = null;

var BOARD_ARROW_SVG =
  '<svg viewBox="0 0 40 16" width="34" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 8h37M31 1l7 7-7 7"/></svg>';

function boardStations() {
  return stations.filter(function (station) { return station.active !== false; });
}

function boardNowText() {
  try {
    var now = new Date();
    var date = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "short", day: "numeric", month: "long" }).format(now);
    var time = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true }).format(now);
    return date + " " + time.toLowerCase();
  } catch (e) {
    return "";
  }
}

function setBoardStation(value) {
  boardStationId = value;
  boardPage = 0;
  renderLiveBoard();
}

function pageBoard(step) {
  boardPage += step;
  renderLiveBoard();
}

function boardStat(label, value, extraClass) {
  return '<div class="ud-stat' + (extraClass ? ' ' + extraClass : '') + '"><span>' + label + '</span><b>' + escapeHtml(value) + '</b></div>';
}

function renderLiveBoard() {
  var area = document.getElementById("boardArea");
  if (!area) return;

  var open = boardStations();
  var mine = user ? myTicket() : null;

  if (!open.some(function (station) { return station.id === boardStationId; })) {
    var preferred = mine && open.some(function (station) { return station.id === mine.stationId; }) ? mine.stationId : "";
    boardStationId = preferred || (open[0] ? open[0].id : "");
    boardPage = 0;
  }

  var boardChoices = open.map(function (station) { return { value: station.id, label: station.name }; });

  // The header (with the station dropdown) is built once so a live update never closes an open dropdown.
  var shellKey = boardChoices.map(function (c) { return c.value + ":" + c.label; }).join("|");
  if (!document.getElementById("udBoardBody") || shellKey !== boardShellKey) {
    boardShellKey = shellKey;
    area.innerHTML =
      '<div class="ud-board-head">' +
        '<div>' +
          '<h2 class="ud-greeting" id="udGreeting"></h2>' +
          '<p class="ud-greeting-sub">Let\'s get you in line.</p>' +
        '</div>' +
        (open.length ?
          '<div class="ud-station-select"><select id="udBoardStation" aria-label="Station" onchange="setBoardStation(this.value)">' +
            boardChoices.map(function (c) { return '<option value="' + escapeHtml(c.value) + '">' + escapeHtml(c.label) + '</option>'; }).join("") +
          '</select></div>' : '') +
      '</div>' +
      '<div id="udBoardBody"></div>';
  }

  var select = document.getElementById("udBoardStation");
  if (select && select.value !== boardStationId) select.value = boardStationId;

  var firstName = user && user.name ? friendlyName(user.name).split(" ")[0] : "";
  setText("udGreeting", "Good Day, " + (firstName || "User"));

  var body = document.getElementById("udBoardBody");
  var station = open.find(function (s) { return s.id === boardStationId; });
  if (!station) {
    body.innerHTML = '<p class="empty-hint">No stations are open right now.</p>';
    return;
  }

  var serving = servingTicketOf(station);
  var line = waitingTicketsOf(station.id);
  var served = tickets.filter(function (item) {
    return item.stationId === station.id && item.status === "completed" && isTodayTicket(item);
  }).length;

  var pages = Math.max(1, Math.ceil(line.length / BOARD_PAGE_SIZE));
  boardPage = Math.min(Math.max(boardPage, 0), pages - 1);
  var from = boardPage * BOARD_PAGE_SIZE;

  var rowsHtml = line.slice(from, from + BOARD_PAGE_SIZE).map(function (item, i) {
    var isMine = !!mine && item.id === mine.id;
    return '<div class="ud-q-row' + (isMine ? ' is-mine' : '') + '">' +
      '<span class="ud-q-ticket">' + escapeHtml(item.ticketNo) + (isMine ? '<em>You</em>' : '') + '</span>' +
      '<span class="ud-q-arrow">' + BOARD_ARROW_SVG + '</span>' +
      '<span class="ud-q-no">' + (from + i + 1) + '</span>' +
    '</div>';
  }).join("");

  body.innerHTML =
    '<div class="ud-stats">' +
      '<div class="ud-stat ud-stat-queue">' +
        '<div class="ud-now"><span><i class="ud-lbl-long">Currently</i><i class="ud-lbl-short">Now</i> Serving</span><b>' + escapeHtml(serving ? serving.ticketNo : "—") + '</b></div>' +
        '<div class="ud-next"><span>Next in Line</span><b>' + escapeHtml(line[0] ? line[0].ticketNo : "—") + '</b></div>' +
        '<div class="ud-next ud-third"><span>Waiting</span><b>' + escapeHtml(line[1] ? line[1].ticketNo : "—") + '</b></div>' +
      '</div>' +
      boardStat("Total Waiting", String(line.length)) +
      boardStat("Served Today", String(served)) +
    '</div>' +
    '<div class="ud-q-top"><h3>Queues</h3><span class="ud-q-date"><i class="live-dot-pulse"></i>' + escapeHtml(boardNowText()) + '</span></div>' +
    '<div class="ud-q-table">' +
      '<div class="ud-q-th"><span>Ticket No.</span><span>Queue No.</span></div>' +
      (rowsHtml || '<p class="ud-q-empty">No one is waiting at this station.</p>') +
    '</div>' +
    (pages > 1 ?
      '<div class="ud-pager">' +
        '<button type="button" onclick="pageBoard(-1)" aria-label="Previous page"' + (boardPage === 0 ? ' disabled' : '') + '>‹</button>' +
        '<span>' + (boardPage + 1) + ' / ' + pages + '</span>' +
        '<button type="button" onclick="pageBoard(1)" aria-label="Next page"' + (boardPage >= pages - 1 ? ' disabled' : '') + '>›</button>' +
      '</div>' : '');
}

function renderHeader() {
  var name = user ? friendlyName(user.name) : "";
  var meta = user ? (user.studentNumber || (user.type === "walkin" ? "Walk-in" : "")) : "";
  var typeLabel = user && user.type === "student" ? (STUDENT_TYPE_LABELS[user.studentType] || "") : "";

  setText("dashAvatar", user ? getInitials(user.name) : "?");
  setText("welcomeText", name);
  setText("welcomeStudentNo", meta);
  setText("udMenuName", name);
  setText("udMenuMeta", meta);

  var typeBtn = document.getElementById("udMenuType");
  if (typeBtn) {
    typeBtn.hidden = !(user && user.type === "student");
    typeBtn.textContent = "Student type: " + (typeLabel || "Not set");
  }

  var themeBtn = document.getElementById("udMenuTheme");
  if (themeBtn) themeBtn.textContent = document.body.classList.contains("dark") ? "Light mode" : "Dark mode";

  var logoutBtn = document.getElementById("udMenuLogout");
  if (logoutBtn) logoutBtn.textContent = user && user.type === "walkin" ? "End visit" : "Log out";
}

// The wide Enrollment card above the stations: how many are enrolling and the latest enrollment number called.
function enrollmentCardHtml(cooldownMs, ticket) {
  if (!user || user.type !== "student" || !enrollmentStationIds().length) return "";

  var today = tickets.filter(function (t) { return t.enrollment === true && isTodayTicket(t); });
  var enrolling = today.filter(function (t) { return ACTIVE_TICKET_STATUSES.indexOf(t.status) !== -1; }).length;
  var latest = today.filter(function (t) { return t.status === "serving"; })
    .sort(function (a, b) { return timestampToMs(b.servingAt, 0) - timestampToMs(a.servingAt, 0); })[0];

  var typeReady = !!user.studentType && enrollmentFlowFor(user.studentType).length > 0;
  var note = !user.studentType ? "Set your student type to start." :
    !typeReady ? "Not open for " + (STUDENT_TYPE_LABELS[user.studentType] || "your") + " students yet." : "";

  return '<div class="ud-enroll-card">' +
      '<div class="ud-station-icon">' + STATION_ICON_SVG + '</div>' +
      '<div class="ud-enroll-copy">' +
        '<h3>Enrollment</h3>' +
        '<p class="ud-joined">' + enrolling + (enrolling === 1 ? ' person' : ' people') + ' joined</p>' +
        '<p class="ud-serving">Now serving ' + escapeHtml(latest ? latest.ticketNo : "—") + '</p>' +
        (note ? '<p class="ud-enroll-note">' + escapeHtml(note) + '</p>' : '') +
      '</div>' +
      '<button type="button" class="ud-join" onclick="openEnrollment()"' + (cooldownMs > 0 || ticket || (user.studentType && !typeReady) ? ' disabled' : '') + '>Queue</button>' +
    '</div>';
}

function renderStationCards(cooldownMs, ticket) {
  var host = document.getElementById("udStations");
  if (!host) return;

  var cards = "";
  stations.forEach(function (station) {
    if (station.active === false) return;
    var servingTicket = servingTicketOf(station);

    cards +=
      '<div class="ud-station-card">' +
        '<div class="ud-station-top"></div>' +
        '<div class="ud-station-icon">' + STATION_ICON_SVG + '</div>' +
        '<h3>' + escapeHtml(station.name) + '</h3>' +
        '<div class="ud-station-foot">' +
          '<div>' +
            '<p class="ud-joined">' + waitingTicketsOf(station.id).length + ' waiting</p>' +
            '<p class="ud-serving">Now serving ' + escapeHtml(servingTicket ? servingTicket.ticketNo : "—") + '</p>' +
          '</div>' +
          '<button type="button" class="ud-join" onclick="openStation(\'' + escapeHtml(station.id) + '\')"' + (cooldownMs > 0 || ticket ? ' disabled' : '') + '>Queue</button>' +
        '</div>' +
      '</div>';
  });

  var html = "";
  if (ticket) {
    html += '<p class="ud-banner">You are already in line (' + escapeHtml(ticket.ticketNo) + '). <button type="button" class="ud-link" onclick="viewMyTicket()">View ticket</button></p>';
  }
  if (cooldownMs > 0) {
    html += '<p class="ud-banner">⏳ Please wait before joining again. <span id="joinCooldownText">You can join again in ' + formatCountdown(cooldownMs) + '</span></p>';
  }
  html += enrollmentCardHtml(cooldownMs, ticket);
  html += cards ?
    '<div class="ud-stations-grid">' + cards + '</div>' :
    '<p class="empty-hint">No stations are open right now.</p>';

  if (html !== lastStationsHtml) {
    host.innerHTML = html;
    lastStationsHtml = html;
  }
}

// Built once per situation and then left alone, so a live update elsewhere in the queue never resets the
// dropdown or steals focus while the student is choosing a purpose.
function renderJoinCard(station, ticket) {
  var card = document.getElementById("udJoinCard");
  if (!card) return;

  var purposes = joinPurposesFor(station.id);
  var key = [station.id, station.name, ticket ? "ticket" : "free", purposes.join("|")].join("::");
  if (key === lastJoinCardKey && card.innerHTML) return;
  lastJoinCardKey = key;

  var locked = !!ticket;
  var current = joinDraft.purpose;
  var otherValue = joinDraft.other;
  if (locked) {
    current = purposes.indexOf(ticket.purpose) !== -1 ? ticket.purpose : JOIN_OTHER_PURPOSE;
    otherValue = current === JOIN_OTHER_PURPOSE ? ticket.purpose : "";
  }

  var options = '<option value="">Select Purpose</option>' + purposes.map(function (purpose) {
    return '<option value="' + escapeHtml(purpose) + '"' + (purpose === current ? ' selected' : '') + '>' + escapeHtml(purpose) + '</option>';
  }).join("") + '<option value="' + JOIN_OTHER_PURPOSE + '"' + (current === JOIN_OTHER_PURPOSE ? ' selected' : '') + '>Others, please specify</option>';

  card.innerHTML =
    '<h2 class="ud-join-title">' + escapeHtml(station.name) + '</h2>' +
    '<p class="ud-join-text">Select your purpose and generate a ticket to join the queue.</p>' +
    '<div class="ud-join-row">' +
      '<select class="ud-select" id="udPurpose" aria-label="Purpose" onchange="onPurposeChange(this.value)"' + (locked ? ' disabled' : '') + '>' + options + '</select>' +
      '<button type="button" class="ud-generate" onclick="generateTicket()"' + (locked ? ' disabled' : '') + '>Generate Ticket</button>' +
    '</div>' +
    '<input type="text" class="ud-other" id="udPurposeOther" maxlength="100" placeholder="Please specify your purpose" aria-label="Specify your purpose" value="' + escapeHtml(otherValue) + '" oninput="onPurposeOtherInput(this.value)"' +
      (locked ? ' disabled' : '') + (current === JOIN_OTHER_PURPOSE ? '' : ' hidden') + '>';
}

// Start screen (no ticket yet) or step tracker (enrolling): Cashier ✓ → 2 Evaluation → 3 Assessment → Done.
function renderEnrollmentCard(ticket) {
  var card = document.getElementById("udJoinCard");
  if (!card) return;

  var flow = ticket ? ticketEnrollmentFlow(ticket) : enrollmentFlowFor(user.studentType);
  var current = ticket ? (Number(ticket.enrollmentStep) || 0) : -1;
  var names = flow.map(function (id) { return stationNameById(id) || "Removed station"; });
  var key = ["enroll", ticket ? ticket.id : "new", current, ticket ? ticket.status : "", names.join("|")].join("::");
  if (key === lastJoinCardKey && card.innerHTML) return;
  lastJoinCardKey = key;

  var steps = names.concat(["Done"]).map(function (name, i) {
    var state = i < current ? "is-done" : i === current ? "is-current" : "";
    return '<li class="ud-step ' + state + '"><span class="ud-step-dot">' + (i < current ? "✓" : (i + 1)) + '</span><span class="ud-step-name">' + escapeHtml(name) + '</span></li>';
  }).join("");

  card.innerHTML = ticket ?
    '<ol class="ud-steps" aria-label="Enrollment steps">' + steps + '</ol>' :
    '<h2 class="ud-join-title">Enrollment</h2>' +
    '<p class="ud-join-text">As a ' + escapeHtml(STUDENT_TYPE_LABELS[user.studentType] || "student") + ' student you go to these stations in order. Each one sends you on to the next.</p>' +
    '<ol class="ud-steps" aria-label="Enrollment steps">' + steps + '</ol>' +
    '<div class="ud-join-row">' +
      (flow.length ?
        '<button type="button" class="ud-generate ud-generate-wide" onclick="startEnrollment()">Start Enrollment</button>' :
        '<p class="ud-notice">Enrollment isn\'t open for your student type yet.</p>') +
    '</div>';
}

function renderTicketCard(ticket) {
  var ticketStation = stations.find(function (station) { return station.id === ticket.stationId; });
  var skip = ticket.status === "skipped" ? getSkipPhase(ticket) : null;
  ensureSkipCountdownWatcher(skip !== null && skip.phase !== "expired");

  var statusClass = "ud-status";
  var statusText = "Waiting";
  var alertHtml = "";
  if (ticket.status === "serving") {
    statusClass += " is-serving";
    statusText = "Now Serving";
  } else if (skip) {
    statusClass += " is-skipped";
    statusText = "On Hold";
    alertHtml = skip.phase === "expired" ?
      '<p class="ud-ticket-alert">⏳ Your time is up. Please go to the counter now. Staff may give you a last call.</p>' :
      '<p class="ud-ticket-alert" id="ticketCountdownText" data-phase="' + skip.phase + '" data-base-ms="' + skip.baseMs + '">' + escapeHtml(ticketCountdownText(skip.phase, skip.remainingMs)) + '</p>';
  }

  var enrolling = ticket.enrollment === true;
  var servingTicket = servingTicketOf(ticketStation);
  var place = waitingTicketsOf(ticket.stationId).findIndex(function (item) { return item.id === ticket.id; });

  var posBig;
  var posLabel;
  if (ticket.status === "serving") {
    posBig = "NOW";
    posLabel = "Your turn";
  } else if (skip) {
    posBig = "On Hold";
    posLabel = "Go to counter";
  } else {
    posBig = place === -1 ? "—" : ordinalLabel(place + 1);
    posLabel = "In line";
  }

  var typeLabel = STUDENT_TYPE_LABELS[ticket.studentType];

  var notice = document.getElementById("udNotice");
  if (notice) {
    notice.hidden = !!skip;
    notice.textContent = ticket.status === "serving" ?
      (enrolling ? "It's your turn! Your enrollment is now being processed at " + (ticketStation ? ticketStation.name : "the counter") + "." : "It's your turn. Please proceed to the counter.") :
      (enrolling ?
        "Please go to " + (ticketStation ? ticketStation.name : "the next station") + " and wait for your number." + (place >= 0 ? " You're " + ordinalWord(place + 1) + " in line." : "") :
        "Queue joined. We'll let you know when it's your turn.");
  }

  // The enrollment ticket follows its own design: "ENROLLMENT" over the number, a yellow "Now Serving" badge,
  // and no position boxes (the banner above says where they stand).
  if (enrolling && ticket.status === "serving") statusClass = "ud-status";

  document.getElementById("ticketArea").innerHTML =
    '<div class="ud-ticket' + (typeLabel ? ' ticket-type-' + ticket.studentType : '') + '">' +
      '<div class="ud-ticket-head">' +
        '<p class="ud-ticket-station">' + escapeHtml(enrolling ? "Enrollment" : (ticketStation ? ticketStation.name : "")) + '</p>' +
        '<p class="ud-ticket-no">' + escapeHtml(ticket.ticketNo) + '</p>' +
      '</div>' +
      alertHtml +
      '<div class="ud-ticket-who">' +
        '<div>' +
          '<p class="ud-ticket-name">' + escapeHtml(ticket.ownerName) + '</p>' +
          (ticket.studentNumber ? '<p class="ud-ticket-sub">' + escapeHtml(ticket.studentNumber) + '</p>' : '') +
        '</div>' +
        '<span class="' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="ud-ticket-details">' +
        '<div><span>Purpose</span><b>' + escapeHtml(ticket.purpose || "—") + '</b></div>' +
        (typeLabel ? '<div><span>Student Type</span><b>' + escapeHtml(typeLabel) + '</b></div>' : '') +
      '</div>' +
      (enrolling ? '' :
      '<div class="ud-ticket-pos">' +
        '<div class="ud-pos-box"><b>' + escapeHtml(posBig) + '</b><span>' + escapeHtml(posLabel) + '</span></div>' +
        '<div class="ud-pos-box"><b>' + escapeHtml(servingTicket ? servingTicket.ticketNo : "—") + '</b><span>Now serving</span></div>' +
      '</div>') +
    '</div>' +
    (ticket.status === "serving" ? '' : '<button type="button" class="ud-cancel" onclick="confirmCancelTicket()">Cancel Queue</button>');
}

function resetDashboardState() {
  dashView = "stations";
  dashStationId = "";
  dashHadTicket = false;
  dashBrowsing = false;
  joinDraft = { stationId: "", purpose: "", other: "" };
  lastStationsHtml = null;
  lastJoinCardKey = null;
  resetTicketWatch();
}

// Runs after every change; a screen change the app made by itself (a ticket ending, say) updates the
// address in place instead of adding a history entry.
function updateDashboard() {
  renderDashboard();
  if (shownPageId() === "pageDashboard") syncRoute(true);
}

function renderDashboard() {
  var ticket = user ? myTicket() : null;

  renderLiveBoard();
  renderHeader();
  refreshNotificationToggle();
  syncUserNotificationsListener();

  var hero = document.getElementById("udHero");
  var stationsHost = document.getElementById("udStations");
  var stationView = document.getElementById("udStationView");
  var back = document.getElementById("udBack");
  if (!hero || !stationsHost || !stationView) return;

  if (!user) {
    ensureSkipCountdownWatcher(false);
    ensureJoinCooldownWatcher(false);
    resetDashboardState();
    stationsHost.innerHTML = "";
    document.getElementById("ticketArea").innerHTML = "";
    return;
  }

  // Recall and last-call alerts fire wherever the student happens to be looking.
  if (ticket) {
    checkTicketAlerts(ticket);
    watchTicketEvents(ticket);
  } else if (user.type === "walkin") {
    // A walk-in's access lasts as long as their ticket (js/walkin.js); they never browse the stations.
    endWalkinVisitIfOver();
    hero.hidden = true;
    stationsHost.innerHTML = "";
    stationView.hidden = true;
    if (back) back.hidden = true;
    return;
  } else {
    ticketEnded();
  }

  // Someone with a live ticket (including after a refresh) lands on that station's page; once the ticket
  // ends they go back to the station list.
  if (!ticket) dashBrowsing = false;
  if (ticket && !dashBrowsing) {
    dashView = "station";
    dashStationId = ticket.stationId;
  } else if (ticket) {
    dashView = "stations";
    dashStationId = "";
  } else if (dashHadTicket) {
    dashView = "stations";
    dashStationId = "";
    joinDraft = { stationId: "", purpose: "", other: "" };
    lastJoinCardKey = null;
  }
  dashHadTicket = !!ticket;

  var station = stations.find(function (s) { return s.id === dashStationId; });
  var enrollmentView = dashStationId === ENROLLMENT_VIEW && !ticket && user.type === "student" && !!user.studentType;
  if (dashView === "station" && !station && !enrollmentView) {
    dashView = "stations";
    dashStationId = "";
  }

  var cooldownMs = ticket ? 0 : getCancelCooldownRemaining();
  ensureJoinCooldownWatcher(cooldownMs > 0);

  var inStation = dashView === "station";
  hero.hidden = inStation;
  stationsHost.hidden = inStation;
  stationView.hidden = !inStation;
  if (back) back.hidden = !inStation || currentDashboardTab() !== "queue" || user.type === "walkin";

  if (!inStation) {
    ensureSkipCountdownWatcher(false);
    renderStationCards(cooldownMs, ticket);
    return;
  }

  if (enrollmentView || (ticket && ticket.enrollment === true)) renderEnrollmentCard(ticket);
  else renderJoinCard(station, ticket);

  if (!ticket) {
    ensureSkipCountdownWatcher(false);
    var notice = document.getElementById("udNotice");
    if (notice) notice.hidden = true;
    document.getElementById("ticketArea").innerHTML = "";
    return;
  }

  renderTicketCard(ticket);
}
