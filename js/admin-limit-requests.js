// Daily limit requests. Station staff ask for a daily queue limit on one date for their own station (sidebar →
// Staff Tools → Request a Limit); an administrator approves or rejects it in Settings → Limit Requests. Approving
// saves the limit on the station as dayLimits[date], which wins over its normal maxQueue on that date only
// (stationLimitFor, js/queue.js; the server checks the same in functions/lib/join.js).
//
// limitRequests/{id}: { stationId, day "YYYY-MM-DD" (Philippine date), limit, reason, status pending|approved|rejected,
// requestedBy, requestedByName, createdAt, decidedBy, decidedAt, decisionNote }. firestore.rules lets staff create
// one for their own station and cancel it while pending, and only admins decide. Audited by the server.

var LIMIT_REQUEST_MAX = 9999;
var LIMIT_REQUEST_DAYS_AHEAD = 30;

var limitRequests = [];          // admins: the pending ones; station staff: their station's
var limitRequestsUnsubscribe = null;

function startLimitRequestsListener() {
  if (limitRequestsUnsubscribe || !adminUser) return;
  var kind = adminKind();
  var query = kind === "admin" ? db.collection("limitRequests").where("status", "==", "pending") :
    kind === "station" ? db.collection("limitRequests").where("stationId", "==", adminRole) : null;
  if (!query) return;

  limitRequestsUnsubscribe = query.onSnapshot(function (snapshot) {
    limitRequests = snapshot.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
    onLimitRequestsChanged();
  }, function (error) {
    console.error("Could not load limit requests: " + error.message);
  });
}

function stopLimitRequestsListener() {
  if (limitRequestsUnsubscribe) {
    limitRequestsUnsubscribe();
    limitRequestsUnsubscribe = null;
  }
  limitRequests = [];
  updateLimitRequestsBadge();
}

function onLimitRequestsChanged() {
  updateLimitRequestsBadge();
  if (adminKind() === "admin") {
    if (typeof refreshSettings === "function") refreshSettings();
  } else {
    // The request form, if open, keeps its list current.
    var list = document.getElementById("limitReqList");
    if (list) list.innerHTML = myLimitRequestsHtml();
  }
}

/* ---------- Dates ---------- */

function limitToday() {
  return queueDayKey(Date.now());
}

function limitDayPlus(days) {
  return queueDayKey(Date.now() + days * DAY_MS);
}

// "2026-11-12" -> "Thu, Nov 12, 2026".
function limitDayText(day) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return String(day || "");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric"
  });
}

function limitText(limit) {
  return limit > 0 ? limit + (limit === 1 ? " ticket" : " tickets") : "No limit";
}

function isLimitRequestExpired(request) {
  return request.day < limitToday();
}

/* ---------- Admin: sidebar badge and the Settings panel ---------- */

// Soonest date first; ones whose date has passed go last.
function pendingLimitRequests() {
  return limitRequests.filter(function (r) { return r.status === "pending"; })
    .sort(function (a, b) {
      var ea = isLimitRequestExpired(a), eb = isLimitRequestExpired(b);
      if (ea !== eb) return ea ? 1 : -1;
      return a.day < b.day ? -1 : a.day > b.day ? 1 : timestampToMs(a.createdAt, 0) - timestampToMs(b.createdAt, 0);
    });
}

// Admins: requests waiting for a decision (on Settings). Station staff: their station's requests still waiting
// (on Staff Tools → Request a Limit).
function updateLimitRequestsBadge() {
  var kind = typeof adminKind === "function" ? adminKind() : null;
  var waiting = pendingLimitRequests().filter(function (r) { return !isLimitRequestExpired(r); }).length;
  setLimitBadges("[data-limit-badge]", kind === "admin" ? waiting : 0);
  setLimitBadges("[data-limit-staff-badge]", kind === "station" ? waiting : 0);
}

function setLimitBadges(selector, count) {
  document.querySelectorAll(selector).forEach(function (badge) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
  });
}

// For refreshSettings: redraw when a request comes or goes.
function limitRequestsSignature() {
  return limitRequests.map(function (r) { return [r.id, r.status, r.limit, r.day]; });
}

