// Queue Enforcer: staff fill in a walk-in's details and show a one-time QR code. The walk-in scans it with their
// phone, which gets the ticket and follows it in the app until it's done (js/walkin.js, functions/lib/walkin.js).
var ENFORCER_TYPES = ["regular", "transferee", "freshman", "guest"];

// Kept here so the form survives switching sections and the list refreshing underneath it.
var ENFORCER_OTHER_PURPOSE = "__other__";

// The "Enrollment" choice in the form's Station list: the walk-in starts the enrollment process at the first station
// for their student type.
var ENFORCER_ENROLLMENT = "__enrollment__";

function enforcerIsEnrollment() {
  return enforcerDraft.stationId === ENFORCER_ENROLLMENT;
}

function enforcerEnrollmentOptionHtml() {
  if (!enrollmentStationIds().length) return "";
  return '<option value="' + ENFORCER_ENROLLMENT + '"' + (enforcerIsEnrollment() ? ' selected' : '') + '>Enrollment (by student type)</option>';
}

// Whether a change to the enrollment process should redraw the form (it is on screen).
function enforcerFormNeedsFlows() {
  var area = document.getElementById("adminEnforcerArea");
  return !!area && area.style.display !== "none" && !!document.getElementById("enforcerStation");
}

var enforcerDraft = { firstName: "", lastName: "", studentType: "", studentNumber: "", stationId: "", purpose: "", purposeOther: "" };
var enforcerFilter = "";
var enforcerTypeFilter = ""; // "" = all student types

function setEnforcerTypeFilter(value) {
  enforcerTypeFilter = value;
  enforcerSelection = {};
  refreshEnforcerList();
}

function emptyEnforcerDraft(stationId) {
  return { firstName: "", lastName: "", studentType: "", studentNumber: "", stationId: stationId || "", purpose: "", purposeOther: "" };
}

// Regular and Transferee / Irregular walk-ins are enrolled students, so their student number goes on the ticket.
var ENFORCER_NUMBERED_TYPES = ["regular", "transferee"];

function enforcerNeedsStudentNumber() {
  return ENFORCER_NUMBERED_TYPES.indexOf(enforcerDraft.studentType) !== -1;
}

// "02000-123456", "02000123456" or "02000 123456" become "02000-123456"; anything else gives "".
function normalizeStudentNumber(value) {
  var digits = String(value || "").replace(/[\s-]/g, "");
  return /^02000\d{6}$/.test(digits) ? "02000-" + digits.slice(5) : "";
}

function syncEnforcerStudentNumberField() {
  var field = document.getElementById("enforcerStudentNoField");
  if (field) field.style.display = enforcerNeedsStudentNumber() ? "" : "none";
}

// Tidies a valid number into 02000-XXXXXX when the box is left.
function onEnforcerStudentNumberBlur(input) {
  var tidy = normalizeStudentNumber(input.value);
  if (tidy) {
    input.value = tidy;
    enforcerDraft.studentNumber = tidy;
  }
}

function getEnforcerStations() {
  return getSortedStations().filter(function (station) { return station.active !== false; });
}

function getEnforcerPurposes(stationId) {
  var station = stations.find(function (s) { return s.id === stationId; });
  return station && Array.isArray(station.purposes) && station.purposes.length ? station.purposes : queueMgmtPurposes;
}

function enforcerPurposeOptionsHtml() {
  if (enforcerIsEnrollment()) return '<option value="' + ENROLLMENT_PURPOSE + '" selected>' + ENROLLMENT_PURPOSE + '</option>';

  var purposes = enforcerDraft.stationId ? getEnforcerPurposes(enforcerDraft.stationId) : [];

  var options = purposes.map(function (purpose) {
    return '<option value="' + escapeAdminText(purpose) + '"' + (purpose === enforcerDraft.purpose ? ' selected' : '') + '>' + escapeAdminText(purpose) + '</option>';
  }).join("");

  var other = enforcerDraft.stationId ?
    '<option value="' + ENFORCER_OTHER_PURPOSE + '"' + (enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ? ' selected' : '') + '>Others, please specify</option>' : '';

  return '<option value="">Select Purpose</option>' + options + other;
}

function syncEnforcerOtherField() {
  var field = document.getElementById("enforcerOtherField");
  if (field) field.style.display = enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ? "" : "none";
}

