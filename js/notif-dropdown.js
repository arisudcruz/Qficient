// The notifications dropdown: tapping a bell (student header or any admin/staff page header) opens a panel under it,
// Facebook-style: All / Unread, the latest notifications grouped Today / Earlier, blue dots for unread ones,
// "Mark all as read", and "See all notifications" for the full page.
// The two inboxes (js/user-notifications.js and js/admin-notifications.js) supply the items; this file only shows them.

var NOTIF_DROPDOWN_LIMIT = 15;
var notifDropdown = { kind: "", tab: "all", scroll: 0 };

// What each inbox provides. Items are { id, icon, title, detail, ms, unread }.
var NOTIF_DROPDOWN_SOURCES = {
  student: {
    bell: function () { return document.getElementById("udNotifBell"); },
    loaded: function () { return userNotifState.loaded; },
    error: function () { return userNotifState.error; },
    items: function () {
      return userNotifState.items.map(function (item) {
        return { id: item.id, icon: USER_NOTIF_ICONS[item.type] || "🔔", title: item.title || "QFicient", detail: item.body || "", ms: item.ms, unread: !item.read };
      });
    },
    open: function (id) {
      var mine = myTicket();
      var item = userNotifState.items.find(function (entry) { return entry.id === id; });
      openUserNotification(id);
      // One about the ticket they still hold takes them to it; any other just turns read.
      return !!(mine && item && mine.id === item.ticketId);
    },
    markAll: function () { markAllUserNotificationsRead(); },
    seeAll: function () { setDashboardTab("notifications"); window.scrollTo(0, 0); }
  },
  admin: {
    bell: function () {
      return Array.prototype.find.call(document.querySelectorAll(".admin-bell"), function (bell) { return bell.offsetParent !== null; }) || null;
    },
    loaded: function () { return notifState.loaded; },
    error: function () { return ""; },
    items: function () {
      return getNotifications().map(function (item) {
        var t = item.ticket;
        return {
          id: item.id,
          icon: t.enrollment === true ? "🎓" : t.transferredFrom ? "🔀" : "👥",
          title: notifTitle(t),
          detail: notifDetail(t),
          ms: item.ms,
          unread: !isNotifRead(item)
        };
      });
    },
    open: function (id) {
      openNotification(id);
      return true;
    },
    markAll: function () { markAllNotificationsRead(); },
    seeAll: function () { setAdminSection("notifications"); }
  }
};

function notifDropdownPanel() {
  var panel = document.getElementById("notifDropdown");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "notifDropdown";
    panel.className = "notif-dropdown";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Notifications");
    panel.hidden = true;
    // A click inside never counts as "outside": the panel redraws itself on a tab or item click, so by the time
    // the click reaches the document the clicked element is no longer in the page.
    panel.addEventListener("click", function (event) { event.stopPropagation(); });
    document.body.appendChild(panel);
  }
  return panel;
}

function toggleNotifDropdown(kind, event) {
  if (event) event.stopPropagation();
  if (notifDropdown.kind === kind) {
    closeNotifDropdown();
    return;
  }
  if (typeof closeUserMenu === "function") closeUserMenu();
  notifDropdown = { kind: kind, tab: "all", scroll: 0 };
  renderNotifDropdown();
}

function closeNotifDropdown() {
  if (!notifDropdown.kind) return;
  notifDropdown = { kind: "", tab: "all", scroll: 0 };
  var panel = document.getElementById("notifDropdown");
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }
  document.querySelectorAll(".bell-open").forEach(function (bell) { bell.classList.remove("bell-open"); });
}

function setNotifDropdownTab(tab) {
  notifDropdown.tab = tab === "unread" ? "unread" : "all";
  notifDropdown.scroll = 0;
  renderNotifDropdown();
}

function notifDropdownOpenItem(id) {
  var source = NOTIF_DROPDOWN_SOURCES[notifDropdown.kind];
  if (!source) return;
  var leaves = source.open(id);
  if (leaves) closeNotifDropdown();
}

function notifDropdownMarkAll() {
  var source = NOTIF_DROPDOWN_SOURCES[notifDropdown.kind];
  if (source) source.markAll();
}

function notifDropdownSeeAll() {
  var source = NOTIF_DROPDOWN_SOURCES[notifDropdown.kind];
  closeNotifDropdown();
  if (source) source.seeAll();
}

// Under the bell, right edges lined up; on a phone it spans the screen below the header.
function placeNotifDropdown(panel, bell) {
  var rect = bell.getBoundingClientRect();
  var gap = 8;
  panel.style.top = Math.round(rect.bottom + gap) + "px";
  if (window.innerWidth <= 520) {
    panel.style.left = gap + "px";
    panel.style.right = gap + "px";
  } else {
    panel.style.left = "auto";
    panel.style.right = Math.max(gap, Math.round(window.innerWidth - rect.right)) + "px";
  }
}

