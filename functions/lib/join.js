// Joining the queue happens here, on the server, so the rules can't be sidestepped from the browser:
// one live ticket per person, a short pause between joins, a pause after cancelling, a daily limit per
// account and the station's daily queue cap. The app only asks; this file decides.
const { startOfTodayMs, dayKey, toMs } = require("./time");
const { manilaTime } = require("./messages");

const ACTIVE_STATUSES = ["waiting", "serving", "skipped"];
const ENROLLMENT_PURPOSE = "Enrollment";
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

// A station's ticket code (AD1, AD2...). Mirrors assignStationCodes() in js/queue.js: a saved code wins; a station
// without one gets the next free number for its two letters, in order of station id.
// `list` is [{ id, name, code }].
function assignStationCodes(list) {
  const codes = {};
  const used = new Set();

  list.forEach(function (station) {
    if (station.code) {
      codes[station.id] = String(station.code);
      used.add(String(station.code).toUpperCase());
    }
  });

  list.filter(function (station) { return !station.code; })
    .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
    .forEach(function (station) {
      const prefix = ticketPrefix(station.name);
      let n = 1;
      while (used.has(prefix + n)) n++;
      codes[station.id] = prefix + n;
      used.add(prefix + n);
    });

  return codes;
}

function formatTicketNo(code, count) {
  return code + "-" + String(count).padStart(3, "0");
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

// The station's daily cap counts tickets that are still in play today. Shared with walk-in passes (walkin.js).
async function stationCapReached(db, stationId, dayStart) {
  const stationPeek = await db.collection("stations").doc(stationId).get();
  if (!stationPeek.exists) throw new JoinError("not-found", "That station doesn't exist.");
  const maxQueue = Number(stationPeek.data().maxQueue) || 0;
  if (maxQueue <= 0) return false;

  const used = await db.collection("tickets")
    .where("stationId", "==", stationId)
    .where("status", "in", COUNTED_STATUSES)
    .where("createdAt", ">=", new Date(dayStart))
    .count().get();
  return used.data().count >= maxQueue;
}

// When many people take a number at the same station in the same instant, their transactions collide on the station's
// counter and Firestore gives up on some of them (ABORTED, gRPC code 10). Those are tried again after a short random
// pause that grows each time, so the crowd is served one after another instead of colliding again. Anything else
// (a JoinError, a real failure) is not retried.
const CONTENTION_RETRY_MS = 20 * 1000;

function isContention(error) {
  return !!error && !(error instanceof JoinError) &&
    (error.code === 10 || error.code === "aborted" || /contention|ABORTED/i.test(String(error.message)));
}

async function withContentionRetry(work) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isContention(error)) throw error;
      if (Date.now() - started > CONTENTION_RETRY_MS) {
        throw new JoinError("resource-exhausted", "The queue is very busy right now. Please try again in a moment.");
      }
      const pause = Math.min(2000, 100 * Math.pow(2, Math.min(attempt, 4))) * (0.5 + Math.random());
      await new Promise(function (resolve) { setTimeout(resolve, pause); });
    }
  }
}

// Takes the station's next ticket number inside a transaction (numbers restart at 001 on a new day).
async function nextTicketNo(db, tx, stationRef, stationId, station, today) {
  const newDay = station.countDay !== today;
  const count = newDay ? 1 : (Number(station.count) || 0) + 1;
  let code = station.code;
  if (!code) {
    const all = await db.collection("stations").get();
    code = assignStationCodes(all.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); }))[stationId];
  }
  tx.update(stationRef, newDay ? { count: count, countDay: today } : { count: count });
  return formatTicketNo(code || ticketPrefix(station.name) + "1", count);
}