function onEnforcerInput(field, value) {
  enforcerDraft[field] = value;

  if (field === "studentType") syncEnforcerStudentNumberField();

  if (field === "stationId") {
    enforcerDraft.purpose = value === ENFORCER_ENROLLMENT ? ENROLLMENT_PURPOSE : "";
    enforcerDraft.purposeOther = "";
    var purposeSelect = document.getElementById("enforcerPurpose");
    if (purposeSelect) {
      purposeSelect.innerHTML = enforcerPurposeOptionsHtml();
      purposeSelect.disabled = !value || value === ENFORCER_ENROLLMENT;
    }
  }

  if (field === "stationId" || field === "purpose") {
    syncEnforcerOtherField();
    if (field === "purpose" && value === ENFORCER_OTHER_PURPOSE) {
      var otherInput = document.getElementById("enforcerOther");
      if (otherInput) otherInput.focus();
    }
  }
}

// The purpose that goes on the ticket: the chosen one, or what was typed for "Others".
function enforcerFinalPurpose() {
  return enforcerDraft.purpose === ENFORCER_OTHER_PURPOSE ?
    enforcerDraft.purposeOther.trim().replace(/\s+/g, " ") :
    enforcerDraft.purpose;
}

// The station picker in the Queue List header only narrows the list; the Walk-in Form has its own Station field.
function onEnforcerFilter(stationId) {
  enforcerFilter = stationId;
  enforcerSelection = {};
  refreshEnforcerList();
}

function clearEnforcerForm() {
  enforcerDraft = emptyEnforcerDraft("");
  renderEnforcer();
}

function enforcerFormProblem() {
  var d = enforcerDraft;

  if (!/\p{L}/u.test(d.firstName.trim())) return "Please enter the first name.";
  if (!/\p{L}/u.test(d.lastName.trim())) return "Please enter the last name.";
  if (ENFORCER_TYPES.indexOf(d.studentType) === -1) return "Please select the student type.";
  if (enforcerNeedsStudentNumber()) {
    if (!d.studentNumber.trim()) return "Please enter the student number (02000-XXXXXX).";
    if (!normalizeStudentNumber(d.studentNumber)) return "Please enter a valid student number, like 02000-123456.";
  }
  if (!d.stationId) return "Please select the station.";
  if (d.stationId === ENFORCER_ENROLLMENT) {
    if (ENROLLMENT_TYPES.indexOf(d.studentType) === -1) return "Enrollment is for Regular, Transferee / Irregular and Incoming Freshman students.";
    var flow = enrollmentFlowFor(d.studentType);
    if (!flow.length) return "Enrollment isn't set up for " + STUDENT_TYPE_LABELS[d.studentType] + " students yet.";
    var first = stations.find(function (s) { return s.id === flow[0]; });
    if (!first || first.active === false) return "The first enrollment station is currently unavailable.";
  }
  if (!d.purpose) return "Please select the purpose.";
  if (d.purpose === ENFORCER_OTHER_PURPOSE && !/[\p{L}\p{N}]/u.test(d.purposeOther)) return "Please specify the purpose.";
  return "";
}

/* ---------- Walk-in QR pass ---------- */

var WALKIN_PASS_MINUTES = 10; // keep in step with walkinPassMinutes in functions/config.js
var QR_LIB = { src: "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js", integrity: "sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1" };

// The pass on screen: { passId, details, createdMs, unsubscribe, timer }.
var walkinPassView = null;

function loadQrLib() {
  if (typeof qrcode === "function") return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var script = document.createElement("script");
    script.src = QR_LIB.src;
    script.integrity = QR_LIB.integrity;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = function () { script.remove(); reject(new Error("the QR code tool could not be downloaded. Check the connection.")); };
    document.head.appendChild(script);
  });
}

// 16 random bytes as URL-safe text: the part of the QR code that only the walk-in's phone ever sees.
function randomPassSecret() {
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256Hex(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  });
}

