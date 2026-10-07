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

function seedStations() {
  var defaults = [
    { id: "cashier", name: "Cashier" },
    { id: "registrar", name: "Registrar" },
    { id: "admission", name: "Evaluation / Admission" }
  ];

  db.collection("stations").limit(1).get().then(function (snapshot) {
    if (!snapshot.empty) return;

    defaults.forEach(function (station) {
      db.collection("stations").doc(station.id).set({
        name: station.name,
        count: 0,
        nowServingId: null,
        active: true
      });
    });
  });
}

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

db.collection("tickets").onSnapshot(function (snapshot) {
  tickets = snapshot.docs.map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  });
  updateDashboard();
  updateAdmin();
  renderQueueManagement();
}, function (err) {
  say("Connection error: " + err.message);
});

seedStations();
