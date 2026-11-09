// The notifications dropdown: tapping a bell (student header or any admin/staff page header) opens a panel under it,
// Facebook-style: All / Unread, the latest notifications grouped Today / Earlier, blue dots for unread ones,
// "Mark all as read", and "See all notifications" for the full page.
// The two inboxes (js/user-notifications.js and js/admin-notifications.js) supply the items; this file only shows them.

/* ---------- Notification icons (shared by the dropdown and both Notifications pages) ---------- */

// Line icons on a 24x24 grid, drawn in the text colour.
var NOTIF_ICON_PATHS = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bellRing: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M4 2C2.8 3.7 2 5.7 2 8M22 8c0-2.3-.8-4.3-2-6"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
  hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
  next: '<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
  megaphone: '<path d="M3 11l18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  pause: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9M14 15V9"/>',
  alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3L2 6M22 6l-3-3"/>',
  transfer: '<path d="M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
  removed: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  nextStation: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8l4 4-4 4"/>',
  graduate: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5M22 10v6"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  blocked: '<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'
};

function notifIconSvg(name, size) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (NOTIF_ICON_PATHS[name] || NOTIF_ICON_PATHS.bell) + '</svg>';
}

// The icon box of one notification: the icon in its tone's colours (info, alert, good, danger).
function notifIconHtml(boxClass, icon, size) {
  return '<span class="' + boxClass + ' notif-tone-' + (icon.tone || "info") + '" aria-hidden="true">' + notifIconSvg(icon.name, size) + '</span>';
}

// Staff inbox items are tickets: an enrollment, a transfer in, or a new ticket.
function staffNotifIcon(ticket) {
  if (ticket.enrollment === true) return { name: "graduate", tone: "info" };
  if (ticket.transferredFrom) return { name: "transfer", tone: "info" };
  return { name: "people", tone: "info" };
}

// The big bell over "You're all caught up".
function notifEmptyIconHtml(size) {
  return '<span class="notif-empty-icon" aria-hidden="true">' + notifIconSvg("bell", size) + '</span>';
}

var NOTIF_DROPDOWN_LIMIT = 15;
var notifDropdown = { kind: "", tab: "all", scroll: 0 };

// What each inbox provides. Items are { id, icon: { name, tone }, title, detail, ms, unread }.
var NOTIF_DROPDOWN_SOURCES = {
  student: {
    bell: function () { return document.getElementById("udNotifBell"); },
    loaded: function () { return userNotifState.loaded; },
    error: function () { return userNotifState.error; },
    items: function () {
      return userNotifState.items.map(function (item) {
        return { id: item.id, icon: userNotifIcon(item.type), title: item.title || "QFicient", detail: item.body || "", ms: item.ms, unread: !item.read };
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
          icon: staffNotifIcon(t),
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
  if (typeof closeProfileMenu === "function") closeProfileMenu();
  notifDropdown ={ kind: kind, tab: "all", scroll: 0 };
  notifDropdownOpenedAt = Date.now();
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
    bodyHtml = '<p class="nd-empty">' + notifEmptyIconHtml(30) + (notifDropdown.tab === "unread" ? "You're all caught up" : "No notifications yet") + '</p>';
  } else {
    bodyHtml = groups.map(function (group) {
      return '<p class="nd-group">' + group.label + '</p>' + group.items.map(function (item) {
        var id = escapeHtml(item.id);
        return '<button type="button" class="nd-item' + (item.unread ? ' is-unread' : '') + '" onclick="notifDropdownOpenItem(\'' + id + '\')">' +
          notifIconHtml("nd-icon", item.icon, 22) +
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

// Closes on a click outside, Escape, scrolling the page, or a page change.
var notifDropdownOpenedAt = 0;

// Scrolling the page (or the admin console's scrolling area) closes it, since the bell scrolls away from it.
// Scrolling the dropdown's own list doesn't, and neither does a small scroll the opening tap itself can cause.
document.addEventListener("scroll", function (event) {
  if (!notifDropdown.kind || Date.now() - notifDropdownOpenedAt < 300) return;
  var target = event.target;
  if (target && target.nodeType === 1 && target.closest("#notifDropdown")) return;
  closeNotifDropdown();
}, true);

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
