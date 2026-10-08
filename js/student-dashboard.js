var STUDENT_TYPE_LABELS = {
  regular: "Regular",
  transferee: "Transferee / Irregular",
  guest: "Guest"
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
var lastNotifiedLastCallMs = null;
var skipCountdownIntervalId = null;

function showStudentToast(text) {
  if (typeof Toastify === "undefined") return;
  Toastify({
    text: text,
    duration: 8000,
    gravity: "top",
    position: "center",
    style: { background: "#E5484D" }
  }).showToast();
}

function notifyRecall() {
  showStudentToast("⏰ Please go to the counter. You're being called.");
}

function notifyLastCall() {
  showStudentToast("🚨 Last call! Return to the counter within " + formatVoidWindow() + " or your ticket will be voided.");
}

function ticketCountdownText(phase, remainingMs) {
  if (phase === "final") {
    return remainingMs > 0 ?
      "🚨 Last call! Return to the counter within " + formatCountdown(remainingMs) + " or your ticket will be voided." :
      "🚨 Your last chance has ended. Your ticket is being voided.";
  }
  return "⚠️ Please return to the counter. " + formatCountdown(remainingMs) + " left.";
}

function tickTicketCountdown() {
  var el = document.getElementById("ticketCountdownText");
  if (!el) return;

  var phase = el.getAttribute("data-phase");
  var remaining = AUTO_VOID_WINDOW_MS - (Date.now() - Number(el.getAttribute("data-base-ms")));

  if (phase === "initial" && remaining <= 0) {
    clearInterval(skipCountdownIntervalId);
    skipCountdownIntervalId = null;
    updateDashboard();
    return;
  }
  el.textContent = ticketCountdownText(phase, remaining);
}

function ensureSkipCountdownWatcher(needsTimer) {
  if (needsTimer && !skipCountdownIntervalId) {
    skipCountdownIntervalId = setInterval(tickTicketCountdown, 1000);
  } else if (!needsTimer && skipCountdownIntervalId) {
    clearInterval(skipCountdownIntervalId);
    skipCountdownIntervalId = null;
  }
}

var joinCooldownIntervalId = null;

function tickJoinCooldown() {
  var el = document.getElementById("joinCooldownText");
  if (!el) return;

  var remaining = getCancelCooldownRemaining();
  if (remaining <= 0) {
    clearInterval(joinCooldownIntervalId);
    joinCooldownIntervalId = null;
    updateDashboard();
    return;
  }
  el.textContent = "You can join again in " + formatCountdown(remaining);
}

function ensureJoinCooldownWatcher(active) {
  if (active && !joinCooldownIntervalId) {
    joinCooldownIntervalId = setInterval(tickJoinCooldown, 1000);
  } else if (!active && joinCooldownIntervalId) {
    clearInterval(joinCooldownIntervalId);
    joinCooldownIntervalId = null;
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
    var servingTicket = servingTicketOf(station);
    var servingText = servingTicket ? servingTicket.ticketNo : "—";
    var waitingCount = tickets.filter(function (item) {
      return item.stationId === station.id && item.status === "waiting" && isTodayTicket(item);
    }).length;

    return '<div class="board-card">' +
      '<div class="board-card-top">' +
        '<span class="board-station-name">' + escapeHtml(station.name) + '</span>' +
        '<span class="board-waiting-chip">' + (station.active === false ? 'Closed' : waitingCount + ' waiting') + '</span>' +
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
      ensureJoinCooldownWatcher(false);
      stationArea.innerHTML = "";
      return;
    }

    var cooldownMs = getCancelCooldownRemaining();
    ensureJoinCooldownWatcher(cooldownMs > 0);

    if (cooldownMs > 0) {
      stationArea.innerHTML =
        '<div class="cooldown-card">' +
          '<p class="cooldown-title">⏳ Please wait before joining again</p>' +
          '<p class="cooldown-text" id="joinCooldownText">You can join again in ' + formatCountdown(cooldownMs) + '</p>' +
        '</div>';
      return;
    }

    var html = '<p class="section-label">Select a service to join the queue</p>' +
      '<div class="app-field">' +
        '<label>Purpose</label>' +
        '<input type="text" id="queuePurpose" placeholder="e.g. Certificate of Registration" value="' + escapeHtml(pendingJoinPurpose) + '" oninput="setPendingJoinPurpose(this.value)">' +
      '</div>';
    for (var i = 0; i < stations.length; i++) {
      var station = stations[i];
      if (station.active === false) continue;
      var servingTicket = servingTicketOf(station);
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
  ensureJoinCooldownWatcher(false);

  if (ticket.recalledAt && typeof ticket.recalledAt.toMillis === "function") {
    var recallMs = ticket.recalledAt.toMillis();
    if (recallMs !== lastNotifiedRecallMs) {
      lastNotifiedRecallMs = recallMs;
      notifyRecall();
    }
  }

  if (ticket.lastCallAt && typeof ticket.lastCallAt.toMillis === "function") {
    var lastCallMs = ticket.lastCallAt.toMillis();
    if (lastCallMs !== lastNotifiedLastCallMs) {
      lastNotifiedLastCallMs = lastCallMs;
      notifyLastCall();
    }
  }

  var skip = ticket.status === "skipped" ? getSkipPhase(ticket) : null;
  ensureSkipCountdownWatcher(skip !== null && skip.phase !== "expired");

  var ticketStation = stations.find(function (station) {
    return station.id === ticket.stationId;
  });

  var statusClass = "status-pill waiting";
  var statusText = "Waiting";
  var countdownHtml = "";
  if (ticket.status === "serving") {
    statusClass = "status-pill done";
    statusText = "Now Serving";
  } else if (skip) {
    statusClass = "status-pill danger";
    statusText = "Skipped";
    countdownHtml = skip.phase === "expired" ?
      '<p class="ticket-countdown">⏳ Your time is up. Please go to the counter now. Staff may give you a last call.</p>' :
      '<p class="ticket-countdown" id="ticketCountdownText" data-phase="' + skip.phase + '" data-base-ms="' + skip.baseMs + '">' + ticketCountdownText(skip.phase, skip.remainingMs) + '</p>';
  }

  var detailCellsHtml = '<div><span class="ticket-purpose-label">Purpose</span><span class="ticket-purpose-value">' + escapeHtml(ticket.purpose || "—") + '</span></div>';
  if (ticket.studentType) {
    detailCellsHtml += '<div><span class="ticket-purpose-label">Student Type</span><span class="ticket-purpose-value">' + escapeHtml(STUDENT_TYPE_LABELS[ticket.studentType] || ticket.studentType) + '</span></div>';
  }

  ticketArea.innerHTML =
    '<div class="ticket-card' + (ticket.verified ? ' verified' : '') + '">' +
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
    (ticket.status === "serving" ? '' : '<button type="button" class="app-btn app-btn-outline" onclick="cancelTicket()">Cancel Queue</button>');

  stationArea.innerHTML = "";
}
