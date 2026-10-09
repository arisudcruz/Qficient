// Hash routes: the address bar follows the screen, and the browser's back, forward and refresh follow it back.
//
//   #/                         home
//   #/login   #/guest          sign-in screens
//   #/dashboard                student/guest station list
//   #/dashboard/board          live board
//   #/dashboard/<station id>   a station's join page (or your ticket)
//   #/admin                    admin sign-in
//   #/admin/<section>          admin console: dashboard, queue, enforcer, notifications, rules, settings
//
// The screen is still switched by goTo(); this file only keeps the hash in step with it (syncRoute) and
// turns a hash back into a screen (applyRoute).
var ROUTE_PAGE_IDS = { login: "pageLogin", guest: "pageGuest", dashboard: "pageDashboard", admin: "pageAdmin" };

var routeLock = false;     // true while the router itself is switching screens, so it doesn't write the hash back
var pendingRoute = null;   // a link to a signed-in screen, waiting for the saved session to be restored
var pendingRouteTimer = null;

function parseRoute(hash) {
  var parts = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  return { name: parts[0] || "home", sub: parts[1] ? decodeURIComponent(parts[1]) : "" };
}

function shownPageId() {
  var page = document.querySelector(".page.show");
  return page ? page.id : "";
}

function currentAdminSection() {
  var keys = Object.keys(ADMIN_SECTION_AREAS);
  for (var i = 0; i < keys.length; i++) {
    var area = document.getElementById(ADMIN_SECTION_AREAS[keys[i]]);
    if (area && area.style.display !== "none") return keys[i];
  }
  return "dashboard";
}

// The hash that matches what is on screen right now; null for screens that have no address (the invite flow).
function routeHashForScreen() {
  switch (shownPageId()) {
    case "pageHome": return "#/";
    case "pageLogin": return "#/login";
    case "pageGuest": return "#/guest";
    case "pageAdminLogin": return "#/admin";
    case "pageAdmin": return "#/admin/" + currentAdminSection();
    case "pageDashboard": {
      var board = document.getElementById("dashboardTabBoard");
      if (board && !board.hidden) return "#/dashboard/board";
      if (dashView === "station" && dashStationId) return "#/dashboard/" + encodeURIComponent(dashStationId);
      return "#/dashboard";
    }
    default: return null;
  }
}

function sameHash(a, b) {
  return (a || "#/") === (b || "#/") || (a === "" && b === "#/") || (a === "#/" && b === "");
}

function replaceHash(hash) {
  try {
    history.replaceState(null, "", window.location.pathname + window.location.search + hash);
  } catch (e) {}
}

// Writes the hash for the current screen. A normal call adds a history entry, so Back returns to the
// previous screen; replace = true swaps the entry instead (for changes the app makes on its own).
function syncRoute(replace) {
  if (routeLock || pendingRoute || inviteFlowActive) return;

  var hash = routeHashForScreen();
  if (!hash || sameHash(window.location.hash, hash)) return;

  if (replace) replaceHash(hash);
  else window.location.hash = hash;
}

function withRouteLock(work) {
  routeLock = true;
  try {
    work();
  } finally {
    routeLock = false;
  }
}

// Opens the dashboard sub-screen a link asks for.
function applyDashboardSub(sub) {
  if (sub === "board") {
    setDashboardTab("board");
    return;
  }

  setDashboardTab("queue");

  var wanted = sub && stations.some(function (station) { return station.id === sub; }) ? sub : "";
  if (wanted && myTicket()) viewMyTicket();
  else if (wanted) openStation(wanted);
  else if (dashView === "station") backToStations();
}

function applyAdminSub(sub) {
  var section = ADMIN_SECTION_AREAS[sub] ? sub : ADMIN_HOME_SECTION[adminKind()] || "dashboard";
  setAdminSection(section);
}

function clearPendingRoute() {
  pendingRoute = null;
  if (pendingRouteTimer) {
    clearTimeout(pendingRouteTimer);
    pendingRouteTimer = null;
  }
}

// The saved session did not come back (or took too long), so a link to a signed-in screen falls back to its sign-in.
function settlePendingRoute() {
  if (!pendingRoute) return;
  var route = pendingRoute;
  clearPendingRoute();

  withRouteLock(function () {
    goTo(route.name === "admin" ? "pageAdminLogin" : "pageHome");
  });
  replaceHash(routeHashForScreen() || "#/");
}

// Called by goTo() after it shows a screen. A waiting link for that screen is finished here.
function routerAfterGoTo(pageId) {
  if (routeLock || inviteFlowActive) return;

  if (pendingRoute && ROUTE_PAGE_IDS[pendingRoute.name] === pageId) {
    var route = pendingRoute;
    clearPendingRoute();

    withRouteLock(function () {
      if (route.name === "dashboard") applyDashboardSub(route.sub);
      else if (route.name === "admin") applyAdminSub(route.sub);
    });
    var hash = routeHashForScreen();
    if (hash) replaceHash(hash);
    return;
  }

  syncRoute(false);
}

function applyRoute(isFirstLoad) {
  if (inviteFlowActive) return;

  var route = parseRoute(window.location.hash);
  var signedStudent = !!user;
  var signedStaff = typeof isAdminSignedIn === "function" && isAdminSignedIn();

  clearPendingRoute();

  withRouteLock(function () {
    if (route.name === "dashboard") {
      if (signedStudent) {
        goTo("pageDashboard");
        applyDashboardSub(route.sub);
      } else if (isFirstLoad) {
        pendingRoute = route;
      } else {
        goTo("pageHome");
      }
    } else if (route.name === "admin") {
      if (signedStaff) {
        goTo("pageAdmin");
        applyAdminSub(route.sub);
      } else if (isFirstLoad) {
        pendingRoute = route;
      } else {
        goTo("pageAdminLogin");
      }
    } else if (signedStudent) {
      goTo("pageDashboard");      // a signed-in student has no use for the sign-in screens
    } else if (route.name === "login") {
      goTo("pageLogin");
    } else if (route.name === "guest") {
      goTo("pageGuest");
    } else {
      goTo("pageHome");
    }
  });

  if (pendingRoute) {
    pendingRouteTimer = setTimeout(settlePendingRoute, 8000);
    return;
  }

  var hash = routeHashForScreen();
  if (hash && !sameHash(window.location.hash, hash)) replaceHash(hash);
}

window.addEventListener("hashchange", function () {
  if (routeLock || inviteFlowActive) return;

  // The change came from syncRoute(): the screen already matches.
  if (sameHash(window.location.hash, routeHashForScreen())) return;

  applyRoute(false);
});

// Nobody is signed in, so a link to a signed-in screen can be settled right away.
firebase.auth().onAuthStateChanged(function (firebaseUser) {
  if (!firebaseUser) settlePendingRoute();
});

applyRoute(true);
