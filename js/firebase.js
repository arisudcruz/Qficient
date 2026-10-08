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

function startTicketsListener() {
  if (ticketsUnsubscribe) return;

  ticketsUnsubscribe = db.collection("tickets").onSnapshot(function (snapshot) {
    tickets = snapshot.docs.map(function (doc) {
      return Object.assign({ id: doc.id }, doc.data());
    });
    updateDashboard();
    updateAdmin();
    renderQueueManagement();
    refreshNotifications();
  }, function (err) {
    say("Connection error: " + err.message);
  });
}

function stopTicketsListener() {
  if (ticketsUnsubscribe) {
    ticketsUnsubscribe();
    ticketsUnsubscribe = null;
  }
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