// Redrawn on open and whenever the inbox changes while it is open.
function renderNotifDropdown() {
  var source = NOTIF_DROPDOWN_SOURCES[notifDropdown.kind];
  var panel = notifDropdownPanel();
  if (!source) return;

  var bell = source.bell();
  if (!bell) {
    closeNotifDropdown();
    return;
  }
  document.querySelectorAll(".bell-open").forEach(function (b) { if (b !== bell) b.classList.remove("bell-open"); });
  bell.classList.add("bell-open");

  var list = panel.querySelector(".nd-list");
  if (list) notifDropdown.scroll = list.scrollTop;

  var all = source.loaded() ? source.items() : [];
  var unreadCount = all.filter(function (item) { return item.unread; }).length;
  var shown = (notifDropdown.tab === "unread" ? all.filter(function (item) { return item.unread; }) : all).slice(0, NOTIF_DROPDOWN_LIMIT);

  var dayStart = startOfTodayMs();
  var groups = [
    { label: "Today", items: shown.filter(function (item) { return item.ms >= dayStart; }) },
    { label: "Earlier", items: shown.filter(function (item) { return item.ms < dayStart; }) }
  ].filter(function (group) { return group.items.length; });

  var bodyHtml;
  if (!source.loaded()) {
    bodyHtml = '<p class="nd-empty">Loading notifications...</p>';
  } else if (source.error()) {
    bodyHtml = '<p class="nd-empty">' + escapeHtml(source.error()) + '</p>';
  } else if (!groups.length) {
    bodyHtml = '<p class="nd-empty"><span aria-hidden="true">🔔</span>' + (notifDropdown.tab === "unread" ? "You're all caught up" : "No notifications yet") + '</p>';
  } else {
    bodyHtml = groups.map(function (group) {
      return '<p class="nd-group">' + group.label + '</p>' + group.items.map(function (item) {
        var id = escapeHtml(item.id);
        return '<button type="button" class="nd-item' + (item.unread ? ' is-unread' : '') + '" onclick="notifDropdownOpenItem(\'' + id + '\')">' +
          '<span class="nd-icon" aria-hidden="true">' + item.icon + '</span>' +
          '<span class="nd-copy">' +
            '<span class="nd-title">' + escapeHtml(item.title) + '</span>' +
            '<span class="nd-detail">' + escapeHtml(item.detail) + '</span>' +
            '<span class="nd-time">' + escapeHtml(formatNotifTime(item.ms)) + '</span>' +
          '</span>' +
          (item.unread ? '<span class="nd-dot" aria-label="Unread"></span>' : '') +
        '</button>';
      }).join("");
    }).join("");
  }

  panel.innerHTML =
    '<div class="nd-head">' +
      '<h2>Notifications</h2>' +
      '<button type="button" class="nd-mark"' + (unreadCount ? '' : ' disabled') + ' onclick="notifDropdownMarkAll()">Mark all as read</button>' +
    '</div>' +
    '<div class="nd-tabs" role="tablist">' +
      '<button type="button" role="tab" class="nd-tab' + (notifDropdown.tab === "all" ? ' active' : '') + '" onclick="setNotifDropdownTab(\'all\')">All</button>' +
      '<button type="button" role="tab" class="nd-tab' + (notifDropdown.tab === "unread" ? ' active' : '') + '" onclick="setNotifDropdownTab(\'unread\')">Unread' + (unreadCount ? ' (' + unreadCount + ')' : '') + '</button>' +
    '</div>' +
    '<div class="nd-list">' + bodyHtml + '</div>' +
    '<button type="button" class="nd-all" onclick="notifDropdownSeeAll()">See all notifications</button>';

  panel.hidden = false;
  placeNotifDropdown(panel, bell);
  var newList = panel.querySelector(".nd-list");
  if (newList) newList.scrollTop = notifDropdown.scroll;
}

// The inboxes call this after every change.
function refreshNotifDropdown(kind) {
  if (notifDropdown.kind === kind) renderNotifDropdown();
}

// Closes on a click outside, Escape, a page change or a resize.
document.addEventListener("click", function (event) {
  if (!notifDropdown.kind) return;
  if (event.target.closest("#notifDropdown, .ud-bell, .admin-bell")) return;
  closeNotifDropdown();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeNotifDropdown();
});

window.addEventListener("resize", function () {
  if (notifDropdown.kind) renderNotifDropdown();
});

window.addEventListener("hashchange", function () {
  closeNotifDropdown();
});