function limitRequestsPanelHtml() {
  var pending = pendingLimitRequests();
  if (!pending.length) return "";

  var rows = pending.map(function (r) {
    var station = stations.find(function (s) { return s.id === r.stationId; });
    var expired = isLimitRequestExpired(r);
    var id = escapeAdminText(r.id);
    var current = station ? stationLimitFor(station, r.day) : 0;

    return '<tr' + (expired ? ' class="limit-req-expired"' : '') + '>' +
      '<td class="settings-strong">' + escapeAdminText(station ? station.name : "A removed station") + '</td>' +
      '<td>' + escapeAdminText(limitDayText(r.day)) + (expired ? ' <span class="type-tag limit-tag-expired">Expired</span>' : '') + '</td>' +
      '<td class="settings-strong">' + escapeAdminText(limitText(r.limit)) + '</td>' +
      '<td>' + escapeAdminText(limitText(current)) + '</td>' +
      '<td class="limit-req-reason">' + escapeAdminText(r.reason || "—") + '</td>' +
      '<td>' + escapeAdminText(r.requestedByName || r.requestedBy || "Staff") +
        '<span class="staff-login">' + escapeAdminText(r.createdAt ? manilaDateTimeText(timestampToMs(r.createdAt, 0)) : "") + '</span></td>' +
      '<td><div class="settings-actions">' +
        (expired ?
          '<button type="button" class="settings-btn settings-btn-blue" onclick="confirmRejectLimitRequest(\'' + id + '\', true)">Dismiss</button>' :
          '<button type="button" class="settings-btn settings-btn-green" onclick="confirmApproveLimitRequest(\'' + id + '\')"' + (station ? '' : ' disabled') + '>Approve</button>' +
          '<button type="button" class="settings-btn settings-btn-red" onclick="confirmRejectLimitRequest(\'' + id + '\', false)">Reject</button>') +
      '</div></td></tr>';
  }).join("");

  return '<section class="panel settings-panel limit-req-panel">' +
    '<div class="panel-header"><h2>Limit Requests <span class="limit-req-count">' + pending.length + '</span></h2></div>' +
    '<p class="settings-help">Station staff asking for a daily queue limit on one date. Approving sets that station\'s limit for that date only; on other days its normal limit applies.</p>' +
    '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr>' +
      '<th>Station</th><th>Date</th><th>Requested</th><th>Current</th><th>Reason</th><th>Requested By</th><th>Action</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
  '</section>';
}

function findLimitRequest(id) {
  return limitRequests.find(function (r) { return r.id === id; });
}

function confirmApproveLimitRequest(id) {
  var request = findLimitRequest(id);
  var station = request && stations.find(function (s) { return s.id === request.stationId; });
  if (!request || !station || request.status !== "pending") return;
  if (isLimitRequestExpired(request)) {
    say("That date has already passed. Dismiss the request instead.");
    return;
  }

  showConfirmModal({
    title: "Approve this limit?",
    message: station.name + " will take at most " + limitText(request.limit) + " on " + limitDayText(request.day) +
      " (now: " + limitText(stationLimitFor(station, request.day)) + "). Other days keep the station's normal limit.",
    confirmLabel: "Approve",
    tone: "primary",
    onConfirm: function () { return approveLimitRequest(request, station); }
  });
}

