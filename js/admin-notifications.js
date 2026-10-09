// Admin inbox: every ticket is a "New Queue Request". Which ones a staff member has read or deleted
// is stored in Firestore (staffNotifications/{their email}), so it follows them across computers.
var NOTIF_LOOKBACK_DAYS = 7;
var NOTIF_PAGE_SIZE = 30;

var notifState = {
  loaded: false,
  readBeforeMs: null,
  readIds: {},
  deletedIds: {},
  tab: "unread",
  limit: NOTIF_PAGE_SIZE,
  menuId: null
};

var notifUnsubscribe = null;
var notifTimer = null;

function notifDocRef() {
  return db.collection("staffNotifications").doc(staffKey(adminUser.email));
}

function startNotificationsListener() {
  if (notifUnsubscribe || !adminUser) return;

  notifUnsubscribe = notifDocRef().onSnapshot(function (doc) {
    var data = doc.exists ? doc.data() : {};
    notifState.readBeforeMs = data.readAllBefore && typeof data.readAllBefore.toMillis === "function" ? data.readAllBefore.toMillis() : null;
    notifState.readIds = data.readIds || {};
    notifState.deletedIds = data.deletedIds || {};
    notifState.loaded = true;
    refreshNotifications();
  }, function (error) {
    // Still show the inbox (everything from today unread) so a missing rule doesn't leave the page empty.
    console.error("Could not load notification state: " + error.message);
    notifState.loaded = true;
    refreshNotifications();
  });

  // Keeps the "2h ago" style labels fresh.
  notifTimer = setInterval(refreshNotifications, 30 * 1000);
}

function stopNotificationsListener() {
  if (notifUnsubscribe) {
    notifUnsubscribe();
    notifUnsubscribe = null;
  }
  if (notifTimer) {
    clearInterval(notifTimer);
    notifTimer = null;
  }
  notifState = { loaded: false, readBeforeMs: null, readIds: {}, deletedIds: {}, tab: "unread", limit: NOTIF_PAGE_SIZE, menuId: null };
  updateNotificationBadge(0);
}

function notifCreatedMs(ticket) {
  return ticket.createdAt && typeof ticket.createdAt.toMillis === "function" ? ticket.createdAt.toMillis() : Date.now();
}

function isNotifRead(item) {
  var readBefore = notifState.readBeforeMs !== null ? notifState.readBeforeMs : startOfTodayMs();
  return !!notifState.readIds[item.id] || item.ms <= readBefore;
}

// Newest first; deleted ones are left out.
function getNotifications() {
  var cutoff = Date.now() - NOTIF_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  return tickets.map(function (ticket) {
    return { id: ticket.id, ticket: ticket, ms: notifCreatedMs(ticket) };
  }).filter(function (item) {
    return item.ms >= cutoff && !notifState.deletedIds[item.id] && canViewStationData(item.ticket.stationId);
  }).sort(function (a, b) {
    return b.ms - a.ms;
  });
}

function formatNotifTime(ms) {
  var seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);

  if (seconds < 60) return "Just Now";
  if (minutes < 2) return "a minute ago";
  if (hours < 1) return minutes + " minutes ago";
  if (days < 1) return hours + "h";
  return days + "d";
}

function notifTitle(ticket) {
  return ticket.transferredFrom ? "Transferred Queue Request" : "New Queue Request";
}

function notifDetail(ticket) {
  var detail = (ticket.ticketNo || "-") + " - " + (ticket.purpose || "No purpose given");
  return detail + " · " + getStationName(ticket.stationId);
}

function updateNotificationBadge(count) {
  var badge = document.getElementById("notifBadge");
  if (!badge) return;

  badge.style.display = count > 0 ? "" : "none";
  badge.textContent = count > 99 ? "99+" : String(count);
}

// Called whenever tickets or the notification state change.
function refreshNotifications() {
  if (!adminUser || !notifState.loaded) return;

  var unread = getNotifications().filter(function (item) { return !isNotifRead(item); });
  updateNotificationBadge(unread.length);

  var area = document.getElementById("adminNotificationsArea");
  if (area && area.style.display !== "none") renderNotifications();
}

