function closeConfirmModal() {
  var overlay = document.getElementById("confirmModal");
  if (overlay) overlay.remove();
}

function showConfirmModal(options) {
  closeConfirmModal();

  var toneClass = options.tone === "danger" ? "confirm-modal-btn-danger" : "confirm-modal-btn-primary";

  var overlay = document.createElement("div");
  overlay.className = "confirm-modal-backdrop";
  overlay.id = "confirmModal";
  overlay.innerHTML =
    '<div class="confirm-modal-card">' +
      '<button type="button" class="confirm-modal-close" aria-label="Close">✕</button>' +
      '<h2 class="confirm-modal-title">' + escapeAdminText(options.title) + '</h2>' +
      '<p class="confirm-modal-message">' + escapeAdminText(options.message) + '</p>' +
      '<div class="confirm-modal-actions">' +
        '<button type="button" class="confirm-modal-btn confirm-modal-btn-cancel">No</button>' +
        '<button type="button" class="confirm-modal-btn ' + toneClass + '">Yes, ' + escapeAdminText(options.confirmLabel) + '</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  overlay.querySelector(".confirm-modal-close").addEventListener("click", closeConfirmModal);
  overlay.querySelector(".confirm-modal-btn-cancel").addEventListener("click", closeConfirmModal);
  var confirmButton = overlay.querySelector("." + toneClass);
  confirmButton.addEventListener("click", function () {
    var result = options.onConfirm();
    // When the action returns its save, keep the dialog open with a spinner until it finishes.
    if (result && typeof result.then === "function") {
      setButtonLoading(confirmButton, true);
      overlay.querySelector(".confirm-modal-btn-cancel").disabled = true;
      result.then(closeConfirmModal, closeConfirmModal);
    } else {
      closeConfirmModal();
    }
  });
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeConfirmModal();
  });
  document.addEventListener("keydown", function handleEscape(event) {
    if (event.key === "Escape") {
      closeConfirmModal();
      document.removeEventListener("keydown", handleEscape);
    }
  });
}

// The right side of every admin page header: notification bell, who is signed in, and Logout.
function adminHeaderRightHtml() {
  var onInbox = typeof currentAdminSection === "function" && currentAdminSection() === "notifications";

  return '<div class="admin-header-right">' +
    staffSoundButtonHtml() +
    '<button type="button" class="admin-bell' + (onInbox ? ' active' : '') + '" title="Notifications" aria-label="Notifications" aria-haspopup="dialog" onclick="toggleNotifDropdown(\'admin\', event)">' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' +
      '<span class="admin-bell-badge" data-notif-badge hidden></span>' +
    '</button>' +
    '<button type="button" class="admin-theme-btn" title="Light / dark mode" aria-label="Switch between light and dark mode" onclick="toggleTheme()">' +
      '<svg class="admin-theme-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
      '<svg class="admin-theme-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
    '</button>' +
    '<span class="admin-header-divider" aria-hidden="true"></span>' +
    '<span class="admin-header-name">' + escapeAdminText(adminDisplayName()) + '</span>' +
    '<button type="button" class="settings-logout" onclick="confirmAdminLogout()">Logout</button>' +
  '</div>';
}

// The student-type filter above the queue lists (Queue Management and Queue Enforcer). It only hides rows;
// Call Next and the queue order are unchanged. A ticket without a known type counts as Regular, as in the list.
var QUEUE_TYPE_FILTERS = [
  { value: "", label: "All Types" },
  { value: "regular", label: "Regular" },
  { value: "transferee", label: "Transferee / Irregular" },
  { value: "freshman", label: "Incoming Freshman" },
  { value: "guest", label: "Guest" },
  { value: "enrollment", label: "Enrollment" }
];

function ticketTypeOf(ticket) {
  return ticket.studentType === "transferee" || ticket.studentType === "freshman" || ticket.studentType === "guest" ? ticket.studentType : "regular";
}

// "enrollment" picks enrollment tickets of any student type.
function ticketMatchesTypeFilter(ticket, filter) {
  if (filter === "enrollment") return ticket.enrollment === true;
  return !filter || ticketTypeOf(ticket) === filter;
}

function queueTypeFilterHtml(selected, onchange) {
  return '<select class="queue-type-filter" aria-label="Show student type" onchange="' + onchange + '">' +
    QUEUE_TYPE_FILTERS.map(function (option) {
      return '<option value="' + option.value + '"' + (option.value === selected ? ' selected' : '') + '>' + option.label + '</option>';
    }).join("") +
  '</select>';
}

function queueTypeFilterLabel(filter) {
  var option = QUEUE_TYPE_FILTERS.find(function (o) { return o.value === filter; });
  return option ? option.label : "";
}

function escapeAdminText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Dates on the dashboard and in Reports are Philippine queue days (UTC+8), whatever timezone the staff computer is set to.
function getAdminToday() {
  return queueDayKey(Date.now());
}

function getAdminDate(value, endOfDay) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;

  var startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - QUEUE_TZ_OFFSET_MS;
  return new Date(endOfDay ? startMs + DAY_MS - 1 : startMs);
}

