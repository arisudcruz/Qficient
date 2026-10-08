// Layout only: placeholder notifications until the real data is wired up.
var notificationGroups = [
  {
    label: "Today",
    items: [
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "Just Now" },
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "a minute ago" },
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "23 minutes ago" }
    ]
  },
  {
    label: "Earlier",
    items: [
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "2h" },
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "15h" },
      { title: "New Queue Request", detail: "R-025 - Request for Transcript of Records", time: "1d" }
    ]
  }
];

function renderNotifications() {
  var area = document.getElementById("adminNotificationsArea");
  if (!area) return;

  var groupsHtml = notificationGroups.map(function (group, index) {
    var controlsHtml = index === 0 ?
      '<div class="notif-controls">' +
        '<button type="button" class="notif-mark-all">Mark All Read</button>' +
        '<div class="notif-tabs" role="tablist">' +
          '<button type="button" class="notif-tab active" role="tab">Unread</button>' +
          '<button type="button" class="notif-tab" role="tab">Read</button>' +
        '</div>' +
      '</div>' : '';

    var cardsHtml = group.items.map(function (item) {
      return '<article class="notif-card">' +
        '<span class="notif-icon" aria-hidden="true">👥</span>' +
        '<div class="notif-copy">' +
          '<p class="notif-title">' + escapeAdminText(item.title) + '</p>' +
          '<p class="notif-detail">' + escapeAdminText(item.detail) + '</p>' +
        '</div>' +
        '<div class="notif-side">' +
          '<button type="button" class="notif-menu-btn" aria-label="More options">•••</button>' +
          '<span class="notif-time">' + escapeAdminText(item.time) + '</span>' +
        '</div>' +
      '</article>';
    }).join("");

    return '<section class="notif-group">' +
      '<div class="notif-group-head"><h2 class="notif-group-title">' + escapeAdminText(group.label) + '</h2>' + controlsHtml + '</div>' +
      '<div class="notif-list">' + cardsHtml + '</div>' +
    '</section>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Notifications</div>' +
      '<div class="settings-header-user"><span>QFicient Admin</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>' +
    groupsHtml;
}
