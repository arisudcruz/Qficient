importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAFKl1GDFnEZa2ziMAqu8-1F-zkBSTI9g8",
  authDomain: "qficient.firebaseapp.com",
  projectId: "qficient",
  storageBucket: "qficient.firebasestorage.app",
  messagingSenderId: "738980528130",
  appId: "1:738980528130:web:afeb6726234dacff00a71b"
});

var messaging = firebase.messaging();

// The notification server sends data-only messages, so this is the one place a notification is displayed.
messaging.onBackgroundMessage(function (payload) {
  // A message with a "notification" part is already shown by the Firebase SDK; showing it again would duplicate it.
  if (payload.notification) return;

  var data = payload.data || {};
  var options = {
    body: data.body || "",
    icon: "/assets/qfficient-badge.png",
    tag: data.tag || undefined,
    renotify: !!data.tag
  };
  self.registration.showNotification(data.title || "QFicient", options);
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        if ("focus" in clients[i]) return clients[i].focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