// One batch: the request is marked approved, and the station gets the limit for that date (dates already past are
// dropped from its dayLimits at the same time).
function approveLimitRequest(request, station) {
  var today = limitToday();
  var dayLimits = {};
  Object.keys(station.dayLimits || {}).forEach(function (day) {
    if (day >= today) dayLimits[day] = station.dayLimits[day];
  });
  dayLimits[request.day] = request.limit;

  var batch = db.batch();
  batch.update(db.collection("limitRequests").doc(request.id), {
    status: "approved",
    decidedBy: staffKey(adminUser.email),
    decidedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.update(db.collection("stations").doc(station.id), { dayLimits: dayLimits });

  return batch.commit().then(function () {
    sayDone(station.name + " will take at most " + limitText(request.limit) + " on " + limitDayText(request.day) + ".");
  }).catch(function (error) {
    say("Could not approve the request: " + error.message);
  });
}

// Reject (with an optional note for the staff member), or Dismiss one whose date has passed.
function confirmRejectLimitRequest(id, expired) {
  var request = findLimitRequest(id);
  if (!request || request.status !== "pending") return;
  var station = stations.find(function (s) { return s.id === request.stationId; });
  var name = station ? station.name : "the station";

  if (expired) {
    showConfirmModal({
      title: "Dismiss this request?",
      message: "The request for " + name + " on " + limitDayText(request.day) + " is past its date. It will be marked rejected.",
      confirmLabel: "Dismiss",
      tone: "primary",
      onConfirm: function () { return rejectLimitRequest(request, "The date had passed."); }
    });
    return;
  }

  showFormModal("Reject Limit Request",
    '<div class="modal-section">' +
      '<p class="modal-help">' + escapeAdminText(name) + ' asked for ' + escapeAdminText(limitText(request.limit)) + ' on ' + escapeAdminText(limitDayText(request.day)) + '.</p>' +
      '<div class="modal-field"><label for="limitRejectNote">Note for the staff member (optional)</label>' +
        '<textarea id="limitRejectNote" class="modal-input" rows="3" maxlength="200" placeholder="Why it was rejected"></textarea></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="closeFormModal()">Cancel</button>' +
        '<button type="button" class="settings-btn settings-btn-red" id="limitRejectBtn" onclick="submitRejectLimitRequest(\'' + escapeAdminText(id) + '\')">Reject Request</button>' +
      '</div>' +
    '</div>');
}

function submitRejectLimitRequest(id) {
  var request = findLimitRequest(id);
  if (!request) {
    closeFormModal();
    return;
  }
  var note = document.getElementById("limitRejectNote").value.replace(/\s+/g, " ").trim().slice(0, 200);
  var button = document.getElementById("limitRejectBtn");
  setButtonLoading(button, true);
  rejectLimitRequest(request, note).then(function (ok) {
    setButtonLoading(button, false);
    if (ok) closeFormModal();
  });
}

function rejectLimitRequest(request, note) {
  var change = {
    status: "rejected",
    decidedBy: staffKey(adminUser.email),
    decidedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (note) change.decisionNote = note;
  return db.collection("limitRequests").doc(request.id).update(change).then(function () {
    sayDone("Request rejected.");
    return true;
  }).catch(function (error) {
    say("Could not reject the request: " + error.message);
    return false;
  });
}

/* ---------- Admin: limits for one date, in Settings → Service Station and Edit Station ---------- */

function upcomingDayLimits(station) {
  var today = limitToday();
  return Object.keys((station && station.dayLimits) || {}).filter(function (day) {
    return day >= today && Number(station.dayLimits[day]) > 0;
  }).sort();
}

// Small line under the station name in the Service Station table.
function stationDayLimitsNoteHtml(station) {
  var days = upcomingDayLimits(station);
  if (!days.length) return "";
  return '<span class="station-day-limits">' + days.map(function (day) {
    return escapeAdminText(limitDayText(day).replace(/^\w+, /, "").replace(/, \d{4}$/, "")) + ': ' + Number(station.dayLimits[day]);
  }).join(" · ") + '</span>';
}

// In Edit Station, under Maximum Service Queue: each approved date limit, with ✕ to remove it.
function stationDayLimitsEditHtml(station) {
  var days = upcomingDayLimits(station);
  if (!days.length) return "";
  return '<div class="day-limit-list"><p class="modal-help">Limits for one date (approved requests):</p>' +
    days.map(function (day) {
      return '<div class="day-limit-row" data-day="' + escapeAdminText(day) + '"><span>' + escapeAdminText(limitDayText(day)) + '</span>' +
        '<strong>' + escapeAdminText(limitText(Number(station.dayLimits[day]))) + '</strong>' +
        '<button type="button" class="settings-icon-btn settings-icon-red" title="Remove this date\'s limit" onclick="confirmRemoveDayLimit(\'' +
          escapeAdminText(station.id) + '\', \'' + escapeAdminText(day) + '\')">✕</button></div>';
    }).join("") + '</div>';
}

function confirmRemoveDayLimit(stationId, day) {
  var station = stations.find(function (s) { return s.id === stationId; });
  if (!station || !station.dayLimits || !(day in station.dayLimits)) return;

  showConfirmModal({
    title: "Remove this date's limit?",
    message: station.name + " goes back to its normal limit (" + limitText(Number(station.maxQueue) || 0) + ") on " + limitDayText(day) + ".",
    confirmLabel: "Remove",
    tone: "danger",
    onConfirm: function () {
      var change = {};
      change["dayLimits." + day] = firebase.firestore.FieldValue.delete();
      return db.collection("stations").doc(stationId).update(change).then(function () {
        var row = document.querySelector('#formModal .day-limit-row[data-day="' + day + '"]');
        if (row) row.remove();
        sayDone("The limit for " + limitDayText(day) + " was removed.");
      }).catch(function (error) {
        say("Could not remove the limit: " + error.message);
      });
    }
  });
}

/* ---------- Station staff: Staff Tools → Request a Limit ---------- */

function myLimitStation() {
  return adminKind() === "station" ? stations.find(function (s) { return s.id === adminRole; }) : null;
}

// From the sidebar: on phones the sidebar is a drawer, which closes first.
function openLimitRequestFromNav() {
  closeAdminNav();
  openLimitRequestModal();
}

// "Today: 12 / 40 tickets", or "Today: No limit", at the top of the request form.
function limitTodayLineHtml(station) {
  var today = limitToday();
  var limit = stationLimitFor(station, today);
  var used = countStationTicketsToday(station.id);
  var forToday = station.dayLimits && Number(station.dayLimits[today]) > 0;
  return '<p class="limit-today">' +
    '<span class="limit-today-label">Today</span>' +
    '<strong>' + escapeAdminText(limit > 0 ? used + " / " + limit + " tickets" : "No limit") + '</strong>' +
    (forToday ? '<span class="type-tag limit-tag-approved">Approved for today</span>' : '') +
  '</p>';
}

function limitStatusTagHtml(request) {
  if (request.status === "approved") return '<span class="type-tag limit-tag-approved">Approved</span>';
  if (request.status === "rejected") return '<span class="type-tag limit-tag-rejected">Rejected</span>';
  if (isLimitRequestExpired(request)) return '<span class="type-tag limit-tag-expired">Expired</span>';
  return '<span class="type-tag limit-tag-pending">Pending</span>';
}

// This station's requests for today and later (and pending ones that ran out), newest date first.
function myLimitRequestsHtml() {
  var me = adminUser ? staffKey(adminUser.email) : "";
  var today = limitToday();
  var shown = limitRequests.filter(function (r) { return r.day >= today || r.status === "pending"; })
    .sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : timestampToMs(b.createdAt, 0) - timestampToMs(a.createdAt, 0); });
  if (!shown.length) return '<p class="limit-req-empty">No requests yet.</p>';

  return shown.map(function (r) {
    var canCancel = r.status === "pending" && r.requestedBy === me;
    return '<div class="limit-req-item">' +
      '<div class="limit-req-main">' +
        '<strong>' + escapeAdminText(limitDayText(r.day)) + '</strong>' +
        '<span>' + escapeAdminText(limitText(r.limit)) + (r.reason ? ' · ' + escapeAdminText(r.reason) : '') + '</span>' +
        (r.decisionNote ? '<span class="limit-req-note">Admin: ' + escapeAdminText(r.decisionNote) + '</span>' : '') +
      '</div>' +
      limitStatusTagHtml(r) +
      (canCancel ? '<button type="button" class="settings-btn settings-btn-blue limit-req-cancel" onclick="confirmCancelLimitRequest(\'' + escapeAdminText(r.id) + '\')">Cancel</button>' : '') +
    '</div>';
  }).join("");
}

function openLimitRequestModal() {
  var station = myLimitStation();
  if (!station) return;
  var today = limitToday();

  showFormModal("Request a Daily Limit",
    '<div class="modal-section">' +
      limitTodayLineHtml(station) +
      '<p class="modal-help">Ask for the most tickets ' + escapeAdminText(station.name) + ' takes on one date. An administrator has to approve it before it takes effect. Normal limit: ' + escapeAdminText(limitText(Number(station.maxQueue) || 0)) + '.</p>' +
      '<div class="modal-field"><label for="limitReqDay">Date</label>' +
        '<input type="date" id="limitReqDay" class="modal-input" min="' + today + '" max="' + limitDayPlus(LIMIT_REQUEST_DAYS_AHEAD) + '" value="' + today + '"></div>' +
      '<div class="modal-field"><label for="limitReqLimit">Maximum Tickets</label>' +
        '<input type="number" id="limitReqLimit" class="modal-input" min="1" max="' + LIMIT_REQUEST_MAX + '" step="1" placeholder="e.g. 50"></div>' +
      '<div class="modal-field"><label for="limitReqReason">Reason (optional)</label>' +
        '<textarea id="limitReqReason" class="modal-input" rows="2" maxlength="200" placeholder="e.g. Only one window open that day"></textarea></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="closeFormModal()">Close</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" id="limitReqSend" onclick="sendLimitRequest()">Send Request</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">My Requests</h3>' +
      '<div id="limitReqList" class="limit-req-list">' + myLimitRequestsHtml() + '</div>' +
    '</div>');
}

function limitRequestProblem(day, limit, stationId) {
  var today = limitToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Please choose the date.";
  if (day < today) return "Choose today or a later date.";
  if (day > limitDayPlus(LIMIT_REQUEST_DAYS_AHEAD)) return "Choose a date within the next " + LIMIT_REQUEST_DAYS_AHEAD + " days.";
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_REQUEST_MAX) return "Enter a whole number from 1 to " + LIMIT_REQUEST_MAX + ".";
  if (limitRequests.some(function (r) { return r.status === "pending" && r.stationId === stationId && r.day === day; })) {
    return "There is already a pending request for " + limitDayText(day) + ". Cancel it first to ask for a different limit.";
  }
  return "";
}

