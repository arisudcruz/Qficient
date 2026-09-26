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

  renderLiveBoard();

  if (!ticketArea || !stationArea) return;

  if (avatar && user) avatar.textContent = getInitials(user.name);

  if (!ticket) {
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

  var ticketStation = stations.find(function (station) {
    return station.id === ticket.stationId;
  });
  var statusClass = ticket.verified ? "status-pill done" : "status-pill waiting";
  var statusText = ticket.verified ? "Verified ✓" : "Waiting";

  ticketArea.innerHTML =
    '<div class="ticket-card">' +
      '<div class="ticket-head">' +
        '<p class="ticket-station-label">' + escapeHtml(ticketStation ? ticketStation.name : "") + '</p>' +
        '<p class="ticket-number">' + escapeHtml(ticket.ticketNo) + '</p>' +
      '</div>' +
      '<div class="ticket-body">' +
        '<span class="ticket-owner">' + escapeHtml(ticket.ownerName) + '</span>' +
        '<span class="' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="ticket-purpose-row">' +
        '<span class="ticket-purpose-label">Purpose</span>' +
        '<span class="ticket-purpose-value">' + escapeHtml(ticket.purpose || "—") + '</span>' +
      '</div>' +
    '</div>' +
    '<button type="button" class="app-btn app-btn-outline" onclick="cancelTicket()">Cancel Queue</button>';

  stationArea.innerHTML = "";
}