// Saves the pass (only the secret's hash is stored) and gives back what goes into the QR code.
function createWalkinPass(details) {
  if (adminRole !== "admin" && adminRole !== "enforcer") {
    say("Only an administrator or a Queue Enforcer can make walk-in tickets.");
    return Promise.resolve(null);
  }

  var secret = randomPassSecret();
  var ref = db.collection("walkinPasses").doc();

  return sha256Hex(secret).then(function (hash) {
    var pass = {
      ownerName: details.ownerName,
      studentType: details.studentType,
      stationId: details.stationId,
      purpose: details.purpose,
      secretHash: hash,
      createdBy: staffKey(adminUser.email),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (details.studentNumber) pass.studentNumber = details.studentNumber;
    if (details.enrollmentFlow) {
      pass.enrollment = true;
      pass.enrollmentFlow = details.enrollmentFlow;
    }
    return ref.set(pass);
  }).then(function () {
    var base = window.location.origin + window.location.pathname;
    return { passId: ref.id, url: base + "#/pass/" + ref.id + "." + secret };
  }).catch(function (err) {
    say("Could not make the QR code: " + err.message);
    return null;
  });
}

// What the form describes, ready for a pass.
function enforcerPassDetails() {
  var d = enforcerDraft;
  var enrolling = enforcerIsEnrollment();
  var flow = enrolling ? enrollmentFlowFor(d.studentType).slice() : null;
  return {
    ownerName: d.firstName.trim().replace(/\s+/g, " ") + " " + d.lastName.trim().replace(/\s+/g, " "),
    studentType: d.studentType,
    studentNumber: enforcerNeedsStudentNumber() ? normalizeStudentNumber(d.studentNumber) : "",
    stationId: enrolling ? flow[0] : d.stationId,
    purpose: enrolling ? ENROLLMENT_PURPOSE : enforcerFinalPurpose(),
    enrollmentFlow: flow
  };
}

function generateWalkinQr() {
  var problem = enforcerFormProblem();
  if (problem) {
    say(problem);
    return;
  }

  var details = enforcerPassDetails();
  var button = document.getElementById("enforcerGenerateBtn");
  setButtonLoading(button, true);

  showWalkinPass(details).then(function () {
    setButtonLoading(button, false);
  });
}

function showWalkinPass(details) {
  stopWalkinPassView();

  return Promise.all([loadQrLib(), createWalkinPass(details)]).then(function (results) {
    var made = results[1];
    if (!made) return;

    var qr = qrcode(0, "M");
    qr.addData(made.url);
    qr.make();

    var station = stations.find(function (s) { return s.id === details.stationId; });
    var where = details.enrollmentFlow ?
      "Enrollment · starts at " + (station ? station.name : "the first station") :
      (station ? station.name : "") + " · " + details.purpose;

    showFormModal("Scan to get the ticket",
      '<div class="walkin-qr">' +
        '<div class="walkin-qr-code" aria-label="QR code for the walk-in ticket">' + qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) + '</div>' +
        '<p class="walkin-qr-name">' + escapeAdminText(details.ownerName) + '</p>' +
        '<p class="walkin-qr-meta">' + escapeAdminText(where) + '</p>' +
        '<p class="walkin-qr-status" id="walkinQrStatus" role="status">Waiting for scan…</p>' +
        '<p class="modal-help">Ask the walk-in to scan this with their phone camera. The ticket opens on their phone and they are alerted when it\'s their turn. The code works once and expires in ' + WALKIN_PASS_MINUTES + ' minutes.</p>' +
        '<div class="settings-actions walkin-qr-actions">' +
          '<button type="button" class="settings-btn settings-btn-blue" id="walkinQrNew" hidden onclick="renewWalkinPass()">New code</button>' +
          '<button type="button" class="settings-btn settings-btn-primary" onclick="closeFormModal()">Close</button>' +
        '</div>' +
      '</div>');

    walkinPassView = { passId: made.passId, details: details, createdMs: Date.now(), unsubscribe: null, timer: null };
    var view = walkinPassView;

    view.unsubscribe = db.collection("walkinPasses").doc(made.passId).onSnapshot(function (doc) {
      var data = doc.exists ? doc.data() : null;
      if (!data || !data.usedAt || walkinPassView !== view) return;
      walkinPassScanned(data);
    }, function (err) {
      console.error("Could not follow the walk-in pass: " + err.message);
    });

    view.timer = setInterval(tickWalkinPass, 1000);
    tickWalkinPass();
  });
}

