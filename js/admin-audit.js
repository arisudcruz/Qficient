// Audit Trail: what admins and staff did. The entries are written by the server (functions/lib/audit.js) from the
// account that made each change, so they can't be skipped or faked; this page only reads them. Admins see everyone;
// the Queue Enforcer and station staff see only their own ("Activity History", opened from the profile menu). Sign-in and sign-out are the only entries
// the browser writes (logAccountEvent), and firestore.rules only lets it write them for the person signed in.

var AUDIT_PAGE_SIZE = 200;
var AUDIT_CATEGORIES = [
  { value: "", label: "All Activity" },
  { value: "queue", label: "Queue Actions" },
  { value: "walkin", label: "Walk-ins" },
  { value: "station", label: "Stations" },
  { value: "staff", label: "Staff" },
  { value: "settings", label: "Settings" },
  { value: "account", label: "Sign-in / Sign-out" }
];

var AUDIT_ACTION_LABELS = {
  call: "Called", complete: "Completed", hold: "On Hold", lastCall: "Last Call", recall: "Recalled", prioritize: "Prioritized",
  remove: "Removed", autoVoid: "Auto-voided", closedVoid: "Voided at Closing", cancel: "Cancelled", verify: "Verified", create: "Created", enrollmentNext: "Enrollment Hand-off",
  transfer: "Transferred", walkinPass: "Walk-in QR", manualTicket: "Manual Ticket", stationCreate: "Station Added", stationEdit: "Station Edited",
  stationDelete: "Station Deleted", staffAdd: "Staff Added", staffRole: "Role Changed", staffEdit: "Staff Edited",
  staffRemove: "Staff Removed", passwordReset: "Password Reset", passwordChange: "Password Changed", unblock: "Block Lifted", settingsTimeout: "Timeout Changed", windowHours: "Window Hours",
  enrollmentFlow: "Enrollment Process", enrollmentOpen: "Enrollment On/Off", roleRules: "Role Rules",
  limitRequest: "Limit Request", limitRequestCancel: "Limit Request Cancelled", limitApprove: "Limit Approved", limitReject: "Limit Rejected", liveBoard: "Live Board Preset", signIn: "Signed In", signOut: "Signed Out",
  accountLocked: "Account Locked", accountUnlocked: "Account Unlocked"
};

var auditState = null;

function auditIsAdmin() {
  return adminKind() === "admin";
}

function freshAuditState() {
  var today = getAdminToday();
  var weekAgo = queueDayKey(getAdminDate(today).getTime() - 6 * DAY_MS);
  return { from: weekAgo, to: today, actor: "", category: "", search: "", items: [], cursor: null, loading: false, done: false, loaded: false, error: "" };
}

function resetAuditState() {
  auditState = null;
}

/* ---------- Loading ---------- */

function auditQuery() {
  var s = auditState;
  var fromMs = getAdminDate(s.from).getTime();
  var toMs = getAdminDate(s.to, true).getTime();
  var q = db.collection("auditLogs");
  // Staff may only read their own entries, and the database checks it: the query must ask for exactly those.
  if (!auditIsAdmin()) q = q.where("actorEmail", "==", staffKey(adminUser.email));
  return q.where("at", ">=", firebase.firestore.Timestamp.fromMillis(fromMs))
    .where("at", "<=", firebase.firestore.Timestamp.fromMillis(toMs))
    .orderBy("at", "desc");
}

function loadAudit(more) {
  var s = auditState;
  if (!s || s.loading) return;
  if (!getAdminDate(s.from) || !getAdminDate(s.to) || s.from > s.to) {
    say("Please choose a valid date range (From must be on or before To).");
    return;
  }

  if (!more) {
    s.items = [];
    s.cursor = null;
    s.done = false;
  }
  s.loading = true;
  s.error = "";
  renderAudit();

  var q = auditQuery().limit(AUDIT_PAGE_SIZE);
  if (more && s.cursor) q = q.startAfter(s.cursor);

  q.get().then(function (snapshot) {
    if (auditState !== s) return;
    snapshot.docs.forEach(function (doc) {
      var d = doc.data();
      s.items.push(Object.assign({ id: doc.id, ms: timestampToMs(d.at, Date.now()) }, d));
    });
    s.cursor = snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : s.cursor;
    s.done = snapshot.docs.length < AUDIT_PAGE_SIZE;
    s.loaded = true;
  }).catch(function (error) {
    console.error("Could not load the audit trail: " + error.message);
    s.error = "Could not load the audit trail. Please try again.";
  }).then(function () {
    s.loading = false;
    renderAudit();
  });
}

/* ---------- Filters (in the browser, over what is loaded) ---------- */

function onAuditInput(field, value) {
  auditState[field] = value;
  if (field === "from" || field === "to") loadAudit(false);
  else renderAudit();
}

function auditVisibleItems() {
  var s = auditState;
  var words = String(s.search || "").trim().toLowerCase();
  return s.items.filter(function (item) {
    if (s.actor && item.actorEmail !== s.actor) return false;
    if (s.category && item.category !== s.category) return false;
    if (!words) return true;
    return [item.summary, item.actorName, item.actorUsername, item.actorRole, item.targetId, AUDIT_ACTION_LABELS[item.action]]
      .join(" ").toLowerCase().indexOf(words) !== -1;
  });
}

function auditStaffChoices() {
  var seen = {};
  auditState.items.forEach(function (item) {
    if (!seen[item.actorEmail]) seen[item.actorEmail] = item.actorName || item.actorUsername || item.actorEmail;
  });
  return Object.keys(seen).map(function (email) { return { email: email, label: seen[email] }; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });
}

/* ---------- Showing ---------- */

function auditTimeText(ms) {
  return new Date(ms).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit"
  });
}