function getTicketDate(ticket) {
  if (!ticket.createdAt) return null;
  if (typeof ticket.createdAt.toDate === "function") return ticket.createdAt.toDate();
  var date = new Date(ticket.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getStationName(stationId) {
  var station = (stations || []).find(function (item) { return item.id === stationId; });
  return station ? station.name : stationId || "Unknown";
}

function formatAdminStatus(status) {
  if (status === "skipped") return "On Hold";
  return (status || "waiting").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
}

// Phones and tablets (up to 1180px): the sidebar is a drawer opened from the menu button in the top bar.
function openAdminNav() {
  var shell = document.querySelector("#pageAdmin .admin-shell");
  if (shell) shell.classList.add("nav-open");
}

function closeAdminNav() {
  var shell = document.querySelector("#pageAdmin .admin-shell");
  if (shell) shell.classList.remove("nav-open");
}

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeAdminNav();
});

function toggleSidebar() {
  var shell = document.querySelector("#pageAdmin .admin-shell");
  var toggle = document.querySelector("#pageAdmin .sidebar-toggle");
  var collapsed = shell.classList.toggle("sidebar-collapsed");

  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}

var ADMIN_SECTION_AREAS = {
  dashboard: "adminArea",
  queue: "adminQueueArea",
  enforcer: "adminEnforcerArea",
  notifications: "adminNotificationsArea",
  liveboard: "adminLiveBoardArea",
  reports: "adminReportsArea",
  rules: "adminRulesArea",
  settings: "adminSettingsArea",
  enrollmentsettings: "adminEnrollmentSettingsArea"
};

// Which pages each kind of account can open. Admins have no restrictions. Everyone sees the Dashboard and
// Notifications; the Enforcer adds the Queue Enforcer page, Queue Management staff add Queue Management
// (their own station only); both can read the Rules but never open Settings.
var ADMIN_ROLE_SECTIONS = {
  admin: ["dashboard", "queue", "enforcer", "notifications", "liveboard", "reports", "rules", "settings", "enrollmentsettings"],
  enforcer: ["dashboard", "notifications", "liveboard", "enforcer", "rules"],
  station: ["dashboard", "queue", "notifications", "liveboard", "reports", "rules"]
};

// Where each kind of account lands after signing in.
var ADMIN_HOME_SECTION = { admin: "dashboard", enforcer: "enforcer", station: "queue" };

// Forget what the previous person had open (tabs, filters, drafts) so the next person on this browser starts clean.
function resetAdminPageState() {
  dashStation = "all";
  rulesActiveTab = "general";
  enforcerFilter = "";
  enforcerSelection = {};
  enforcerDraft = emptyEnforcerDraft("");
  queueSelection = {};
  queueTypeFilter = "";
  resetQueueTransfer();
  enrollmentFlowDrafts = {};
  enrollmentSettingsType = "regular";
  settingsSelectedRole = "admin";
  settingsRoleDrafts = {};
  settingsTimeoutDraft = null;
  resetReportState();
}

function canOpenSection(section) {
  var kind = adminKind();
  return !kind || ADMIN_ROLE_SECTIONS[kind].indexOf(section) !== -1;
}

function applyAdminAccess() {
  var kind = adminKind();

  document.querySelectorAll("#pageAdmin .nav-item[data-section], #pageAdmin .tool-item[data-section]").forEach(function (item) {
    item.style.display = canOpenSection(item.getAttribute("data-section")) ? "" : "none";
  });

  var toolLabel = document.querySelector("#pageAdmin .tool-label");
  if (toolLabel) toolLabel.style.display = canOpenSection("rules") || canOpenSection("settings") ? "" : "none";

  var badge = document.querySelector("#pageAdmin .user-badge");
  var meta = document.querySelector("#pageAdmin .user-meta");
  if (badge) badge.textContent = kind === "enforcer" ? "QE" : (kind === "station" ? getStationName(adminRole).slice(0, 2).toUpperCase() : "AU");
  if (meta) meta.textContent = kind === "enforcer" ? "Queue Enforcer" : (kind === "station" ? getStationName(adminRole) + " Staff" : "Admin User");

  if (kind === "station") {
    activeQueueStation = adminRole;
    resetQueueTransfer();
    queueSelection = {};
  }

  if (kind && kind !== "admin") setAdminSection(ADMIN_HOME_SECTION[kind]);
}

function setAdminSection(section) {
  if (!canOpenSection(section)) section = ADMIN_HOME_SECTION[adminKind()];
  closeAdminNav();

  Object.keys(ADMIN_SECTION_AREAS).forEach(function (key) {
    var area = document.getElementById(ADMIN_SECTION_AREAS[key]);
    if (area) area.style.display = key === section ? "" : "none";
  });

  document.querySelectorAll("#pageAdmin [data-section]").forEach(function (item) {
    item.classList.toggle("active", item.getAttribute("data-section") === section);
  });

  if (typeof syncRoute === "function") syncRoute(false);

  if (section === "queue") {
    renderQueueManagement();
    startAutoVoidWatcher();
    return;
  }

  stopAutoVoidWatcher();
  if (section === "settings") {
    renderSettings();
  } else if (section === "enrollmentsettings") {
    renderEnrollmentSettings();
  } else if (section === "enforcer") {
    renderEnforcer();
  } else if (section === "notifications") {
    renderNotifications();
  } else if (section === "liveboard") {
    renderLiveBoardLauncher();
  } else if (section === "reports") {
    renderReports();
  } else if (section === "rules") {
    renderRules();
  } else {
    updateAdmin();
  }
}
