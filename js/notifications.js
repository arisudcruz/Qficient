var FCM_VAPID_KEY = "BJqn3yUfZEwESTb-e13tIxQnHE0LDFo4grtHFTs0lU17xWhzzoXyD4WtFdoyBdMsULnyDOYLsQU2Rnxx12CHpdo";

var fcmMessaging = null;
var fcmTokenRefreshed = false;

function isFcmSupported() {
  return typeof Notification !== "undefined" &&
    typeof firebase !== "undefined" &&
    !!firebase.messaging &&
    firebase.messaging.isSupported();
}

function getFcmMessaging() {
  if (!fcmMessaging && isFcmSupported()) {
    fcmMessaging = firebase.messaging();
    fcmMessaging.onMessage(function (payload) {
      if (typeof Toastify === "undefined") return;
      var title = (payload.notification && payload.notification.title) || "QFicient";
      var body = (payload.notification && payload.notification.body) || "";
      Toastify({
        text: title + (body ? " — " + body : ""),
        duration: 8000,
        gravity: "top",
        position: "center",
        style: { background: "#4F46E5" }
      }).showToast();
    });
  }
  return fcmMessaging;
}

function saveFcmToken(token) {
  if (!user || !token) return;

  user.fcmToken = token;

  if (user.type === "student") {
    db.collection("students").doc(user.id).set({
      fcmToken: token,
      fcmTokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(function (err) {
      console.error("Could not save FCM token: " + err.message);
    });
  }

  var ticket = myTicket();
  if (ticket) {
    db.collection("tickets").doc(ticket.id).update({ fcmToken: token }).catch(function (err) {
      console.error("Could not attach FCM token to ticket: " + err.message);
    });
  }
}

function requestFcmToken() {
  return navigator.serviceWorker.register("/firebase-messaging-sw.js").then(function (registration) {
    return getFcmMessaging().getToken({
      vapidKey: FCM_VAPID_KEY,
      serviceWorkerRegistration: registration
    });
  });
}

function enableNotifications() {
  if (!isFcmSupported()) {
    say("Push notifications aren't supported in this browser.");
    return;
  }

  if (FCM_VAPID_KEY.indexOf("REPLACE_WITH") === 0) {
    say("Notifications aren't configured yet — missing VAPID key in js/notifications.js.");
    return;
  }

  Notification.requestPermission().then(function (permission) {
    refreshNotificationToggle();

    if (permission !== "granted") {
      say("Notifications permission was not granted.");
      return;
    }

    requestFcmToken().then(function (token) {
      if (!token) {
        say("Could not get a notification token. Please try again.");
        return;
      }
      saveFcmToken(token);
      say("Notifications enabled.");
    }).catch(function (err) {
      say("Could not enable notifications: " + err.message);
    });
  });
}

function refreshNotificationToggle() {
  var area = document.getElementById("notificationToggle");
  if (!area) return;

  if (!user || !isFcmSupported()) {
    area.innerHTML = "";
    return;
  }

  var permission = Notification.permission;

  if (permission === "granted") {
    area.innerHTML = '<span class="notif-chip notif-chip-on">🔔 Notifications On</span>';

    if (!fcmTokenRefreshed && FCM_VAPID_KEY.indexOf("REPLACE_WITH") !== 0) {
      fcmTokenRefreshed = true;
      requestFcmToken().then(saveFcmToken).catch(function (err) {
        console.error("Could not refresh FCM token: " + err.message);
      });
    }
  } else if (permission === "denied") {
    area.innerHTML = '<span class="notif-chip notif-chip-off">🔕 Notifications Blocked</span>';
  } else {
    area.innerHTML = '<button type="button" class="notif-chip" onclick="enableNotifications()">🔕 Enable Notifications</button>';
  }
}