async function joinQueue(deps, auth, data) {
  const { db, FieldValue, config } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const input = data || {};

  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please sign in to join the queue.");

  const token = auth.token || {};
  const provider = token.firebase && token.firebase.sign_in_provider;
  if (provider === "password") {
    throw new JoinError("permission-denied", "Staff accounts can't join the queue. Use a student account.");
  }
  // Walk-ins (anonymous sign-in) get their ticket only through a Queue Enforcer's QR code (walkin.js).
  if (provider === "anonymous") {
    throw new JoinError("permission-denied", "Walk-ins get their ticket from the Queue Enforcer. Please ask them for a QR code.");
  }

  const enrolling = input.enrollment === true;
  let stationId = typeof input.stationId === "string" ? input.stationId.trim() : "";
  let purpose = cleanText(input.purpose, 200);

  if (enrolling) {
    // The station and purpose come from the enrollment process, not from the request.
    stationId = "pending";
    purpose = ENROLLMENT_PURPOSE;
  }

  if (!stationId || stationId.length > 100 || stationId.indexOf("/") !== -1) throw new JoinError("invalid-argument", "Please choose a station.");
  if (!/[\p{L}\p{N}]/u.test(purpose)) throw new JoinError("invalid-argument", "Please enter your purpose before joining.");

  const ownerName = cleanText(token.name || token.email, 120);
  if (!ownerName) throw new JoinError("failed-precondition", "Your account has no name. Please sign in again.");
  const studentNumber = studentNumberFromEmail(token.email);

  const profile = await db.collection("students").doc(auth.uid).get();
  const saved = profile.exists ? profile.data().studentType : "";
  const studentType = saved === "regular" || saved === "transferee" ? saved : "";

  // An enrollment starts at the first station of the student type's process, and the ticket keeps a copy of that
  // process so later changes in Enrollment Settings don't move students who are already enrolling.
  let enrollmentFlow = null;
  if (enrolling) {
    if (!studentType) throw new JoinError("failed-precondition", "Please set your student type first (account menu), then start your enrollment.");
    const settings = await db.collection("settings").doc("enrollment").get();
    const flows = settings.exists && settings.data().flows ? settings.data().flows : {};
    const flow = flows[studentType];
    if (!Array.isArray(flow) || !flow.length || flow.length > 20 || !flow.every(function (id) { return typeof id === "string" && id && id.indexOf("/") === -1; })) {
      throw new JoinError("failed-precondition", "Enrollment isn't open for your student type yet.");
    }
    enrollmentFlow = flow.slice();
    stationId = enrollmentFlow[0];
  }

  const stationRef = db.collection("stations").doc(stationId);
  const stateRef = db.collection("joinState").doc(auth.uid);
  const today = dayKey(config.tzOffsetMs, now);
  const dayStart = startOfTodayMs(config.tzOffsetMs, now);

  if (await stationCapReached(db, stationId, dayStart)) {
    throw new JoinError("resource-exhausted", "This station has reached its daily queue limit. Please try again tomorrow.");
  }

  // Step 1, this student only: the one-ticket rule and the join limits, then the join is reserved (lastJoinMs) so
  // a double tap can't make two tickets. Nobody else touches this record, so it never collides with the crowd.
  const before = await withContentionRetry(() => db.runTransaction(async function (tx) {
    const stateSnap = await tx.get(stateRef);
    const state = stateSnap.exists ? stateSnap.data() : {};

    // Blocked for missing their turn too often (functions/lib/strikes.js).
    const blockedUntilMs = toMs(state.blockedUntil);
    if (blockedUntilMs > now) {
      const rules = config.noShow || {};
      throw new JoinError("failed-precondition", "You missed your turn " + (rules.limit || 3) + " times in " + (rules.windowDays || 7) +
        " days, so you can join again on " + manilaTime(blockedUntilMs) + ". Please see the front desk if this is a mistake.");
    }

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

    // merge: the record also holds no-show strikes and any block (lib/strikes.js), which a join must keep.
    tx.set(stateRef, { ticketId: state.ticketId || null, lastJoinMs: now, day: today, joins: joinsToday + 1 }, { merge: true });
    return stateSnap.exists ? state : null;
  }));

  // Step 2, the busy part: take the station's next number and create the ticket. It only reads the station, so the
  // counter is held as briefly as possible, and a collision with the crowd is simply tried again.
  try {
    return await withContentionRetry(function () {
      return db.runTransaction(async function (tx) {
        const stationSnap = await tx.get(stationRef);
        if (!stationSnap.exists) throw new JoinError("not-found", "That station doesn't exist.");
        const station = stationSnap.data();
        if (station.active === false) throw new JoinError("failed-precondition", "This station is currently unavailable.");

        const ticketNo = await nextTicketNo(db, tx, stationRef, stationId, station, today);

        const ticketRef = db.collection("tickets").doc();
        const ticket = {
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
        };
        if (enrollmentFlow) {
          ticket.enrollment = true;
          ticket.enrollmentFlow = enrollmentFlow;
          ticket.enrollmentStep = 0;
        }
        tx.set(ticketRef, ticket);
        tx.set(stateRef, { ticketId: ticketRef.id }, { merge: true });

        return { ticketId: ticketRef.id, ticketNo: ticketNo, stationName: station.name || "" };
      });
    });
  } catch (error) {
    // No ticket was made: give the reserved join back, so the student can try again right away.
    // Only the join fields are put back, so strikes or a block recorded meanwhile stay.
    const undo = before ?
      { ticketId: before.ticketId || null, lastJoinMs: Number(before.lastJoinMs) || 0, day: before.day || null, joins: Number(before.joins) || 0 } :
      { ticketId: null, lastJoinMs: 0, day: null, joins: 0 };
    await stateRef.set(undo, { merge: true }).catch(function () {});
    throw error;
  }
}

module.exports = { joinQueue, JoinError, ticketPrefix, assignStationCodes, formatTicketNo, studentNumberFromEmail, stationCapReached, nextTicketNo, withContentionRetry };
