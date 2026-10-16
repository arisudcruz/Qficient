// The student's notification history (the Notifications tab on their dashboard). The Cloud Functions save a copy
// of every alert they send to a student in `userNotifications`; this page lists the last week of them.
var USER_NOTIF_LIMIT = 100;
var USER_NOTIF_PAGE_SIZE = 20;

var userNotifState = { uid: null, loaded: false, error: "", items: [], tab: "unread", limit: USER_NOTIF_PAGE_SIZE, menuId: null };
var userNotifUnsubscribe = null;

var USER_NOTIF_ICONS = {
  joined: "🎟️",
  soon: "📣",
  next: "⏭️",
  serving: "🔔",
  recall: "📢",
  skipped: "⏸️",
  lastCall: "⏰",
  transferred: "🔀",
  void: "❌",
  completed: "✅"
};

// Follows whoever is signed in: starts for a student, stops on logout or when someone else signs in.
function syncUserNotificationsListener() {
  var uid = user ? user.id : null;
  if (uid === userNotifState.uid) return;

  if (userNotifUnsubscribe) {
    userNotifUnsubscribe();
    userNotifUnsubscribe = null;
  }
  userNotifState = { uid: uid, loaded: false, error: "", items: [], tab: "unread", limit: USER_NOTIF_PAGE_SIZE, menuId: null };
  if (!uid) {
    renderUserNotifBadge();
    return;
  }

  userNotifUnsubscribe = db.collection("userNotifications")
    .where("ownerId", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(USER_NOTIF_LIMIT)
    .onSnapshot(function (snapshot) {
      if (userNotifState.uid !== uid) return;
      userNotifState.items = snapshot.docs.map(function (doc) {
        var data = doc.data();
        return Object.assign({ id: doc.id, ms: timestampToMs(data.createdAt, Date.now()) }, data);
      });
      userNotifState.loaded = true;
      userNotifState.error = "";
      refreshUserNotifications();
    }, function (error) {
      console.error("Could not load notifications: " + error.message);
      userNotifState.loaded = true;
      userNotifState.error = "Could not load your notifications. Please try again later.";
      refreshUserNotifications();
    });
}

function userNotifUnreadCount() {
  return userNotifState.items.filter(function (item) { return !item.read; }).length;
}

function renderUserNotifBadge() {
  var badge = document.getElementById("udNotifBadge");
  if (!badge) return;
  var count = userNotifUnreadCount();
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? "99+" : String(count);
}

function refreshUserNotifications() {
  renderUserNotifBadge();
  var panel = document.getElementById("dashboardTabNotifications");
  if (panel && !panel.hidden) renderUserNotifications();
}

function markUserNotificationRead(id) {
  return db.collection("userNotifications").doc(id).update({ read: true }).catch(function (error) {
    console.error("Could not mark the notification read: " + error.message);
  });
}

function markAllUserNotificationsRead() {
  var unread = userNotifState.items.filter(function (item) { return !item.read; });
  if (!unread.length) return;

  var batch = db.batch();
  unread.forEach(function (item) {
    batch.update(db.collection("userNotifications").doc(item.id), { read: true });
  });
  batch.commit().catch(function (error) {
    say("Could not update notifications: " + error.message);
  });
}

function confirmDeleteUserNotification(id) {
  userNotifState.menuId = null;
  renderUserNotifications();

  showConfirmModal({
    title: "Are you sure you want to delete this notification?",
    message: "It will be removed from your notifications.",
    confirmLabel: "Delete",
    tone: "danger",
    onConfirm: function () {
      return db.collection("userNotifications").doc(id).delete().catch(function (error) {
        say("Could not delete the notification: " + error.message);
      });
    }
  });
}

function setUserNotificationsTab(tab) {
  userNotifState.tab = tab === "read" ? "read" : "unread";
  userNotifState.limit = USER_NOTIF_PAGE_SIZE;
  userNotifState.menuId = null;
  renderUserNotifications();
}

function showMoreUserNotifications() {
  userNotifState.limit += USER_NOTIF_PAGE_SIZE;
  renderUserNotifications();
}

function toggleUserNotifMenu(id, event) {
  event.stopPropagation();
  userNotifState.menuId = userNotifState.menuId === id ? null : id;
  renderUserNotifications();
}

// Opening a notification marks it read; one about the ticket they still have open takes them to it.
function openUserNotification(id) {
  var item = userNotifState.items.find(function (entry) { return entry.id === id; });
  if (!item) return;

  if (!item.read) markUserNotificationRead(id);

  var mine = myTicket();
  if (mine && mine.id === item.ticketId) {
    setDashboardTab("queue");
    viewMyTicket();
  }
}

document.addEventListener("click", function (event) {
  if (userNotifState.menuId && !event.target.closest(".notif-popover, .notif-menu-btn")) {
    userNotifState.menuId = null;
    renderUserNotifications();
  }
});

function renderUserNotifications() {
  var area = document.getElementById("udNotifArea");
  if (!area) return;

  var headHtml =
    '<div class="ud-board-head">' +
      '<div>' +
        '<h2 class="ud-greeting">Notifications</h2>' +
        '<p class="ud-greeting-sub">Updates about your tickets from the last 7 days.</p>' +
      '</div>' +
    '</div>';

  if (!userNotifState.loaded) {
    area.innerHTML = headHtml + '<p class="ud-notif-note">Loading notifications...</p>';
    return;
  }
  if (userNotifState.error) {
    area.innerHTML = headHtml + '<p class="ud-notif-note">' + escapeHtml(userNotifState.error) + '</p>';
    return;
  }

  var all = userNotifState.items;
  var wantRead = userNotifState.tab === "read";
  var shown = all.filter(function (item) { return !!item.read === wantRead; });
  var unreadCount = userNotifUnreadCount();
  var visible = shown.slice(0, userNotifState.limit);

  var controlsHtml =
    '<div class="notif-controls">' +
      '<button type="button" class="notif-mark-all" onclick="markAllUserNotificationsRead()"' + (unreadCount ? '' : ' disabled') + '>Mark All Read</button>' +
      '<div class="notif-tabs" role="tablist">' +
        '<button type="button" class="notif-tab' + (wantRead ? '' : ' active') + '" role="tab" onclick="setUserNotificationsTab(\'unread\')">Unread' + (unreadCount ? ' (' + unreadCount + ')' : '') + '</button>' +
        '<button type="button" class="notif-tab' + (wantRead ? ' active' : '') + '" role="tab" onclick="setUserNotificationsTab(\'read\')">Read</button>' +
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
      '<div class="notif-group-head"><h3 class="notif-group-title">Today</h3>' + controlsHtml + '</div>' +
      '<div class="ud-notif-empty"><div aria-hidden="true">🔔</div><p>' + (wantRead ? 'No read notifications' : 'You\'re all caught up') + '</p></div>';
  } else {
    bodyHtml = groups.map(function (group, index) {
      var cardsHtml = group.items.map(function (item) {
        var id = escapeHtml(item.id);

        return '<article class="notif-card' + (item.read ? ' read' : '') + '" onclick="openUserNotification(\'' + id + '\')">' +
          '<span class="notif-icon" aria-hidden="true">' + (USER_NOTIF_ICONS[item.type] || "🔔") + '</span>' +
          '<div class="notif-copy">' +
            '<p class="notif-title">' + escapeHtml(item.title || "QFicient") + '</p>' +
            '<p class="notif-detail">' + escapeHtml(item.body || "") + '</p>' +
          '</div>' +
          '<div class="notif-side">' +
            '<button type="button" class="notif-menu-btn" aria-label="More options" onclick="toggleUserNotifMenu(\'' + id + '\', event)">•••</button>' +
            '<span class="notif-time">' + escapeHtml(formatNotifTime(item.ms)) + '</span>' +
          '</div>' +
          (userNotifState.menuId === item.id ?
            '<div class="notif-popover"><button type="button" onclick="event.stopPropagation(); confirmDeleteUserNotification(\'' + id + '\')">Delete Notification</button></div>' : '') +
        '</article>';
      }).join("");

      return '<section class="notif-group">' +
        '<div class="notif-group-head"><h3 class="notif-group-title">' + group.label + '</h3>' + (index === 0 ? controlsHtml : '') + '</div>' +
        '<div class="notif-list">' + cardsHtml + '</div>' +
      '</section>';
    }).join("");

    if (shown.length > visible.length) {
      bodyHtml += '<div class="notif-more"><button type="button" class="ud-notif-more" onclick="showMoreUserNotifications()">Show ' +
        Math.min(USER_NOTIF_PAGE_SIZE, shown.length - visible.length) + ' more</button></div>';
    }
  }

  area.innerHTML = headHtml + bodyHtml;
}

// "5 minutes ago" goes stale while the tab sits open.
setInterval(function () {
  var panel = document.getElementById("dashboardTabNotifications");
  if (panel && !panel.hidden && userNotifState.loaded && !userNotifState.menuId) renderUserNotifications();
}, 30 * 1000);
