function updateDashboard() {
  var ticket = user ? myTicket() : null;
  var ticketArea = document.getElementById("ticketArea");
  var stationArea = document.getElementById("stationArea");

  if (!ticket) {
    ticketArea.innerHTML = "";
    if (!user) {
      stationArea.innerHTML = "";
      return;
    }

    var html = '<p class="small">Select a service to join the queue:</p>';
    for (var i = 0; i < stations.length; i++) {
      var station = stations[i];
      var servingTicket = station.nowServingId ? tickets.find(function (item) {
        return item.id === station.nowServingId;
      }) : null;
      var servingText = servingTicket ? servingTicket.ticketNo : "—";
      html +=
        '<div class="box stationRow">' +
          '<div>' +
            '<p class="stationName">' + station.name + '</p>' +
            '<p class="stationSub">Now serving ' + servingText + '</p>' +
          '</div>' +
          '<button class="joinBtn" onclick="joinQueue(\'' + station.id + '\')">Join</button>' +
        '</div>';
    }
    stationArea.innerHTML = html;
    return;
  }

  var ticketStation = stations.find(function (station) {
    return station.id === ticket.stationId;
  });
  var boxClass = ticket.verified ? "ticketBox done" : "ticketBox";
  var tagClass = ticket.verified ? "tag done" : "tag";
  var tagText = ticket.verified ? "Verified ✓" : "Waiting";

  ticketArea.innerHTML =
    '<div class="' + boxClass + '">' +
      '<div class="ticketTop">' +
        '<p class="ticketStation">' + ticketStation.name + '</p>' +
        '<p class="ticketNumber">' + ticket.ticketNo + '</p>' +
      '</div>' +
      '<div class="ticketBottom">' +
        '<p>' + ticket.ownerName + '</p>' +
        '<span class="' + tagClass + '">' + tagText + '</span>' +
      '</div>' +
    '</div>' +
    '<button class="cancelBtn" onclick="cancelTicket()">Cancel Queue</button>';

  stationArea.innerHTML = "";
}
