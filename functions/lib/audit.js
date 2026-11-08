// Audit trail: what admins and staff do, written by the server (Firestore triggers with auth context), so it can't
// be skipped or faked from a browser. Each entry in auditLogs says who, when, and in plain words what they did.
// The describe* functions are pure (no Firebase) so they can be unit-tested; index.js wires them to the triggers.
const { toMs } = require("./time");

const ROLE_RULE_NAMES = {
  "page.dashboard": "Dashboard",
  "page.notifications": "Notifications",
  "page.liveboard": "Live Board",
  "page.reports": "Reports",
  recall: "Recall",
  prioritize: "Prioritize",
  remove: "Remove",
  hold: "Put on Hold",
  lastCall: "Last Call",
  transfer: "Transfer",
  walkin: "Walk-in Tickets"
};

const STUDENT_TYPE_NAMES = { regular: "Regular", transferee: "Transferee / Irregular", freshman: "Incoming Freshman", guest: "Guest" };

function entry(category, action, summary, extra) {
  return Object.assign({ category: category, action: action, summary: summary }, extra || {});
}

function windowText(after, windows) {
  return windows > 1 && Number(after.window) >= 1 ? ", Window " + Number(after.window) : "";
}

// What a staff member did to a ticket. `station(id)` gives { name, windows }.
function describeTicketAction(before, after, station) {
  if (!after) return null; // tickets are never deleted from the app
  const at = station(after.stationId);
  const no = after.ticketNo || "a ticket";
  const extra = { stationId: after.stationId, targetId: after.ticketNo || "" };

  if (!before) return entry("queue", "create", "Created ticket " + no + " at " + at.name, extra);

  // An enrollment student sent on to the next station of their process.
  if (after.enrollment === true && before.stationId !== after.stationId) {
    const from = station(before.stationId);
    return entry("queue", "enrollmentNext", "Sent " + (before.ticketNo || no) + " on from " + from.name + " to " + at.name + " as " + no,
      { stationId: before.stationId, targetId: before.ticketNo || no });
  }
  if (before.stationId !== after.stationId) {
    return entry("queue", "transfer", "Moved " + (before.ticketNo || no) + " to " + at.name + " as " + no + (after.prioritizedAt ? " (prioritized)" : ""), extra);
  }

  if (after.status !== before.status) {
    if (after.status === "serving") return entry("queue", "call", "Called " + no + " at " + at.name + windowText(after, at.windows), extra);
    if (after.status === "completed") {
      return entry("queue", "complete", (after.enrollment === true ? "Completed the enrollment of " : "Completed ") + no + " at " + at.name, extra);
    }
    if (after.status === "skipped") return entry("queue", "hold", "Put " + no + " on hold at " + at.name, extra);
    if (after.status === "void") {
      return after.autoVoided ?
        entry("queue", "autoVoid", "Voided " + no + " at " + at.name + " after its last call ran out", extra) :
        entry("queue", "remove", "Removed " + no + " at " + at.name, extra);
    }
    if (after.status === "cancelled") return entry("queue", "cancel", "Cancelled " + no + " at " + at.name, extra);
  }

  if (after.lastCalled === true && toMs(after.lastCallAt) !== toMs(before.lastCallAt)) {
    return entry("queue", "lastCall", "Gave " + no + " a last call at " + at.name, extra);
  }
  if ((after.recallCount || 0) > (before.recallCount || 0)) {
    return entry("queue", "recall", "Recalled " + no + " at " + at.name, extra);
  }
  if (after.prioritizedAt && toMs(after.prioritizedAt) !== toMs(before.prioritizedAt)) {
    return entry("queue", "prioritize", "Prioritized " + no + " at " + at.name, extra);
  }
  if (after.verified === true && before.verified !== true) {
    return entry("queue", "verify", "Verified " + no + " at " + at.name, extra);
  }
  return null; // bookkeeping (notifications sent, etc.)
}

