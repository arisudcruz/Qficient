var STUDENT_TYPE_LABELS = {
  regular: "Regular",
  transferee: "Transferee / Irregular"
};

function closeStudentTypeModal() {
  var overlay = document.getElementById("studentTypeModal");
  if (overlay) overlay.remove();
}

function selectStudentType(type) {
  db.collection("students").doc(user.id).set({
    studentType: type,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true })
    .then(function () {
      user.studentType = type;
      closeStudentTypeModal();
      updateDashboard();
      say("Student type set to " + STUDENT_TYPE_LABELS[type] + ".");
    })
    .catch(function (err) {
      say("Could not save student type: " + err.message);
    });
}

function promptStudentType(isFirstTime) {
  closeStudentTypeModal();

  var overlay = document.createElement("div");
  overlay.className = "app-modal-backdrop";
  overlay.id = "studentTypeModal";
  overlay.innerHTML =
    '<div class="app-modal-sheet">' +
      '<p class="app-modal-title">' + (isFirstTime ? "Welcome! What's your student type?" : "Update Student Type") + '</p>' +
      '<p class="app-modal-sub">' + (isFirstTime ? "This helps front-desk staff serve you correctly. You can change this anytime." : "You can change this anytime from your dashboard.") + '</p>' +
      '<button type="button" class="role-card" onclick="selectStudentType(\'regular\')">' +
        '<span class="role-icon role-icon-student">🎓</span>' +
        '<span class="role-copy"><span class="role-title">Regular</span><span class="role-desc">Standard enrollment, on-track curriculum.</span></span>' +
      '</button>' +
      '<button type="button" class="role-card" onclick="selectStudentType(\'transferee\')">' +
        '<span class="role-icon role-icon-guest">🔀</span>' +
        '<span class="role-copy"><span class="role-title">Transferee / Irregular</span><span class="role-desc">Transferred or non-standard course load.</span></span>' +
      '</button>' +
      (isFirstTime ? '' : '<button type="button" class="app-btn app-btn-outline" onclick="closeStudentTypeModal()">Cancel</button>') +
    '</div>';

  var host = document.getElementById("pageDashboard") || document.body;
  host.appendChild(overlay);
}

var lastNotifiedRecallMs = null;
var skipCountdownIntervalId = null;

function notifyRecall() {
  if (typeof Toastify === "undefined") return;
  Toastify({
    text: "⏰ You've been recalled! Please return to the counter within 1 minute.",
    duration: 8000,
    gravity: "top",
    position: "center",
    style: { background: "#E5484D" }
  }).showToast();
}

function ensureSkipCountdownWatcher(isSkipped) {
  if (isSkipped && !skipCountdownIntervalId) {
    skipCountdownIntervalId = setInterval(updateDashboard, 1000);
  } else if (!isSkipped && skipCountdownIntervalId) {
    clearInterval(skipCountdownIntervalId);
    skipCountdownIntervalId = null;
  }
}

var pendingJoinPurpose = "";

function setPendingJoinPurpose(value) {
  pendingJoinPurpose = value;
}

function joinSelectedStation(stationId) {
  var purposeInput = document.getElementById("queuePurpose");
  var purpose = purposeInput ? purposeInput.value.trim() : "";

  if (!purpose) {
    say("Please enter your purpose before joining.");
    return;
  }

  joinQueue(stationId, purpose);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getInitials(name) {
  var trimmed = (name || "").trim();
  if (!trimmed) return "?";
  var parts = trimmed.split(/\s+/);
  var initials = parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "");
  return initials.toUpperCase();
}

function setDashboardTab(tab) {
  var queuePanel = document.getElementById("dashboardTabQueue");
  var boardPanel = document.getElementById("dashboardTabBoard");
  var tabBtnQueue = document.getElementById("tabBtnQueue");
  var tabBtnBoard = document.getElementById("tabBtnBoard");

  if (queuePanel) queuePanel.style.display = tab === "board" ? "none" : "";
  if (boardPanel) boardPanel.style.display = tab === "board" ? "" : "none";
  if (tabBtnQueue) tabBtnQueue.classList.toggle("active", tab !== "board");
  if (tabBtnBoard) tabBtnBoard.classList.toggle("active", tab === "board");
}

function renderLiveBoard() {
  var area = document.getElementById("boardArea");
  if (!area) return;

  var cardsHtml = stations.map(function (station) {
    var servingTicket = station.nowServingId ? tickets.find(function (item) {
      return item.id === station.nowServingId;
    }) : null;
    var servingText = servingTicket ? servingTicket.ticketNo : "—";
    var waitingCount = tickets.filter(function (item) {
      return item.stationId === station.id && item.status === "waiting";
    }).length;

    return '<div class="board-card">' +
      '<div class="board-card-top">' +
        '<span class="board-station-name">' + escapeHtml(station.name) + '</span>' +
        '<span class="board-waiting-chip">' + waitingCount + ' waiting</span>' +
      '</div>' +
      '<div class="board-serving-row">' +
        '<span class="board-serving-label">Now Serving</span>' +
        '<span class="board-serving-number">' + escapeHtml(servingText) + '</span>' +
      '</div>' +
    '</div>';
  }).join("");

  area.innerHTML =
    '<span class="live-pill"><span class="live-dot-pulse"></span>Live</span>' +
    '<p class="board-caption">Updates instantly as tickets move — no refresh needed.</p>' +
    (cardsHtml || '<p class="empty-hint">No stations available yet.</p>');
}