/* Writes. Pruning drops entries for tickets that have aged out, so the document stays small. */

function notifPruneEntries() {
  if (!tickets.length) return {};

  var cutoff = Date.now() - (NOTIF_LOOKBACK_DAYS + 1) * 24 * 60 * 60 * 1000;
  var live = {};
  tickets.forEach(function (ticket) {
    if (notifCreatedMs(ticket) >= cutoff) live[ticket.id] = true;
  });

  var patch = {};
  ["readIds", "deletedIds"].forEach(function (field) {
    var stale = {};
    Object.keys(notifState[field]).forEach(function (id) {
      if (!live[id]) stale[id] = firebase.firestore.FieldValue.delete();
    });
    if (Object.keys(stale).length) patch[field] = stale;
  });
  return patch;
}

function saveNotifications(patch) {
  var prune = notifPruneEntries();
  var data = {};

  ["readIds", "deletedIds"].forEach(function (field) {
    var merged = Object.assign({}, prune[field] || {}, patch[field] || {});
    if (Object.keys(merged).length) data[field] = merged;
  });
  if (patch.readAllBefore) data.readAllBefore = patch.readAllBefore;
  data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

  return notifDocRef().set(data, { merge: true }).catch(function (error) {
    say("Could not update notifications: " + error.message);
  });
}

function markNotificationRead(id) {
  var patch = { readIds: {} };
  patch.readIds[id] = true;
  return saveNotifications(patch);
}

function markAllNotificationsRead() {
  var unread = getNotifications().filter(function (item) { return !isNotifRead(item); });
  if (!unread.length) return;

  var newest = unread.reduce(function (max, item) { return Math.max(max, item.ms); }, 0);
  var current = notifState.readBeforeMs !== null ? notifState.readBeforeMs : 0;

  saveNotifications({ readAllBefore: firebase.firestore.Timestamp.fromMillis(Math.max(newest, current)) });
}

function confirmDeleteNotification(id) {
  notifState.menuId = null;
  renderNotifications();

  showConfirmModal({
    title: "Delete this notification?",
    message: "It is removed from your list only. The ticket and other staff are not affected.",
    confirmLabel: "Delete",
    tone: "danger",
    onConfirm: function () {
      var patch = { deletedIds: {} };
      patch.deletedIds[id] = true;
      saveNotifications(patch);
    }
  });
}

/* Interaction */

function setNotificationsTab(tab) {
  notifState.tab = tab;
  notifState.limit = NOTIF_PAGE_SIZE;
  notifState.menuId = null;
  renderNotifications();
}

function showMoreNotifications() {
  notifState.limit += NOTIF_PAGE_SIZE;
  renderNotifications();
}

function toggleNotifMenu(id, event) {
  event.stopPropagation();
  notifState.menuId = notifState.menuId === id ? null : id;
  renderNotifications();
}

// Opening a notification marks it read and jumps to that station in Queue Management.
function openNotification(id) {
  var item = getNotifications().find(function (entry) { return entry.id === id; });
  if (!item) return;

  if (!isNotifRead(item)) markNotificationRead(id);

  // An enforcer has no Queue Management page: they land on the Queue Enforcer list for that station instead.
  if (adminKind() === "enforcer") {
    if (getEnforcerStations().some(function (station) { return station.id === item.ticket.stationId; })) {
      enforcerFilter = item.ticket.stationId;
    }
    setAdminSection("enforcer");
    return;
  }

  if (canServeStation(item.ticket.stationId) && stations.some(function (station) { return station.id === item.ticket.stationId; })) {
    activeQueueStation = item.ticket.stationId;
    resetQueueTransfer();
    queueSelection = {};
  }
  setAdminSection("queue");
}

document.addEventListener("click", function (event) {
  if (notifState.menuId && !event.target.closest(".notif-popover, .notif-menu-btn")) {
    notifState.menuId = null;
    renderNotifications();
  }
});