function renewWalkinPass() {
  if (!walkinPassView) return;
  showWalkinPass(walkinPassView.details);
}

function stopWalkinPassView() {
  if (!walkinPassView) return;
  if (walkinPassView.unsubscribe) walkinPassView.unsubscribe();
  clearInterval(walkinPassView.timer);
  walkinPassView = null;
}

function tickWalkinPass() {
  var status = document.getElementById("walkinQrStatus");
  // The dialog was closed: stop following the pass.
  if (!status) {
    stopWalkinPassView();
    return;
  }
  if (status.classList.contains("is-done")) return;

  var remaining = WALKIN_PASS_MINUTES * 60 * 1000 - (Date.now() - walkinPassView.createdMs);
  if (remaining > 0) {
    status.textContent = "Waiting for scan… expires in " + formatCountdown(remaining);
    return;
  }

  status.textContent = "This code has expired. Make a new one if they still need a ticket.";
  status.classList.add("is-expired");
  document.querySelector(".walkin-qr-code").classList.add("is-expired");
  var renew = document.getElementById("walkinQrNew");
  if (renew) renew.hidden = false;
  if (walkinPassView.unsubscribe) walkinPassView.unsubscribe();
  clearInterval(walkinPassView.timer);
}

function walkinPassScanned(pass) {
  var status = document.getElementById("walkinQrStatus");
  if (status) {
    status.textContent = "✓ Ticket " + pass.ticketNo + " is on their phone.";
    status.classList.add("is-done");
  }
  var code = document.querySelector(".walkin-qr-code");
  if (code) code.classList.add("is-used");
  clearInterval(walkinPassView.timer);
  if (walkinPassView.unsubscribe) walkinPassView.unsubscribe();

  enforcerDraft = emptyEnforcerDraft("");
  renderEnforcer();
}

function enforcerStatusClass(status) {
  return status === "cancelled" || status === "voided" ? "void" : (status || "waiting");
}

// Ticket ids ticked in the queue list. Only tickets still waiting in a queue can be ticked.
var enforcerSelection = {};

function isEnforcerSelectable(ticket) {
  return ticket.status === "waiting" || ticket.status === "skipped";
}

// The whole queue for today: everyone being served, waiting or skipped, grouped by station in queue order.
function getEnforcerListTickets() {
  var stationOrder = {};
  getSortedStations().forEach(function (station, index) { stationOrder[station.id] = index; });

  return tickets.filter(function (ticket) {
    return (ticket.status === "serving" || ticket.status === "waiting" || ticket.status === "skipped") &&
      isTodayTicket(ticket) && (!enforcerFilter || ticket.stationId === enforcerFilter) &&
      ticketMatchesTypeFilter(ticket, enforcerTypeFilter);
  }).sort(function (a, b) {
    var byStation = (stationOrder[a.stationId] || 0) - (stationOrder[b.stationId] || 0);
    if (byStation) return byStation;

    var aServing = a.status === "serving" ? 0 : 1;
    var bServing = b.status === "serving" ? 0 : 1;
    return aServing - bServing || compareQueueOrder(a, b);
  });
}

function getSelectedEnforcerTickets() {
  return getEnforcerListTickets().filter(function (ticket) {
    return enforcerSelection[ticket.id] && isEnforcerSelectable(ticket);
  });
}

// Small tags next to the name: a walk-in (made with a QR code), the student type when not Regular, and priority.
function enforcerTagsHtml(ticket) {
  var tags = "";

  if (ticket.manual === true) tags += ' <span class="type-tag manual-tag">Walk-in</span>';
  if (ticket.enrollment === true) {
    tags += ' <span class="type-tag enrollment-tag">Enrollment ' + ((Number(ticket.enrollmentStep) || 0) + 1) + '/' + (ticketEnrollmentFlow(ticket).length || 1) + '</span>';
  }
  if (ticket.studentType === "transferee" || ticket.studentType === "freshman" || ticket.studentType === "guest") {
    tags += ' <span class="type-tag queue-row-' + ticket.studentType + '">' + escapeAdminText(STUDENT_TYPE_SHORT_LABELS[ticket.studentType]) + '</span>';
  }
  if (ticket.prioritizedAt && ticket.status === "waiting") tags += ' <span class="type-tag priority-tag">\u2605 Priority</span>';

  return tags;
}

