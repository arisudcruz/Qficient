function updateAdmin() {
  var area = document.getElementById("adminArea");
  var html = "";

  for (var i = 0; i < stations.length; i++) {
    var station = stations[i];
    html += '<div class="box" style="margin-bottom:14px;">';
    html += '<p style="font-weight:700;margin:0 0 10px;">' + station.name + '</p>';

    var servingTicket = station.nowServingId ? tickets.find(function (ticket) {
      return ticket.id === station.nowServingId;
    }) : null;

    if (servingTicket) {
      var pickerHtml = '<select id="pick-' + station.id + '">';
      for (var j = 0; j < stations.length; j++) {
        if (stations[j].id !== station.id) {
          pickerHtml += '<option value="' + stations[j].id + '">' + stations[j].name + '</option>';
        }
      }
      pickerHtml += '</select>';

      html +=
        '<div class="servingBox">' +
          '<span class="servingNumber">' + servingTicket.ticketNo + '</span>' +
          '<div class="btnRow">' +
            '<button class="smallBtn" onclick="finishTicket(\'' + station.id + '\')">Complete</button>' +
            '<button class="smallBtn" onclick="verifyTicket(\'' + station.id + '\')">Verify</button>' +
            '<button class="smallBtn" onclick="cancelServing(\'' + station.id + '\')">Void</button>' +
          '</div>' +
          '<div class="btnRow">' +
            pickerHtml +
            '<button class="smallBtn" onclick="transferTicket(\'' + station.id + '\')">Transfer</button>' +
          '</div>' +
        '</div>';
    } else {
      var waiting = tickets.filter(function (ticket) {
        return ticket.stationId === station.id && ticket.status === "waiting";
      }).sort(function (a, b) {
        var aTime = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
        var bTime = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
        return aTime - bTime;
      });
      var next = waiting[0];
      if (next) {
        html += '<button class="bigBtn" onclick="callNext(\'' + station.id + '\')">Call Next (' + next.ticketNo + ')</button>';
      } else {
        html += '<p class="small" style="margin:0;">Queue is empty.</p>';
      }
    }
    html += '</div>';
  }
  area.innerHTML = html;
}

function callNext(stationId) {
  var waiting = tickets.filter(function (ticket) {
    return ticket.stationId === stationId && ticket.status === "waiting";
  }).sort(function (a, b) {
    var aTime = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    var bTime = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    return aTime - bTime;
  });
  var next = waiting[0];
  if (!next) return;

  db.collection("tickets").doc(next.id).update({ status: "called" });
  db.collection("stations").doc(stationId).update({ nowServingId: next.id });
}

function finishTicket(stationId) {
  var station = stations.find(function (item) { return item.id === stationId; });
  if (station.nowServingId) {
    db.collection("tickets").doc(station.nowServingId).update({ status: "completed" });
  }
  db.collection("stations").doc(stationId).update({ nowServingId: null });
}

function verifyTicket(stationId) {
  var station = stations.find(function (item) { return item.id === stationId; });
  if (station.nowServingId) {
    db.collection("tickets").doc(station.nowServingId).update({ verified: true });
    say("Ticket verified.");
  }
}

function cancelServing(stationId) {
  var station = stations.find(function (item) { return item.id === stationId; });
  if (station.nowServingId) {
    db.collection("tickets").doc(station.nowServingId).update({ status: "voided" });
  }
  db.collection("stations").doc(stationId).update({ nowServingId: null });
}

function transferTicket(stationId) {
  var station = stations.find(function (item) { return item.id === stationId; });
  var picker = document.getElementById("pick-" + stationId);
  var targetId = picker.value;
  var target = stations.find(function (item) { return item.id === targetId; });

  if (!station.nowServingId) return;
  var ticketId = station.nowServingId;
  var targetRef = db.collection("stations").doc(targetId);

  db.runTransaction(function (transaction) {
    return transaction.get(targetRef).then(function (doc) {
      var data = doc.data();
      var newCount = (data.count || 0) + 1;
      var letter = data.name.charAt(0);
      var number = String(newCount).padStart(3, "0");
      var newTicketNo = letter + "-" + number;

      transaction.update(targetRef, { count: newCount });
      transaction.update(db.collection("tickets").doc(ticketId), {
        ticketNo: newTicketNo,
        stationId: targetId,
        status: "waiting"
      });

      return newTicketNo;
    });
  }).then(function (newTicketNo) {
    db.collection("stations").doc(stationId).update({ nowServingId: null });
    say("Ticket transferred to " + target.name + " as " + newTicketNo + ".");
  }).catch(function (err) {
    say("Transfer failed: " + err.message);
  });
}