/* Rendering */

function renderNotifications() {
  var area = document.getElementById("adminNotificationsArea");
  if (!area) return;

  var headerHtml =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Notifications</div>' +
      '<div class="settings-header-user"><span>' + escapeAdminText(adminDisplayName()) + '</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>';

  if (!notifState.loaded) {
    area.innerHTML = headerHtml + '<p class="settings-sub">Loading notifications...</p>';
    return;
  }

  var all = getNotifications();
  var wantRead = notifState.tab === "read";
  var shown = all.filter(function (item) { return isNotifRead(item) === wantRead; });
  var unreadCount = all.length - all.filter(isNotifRead).length;
  var visible = shown.slice(0, notifState.limit);

  var controlsHtml =
    '<div class="notif-controls">' +
      '<button type="button" class="notif-mark-all" onclick="markAllNotificationsRead()"' + (unreadCount ? '' : ' disabled') + '>Mark All Read</button>' +
      '<div class="notif-tabs" role="tablist">' +
        '<button type="button" class="notif-tab' + (wantRead ? '' : ' active') + '" role="tab" onclick="setNotificationsTab(\'unread\')">Unread' + (unreadCount ? ' (' + unreadCount + ')' : '') + '</button>' +
        '<button type="button" class="notif-tab' + (wantRead ? ' active' : '') + '" role="tab" onclick="setNotificationsTab(\'read\')">Read</button>' +
      '</div>' +
    '</div>';

  var dayStart = startOfTodayMs();
  var groups = [
    { label: "Today", items: visible.filter(function (item) { return item.ms >= dayStart; }) },
    { label: "Earlier", items: visible.filter(function (item) { return item.ms < dayStart; }) }
  ].filter(function (group) { return group.items.length; });

  var bodyHtml;
  if (!groups.length) {
    bodyHtml =
      '<div class="notif-group-head"><h2 class="notif-group-title">Today</h2>' + controlsHtml + '</div>' +
      '<div class="settings-empty"><div class="settings-empty-icon">🔔</div><p>' + (wantRead ? 'No read notifications' : 'You\'re all caught up') + '</p></div>';
  } else {
    bodyHtml = groups.map(function (group, index) {
      var cardsHtml = group.items.map(function (item) {
        var id = escapeAdminText(item.id);
        var read = isNotifRead(item);

        return '<article class="notif-card' + (read ? ' read' : '') + '" onclick="openNotification(\'' + id + '\')">' +
          '<span class="notif-icon" aria-hidden="true">👥</span>' +
          '<div class="notif-copy">' +
            '<p class="notif-title">' + escapeAdminText(notifTitle(item.ticket)) + '</p>' +
            '<p class="notif-detail">' + escapeAdminText(notifDetail(item.ticket)) + '</p>' +
          '</div>' +
          '<div class="notif-side">' +
            '<button type="button" class="notif-menu-btn" aria-label="More options" onclick="toggleNotifMenu(\'' + id + '\', event)">•••</button>' +
            '<span class="notif-time">' + escapeAdminText(formatNotifTime(item.ms)) + '</span>' +
          '</div>' +
          (notifState.menuId === item.id ?
            '<div class="notif-popover"><button type="button" onclick="event.stopPropagation(); confirmDeleteNotification(\'' + id + '\')">Delete Notification</button></div>' : '') +
        '</article>';
      }).join("");

      return '<section class="notif-group">' +
        '<div class="notif-group-head"><h2 class="notif-group-title">' + group.label + '</h2>' + (index === 0 ? controlsHtml : '') + '</div>' +
        '<div class="notif-list">' + cardsHtml + '</div>' +
      '</section>';
    }).join("");

    if (shown.length > visible.length) {
      bodyHtml += '<div class="notif-more"><button type="button" class="settings-btn settings-btn-blue" onclick="showMoreNotifications()">Show ' +
        Math.min(NOTIF_PAGE_SIZE, shown.length - visible.length) + ' more</button></div>';
    }
  }

  area.innerHTML = headerHtml + bodyHtml;
}