function sendLimitRequest() {
  var station = myLimitStation();
  if (!station || !adminUser) return;

  var day = document.getElementById("limitReqDay").value;
  var raw = document.getElementById("limitReqLimit").value.trim();
  var limit = raw === "" ? NaN : Number(raw);
  var reason = document.getElementById("limitReqReason").value.replace(/\s+/g, " ").trim().slice(0, 200);

  var problem = limitRequestProblem(day, limit, station.id);
  if (problem) {
    say(problem);
    return;
  }

  var request = {
    stationId: station.id,
    day: day,
    limit: limit,
    status: "pending",
    requestedBy: staffKey(adminUser.email),
    requestedByName: (adminName || adminRoleLabel()).slice(0, 120),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (reason) request.reason = reason;

  var button = document.getElementById("limitReqSend");
  setButtonLoading(button, true);
  db.collection("limitRequests").add(request).then(function () {
    document.getElementById("limitReqLimit").value = "";
    document.getElementById("limitReqReason").value = "";
    sayDone("Request sent. " + limitText(limit) + " on " + limitDayText(day) + " takes effect once an administrator approves it.");
  }).catch(function (error) {
    say("Could not send the request: " + error.message);
  }).then(function () {
    setButtonLoading(button, false);
  });
}

function confirmCancelLimitRequest(id) {
  var request = findLimitRequest(id);
  if (!request || request.status !== "pending") return;

  showConfirmModal({
    title: "Cancel this request?",
    message: "The request for " + limitText(request.limit) + " on " + limitDayText(request.day) + " will be withdrawn.",
    confirmLabel: "Cancel Request",
    tone: "danger",
    onConfirm: function () {
      return db.collection("limitRequests").doc(id).delete().catch(function (error) {
        say("Could not cancel the request: " + error.message);
      });
    }
  });
}
