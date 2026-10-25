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
      // With the dashboard open and in view, it has already announced this change itself (with sound).
      if (user && document.visibilityState === "visible") return;
      var data = payload.data || {};
      var urgent = typeof isUrgentPushTag === "function" ? isUrgentPushTag(data.tag) : true;
      if (typeof playChime === "function") playChime(urgent);
      if (typeof buzz === "function") buzz(urgent);
      if (typeof Toastify === "undefined") return;
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
      sayDone("Notifications enabled.");
    }).catch(function (err) {
      say("Could not enable notifications: " + err.message);
    });
  });
}

// The "phone alerts" item in the account menu: turns on push alerts, or says they are on or blocked.
function refreshNotificationToggle() {
  var item = document.getElementById("udMenuAlerts");
  if (!item) return;

  if (!user || !isFcmSupported()) {
    item.hidden = true;
    return;
  }

  var permission = Notification.permission;
  item.hidden = false;
  item.disabled = permission !== "default";
  item.classList.toggle("ud-menu-status", permission !== "default");

  if (permission === "granted") {
    item.textContent = "Phone alerts are on ✓";

    if (fcmTokenRegisteredFor !== user.id && FCM_VAPID_KEY.indexOf("REPLACE_WITH") !== 0) {
      fcmTokenRegisteredFor = user.id;
      requestFcmToken().then(saveFcmToken).catch(function (err) {
        console.error("Could not refresh FCM token: " + err.message);
      });
    }
  } else if (permission === "denied") {
    item.textContent = "Phone alerts are blocked in this browser";
    item.title = "Allow notifications for this site in the browser's settings to turn them on.";
  } else {
    item.textContent = "Turn on phone alerts";
    item.title = "Ring and vibrate this phone when it's almost your turn, even if QFicient is closed.";
  }
}