function updateDashboard() {
  var ticket = user ? myTicket() : null;
  var ticketArea = document.getElementById("ticketArea");
  var stationArea = document.getElementById("stationArea");
  var avatar = document.getElementById("dashAvatar");
  var greetingEl = document.getElementById("welcomeText");
  var studentNoEl = document.getElementById("welcomeStudentNo");
  var typeChipArea = document.getElementById("studentTypeChip");

  renderLiveBoard();

  if (avatar && user) avatar.textContent = getInitials(user.name);
  if (greetingEl) greetingEl.textContent = user ? ("Welcome, " + user.name) : "Welcome";
  if (studentNoEl) studentNoEl.textContent = (user && user.studentNumber) ? user.studentNumber : "";

  if (typeChipArea) {
    typeChipArea.innerHTML = (user && user.type === "student") ?
      '<button type="button" class="student-type-chip" onclick="promptStudentType(false)">' +
        escapeHtml(STUDENT_TYPE_LABELS[user.studentType] || "Set student type") +
        ' <span class="edit-icon">✎</span>' +
      '</button>' : '';
  }

  refreshNotificationToggle();

  if (!ticketArea || !stationArea) return;

  if (!ticket) {
    ensureSkipCountdownWatcher(false);
    ticketArea.innerHTML = "";
    if (!user) {
      stationArea.innerHTML = "";
      return;
    }

    var html = '<p class="section-label">Select a service to join the queue</p>' +
      '<div class="app-field">' +
        '<label>Purpose</label>' +
        '<input type="text" id="queuePurpose" placeholder="e.g. Certificate of Registration" value="' + escapeHtml(pendingJoinPurpose) + '" oninput="setPendingJoinPurpose(this.value)">' +
      '</div>';
    for (var i = 0; i < stations.length; i++) {
      var station = stations[i];
      var servingTicket = station.nowServingId ? tickets.find(function (item) {
        return item.id === station.nowServingId;
      }) : null;
      var servingText = servingTicket ? servingTicket.ticketNo : "—";
      html +=
        '<div class="station-card">' +
          '<span class="station-icon">🏷️</span>' +
          '<div class="station-copy">' +
            '<p class="station-name">' + escapeHtml(station.name) + '</p>' +
            '<p class="station-sub">Now serving ' + escapeHtml(servingText) + '</p>' +
          '</div>' +
          '<button type="button" class="station-join-btn" onclick="joinSelectedStation(\'' + station.id + '\')">Join</button>' +
        '</div>';
    }
    stationArea.innerHTML = html;
    return;
  }

  pendingJoinPurpose = "";

  if (ticket.recalledAt && typeof ticket.recalledAt.toMillis === "function") {
    var recallMs = ticket.recalledAt.toMillis();
    if (recallMs !== lastNotifiedRecallMs) {
      lastNotifiedRecallMs = recallMs;
      notifyRecall();
    }
  }

  ensureSkipCountdownWatcher(ticket.status === "skipped");

  var ticketStation = stations.find(function (station) {
    return station.id === ticket.stationId;
  });

  var statusClass = "status-pill waiting";
  var statusText = "Waiting";
  var countdownHtml = "";
  if (ticket.status === "serving") {
    statusClass = "status-pill done";
    statusText = "Now Serving";
  } else if (ticket.status === "skipped") {
    statusClass = "status-pill danger";
    statusText = "Skipped";
    var baseMs = (ticket.skippedAt && typeof ticket.skippedAt.toMillis === "function") ? ticket.skippedAt.toMillis() : Date.now();
    var remainingMs = AUTO_VOID_WINDOW_MS - (Date.now() - baseMs);
    countdownHtml = '<p class="ticket-countdown">⚠️ Please return to the counter — auto-void in ' + formatCountdown(remainingMs) + '</p>';
  }

  var detailCellsHtml = '<div><span class="ticket-purpose-label">Purpose</span><span class="ticket-purpose-value">' + escapeHtml(ticket.purpose || "—") + '</span></div>';
  if (ticket.studentType) {
    detailCellsHtml += '<div><span class="ticket-purpose-label">Student Type</span><span class="ticket-purpose-value">' + escapeHtml(STUDENT_TYPE_LABELS[ticket.studentType] || ticket.studentType) + '</span></div>';
  }

  ticketArea.innerHTML =
    '<div class="ticket-card">' +
      '<div class="ticket-head">' +
        '<p class="ticket-station-label">' + escapeHtml(ticketStation ? ticketStation.name : "") + '</p>' +
        '<p class="ticket-number">' + escapeHtml(ticket.ticketNo) + '</p>' +
      '</div>' +
      '<div class="ticket-body">' +
        '<div class="ticket-owner-block">' +
          '<span class="ticket-owner">' + escapeHtml(ticket.ownerName) + '</span>' +
          (ticket.studentNumber ? '<span class="ticket-student-no">' + escapeHtml(ticket.studentNumber) + '</span>' : '') +
        '</div>' +
        '<span class="' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      countdownHtml +
      '<div class="ticket-detail-grid">' + detailCellsHtml + '</div>' +
    '</div>' +
    '<button type="button" class="app-btn app-btn-outline" onclick="cancelTicket()">Cancel Queue</button>';

  stationArea.innerHTML = "";
}
