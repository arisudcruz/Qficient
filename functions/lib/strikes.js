// No-show strikes. A student whose ticket is voided because the Last Call ran out (they were put On Hold, called
// again and still didn't come back) gets a strike. `limit` strikes within `windowDays` block them from joining the
// queue for `blockHours` (joinQueue checks blockedUntil). An admin can lift a block early from Settings.
// Everything lives on the student's joinState/{uid} record, which the join limits already use.

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

module.exports = { isNoShow, recordNoShow };