function listText(list) {
  return Array.isArray(list) && list.length ? list.join(", ") : "none";
}

// Changes to a station in Settings. Counter bumps and pointer moves (part of serving) are not logged.
function describeStationChange(before, after, id) {
  if (!before && after) return entry("station", "stationCreate", "Created the station " + (after.name || id), { stationId: id, targetId: after.name || id });
  if (before && !after) return entry("station", "stationDelete", "Deleted the station " + (before.name || id), { stationId: id, targetId: before.name || id });
  if (!before || !after) return null;

  const name = after.name || id;
  const changes = [];
  if (before.name !== after.name) changes.push("renamed from " + before.name + " to " + after.name);
  if ((before.active !== false) !== (after.active !== false)) changes.push(after.active === false ? "disabled" : "enabled");
  if (JSON.stringify(before.purposes || null) !== JSON.stringify(after.purposes || null)) changes.push("purposes set to " + listText(after.purposes));
  if ((before.maxQueue || null) !== (after.maxQueue || null)) changes.push("daily limit " + (after.maxQueue > 0 ? "set to " + after.maxQueue : "removed"));
  if ((Number(before.windows) || 1) !== (Number(after.windows) || 1)) changes.push("windows " + (Number(before.windows) || 1) + " → " + (Number(after.windows) || 1));
  if (!changes.length) return null;

  return entry("station", "stationEdit", "Station " + name + ": " + changes.join("; "), { stationId: id, targetId: name });
}

// Changes to staff accounts in Settings. `roleName(role)` turns a role id into words.
function describeStaffChange(before, after, id, roleName) {
  const who = function (d) { return (d && (d.name || d.username)) || id; };
  if (!before && after) {
    return entry("staff", "staffAdd", "Added " + who(after) + (after.username ? " (" + after.username + ")" : "") + " as " + roleName(after.role), { targetId: after.username || id });
  }
  if (before && !after) return entry("staff", "staffRemove", "Removed " + who(before) + "'s access", { targetId: before.username || id });
  if (!before || !after) return null;

  const changes = [];
  if (before.role !== after.role) changes.push("role " + roleName(before.role) + " → " + roleName(after.role));
  if ((before.name || "") !== (after.name || "")) changes.push("name " + (before.name || "—") + " → " + (after.name || "—"));
  if (!changes.length) return null;
  return entry("staff", before.role !== after.role ? "staffRole" : "staffEdit", "Staff " + who(after) + ": " + changes.join("; "), { targetId: after.username || id });
}

// Changes to System Settings, the enrollment process and the role rules. `roleName(id)` names a role.
function describeSettingsChange(docId, before, after, roleName) {
  const b = before || {};
  const a = after || {};

  if (docId === "system") {
    if (b.autoVoidMinutes === a.autoVoidMinutes) return null;
    return entry("settings", "settingsTimeout", "Changed the on-hold / last-call timeout from " + (b.autoVoidMinutes || "?") + " to " + (a.autoVoidMinutes || "?") + " minute(s)");
  }

  if (docId === "enrollment") {
    const bf = b.flows || {};
    const af = a.flows || {};
    const types = Object.keys(Object.assign({}, bf, af)).filter(function (t) { return JSON.stringify(bf[t] || []) !== JSON.stringify(af[t] || []); });
    if (!types.length) return null;
    return entry("settings", "enrollmentFlow", "Changed the enrollment process for " + types.map(function (t) { return STUDENT_TYPE_NAMES[t] || t; }).join(", "));
  }

  if (docId === "roleRules") {
    const br = b.roles || {};
    const ar = a.roles || {};
    const parts = [];
    Object.keys(Object.assign({}, br, ar)).forEach(function (roleId) {
      const was = br[roleId] || {};
      const now = ar[roleId] || {};
      const flips = Object.keys(Object.assign({}, was, now)).filter(function (key) {
        return (was[key] !== false) !== (now[key] !== false);
      }).map(function (key) {
        return (ROLE_RULE_NAMES[key] || key) + (now[key] === false ? " off" : " on");
      });
      if (flips.length) parts.push(roleName(roleId) + ": " + flips.join(", "));
    });
    if (!parts.length) return null;
    return entry("settings", "roleRules", "Changed the role rules. " + parts.join("; "));
  }

  return null;
}

