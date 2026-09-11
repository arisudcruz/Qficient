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

  defaults.forEach(function (station) {
    var ref = db.collection("stations").doc(station.id);
    ref.get().then(function (doc) {
      if (!doc.exists) {
        ref.set({ name: station.name, count: 0, nowServingId: null });
      }
    });
  });
}

db.collection("stations").onSnapshot(function (snapshot) {
  stations = snapshot.docs.map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  });
  updateDashboard();
  updateAdmin();
}, function (err) {
  say("Connection error: " + err.message);
});

db.collection("tickets").onSnapshot(function (snapshot) {
  tickets = snapshot.docs.map(function (doc) {
    return Object.assign({ id: doc.id }, doc.data());
  });
  updateDashboard();
  updateAdmin();
}, function (err) {
  say("Connection error: " + err.message);
});

seedStations();