function enforcerListRowsHtml() {
  var list = getEnforcerListTickets();

  if (!list.length) {
    return '<tr><td colspan="6" class="empty-row">' + (enforcerTypeFilter ?
      'No ' + escapeAdminText(queueTypeFilterLabel(enforcerTypeFilter)) + ' tickets in the queue right now.' :
      'No tickets in the queue right now.') + '</td></tr>';
  }

  return list.map(function (ticket) {
    var selectable = isEnforcerSelectable(ticket);
    var selected = selectable && !!enforcerSelection[ticket.id];
    var id = escapeAdminText(ticket.id);

    return '<tr class="queue-row' + (selectable ? '' : ' not-selectable') + (selected ? ' selected' : '') + '"' +
      (selectable ? ' data-ticket="' + id + '" onclick="toggleEnforcerSelection(\'' + id + '\', event)"' : '') + '>' +
      '<td class="queue-select-cell"><input type="radio" name="enforcerSelect" class="queue-select-box" aria-label="Select ticket ' + escapeAdminText(ticket.ticketNo) + '"' +
        (selectable ? '' : ' disabled') + (selected ? ' checked' : '') + '></td>' +
      '<td class="settings-strong">' + escapeAdminText(ticket.ticketNo) + '</td>' +
      '<td>' + escapeAdminText(ticket.ownerName) + enforcerTagsHtml(ticket) + '</td>' +
      '<td>' + escapeAdminText(ticket.purpose) + '</td>' +
      '<td>' + escapeAdminText(getStationName(ticket.stationId)) + '</td>' +
      '<td><span class="status-badge compact ' + enforcerStatusClass(ticket.status) + '">' + escapeAdminText(formatAdminStatus(ticket.status)) + '</span></td></tr>';
  }).join("");
}

function updateEnforcerSelectionUI() {
  var selectableIds = {};
  getEnforcerListTickets().forEach(function (ticket) {
    if (isEnforcerSelectable(ticket)) selectableIds[ticket.id] = true;
  });

  // Forget tickets that are no longer waiting (called, removed, cancelled).
  Object.keys(enforcerSelection).forEach(function (id) {
    if (!selectableIds[id]) delete enforcerSelection[id];
  });

  var selectedCount = 0;
  document.querySelectorAll("#enforcerListBody .queue-row[data-ticket]").forEach(function (row) {
    var selected = !!enforcerSelection[row.getAttribute("data-ticket")];
    row.classList.toggle("selected", selected);
    row.querySelector(".queue-select-box").checked = selected;
    if (selected) selectedCount++;
  });

  var total = Object.keys(selectableIds).length;
  var selectAll = document.getElementById("enforcerSelectAll");
  if (selectAll) {
    selectAll.disabled = total === 0;
    selectAll.checked = total > 0 && selectedCount === total;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
  }

  var actionBtn = document.getElementById("enforcerActionBtn");
  if (actionBtn) {
    actionBtn.style.display = selectedCount ? "" : "none";
    actionBtn.textContent = "Action";
  }
}

function toggleEnforcerSelection(ticketId, event) {
  if (event && event.target.closest("button")) return;

  // One ticket at a time, like Queue Management.
  enforcerSelection = enforcerSelection[ticketId] ? {} : (function () { var only = {}; only[ticketId] = true; return only; })();
  updateEnforcerSelectionUI();
}


// Enforcers manage the tickets they created, but they cannot call or skip anyone: only Prioritize, Recall and Remove.
function openEnforcerActionsModal() {
  var selected = getSelectedEnforcerTickets();
  if (!selected.length) return;

  var waitingCount = selected.filter(function (ticket) { return ticket.status === "waiting"; }).length;
  var numbers = selected.map(function (ticket) { return escapeAdminText(ticket.ticketNo); }).join(", ");

  showFormModal("Queue Actions",
    '<p class="modal-help">' + selected.length + ' ticket' + (selected.length === 1 ? '' : 's') + ' selected: ' + numbers + '</p>' +
    '<div class="queue-actions-grid">' +
      queueActionButtonHtml('\u2B06 Prioritize', "confirmEnforcerAction('prioritize')", waitingCount === 0, "Only waiting tickets can be prioritized") +
      queueActionButtonHtml('\u21BA Recall', "confirmEnforcerAction('recall')", false, "") +
      queueActionButtonHtml('\uD83D\uDDD1 Remove', "confirmEnforcerAction('remove')", false, "") +
    '</div>');
}

