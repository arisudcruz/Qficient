// Audit trail: what admins and staff do, written by the server (Firestore triggers with auth context), so it can't
// be skipped or faked from a browser. Each entry in auditLogs says who, when, and in plain words what they did.
// The describe* functions are pure (no Firebase) so they can be unit-tested; index.js wires them to the triggers.
const { toMs } = require("./time");
const { DAY_KEYS, minutesText } = require("./hours");

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
      if (after.closedVoid) return entry("queue", "closedVoid", "Voided " + no + " at " + at.name + " when the window hours closed", extra);
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
  // Limits for one date (dayLimits) come from approved staff requests, which are logged with the request
  // (describeLimitRequest). Only an admin removing one by hand (nothing added in the same change) is logged here.
  const bd = before.dayLimits || {};
  const ad = after.dayLimits || {};
  const addedOrChanged = Object.keys(ad).some(function (d) { return bd[d] !== ad[d]; });
  const removed = Object.keys(bd).filter(function (d) { return !(d in ad); }).sort();
  if (!addedOrChanged && removed.length) changes.push("removed the daily limit for " + removed.map(dayLabel).join(", "));
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

  // Staff changing their own password (js/admin-password.js) marks the record with passwordChangedAt.
  if (toMs(after.passwordChangedAt) && toMs(after.passwordChangedAt) !== toMs(before.passwordChangedAt)) {
    return entry("staff", "passwordChange", who(after) + " changed their own password", { targetId: after.username || id });
  }

  const changes = [];
  if (before.role !== after.role) changes.push("role " + roleName(before.role) + " → " + roleName(after.role));
  if ((before.name || "") !== (after.name || "")) changes.push("name " + (before.name || "—") + " → " + (after.name || "—"));
  if (!changes.length) return null;
  return entry("staff", before.role !== after.role ? "staffRole" : "staffEdit", "Staff " + who(after) + ": " + changes.join("; "), { targetId: after.username || id });
}

// The Live Board presets that were added, changed or removed, compared by id.
function describeLiveBoardChange(before, after, stationName) {
  const list = function (d) { return Array.isArray(d.presets) ? d.presets.filter(function (p) { return p && p.id; }) : []; };
  const byId = function (presets) {
    const map = {};
    presets.forEach(function (p) { map[p.id] = p; });
    return map;
  };
  const b = byId(list(before));
  const a = byId(list(after));
  const label = function (p) {
    const names = (Array.isArray(p.stations) ? p.stations : []).map(function (id) { return stationName ? stationName(id) : id; });
    return "\"" + (p.name || "Untitled") + "\" (" + names.join(", ") + ")";
  };

  const parts = [];
  Object.keys(a).forEach(function (id) {
    if (!b[id]) parts.push("Added the Live Board preset " + label(a[id]));
    else if (b[id].name !== a[id].name || JSON.stringify(b[id].stations || []) !== JSON.stringify(a[id].stations || [])) {
      parts.push("Changed the Live Board preset " + (b[id].name !== a[id].name ? "\"" + (b[id].name || "Untitled") + "\" to " : "") + label(a[id]));
    }
  });
  Object.keys(b).forEach(function (id) {
    if (!a[id]) parts.push("Removed the Live Board preset \"" + (b[id].name || "Untitled") + "\"");
  });
  return parts.length ? entry("settings", "liveBoard", parts.join("; ")) : null;
}

// One day of the window hours, e.g. "8:00 AM–5:00 PM" or "closed".
function hoursDayText(day) {
  return day && day.open === true ? minutesText(day.start) + "–" + minutesText(day.end) : "closed";
}

const HOURS_DAY_NAMES = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };

