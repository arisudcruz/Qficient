// No-show strikes. A student whose ticket is voided because the Last Call ran out (they were put On Hold, called
// again and still didn't come back) gets a strike. `limit` strikes within `windowDays` block them from joining the
// queue for `blockHours` (joinQueue checks blockedUntil). An admin can lift a block early from Settings.
// Everything lives on the student's joinState/{uid} record, which the join limits already use.

const { DAY_MS, startOfTodayMs, dayKey, toMs } = require("./time");

// Whether a ticket's change is a no-show worth a strike.
function isNoShow(before, after) {
  return !!before && !!after &&
    before.status !== "void" && after.status === "void" &&
    after.autoVoided === true && after.staleCleanup !== true &&
    after.manual !== true &&
    typeof after.ownerId === "string" && after.ownerId !== "" && after.ownerId.indexOf("manual:") !== 0;
}

// Records one strike for the ticket's owner (once per ticket, however often the event is delivered).
// Returns { strikes, blockedUntilMs, counted }: the strikes now on record (0 once a block starts), the end of a
// block that this strike started, and whether this call added anything.
async function recordNoShow(deps, ticket, nowMs) {
  const { db, Timestamp, config } = deps;
  const rules = config.noShow || {};
  const limit = Number(rules.limit) || 3;
  const windowMs = (Number(rules.windowDays) || 7) * 24 * 60 * 60 * 1000;
  const blockMs = (Number(rules.blockHours) || 24) * 60 * 60 * 1000;
  const stateRef = db.collection("joinState").doc(ticket.ownerId);

  return db.runTransaction(async function (tx) {
    const snap = await tx.get(stateRef);
    const state = snap.exists ? snap.data() : {};

    // Already counted (a repeated event), or this ticket already started the current block.
    if ((state.noShows && state.noShows[ticket.id]) || state.blockedByTicket === ticket.id) {
      return { strikes: Object.keys(state.noShows || {}).length, blockedUntilMs: 0, counted: false };
    }

    const noShows = {};
    Object.keys(state.noShows || {}).forEach(function (id) {
      if (nowMs - Number(state.noShows[id]) < windowMs) noShows[id] = Number(state.noShows[id]);
    });
    noShows[ticket.id] = nowMs;
    const strikes = Object.keys(noShows).length;

    if (strikes < limit) {
      tx.set(stateRef, { noShows: noShows }, { merge: true });
      return { strikes: strikes, blockedUntilMs: 0, counted: true };
    }

    const blockedUntilMs = nowMs + blockMs;
    tx.set(stateRef, {
      noShows: {},
      blockedUntil: Timestamp.fromMillis(blockedUntilMs),
      blockedAt: Timestamp.fromMillis(nowMs),
      blockedReason: "noShow",
      blockedByTicket: ticket.id,
      ownerName: ticket.ownerName || "",
      studentNumber: ticket.studentNumber || ""
    }, { merge: true });
    return { strikes: strikes, blockedUntilMs: blockedUntilMs, counted: true };
  });
}

// Cancels. A student who cancels `limit` tickets in one queue day can't join again until that day ends. The count
// lives on joinState/{uid} as cancels: { ticketId: ms } for the day in cancelsDay; a new day starts it afresh.

function isWalkinTicket(ticket) {
  return ticket.manual === true || typeof ticket.ownerId !== "string" || ticket.ownerId === "" ||
    ticket.ownerId.indexOf("manual:") === 0 || ticket.ownerId.indexOf("nophone:") === 0;
}

// Whether a ticket's change is its owner cancelling it (only the owner may set "cancelled"; see firestore.rules).
function isOwnerCancel(before, after) {
  return !!before && !!after && before.status !== "cancelled" && after.status === "cancelled" && !isWalkinTicket(after);
}

// Records one cancel for the ticket's owner (once per ticket). Returns { count, blockedUntilMs, counted }: the
// cancels so far today (the limit when this one started a block), the end of a block it started, and whether this
// call added anything.
async function recordCancel(deps, ticket, nowMs) {
  const { db, Timestamp, config } = deps;
  const rules = config.cancelBlock || {};
  const limit = Number(rules.limit) || 5;
  const today = dayKey(config.tzOffsetMs, nowMs);
  const stateRef = db.collection("joinState").doc(ticket.ownerId);

  return db.runTransaction(async function (tx) {
    const snap = await tx.get(stateRef);
    const state = snap.exists ? snap.data() : {};
    const sameDay = state.cancelsDay === today;
    const cancels = sameDay && state.cancels && typeof state.cancels === "object" ? Object.assign({}, state.cancels) : {};

    if (cancels[ticket.id] || state.blockedByTicket === ticket.id) {
      return { count: Object.keys(cancels).length, blockedUntilMs: 0, counted: false };
    }

    cancels[ticket.id] = nowMs;
    const count = Object.keys(cancels).length;

    if (count < limit) {
      tx.set(stateRef, { cancels: cancels, cancelsDay: today }, { merge: true });
      return { count: count, blockedUntilMs: 0, counted: true };
    }

    // Blocked until the queue day ends. A longer block already in place (missed turns) is kept as it is.
    const untilMs = startOfTodayMs(config.tzOffsetMs, nowMs) + DAY_MS;
    if (toMs(state.blockedUntil) >= untilMs) {
      tx.set(stateRef, { cancels: {}, cancelsDay: today }, { merge: true });
      return { count: count, blockedUntilMs: 0, counted: true };
    }

    tx.set(stateRef, {
      cancels: {},
      cancelsDay: today,
      blockedUntil: Timestamp.fromMillis(untilMs),
      blockedAt: Timestamp.fromMillis(nowMs),
      blockedReason: "cancels",
      blockedByTicket: ticket.id,
      ownerName: ticket.ownerName || "",
      studentNumber: ticket.studentNumber || ""
    }, { merge: true });
    return { count: count, blockedUntilMs: untilMs, counted: true };
  });
}

module.exports = { isNoShow, recordNoShow, isOwnerCancel, recordCancel };
