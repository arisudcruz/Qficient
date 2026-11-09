// The profile menu at the top right of every console page: the signed-in person's initials, name and role open a
// small menu with Change Password, Activity History and Logout.
//
// The page headers are rebuilt on every live update, so the menu isn't inside them: it is one panel on <body>,
// placed under whichever profile button is showing (like the notifications dropdown, js/notif-dropdown.js).

var profileMenuOpenedAt = 0;

// "Juan Dela Cruz" (or the role, for an account without a saved name, e.g. the built-in admin).
function adminProfileName() {
  return adminName || adminRoleLabel();
}

// The line under the name: "Administrator", "Queue Enforcer", "Cashier Staff".
function adminProfileRole() {
  if (adminKind() === "admin") return "Administrator";
  return adminName ? adminRoleLabel() : "Staff";
}

function adminProfileInitials() {
  var words = String(adminProfileName()).replace(/[^A-Za-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  var first = words[0].charAt(0);
  var last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

var PROFILE_ICONS = {
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2.5 2.5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>'
};

function profileIconSvg(name, size) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + PROFILE_ICONS[name] + '</svg>';
}

// The button in the header (part of adminHeaderRightHtml, js/admin-console.js).
function adminProfileButtonHtml() {
  var open = !!document.getElementById("adminProfileMenu") && !document.getElementById("adminProfileMenu").hidden;
  return '<button type="button" class="admin-profile-btn' + (open ? ' is-open' : '') + '" aria-haspopup="menu" aria-expanded="' + (open ? 'true' : 'false') + '" ' +
      'title="Account" onclick="toggleProfileMenu(event)">' +
    '<span class="admin-profile-avatar" aria-hidden="true">' + escapeAdminText(adminProfileInitials()) + '</span>' +
    '<span class="admin-profile-text">' +
      '<span class="admin-header-name">' + escapeAdminText(adminProfileName()) + '</span>' +
      '<span class="admin-profile-role">' + escapeAdminText(adminProfileRole()) + '</span>' +
    '</span>' +
    '<span class="admin-profile-chevron">' + profileIconSvg("chevron", 14) + '</span>' +
  '</button>';
}

// A name change (an admin editing their own name in Settings) shows in every header right away.
function refreshAdminProfileButtons() {
  document.querySelectorAll(".admin-profile-btn").forEach(function (button) {
    button.outerHTML = adminProfileButtonHtml();
  });
  var menu = document.getElementById("adminProfileMenu");
  if (menu && !menu.hidden) renderProfileMenu();
}

function visibleProfileButton() {
  return Array.prototype.find.call(document.querySelectorAll(".admin-profile-btn"), function (button) {
    return button.offsetParent !== null;
  }) || null;
}

function profileMenuPanel() {
  var panel = document.getElementById("adminProfileMenu");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "adminProfileMenu";
    panel.className = "admin-profile-menu";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "Account");
    panel.hidden = true;
    panel.addEventListener("click", function (event) { event.stopPropagation(); });
    document.body.appendChild(panel);
  }
  return panel;
}

function renderProfileMenu() {
  var panel = profileMenuPanel();
  var button = visibleProfileButton();
  if (!button || !adminUser) {
    closeProfileMenu();
    return;
  }

  panel.innerHTML =
    '<div class="apm-head">' +
      '<span class="admin-profile-avatar apm-avatar" aria-hidden="true">' + escapeAdminText(adminProfileInitials()) + '</span>' +
      '<span class="apm-who">' +
        '<strong>' + escapeAdminText(adminProfileName()) + '</strong>' +
        '<span>' + escapeAdminText(adminProfileRole()) + '</span>' +
      '</span>' +
    '</div>' +
    '<button type="button" role="menuitem" class="apm-item" onclick="profileMenuChangePassword()">' +
      profileIconSvg("key", 17) + '<span>Change Password</span></button>' +
    '<button type="button" role="menuitem" class="apm-item" onclick="profileMenuActivity()">' +
      profileIconSvg("history", 17) + '<span>Activity History</span></button>' +
    '<div class="apm-sep" role="separator"></div>' +
    '<button type="button" role="menuitem" class="apm-item apm-danger" onclick="profileMenuLogout()">' +
      profileIconSvg("logout", 17) + '<span>Logout</span></button>';

  panel.hidden = false;
  placeProfileMenu(panel, button);

  document.querySelectorAll(".admin-profile-btn").forEach(function (b) {
    b.classList.toggle("is-open", b === button);
    b.setAttribute("aria-expanded", b === button ? "true" : "false");
  });
}

// Under the button, right edges lined up; on a phone it spans the screen below the header.
function placeProfileMenu(panel, button) {
  var rect = button.getBoundingClientRect();
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

function toggleProfileMenu(event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById("adminProfileMenu");
  if (panel && !panel.hidden) {
    closeProfileMenu();
    return;
  }
  if (typeof closeNotifDropdown === "function") closeNotifDropdown();
  profileMenuOpenedAt = Date.now();
  renderProfileMenu();
}

function closeProfileMenu() {
  var panel = document.getElementById("adminProfileMenu");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.innerHTML = "";
  document.querySelectorAll(".admin-profile-btn").forEach(function (b) {
    b.classList.remove("is-open");
    b.setAttribute("aria-expanded", "false");
  });
}

function profileMenuChangePassword() {
  closeProfileMenu();
  openChangePasswordModal();
}

// Admins: the whole Audit Trail. Staff: their own entries (js/admin-audit.js).
function profileMenuActivity() {
  closeProfileMenu();
  setAdminSection("audit");
}

function profileMenuLogout() {
  closeProfileMenu();
  confirmAdminLogout();
}

document.addEventListener("click", function (event) {
  if (event.target.closest && event.target.closest("#adminProfileMenu, .admin-profile-btn")) return;
  closeProfileMenu();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeProfileMenu();
});

// Scrolling the page moves the button away from the menu; a small scroll the opening tap itself causes doesn't count.
document.addEventListener("scroll", function (event) {
  if (Date.now() - profileMenuOpenedAt < 300) return;
  var target = event.target;
  if (target && target.nodeType === 1 && target.closest("#adminProfileMenu")) return;
  closeProfileMenu();
}, true);

window.addEventListener("resize", function () {
  var panel = document.getElementById("adminProfileMenu");
  if (panel && !panel.hidden) renderProfileMenu();
});

window.addEventListener("hashchange", closeProfileMenu);
