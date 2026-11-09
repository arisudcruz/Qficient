// Manual tickets: for walk-ins without a phone. The Queue Enforcer (or an admin) fills in the Walk-in Form and
// presses Manual Ticket; the ticket is made here at once and its number is shown on the enforcer's screen for the
// walk-in to remember (they follow the TV board and the announcements). The ticket belongs to an owner that never
// signs in ("nophone:..."), carries noPhone: true, and gets no pushes or history of its own (index.js).
// Same safe path as joinQueue and redeemWalkinPass: daily cap, the station's next number in a transaction.
const crypto = require("crypto");
const { startOfTodayMs, dayKey } = require("./time");
const { JoinError, stationCapReached, nextTicketNo, withContentionRetry } = require("./join");

const ADMIN_EMAIL = "admin@qficient.com";
const ENROLLMENT_PURPOSE = "Enrollment";
const STUDENT_TYPES = ["regular", "transferee", "freshman", "guest"];
const ENROLLMENT_TYPES = ["regular", "transferee", "freshman"];
const NUMBERED_TYPES = ["regular", "transferee"];

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

// Who is asking: an administrator, or the Queue Enforcer (whose role rules may limit them). Null for anyone else.
async function callerRole(db, auth) {
  const token = (auth && auth.token) || {};
  const provider = token.firebase && token.firebase.sign_in_provider;
  if (!auth || !auth.uid) throw new JoinError("unauthenticated", "Please sign in again.");
  if (provider !== "password") return null;
  const email = String(token.email || "").toLowerCase();
  if (email === ADMIN_EMAIL) return { email: email, role: "admin" };
  const record = await db.collection("staff").doc(email).get();
  const role = record.exists ? record.data().role : "";
  return role === "admin" || role === "enforcer" ? { email: email, role: role } : null;
}

// System Rules > Role Rules: anything not switched off is allowed; admins are never limited.
async function roleAllows(db, role, key) {
  if (role === "admin") return true;
  const doc = await db.collection("settings").doc("roleRules").get();
  const rules = doc.exists && doc.data().roles ? doc.data().roles[role] : null;
  return !(rules && rules[key] === false);
}

// deps: { db, FieldValue, config, now? }. data: the Walk-in Form (ownerName, studentType, studentNumber, stationId,
// purpose, enrollment, priority).
async function createManualTicket(deps, auth, data) {
  const { db, FieldValue, config } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const input = data || {};

  const caller = await callerRole(db, auth);
  if (!caller) throw new JoinError("permission-denied", "Only the Queue Enforcer or an administrator can make manual tickets.");
  if (!(await roleAllows(db, caller.role, "walkin"))) {
    throw new JoinError("permission-denied", "Making walk-in tickets is turned off for your role in System Rules.");
  }

  const ownerName = cleanText(input.ownerName, 120);
  if (!/\p{L}/u.test(ownerName)) throw new JoinError("invalid-argument", "Please enter the walk-in's name.");

  const enrolling = input.enrollment === true;
  const studentType = enrolling ? cleanText(input.studentType, 20) : "";
  if (enrolling && ENROLLMENT_TYPES.indexOf(studentType) === -1) {
    throw new JoinError("invalid-argument", "Enrollment is for Regular, Transferee / Irregular and Incoming Freshman students.");
  }
  if (studentType && STUDENT_TYPES.indexOf(studentType) === -1) throw new JoinError("invalid-argument", "That student type isn't valid.");

  let studentNumber = "";
  if (NUMBERED_TYPES.indexOf(studentType) !== -1) {
    studentNumber = cleanText(input.studentNumber, 20);
    if (!/^02000-\d{6}$/.test(studentNumber)) throw new JoinError("invalid-argument", "Please enter a valid student number, like 02000-123456.");
  }

  const priority = input.priority === true;
  if (priority && !(await roleAllows(db, caller.role, "prioritize"))) {
    throw new JoinError("permission-denied", "Prioritize is turned off for your role in System Rules.");
  }

  // Where the ticket goes: the chosen station, or the first station of the student type's enrollment process.
  let stationId = cleanText(input.stationId, 100);
  let purpose = cleanText(input.purpose, 200);
  let enrollmentFlow = null;
  if (enrolling) {
    const settings = await db.collection("settings").doc("enrollment").get();
    // The switch in Enrollment Settings: no new enrollments while it is off.
    if (settings.exists && settings.data().open === false) {
      throw new JoinError("failed-precondition", "Enrollment is currently closed.");
    }
    const flows = settings.exists && settings.data().flows ? settings.data().flows : {};
    const flow = flows[studentType];
    if (!Array.isArray(flow) || !flow.length || flow.length > 20) {
      throw new JoinError("failed-precondition", "Enrollment isn't set up for this student type yet.");
    }
    enrollmentFlow = flow.slice();
    stationId = flow[0];
    purpose = ENROLLMENT_PURPOSE;
  }
  if (!stationId || stationId.indexOf("/") !== -1) throw new JoinError("invalid-argument", "Please choose a station.");
  if (!/[\p{L}\p{N}]/u.test(purpose)) throw new JoinError("invalid-argument", "Please choose the purpose.");

  const today = dayKey(config.tzOffsetMs, now);
  const dayStart = startOfTodayMs(config.tzOffsetMs, now);
  const stationRef = db.collection("stations").doc(stationId);

  if (await stationCapReached(db, stationId, dayStart)) {
    throw new JoinError("resource-exhausted", "This station has reached its daily queue limit.");
  }

  return withContentionRetry(function () {
    return db.runTransaction(async function (tx) {
      const stationSnap = await tx.get(stationRef);
      if (!stationSnap.exists) throw new JoinError("not-found", "That station doesn't exist anymore.");
      const station = stationSnap.data();
      if (station.active === false) throw new JoinError("failed-precondition", "This station is currently unavailable.");

      const ticketNo = await nextTicketNo(db, tx, stationRef, stationId, station, today);
      const ticketRef = db.collection("tickets").doc();
      const ticket = {
        ticketNo: ticketNo,
        stationId: stationId,
        ownerId: "nophone:" + crypto.randomBytes(9).toString("hex"),
        ownerName: ownerName,
        studentNumber: studentNumber,
        studentType: studentType,
        purpose: purpose,
        status: "waiting",
        verified: false,
        createdAt: FieldValue.serverTimestamp(),
        manual: true,
        noPhone: true,
        createdBy: caller.email
      };
      if (priority) ticket.prioritizedAt = FieldValue.serverTimestamp();
      if (enrolling) {
        ticket.enrollment = true;
        ticket.enrollmentFlow = enrollmentFlow;
        ticket.enrollmentStep = 0;
      }
      tx.set(ticketRef, ticket);

      return { ticketId: ticketRef.id, ticketNo: ticketNo, stationName: station.name || "", ownerName: ownerName, enrollment: enrolling, priority: priority };
    });
  });
}

module.exports = { createManualTicket };