function confirmEnforcerAction(kind) {
  var selected = getSelectedEnforcerTickets();
  if (!selected.length) {
    closeFormModal();
    return;
  }

  var count = selected.length;
  var noun = count === 1 ? "ticket " + selected[0].ticketNo : count + " tickets";
  var ids = selected.map(function (ticket) { return ticket.id; });
  var options;

  if (kind === "prioritize") {
    var waitingIds = selected.filter(function (ticket) { return ticket.status === "waiting"; }).map(function (ticket) { return ticket.id; });
    if (!waitingIds.length) return;
    options = {
      title: "Prioritize " + (waitingIds.length === 1 ? "this ticket" : waitingIds.length + " tickets") + "?",
      message: "They move to the front of their station's queue, ahead of everyone who is not prioritized." +
        (waitingIds.length < count ? " Tickets on hold in your selection are left as they are." : ""),
      confirmLabel: "Prioritize",
      tone: "primary",
      run: function () { return prioritizeTickets(waitingIds); }
    };
  } else if (kind === "recall") {
    options = {
      title: "Recall " + noun + "?",
      message: "They are notified on their phone to go to the counter (walk-ins too, on the phone that scanned their QR code).",
      confirmLabel: "Recall",
      tone: "primary",
      run: function () { return recallTickets(ids); }
    };
  } else {
    options = {
      title: "Are you sure you want to remove " + noun + "?",
      message: "This immediately voids the selected " + (count === 1 ? "ticket" : "tickets") + ". This cannot be undone.",
      confirmLabel: "Remove",
      tone: "danger",
      run: function () { return removeTickets(ids); }
    };
  }

  showConfirmModal({
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    tone: options.tone,
    onConfirm: function () {
      options.run().then(function (done) {
        if (!done) return;
        closeFormModal();
        enforcerSelection = {};
        updateEnforcerSelectionUI();
      });
    }
  });
}

// Updates only the list, so typing in the form is never interrupted by live changes.
function refreshEnforcerList() {
  var body = document.getElementById("enforcerListBody");
  if (!body) return;

  body.innerHTML = enforcerListRowsHtml();
  updateEnforcerSelectionUI();
}