function describeWalkinPass(before, after, station) {
  if (before || !after) return null; // passes are only created by staff; using them is the walk-in's own action
  const where = after.enrollment === true ? "Enrollment, starting at " + station(after.stationId).name : station(after.stationId).name + ", " + (after.purpose || "");
  return entry("walkin", "walkinPass", "Made a " + (after.priority === true ? "priority " : "") + "walk-in QR for " + (after.ownerName || "a walk-in") + " (" + where + ")", { stationId: after.stationId, targetId: after.ownerName || "" });
}

function describeJoinStateChange(before, after) {
  if (!before || !after) return null;
  const wasBlocked = toMs(before.blockedUntil) > 0;
  if (wasBlocked && !after.blockedUntil && after.unblockedBy) {
    return entry("staff", "unblock", "Lifted the queue block on " + (before.ownerName || "a student") + (before.studentNumber ? " (" + before.studentNumber + ")" : ""), { targetId: before.studentNumber || "" });
  }
  return null;
}

// "Administrator", "Queue Enforcer" or "<Station> Staff".
function roleLabel(role, stationName) {
  if (role === "admin") return "Administrator";
  if (role === "enforcer") return "Queue Enforcer";
  return role ? (stationName || role) + " Staff" : "No role";
}

// The staff member behind a change: their staff record, found through their sign-in. Null for students, walk-ins
// and anything the server does itself. deps: { db, adminAuth }. Cached for a few minutes per uid.
const actorCache = new Map();
const ACTOR_CACHE_MS = 5 * 60 * 1000;

async function actorOf(deps, authType, authId) {
  if (authType !== "app_user" || !authId) return null;
  const cached = actorCache.get(authId);
  if (cached && Date.now() - cached.at < ACTOR_CACHE_MS) return cached.actor;

  let actor = null;
  try {
    const user = await deps.adminAuth.getUser(authId);
    const email = String(user.email || "").toLowerCase();
    const isPassword = (user.providerData || []).some(function (p) { return p.providerId === "password"; });
    if (email && isPassword) {
      const record = await deps.db.collection("staff").doc(email).get();
      if (record.exists) {
        const d = record.data();
        actor = { email: email, username: d.username || (email === "admin@qficient.com" ? "admin" : ""), name: d.name || "", role: d.role || "" };
      }
    }
  } catch (error) {
    actor = null;
  }
  actorCache.set(authId, { at: Date.now(), actor: actor });
  return actor;
}

// Writes one entry. deps: { db, FieldValue, stationName(id) }.
async function writeAudit(deps, actor, item) {
  if (!actor || !item) return false;
  const roleStation = actor.role && actor.role !== "admin" && actor.role !== "enforcer" ? await deps.stationName(actor.role) : "";
  const doc = {
    at: deps.FieldValue.serverTimestamp(),
    actorEmail: actor.email,
    actorUsername: actor.username || "",
    actorName: actor.name || "",
    actorRole: roleLabel(actor.role, roleStation),
    category: item.category,
    action: item.action,
    summary: String(item.summary || "").slice(0, 500)
  };
  if (item.stationId) doc.stationId = item.stationId;
  if (item.targetId) doc.targetId = String(item.targetId).slice(0, 120);
  await deps.db.collection("auditLogs").add(doc);
  return true;
}

module.exports = {
  describeTicketAction, describeStationChange, describeStaffChange, describeSettingsChange,
  describeWalkinPass, describeJoinStateChange, roleLabel, actorOf, writeAudit, ROLE_RULE_NAMES
};
