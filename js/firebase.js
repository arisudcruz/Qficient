const firebaseConfig = {
  apiKey: "AIzaSyAFKl1GDFnEZa2ziMAqu8-1F-zkBSTI9g8",
  authDomain: "qficient.firebaseapp.com",
  projectId: "qficient",
  storageBucket: "qficient.firebasestorage.app",
  messagingSenderId: "738980528130",
  appId: "1:738980528130:web:afeb6726234dacff00a71b"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

var stations = [];
var tickets = [];
var user = null;

db.collection("stations").onSnapshot(function (snapshot) {
  stations = snapshot.docs.map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  });
  updateDashboard();
  updateAdmin();
  if (typeof renderTvBoard === "function") renderTvBoard();
  if (typeof refreshLiveBoardLauncher === "function") refreshLiveBoardLauncher();
  renderQueueManagement();
  refreshSettings();
  refreshEnforcerList();
}, function (err) {
  say("Connection error: " + err.message);
});

db.collection("settings").doc("system").onSnapshot(function (doc) {
  var minutes = doc.exists ? Number(doc.data().autoVoidMinutes) : 1;
  systemSettings.autoVoidMinutes = minutes > 0 ? minutes : 1;
  AUTO_VOID_WINDOW_MS = systemSettings.autoVoidMinutes * 60 * 1000;

  var cooldown = doc.exists ? doc.data().cancelCooldownSeconds : undefined;
  var cooldownSeconds = Number.isInteger(cooldown) && cooldown >= 0 && cooldown <= 3600 ? cooldown : DEFAULT_CANCEL_COOLDOWN_SECONDS;
  var cooldownChanged = cooldownSeconds !== systemSettings.cancelCooldownSeconds;
  systemSettings.cancelCooldownSeconds = cooldownSeconds;
  CANCEL_COOLDOWN_MS = cooldownSeconds * 1000;

  refreshSettings();
  if (cooldownChanged) updateDashboard(); // a student waiting out a cancel sees the new countdown right away
}, function (err) {
  console.error("Could not load system settings: " + err.message);
});

// What each role may do (System Rules > Role Rules); see js/admin-rules.js.
db.collection("settings").doc("roleRules").onSnapshot(function (doc) {
  onRoleRulesChanged(doc.exists ? doc.data().roles : {});
}, function (err) {
  console.error("Could not load the role rules: " + err.message);
});

// The Live Board presets: which stations each TV shows (js/tv-board.js).
db.collection("settings").doc("liveBoard").onSnapshot(function (doc) {
  if (typeof onLiveBoardPresetsChanged === "function") onLiveBoardPresetsChanged(doc.exists ? doc.data().presets : []);
}, function (err) {
  console.error("Could not load the Live Board presets: " + err.message);
});

// The enrollment process for each student type (Enrollment Settings).
db.collection("settings").doc("enrollment").onSnapshot(function (doc) {
  var flows = doc.exists && doc.data().flows ? doc.data().flows : {};
  enrollmentSettings = { flows: flows, open: !(doc.exists && doc.data().open === false) };
  updateDashboard();
  renderQueueManagement();
  renderEnrollmentSettings();
  if (typeof enforcerFormNeedsFlows === "function" && enforcerFormNeedsFlows()) renderEnforcer();
}, function (err) {
  console.error("Could not load the enrollment process: " + err.message);
});

// The window hours (System Settings > Window Hours; js/window-hours.js).
db.collection("settings").doc("windowHours").onSnapshot(function (doc) {
  windowHours = doc.exists ? doc.data() : null;
  windowHoursLastKey = windowHoursKey();
  onWindowHoursChanged();
  refreshSettings();
}, function (err) {
  console.error("Could not load the window hours: " + err.message);
});

var ticketsUnsubscribe = null;
var ticketsLoaded = false; // true once the first list of tickets has arrived

// Students, walk-ins and enforcers only ever use today's tickets, so that is all they download. Admins keep
// a longer window for the dashboard, analytics and the notification inbox.
var ADMIN_HISTORY_DAYS = 60;
var ticketsScopeDays = 1;
var ticketsScopeDay = null;

function ticketsQuery() {
  var startMs = startOfTodayMs() - (ticketsScopeDays - 1) * DAY_MS;
  return db.collection("tickets").where("createdAt", ">=", firebase.firestore.Timestamp.fromMillis(startMs));
}

function setTicketsScope(days) {
  if (days === ticketsScopeDays) return;

  ticketsScopeDays = days;
  if (ticketsUnsubscribe) resubscribeTickets();
}

function resubscribeTickets() {
  if (ticketsUnsubscribe) {
    ticketsUnsubscribe();
    ticketsUnsubscribe = null;
  }
  startTicketsListener();
}

// A page left open past midnight must move on to the new day's tickets.
function checkTicketsDayRollover() {
  if (ticketsUnsubscribe && queueDayKey(Date.now()) !== ticketsScopeDay) resubscribeTickets();
}

setInterval(checkTicketsDayRollover, 60 * 1000);

function startTicketsListener() {
  if (ticketsUnsubscribe) return;

  ticketsScopeDay = queueDayKey(Date.now());
  ticketsUnsubscribe = ticketsQuery().onSnapshot(function (snapshot) {
    tickets = snapshot.docs.map(function (doc) {
      // A time this browser just wrote (On Hold, Last Call) reads as an estimate until the server confirms it,
      // instead of being empty, so countdowns start from the right moment.
      return Object.assign({ id: doc.id }, doc.data({ serverTimestamps: "estimate" }));
    });
    ticketsLoaded = true;
    updateDashboard();
    updateAdmin();
    if (typeof renderTvBoard === "function") renderTvBoard();
    renderQueueManagement();
    refreshNotifications();
    refreshEnforcerList();
    checkStaffAlerts();
  }, function (err) {
    say("Connection error: " + err.message);
  });
}

function stopTicketsListener() {
  if (ticketsUnsubscribe) {
    ticketsUnsubscribe();
    ticketsUnsubscribe = null;
  }
  ticketsScopeDays = 1;
  tickets = [];
}

firebase.auth().onAuthStateChanged(function (firebaseUser) {
  if (firebaseUser) {
    startTicketsListener();
  } else {
    stopTicketsListener();
  }

  endReplacedStudentSession(firebaseUser);
  restoreStudentSession(firebaseUser);
});
