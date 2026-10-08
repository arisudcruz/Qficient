// Warns admins when the notification service (Cloud Functions, see /functions) has stopped reporting in.
var SERVER_OFFLINE_AFTER_MS = 3 * 60 * 1000;

var serverStatusUnsubscribe = null;
var serverStatusTimer = null;
var serverLastSeenMs = null;
var serverBannerDismissed = false;
var serverWasOffline = false;

function isNotifierOffline() {
  return serverLastSeenMs === null || Date.now() - serverLastSeenMs > SERVER_OFFLINE_AFTER_MS;
}

function dismissServerBanner() {
  serverBannerDismissed = true;
  renderServerBanner();
}

function renderServerBanner() {
  var banner = document.getElementById("adminServerBanner");
  if (!banner) return;

  var offline = isNotifierOffline();

  // Show the warning again whenever the server goes offline after having been online.
  if (offline && !serverWasOffline) serverBannerDismissed = false;
  serverWasOffline = offline;

  if (!offline || serverBannerDismissed || !isAdminSignedIn()) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }

  banner.style.display = "";
  banner.innerHTML =
    '<span class="server-banner-text"><strong>Notification service is offline.</strong> ' +
    'Students won\'t get push alerts and expired tickets won\'t be voided automatically until it is running again.</span>' +
    '<button type="button" class="server-banner-close" aria-label="Dismiss" onclick="dismissServerBanner()">✕</button>';
}

function startServerStatusListener() {
  if (serverStatusUnsubscribe) return;

  serverStatusUnsubscribe = db.collection("serverStatus").doc("notifier").onSnapshot(function (doc) {
    var lastSeen = doc.exists ? doc.data().lastSeen : null;
    serverLastSeenMs = lastSeen && typeof lastSeen.toMillis === "function" ? lastSeen.toMillis() : null;
    renderServerBanner();
  }, function (error) {
    console.error("Could not read notification server status: " + error.message);
  });

  serverStatusTimer = setInterval(renderServerBanner, 30 * 1000);
}

function stopServerStatusListener() {
  if (serverStatusUnsubscribe) {
    serverStatusUnsubscribe();
    serverStatusUnsubscribe = null;
  }
  if (serverStatusTimer) {
    clearInterval(serverStatusTimer);
    serverStatusTimer = null;
  }
  serverLastSeenMs = null;
  renderServerBanner();
}