function describeWindowHoursChange(b, a) {
  const parts = [];
  if ((b.enabled === true) !== (a.enabled === true)) parts.push(a.enabled === true ? "Turned window hours on" : "Turned window hours off");

  const bd = b.days || {};
  const ad = a.days || {};
  const days = DAY_KEYS.slice(1).concat(DAY_KEYS[0]); // Monday first
  const changed = days.filter(function (k) { return hoursDayText(bd[k]) !== hoursDayText(ad[k]); });
  if (changed.length) {
    parts.push(b.days ?
      "Changed the hours: " + changed.map(function (k) { return HOURS_DAY_NAMES[k] + " " + hoursDayText(bd[k]) + " → " + hoursDayText(ad[k]); }).join(", ") :
      "Set the hours: " + days.map(function (k) { return HOURS_DAY_NAMES[k] + " " + hoursDayText(ad[k]); }).join(", "));
  }

  const lastJoin = function (d) { return Number.isInteger(d.lastJoinMinutes) ? d.lastJoinMinutes : 0; };
  if (lastJoin(b) !== lastJoin(a)) {
    parts.push("New tickets now stop " + lastJoin(a) + " minute(s) before closing (was " + lastJoin(b) + ")");
  }
  return parts.length ? entry("settings", "windowHours", parts.join("; ")) : null;
}

// Changes to System Settings, the window hours, the enrollment process, the role rules and the Live Board presets. `roleName(id)`
// names a role and `stationName(id)` a station.
function describeSettingsChange(docId, before, after, roleName, stationName) {
  const b = before || {};
  const a = after || {};

  if (docId === "system") {
    const parts = [];
    if (b.autoVoidMinutes !== a.autoVoidMinutes) {
      parts.push("Changed the on-hold / last-call timeout from " + (b.autoVoidMinutes || "?") + " to " + (a.autoVoidMinutes || "?") + " minute(s)");
    }
    // Missing means the default, 20 seconds (functions/config.js).
    const cooldown = function (d) { return Number.isInteger(d.cancelCooldownSeconds) ? d.cancelCooldownSeconds : 20; };
    if (cooldown(b) !== cooldown(a)) {
      parts.push("Changed the cancel cooldown from " + cooldown(b) + " to " + cooldown(a) + " second(s)");
    }
    return parts.length ? entry("settings", "settingsTimeout", parts.join("; ")) : null;
  }

  if (docId === "windowHours") return describeWindowHoursChange(b, a);

  if (docId === "enrollment") {
    // The on/off switch (missing = open).
    const wasOpen = b.open !== false;
    const isOpen = a.open !== false;
    if (wasOpen !== isOpen) {
      return entry("settings", "enrollmentOpen", isOpen ? "Opened enrollment" : "Closed enrollment");
    }
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

  if (docId === "liveBoard") return describeLiveBoardChange(b, a, stationName);

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-12" -> "Nov 12, 2026".
function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1] : String(day || "");
}

// Staff asking for a daily limit on one date, and an admin approving or rejecting it (limitRequests).
// `station(id)` gives { name }.
function describeLimitRequest(before, after, station) {
  const r = after || before;
  if (!r) return null;
  const what = "daily limit of " + r.limit + " for " + station(r.stationId).name + " on " + dayLabel(r.day);
  const extra = { stationId: r.stationId, targetId: dayLabel(r.day) };

  if (!before && after) return entry("station", "limitRequest", "Requested a " + what + (after.reason ? " (" + after.reason + ")" : ""), extra);
  if (before && !after) {
    return before.status === "pending" ? entry("station", "limitRequestCancel", "Cancelled their request for a " + what, extra) : null;
  }
  if (before.status === "pending" && after.status === "approved") return entry("station", "limitApprove", "Approved the " + what, extra);
  if (before.status === "pending" && after.status === "rejected") {
    return entry("station", "limitReject", "Rejected the request for a " + what + (after.decisionNote ? " (" + after.decisionNote + ")" : ""), extra);
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
  describeWalkinPass, describeJoinStateChange, describeLimitRequest, dayLabel, roleLabel, actorOf, writeAudit, ROLE_RULE_NAMES
};
