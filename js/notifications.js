var FCM_VAPID_KEY = "BJqn3yUfZEwESTb-e13tIxQnHE0LDFo4grtHFTs0lU17xWhzzoXyD4WtFdoyBdMsULnyDOYLsQU2Rnxx12CHpdo";

var fcmMessaging = null;
var fcmTokenRegisteredFor = null; // the uid whose token was last saved from this page

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
      var data = payload.data || {};
      var title = data.title || (payload.notification && payload.notification.title) || "QFicient";
      var body = data.body || (payload.notification && payload.notification.body) || "";
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

  db.collection("deviceTokens").doc(user.id).set({
    token: token,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(function (err) {
    console.error("Could not save FCM token: " + err.message);
  });
}

// Called when a different person is about to use this browser (log out, switch account). The device's
// push token is deleted, so alerts meant for the previous person can't reach whoever uses it next.
function forgetThisDevice(uid) {
  var jobs = [];

  if (uid) {
    jobs.push(db.collection("deviceTokens").doc(uid).delete().catch(function () {}));
  }

  if (isFcmSupported() && Notification.permission === "granted") {
    var messaging = getFcmMessaging();
    if (messaging && typeof messaging.deleteToken === "function") {
      jobs.push(Promise.resolve(messaging.deleteToken()).catch(function () {}));
    }
  }

  fcmTokenRegisteredFor = null;
  return Promise.all(jobs);
}

function requestFcmToken() {
  // A freshly registered worker is still installing; subscribing before it is active fails with
  // "no active Service Worker", so wait until it is ready.
  return navigator.serviceWorker.register("/firebase-messaging-sw.js").then(function (registration) {
    return navigator.serviceWorker.ready.then(function (ready) {
      return getFcmMessaging().getToken({
        vapidKey: FCM_VAPID_KEY,
        serviceWorkerRegistration: ready || registration
      });
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

var BELL_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

function refreshNotificationToggle() {
  var area = document.getElementById("notificationToggle");
  if (!area) return;

  if (!user || !isFcmSupported()) {
    area.innerHTML = "";
    return;
  }

  var permission = Notification.permission;

  if (permission === "granted") {
    area.innerHTML = '<span class="ud-bell is-on" role="img" aria-label="Notifications are on" title="Notifications are on">' + BELL_ICON_SVG + '<span class="ud-bell-dot"></span></span>';

    if (fcmTokenRegisteredFor !== user.id && FCM_VAPID_KEY.indexOf("REPLACE_WITH") !== 0) {
      fcmTokenRegisteredFor = user.id;
      requestFcmToken().then(saveFcmToken).catch(function (err) {
        console.error("Could not refresh FCM token: " + err.message);
      });
    }
  } else if (permission === "denied") {
    area.innerHTML = '<span class="ud-bell is-off" role="img" aria-label="Notifications are blocked in this browser" title="Notifications are blocked in this browser">' + BELL_ICON_SVG + '</span>';
  } else {
    area.innerHTML = '<button type="button" class="ud-bell" onclick="enableNotifications()" aria-label="Enable notifications" title="Enable notifications">' + BELL_ICON_SVG + '<span class="ud-bell-dot"></span></button>';
  }
}