function renderEnforcer() {
  var area = document.getElementById("adminEnforcerArea");
  if (!area) return;

  var activeStations = getEnforcerStations();

  // A draft or filter pointing at a station that has since been disabled or removed is dropped.
  var valid = function (id) { return !id || activeStations.some(function (s) { return s.id === id; }); };
  if (!enforcerIsEnrollment() && !valid(enforcerDraft.stationId)) {
    enforcerDraft.stationId = "";
    enforcerDraft.purpose = "";
    enforcerDraft.purposeOther = "";
  }
  if (!valid(enforcerFilter)) enforcerFilter = "";

  var stationOptions = function (placeholder, selectedId) {
    return '<option value="">' + placeholder + '</option>' + activeStations.map(function (station) {
      return '<option value="' + escapeAdminText(station.id) + '"' + (station.id === selectedId ? ' selected' : '') + '>' + escapeAdminText(station.name) + '</option>';
    }).join("");
  };

  var typeOptions = '<option value="">Select Student Type</option>' + ENFORCER_TYPES.map(function (key) {
    return '<option value="' + key + '"' + (key === enforcerDraft.studentType ? ' selected' : '') + '>' + escapeAdminText(STUDENT_TYPE_LABELS[key]) + '</option>';
  }).join("");

  var d = enforcerDraft;

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">Queue Enforcer</div>' +
      adminHeaderRightHtml() +
    '</div>' +

    '<div class="enforcer-title-row">' +
      '<h2 class="settings-title">Walk-in Ticket</h2>' +
    '</div>' +

    '<div class="enforcer-layout">' +
      '<div class="enforcer-main">' +
        '<section class="panel settings-panel enforcer-panel">' +
          '<div class="panel-header"><h2>Walk-in Form</h2></div>' +
          '<p class="settings-help">For walk-ins who can\'t get a ticket on their own. Fill in their details and press Generate QR: they scan it with their phone camera, and the ticket (with its queue number) opens on their phone until their visit is done.</p>' +
          '<div class="enforcer-form-grid">' +
            '<div class="enforcer-field"><label for="enforcerFirstName">First Name*</label><input type="text" id="enforcerFirstName" placeholder="First Name" maxlength="50" value="' + escapeAdminText(d.firstName) + '" oninput="onEnforcerInput(\'firstName\', this.value)"></div>' +
            '<div class="enforcer-field"><label for="enforcerLastName">Last Name*</label><input type="text" id="enforcerLastName" placeholder="Last Name" maxlength="50" value="' + escapeAdminText(d.lastName) + '" oninput="onEnforcerInput(\'lastName\', this.value)"></div>' +
            '<div class="enforcer-field"><label for="enforcerType">Student Type*</label><select id="enforcerType" onchange="onEnforcerInput(\'studentType\', this.value)">' + typeOptions + '</select></div>' +
            '<div class="enforcer-field enforcer-span-2"><label for="enforcerStation">Station*</label><select id="enforcerStation" onchange="onEnforcerInput(\'stationId\', this.value)">' + stationOptions("Select Station", d.stationId).replace(/^(<option value="">[^<]*<\/option>)/, "$1" + enforcerEnrollmentOptionHtml()) + '</select></div>' +
            '<div class="enforcer-field"><label for="enforcerPurpose">Purpose*</label><select id="enforcerPurpose" onchange="onEnforcerInput(\'purpose\', this.value)"' + (d.stationId && !enforcerIsEnrollment() ? '' : ' disabled') + '>' + enforcerPurposeOptionsHtml() + '</select></div>' +
            '<div class="enforcer-field" id="enforcerStudentNoField"' + (enforcerNeedsStudentNumber() ? '' : ' style="display: none"') + '><label for="enforcerStudentNo">Student Number*</label><input type="text" id="enforcerStudentNo" inputmode="numeric" autocomplete="off" placeholder="02000-XXXXXX" maxlength="13" value="' + escapeAdminText(d.studentNumber) + '" oninput="onEnforcerInput(\'studentNumber\', this.value)" onblur="onEnforcerStudentNumberBlur(this)"></div>' +
            '<div class="enforcer-field enforcer-span-all" id="enforcerOtherField"' + (d.purpose === ENFORCER_OTHER_PURPOSE ? '' : ' style="display: none"') + '><label for="enforcerOther">Please specify the purpose*</label><input type="text" id="enforcerOther" placeholder="e.g. Request for diploma" maxlength="100" value="' + escapeAdminText(d.purposeOther) + '" oninput="onEnforcerInput(\'purposeOther\', this.value)"></div>' +
          '</div>' +
          '<div class="settings-actions enforcer-form-actions">' +
            '<button type="button" class="settings-btn settings-btn-blue enforcer-clear" onclick="clearEnforcerForm()">Clear All</button>' +
            '<button type="button" class="settings-btn settings-btn-primary" id="enforcerGenerateBtn" onclick="generateWalkinQr()">Generate QR</button>' +
          '</div>' +
        '</section>' +

        '<section class="panel settings-panel">' +
          '<div class="panel-header"><h2>Queue List</h2>' +
            '<div class="queued-tools">' +
              '<select class="queue-type-filter" aria-label="Show station" onchange="onEnforcerFilter(this.value)">' + stationOptions("All Stations", enforcerFilter) + '</select>' +
              queueTypeFilterHtml(enforcerTypeFilter, "setEnforcerTypeFilter(this.value)") +
              '<button type="button" id="enforcerActionBtn" class="settings-btn settings-btn-primary" style="display: none" onclick="openEnforcerActionsModal()">Action</button></div></div>' +
          '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr>' +
            '<th class="queue-select-cell"><span class="visually-hidden">Select</span></th>' +
            '<th>Queue No.</th><th>Student</th><th>Purpose</th><th>Station</th><th>Status</th></tr></thead>' +
            '<tbody id="enforcerListBody">' + enforcerListRowsHtml() + '</tbody></table></div>' +
        '</section>' +
      '</div>' +
    '</div>';

  updateEnforcerSelectionUI();
}
