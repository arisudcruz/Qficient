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
  refreshSettings();
}, function (err) {
  console.error("Could not load system settings: " + err.message);
});

var ticketsUnsubscribe = null;

// Students, guests and enforcers only ever use today's tickets, so that is all they download. Admins keep
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
      return Object.assign({ id: doc.id }, doc.data());
    });
    updateDashboard();
    updateAdmin();
    renderQueueManagement();
    refreshNotifications();
    refreshEnforcerList();
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

  restoreStudentSession(firebaseUser);
});
