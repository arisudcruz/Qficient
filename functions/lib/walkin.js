// Walk-in passes: the Queue Enforcer fills in a walk-in's details and shows a one-time QR code
// (walkinPasses/{passId}, holding only the SHA-256 of the code's secret). The walk-in scans it with their phone,
// which signs in anonymously and calls redeemWalkinPass: only then is the ticket created, owned by that phone,
// so the walk-in follows it in the app (temporary access) and gets alerts like any student.
const crypto = require("crypto");
const { startOfTodayMs, dayKey, toMs } = require("./time");
const { JoinError, stationCapReached, nextTicketNo, withContentionRetry } = require("./join");

const ACTIVE_STATUSES = ["waiting", "serving", "skipped"];
const PASS_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function passMs(config) {
  return (Number(config.walkinPassMinutes) || 10) * 60 * 1000;
}

async function redeemWalkinPass(deps, auth, data) {
  const { db, FieldValue, config } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const input = data || {};

  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please open the QR code link again.");
  const provider = auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider;
  if (provider !== "anonymous") {
    throw new JoinError("permission-denied", "This phone is signed in to another QFicient account. Log out first, then scan the QR code again.");
  }

  const passId = typeof input.passId === "string" ? input.passId : "";
  const secret = typeof input.secret === "string" ? input.secret : "";
  if (!PASS_ID_PATTERN.test(passId) || !SECRET_PATTERN.test(secret)) {
    throw new JoinError("invalid-argument", "This QR code isn't valid. Ask the Queue Enforcer for a new one.");
  }

  const passRef = db.collection("walkinPasses").doc(passId);
  const peek = await passRef.get();
  if (!peek.exists || !sameHash(hashSecret(secret), peek.data().secretHash)) {
    throw new JoinError("not-found", "This QR code isn't valid. Ask the Queue Enforcer for a new one.");
  }

  const pass = peek.data();

  // The same phone opening the link again (a refresh, a second scan) just gets its ticket back.
  if (pass.usedBy === auth.uid && pass.ticketId) {
    return { ticketId: pass.ticketId, ticketNo: pass.ticketNo, stationName: pass.stationName || "", ownerName: pass.ownerName };
  }
  if (pass.usedAt) throw new JoinError("failed-precondition", "This QR code has already been used. Ask the Queue Enforcer for a new one.");
  if (now - toMs(pass.createdAt) >= passMs(config)) {
    throw new JoinError("deadline-exceeded", "This QR code has expired. Ask the Queue Enforcer for a new one.");
  }

  const stationId = pass.stationId;
  const today = dayKey(config.tzOffsetMs, now);
  const dayStart = startOfTodayMs(config.tzOffsetMs, now);
  const stationRef = db.collection("stations").doc(stationId);
  const stateRef = db.collection("joinState").doc(auth.uid);

  if (await stationCapReached(db, stationId, dayStart)) {
    throw new JoinError("resource-exhausted", "This station has reached its daily queue limit. Please see the Queue Enforcer.");
  }

  // Step 1, this pass and this phone only: the pass is claimed for this phone (so two phones scanning together
  // can't both get a ticket) and the phone must not already hold a live ticket. This never touches the station.
  const claim = await withContentionRetry(() => db.runTransaction(async function (tx) {
    const [passSnap, stateSnap] = await Promise.all([tx.get(passRef), tx.get(stateRef)]);

    const fresh = passSnap.data();
    if (fresh.usedAt || (fresh.claimedBy && fresh.claimedBy !== auth.uid)) {
      throw new JoinError("failed-precondition", "This QR code has already been used. Ask the Queue Enforcer for a new one.");
    }

    // One phone holds one live ticket.
    const state = stateSnap.exists ? stateSnap.data() : {};
    if (state.ticketId) {
      const previous = await tx.get(db.collection("tickets").doc(state.ticketId));
      if (previous.exists && ACTIVE_STATUSES.indexOf(previous.data().status) !== -1 && toMs(previous.data().createdAt) >= dayStart) {
        throw new JoinError("failed-precondition", "This phone already has an active ticket.");
      }
    }

    tx.update(passRef, { claimedBy: auth.uid });
    return { pass: fresh, joinsToday: state.day === today ? Number(state.joins) || 0 : 0 };
  }));

  // Step 2, the busy part: take the station's next number and create the ticket. Only the station is read, so its
  // counter is held as briefly as possible, and a collision with the crowd is simply tried again.
  const fresh = claim.pass;
  try {
    return await withContentionRetry(function () {
      return db.runTransaction(async function (tx) {
        const stationSnap = await tx.get(stationRef);
        if (!stationSnap.exists) throw new JoinError("not-found", "That station doesn't exist anymore. Please see the Queue Enforcer.");
        const station = stationSnap.data();
        if (station.active === false) throw new JoinError("failed-precondition", "This station is currently unavailable. Please see the Queue Enforcer.");

        const ticketNo = await nextTicketNo(db, tx, stationRef, stationId, station, today);
        const ticketRef = db.collection("tickets").doc();
        const ticket = {
          ticketNo: ticketNo,
          stationId: stationId,
          ownerId: auth.uid,
          ownerName: fresh.ownerName,
          studentNumber: "",
          studentType: fresh.studentType,
          purpose: fresh.purpose,
          status: "waiting",
          verified: false,
          createdAt: FieldValue.serverTimestamp(),
          manual: true,
          createdBy: fresh.createdBy
        };
        if (fresh.enrollment === true) {
          ticket.enrollment = true;
          ticket.enrollmentFlow = fresh.enrollmentFlow;
          ticket.enrollmentStep = 0;
        }

        tx.set(ticketRef, ticket);
        tx.update(passRef, { usedAt: FieldValue.serverTimestamp(), usedBy: auth.uid, ticketId: ticketRef.id, ticketNo: ticketNo, stationName: station.name || "" });
        tx.set(stateRef, { ticketId: ticketRef.id, lastJoinMs: now, day: today, joins: claim.joinsToday + 1 }, { merge: true });

        return { ticketId: ticketRef.id, ticketNo: ticketNo, stationName: station.name || "", ownerName: fresh.ownerName };
      });
    });
  } catch (error) {
    // No ticket was made: free the pass again, so it can still be scanned while it's valid.
    await passRef.update({ claimedBy: FieldValue.delete() }).catch(function () {});
    throw error;
  }
}

module.exports = { redeemWalkinPass, hashSecret };
