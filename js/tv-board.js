// The TV Live Board (#/tv): a full-screen display of every open station's queue, meant for a smart TV in the
// waiting area. It needs a staff sign-in on that browser (any console role), because tickets are only readable
// when signed in. The admin console's "Live Board" page opens it in its own window.

var TV_MAIN_COLUMNS = 3;       // stations shown as full columns; the rest become compact cards
var TV_SIDE_PER_PAGE = 3;      // compact cards on screen at once; more than this take turns
var TV_SIDE_PAGE_MS = 10 * 1000;
var TV_WAITING_ROWS = 4;
var TV_IDLE_MS = 3 * 1000;

var tvClockTimer = null;
var tvSideTimer = null;
var tvIdleTimer = null;
var tvSidePage = 0;
var tvLastServing = {};

/* ---------- Admin console page ---------- */

function renderLiveBoardLauncher() {
  var area = document.getElementById("adminLiveBoardArea");
  if (!area) return;

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Live Board</div>' +
      '<div class="settings-header-user"><span>' + escapeAdminText(adminDisplayName()) + '</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>' +
    '<div class="lb-launch">' +
      '<p>Click to view the live queue status and see which numbers are currently being served.</p>' +
      '<button type="button" class="lb-launch-btn" onclick="openTvBoard()">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 8.5v6l5-3z"/></svg>' +
        'Live Board' +
      '</button>' +
      '<p class="lb-launch-help">For the TV: open QFicient in the TV\'s browser, sign in with a staff account, go to Live Board and press the button. Then use the full-screen button at the top of the board.</p>' +
    '</div>';
}

function openTvBoard() {
  var url = window.location.pathname + window.location.search + "#/tv";
  var opened = window.open(url, "qficient-live-board");
  // A blocked pop-up (or a TV browser without windows) just shows the board here.
  if (!opened) window.location.hash = "#/tv";
}

/* ---------- The board ---------- */

function tvStations() {
  return stations.filter(function (station) { return station.active !== false; })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

function tvClockText() {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());
  } catch (e) {
    return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

function tickTvClock() {
  var el = document.getElementById("tvClock");
  if (el) el.textContent = tvClockText();
}

function tvRowHtml(ticket, position) {
  return '<b>' + escapeHtml(ticket.ticketNo) + '</b><i>→</i><b>' + position + '</b>';
}

function tvColumnHtml(station) {
  var serving = servingTicketOf(station);
  var line = waitingTicketsOf(station.id);
  var next = line[0];
  var waiting = line.slice(1, 1 + TV_WAITING_ROWS);
  var more = line.length - 1 - waiting.length;

  return '<section class="tv-col">' +
    '<div class="tv-col-tab">' + escapeHtml(station.name) + '</div>' +
    '<div class="tv-col-body">' +
      '<div class="tv-now" data-station="' + escapeHtml(station.id) + '"><span>Now Serving</span><b>' + escapeHtml(serving ? serving.ticketNo : "—") + '</b></div>' +
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

function tvMiniHtml(station) {
  var serving = servingTicketOf(station);
  var next = waitingTicketsOf(station.id)[0];

  return '<div class="tv-mini">' +
    '<h3>' + escapeHtml(station.name) + '</h3>' +
    '<div class="tv-mini-row">' +
      '<div class="tv-now-mini" data-station="' + escapeHtml(station.id) + '"><span>Now Serving</span><b>' + escapeHtml(serving ? serving.ticketNo : "—") + '</b></div>' +
      '<div class="tv-mini-next"><span>Next in Line</span><b>' + escapeHtml(next ? next.ticketNo : "—") + (next ? '<small>↑</small>' : '') + '</b></div>' +
    '</div>' +
  '</div>';
}

function renderTvBoard() {
  var board = document.getElementById("tvBoard");
  var page = document.getElementById("pageTvBoard");
  if (!board || !page || !page.classList.contains("show")) return;

  tickTvClock();

  var list = tvStations();
  if (!list.length) {
    board.style.gridTemplateColumns = "";
    board.innerHTML = '<p class="tv-empty">No stations are open right now.</p>';
    return;
  }

  var main = list.slice(0, TV_MAIN_COLUMNS);
  var side = list.slice(TV_MAIN_COLUMNS);
  var sidePages = Math.max(1, Math.ceil(side.length / TV_SIDE_PER_PAGE));
  if (tvSidePage >= sidePages) tvSidePage = 0;
  var sideShown = side.slice(tvSidePage * TV_SIDE_PER_PAGE, (tvSidePage + 1) * TV_SIDE_PER_PAGE);

  board.style.gridTemplateColumns = "repeat(" + main.length + ", minmax(0, 1fr))" + (side.length ? " minmax(0, 0.9fr)" : "");
  board.innerHTML = main.map(tvColumnHtml).join("") +
    (side.length ?
      '<aside class="tv-side">' + sideShown.map(tvMiniHtml).join("") +
        (sidePages > 1 ? '<div class="tv-side-pages">' + (tvSidePage + 1) + ' / ' + sidePages + '</div>' : '') +
      '</aside>' : '');

  // Flash a station's "Now Serving" when it calls a new number.
  list.forEach(function (station) {
    var serving = servingTicketOf(station);
    var number = serving ? serving.ticketNo : "";
    if (tvLastServing[station.id] !== undefined && tvLastServing[station.id] !== number && number) {
      var box = board.querySelector('[data-station="' + station.id.replace(/"/g, "") + '"]');
      if (box) box.classList.add("tv-flash");
    }
    tvLastServing[station.id] = number;
  });

  ensureTvSideRotation(sidePages > 1);
}

function ensureTvSideRotation(needed) {
  if (needed && !tvSideTimer) {
    tvSideTimer = setInterval(function () {
      tvSidePage += 1;
      renderTvBoard();
    }, TV_SIDE_PAGE_MS);
  } else if (!needed && tvSideTimer) {
    clearInterval(tvSideTimer);
    tvSideTimer = null;
    tvSidePage = 0;
  }
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
  tvLastServing = {};
  renderTvBoard();
  markTvActive();
  if (!tvClockTimer) tvClockTimer = setInterval(tickTvClock, 1000);
}

function stopTvBoard() {
  if (tvClockTimer) {
    clearInterval(tvClockTimer);
    tvClockTimer = null;
  }
  ensureTvSideRotation(false);
  clearTimeout(tvIdleTimer);
}

document.addEventListener("mousemove", function () {
  if (document.body.getAttribute("data-page") === "pageTvBoard") markTvActive();
});
