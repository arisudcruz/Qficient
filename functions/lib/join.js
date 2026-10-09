// Joining the queue happens here, on the server, so the rules can't be sidestepped from the browser:
// one live ticket per person, a short pause between joins, a pause after cancelling, a daily limit per
// account and the station's daily queue cap. The app only asks; this file decides.
const { startOfTodayMs, dayKey, toMs } = require("./time");

const ACTIVE_STATUSES = ["waiting", "serving", "skipped"];
const COUNTED_STATUSES = ["waiting", "serving", "skipped", "completed"]; // cancelled and void don't use up the cap

class JoinError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ticketPrefix(stationName) {
  return String(stationName || "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "TK";
}

function studentNumberFromEmail(email) {
  const digits = String(email || "").split("@")[0].replace(/\D/g, "");
  return digits ? "02000" + digits : "";
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function wait(ms) {
  return Math.ceil(ms / 1000) + " second" + (Math.ceil(ms / 1000) === 1 ? "" : "s");
}

async function joinQueue(deps, auth, data) {
  const { db, FieldValue, config } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const input = data || {};

  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please sign in to join the queue.");

  const token = auth.token || {};
  const provider = token.firebase && token.firebase.sign_in_provider;
  if (provider === "password") {
    throw new JoinError("permission-denied", "Staff accounts can't join the queue. Use a student or guest account.");
  }

  const guest = provider === "anonymous";
  const stationId = typeof input.stationId === "string" ? input.stationId.trim() : "";
  const purpose = cleanText(input.purpose, 200);

  if (!stationId || stationId.length > 100 || stationId.indexOf("/") !== -1) throw new JoinError("invalid-argument", "Please choose a station.");
  if (!/[\p{L}\p{N}]/u.test(purpose)) throw new JoinError("invalid-argument", "Please enter your purpose before joining.");

  let ownerName;
  let studentNumber = "";
  let studentType = "guest";

  if (guest) {
    ownerName = cleanText(input.guestName, 120);
    if (!/\p{L}/u.test(ownerName)) throw new JoinError("invalid-argument", "Your name is missing. Please start the guest form again.");
  } else {
    ownerName = cleanText(token.name || token.email, 120);
    if (!ownerName) throw new JoinError("failed-precondition", "Your account has no name. Please sign in again.");
    studentNumber = studentNumberFromEmail(token.email);

    const profile = await db.collection("students").doc(auth.uid).get();
    const saved = profile.exists ? profile.data().studentType : "";
    studentType = saved === "regular" || saved === "transferee" ? saved : "";
  }

  const stationRef = db.collection("stations").doc(stationId);
  const stateRef = db.collection("joinState").doc(auth.uid);
  const today = dayKey(config.tzOffsetMs, now);
  const dayStart = startOfTodayMs(config.tzOffsetMs, now);

  // The station's daily cap counts tickets that are still in play today.
  const stationPeek = await stationRef.get();
  if (!stationPeek.exists) throw new JoinError("not-found", "That station doesn't exist.");
  const maxQueue = Number(stationPeek.data().maxQueue) || 0;

  if (maxQueue > 0) {
    const used = await db.collection("tickets")
      .where("stationId", "==", stationId)
      .where("status", "in", COUNTED_STATUSES)
      .where("createdAt", ">=", new Date(dayStart))
      .count().get();

    if (used.data().count >= maxQueue) {
      throw new JoinError("resource-exhausted", "This station has reached its daily queue limit. Please try again tomorrow.");
    }
  }

  return db.runTransaction(async function (tx) {
    const [stationSnap, stateSnap] = await Promise.all([tx.get(stationRef), tx.get(stateRef)]);

    if (!stationSnap.exists) throw new JoinError("not-found", "That station doesn't exist.");
    const station = stationSnap.data();
    if (station.active === false) throw new JoinError("failed-precondition", "This station is currently unavailable.");

    const state = stateSnap.exists ? stateSnap.data() : {};

    if (state.ticketId) {
      const previous = await tx.get(db.collection("tickets").doc(state.ticketId));
      if (previous.exists) {
        const p = previous.data();

        if (ACTIVE_STATUSES.indexOf(p.status) !== -1 && toMs(p.createdAt) >= dayStart) {
          throw new JoinError("failed-precondition", "You already have an active ticket.");
        }

        const cancelledMs = p.status === "cancelled" ? toMs(p.cancelledAt) : 0;
        if (cancelledMs && now - cancelledMs < config.cancelCooldownMs) {
          throw new JoinError("resource-exhausted", "Please wait " + wait(config.cancelCooldownMs - (now - cancelledMs)) + " before joining again.");
        }
      }
    }

    const lastJoinMs = Number(state.lastJoinMs) || 0;
    if (lastJoinMs && now - lastJoinMs < config.joinMinIntervalMs) {
      throw new JoinError("resource-exhausted", "Please wait " + wait(config.joinMinIntervalMs - (now - lastJoinMs)) + " before joining again.");
    }

    const joinsToday = state.day === today ? Number(state.joins) || 0 : 0;
    if (joinsToday >= config.maxJoinsPerDay) {
      throw new JoinError("resource-exhausted", "You've reached today's limit of " + config.maxJoinsPerDay + " tickets. Please see the front desk.");
    }

    // Ticket numbers restart at 001 on the first join of each day.
    const newDay = station.countDay !== today;
    const count = newDay ? 1 : (Number(station.count) || 0) + 1;
    const ticketNo = ticketPrefix(station.name) + "-" + String(count).padStart(3, "0");

    const ticketRef = db.collection("tickets").doc();
    tx.update(stationRef, newDay ? { count: count, countDay: today } : { count: count });
    tx.set(ticketRef, {
      ticketNo: ticketNo,
      stationId: stationId,
      ownerId: auth.uid,
      ownerName: ownerName,
      studentNumber: studentNumber,
      studentType: studentType,
      purpose: purpose,
      status: "waiting",
      verified: false,
      createdAt: FieldValue.serverTimestamp()
    });
    tx.set(stateRef, { ticketId: ticketRef.id, lastJoinMs: now, day: today, joins: joinsToday + 1 });

    return { ticketId: ticketRef.id, ticketNo: ticketNo, stationName: station.name || "" };
  });
}

module.exports = { joinQueue, JoinError, ticketPrefix, studentNumberFromEmail };