function auditActorHtml(item) {
  return '<span class="settings-strong">' + escapeAdminText(item.actorName || item.actorUsername || item.actorEmail) + '</span>' +
    '<span class="audit-sub">' + escapeAdminText([item.actorUsername, item.actorRole].filter(Boolean).join(" · ")) + '</span>';
}

function renderAudit() {
  var area = document.getElementById("adminAuditArea");
  if (!area) return;
  if (!auditState) {
    auditState = freshAuditState();
    loadAudit(false);
    return;
  }

  var s = auditState;
  var admin = auditIsAdmin();
  var title = admin ? "Audit Trail" : "Activity History";
  var visible = auditVisibleItems();

  var staffOptions = '<option value="">All Staff</option>' + auditStaffChoices().map(function (choice) {
    return '<option value="' + escapeAdminText(choice.email) + '"' + (choice.email === s.actor ? ' selected' : '') + '>' + escapeAdminText(choice.label) + '</option>';
  }).join("");
  var categoryOptions = AUDIT_CATEGORIES.map(function (c) {
    return '<option value="' + c.value + '"' + (c.value === s.category ? ' selected' : '') + '>' + c.label + '</option>';
  }).join("");

  var rowsHtml = visible.map(function (item) {
    return '<tr>' +
      '<td class="audit-time">' + escapeAdminText(auditTimeText(item.ms)) + '</td>' +
      (admin ? '<td>' + auditActorHtml(item) + '</td>' : '') +
      '<td><span class="audit-tag audit-tag-' + escapeAdminText(item.category) + '">' + escapeAdminText(AUDIT_ACTION_LABELS[item.action] || item.action) + '</span></td>' +
      '<td class="audit-summary">' + escapeAdminText(item.summary) + '</td>' +
    '</tr>';
  }).join("");

  var emptyText = s.loading && !s.items.length ? "Loading activity..." :
    s.error ? s.error :
    s.items.length ? "No activity matches these filters." : "No activity recorded in this date range.";
  if (!rowsHtml) rowsHtml = '<tr><td colspan="' + (admin ? 4 : 3) + '" class="empty-row">' + escapeAdminText(emptyText) + '</td></tr>';

  var countText = visible.length === s.items.length ?
    s.items.length + (s.done ? "" : "+") + " entr" + (s.items.length === 1 ? "y" : "ies") :
    visible.length + " of " + s.items.length + (s.done ? "" : "+") + " loaded";

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">' + title + '</div>' +
      adminHeaderRightHtml() +
    '</div>' +
    '<p class="settings-sub audit-intro">' + (admin ?
      'Everything admins and staff did: queue actions, walk-in QR codes, changes to stations, staff, settings and role rules, and sign-ins. Recorded by the server, kept for 90 days.' :
      'What you did in QFicient over the last 90 days: queue actions, walk-in QR codes and sign-ins.') + '</p>' +

    '<section class="panel settings-panel">' +
      '<div class="report-filters audit-filters">' +
        '<label>From<input type="date" value="' + escapeAdminText(s.from) + '" onchange="onAuditInput(\'from\', this.value)"></label>' +
        '<label>To<input type="date" value="' + escapeAdminText(s.to) + '" onchange="onAuditInput(\'to\', this.value)"></label>' +
        (admin ? '<label>Staff<select onchange="onAuditInput(\'actor\', this.value)">' + staffOptions + '</select></label>' : '') +
        '<label>Activity<select onchange="onAuditInput(\'category\', this.value)">' + categoryOptions + '</select></label>' +
        '<label class="audit-search">Search<input type="search" placeholder="Ticket no., name, action…" value="' + escapeAdminText(s.search) + '" oninput="onAuditSearch(this.value)"></label>' +
        '<span class="report-filters-spacer"></span>' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="loadAudit(false)"' + (s.loading ? ' disabled' : '') + '>Refresh</button>' +
      '</div>' +
      '<p class="audit-count">' + escapeAdminText(countText) + '</p>' +
      '<div class="table-wrap"><table class="queue-table settings-table audit-table"><thead><tr>' +
        '<th>Date &amp; Time</th>' + (admin ? '<th>Staff</th>' : '') + '<th>Action</th><th>Details</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      (!s.done && s.items.length ?
        '<div class="audit-more"><button type="button" class="settings-btn settings-btn-blue" onclick="loadAudit(true)"' + (s.loading ? ' disabled' : '') + '>' +
          (s.loading ? 'Loading…' : 'Load more') + '</button></div>' : '') +
    '</section>';
}

// Typing in Search keeps the focus (only the table needs redrawing, but the whole page is cheap to redraw).
function onAuditSearch(value) {
  auditState.search = value;
  var input = document.activeElement;
  var caret = input && input.selectionStart;
  renderAudit();
  var again = document.querySelector("#adminAuditArea .audit-search input");
  if (again) {
    again.focus();
    try { again.setSelectionRange(caret, caret); } catch (e) {}
  }
}

/* ---------- Sign-in / sign-out ---------- */

// The only entries the browser writes; firestore.rules accepts them only for the person signed in.
function logAccountEvent(action) {
  if (!adminUser) return Promise.resolve();
  var signingIn = action === "signIn";
  return db.collection("auditLogs").add({
    at: firebase.firestore.FieldValue.serverTimestamp(),
    actorEmail: staffKey(adminUser.email),
    actorUsername: usernameOfEmail(adminUser.email) || "",
    actorName: adminName || "",
    actorRole: adminRoleLabel(),
    category: "account",
    action: signingIn ? "signIn" : "signOut",
    summary: signingIn ? "Signed in to the admin console" : "Signed out of the admin console"
  }).catch(function (error) {
    console.error("Could not record the " + action + ": " + error.message);
  });
}
