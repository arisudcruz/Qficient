// System Rules: what each role may do. An administrator switches permissions on or off per role (the Queue Enforcer,
// and each station's Queue Management staff) in Role Rules; General Rules lists them all for reference.
// Saved in settings/roleRules as { roles: { enforcer: { recall: false, ... }, <stationId>: { ... } } }; anything not
// listed is allowed. Administrators always have every permission. The app hides what is switched off, and
// firestore.rules (roleAllows) refuses the same actions, so they can't be done from the browser console either.
// A role can only be limited, never given more than it has by default.

var ROLE_RULE_GROUPS = [
  {
    title: "Pages",
    rules: [
      { key: "page.dashboard", name: "Dashboard", roles: ["enforcer", "station"],
        desc: "Open the Dashboard with the day's queue figures and charts." },
      { key: "page.notifications", name: "Notifications", roles: ["enforcer", "station"],
        desc: "Open the Notifications page and the bell in the header." },
      { key: "page.liveboard", name: "Live Board", roles: ["enforcer", "station"],
        desc: "Open the Live Board and the full-screen TV board." },
      { key: "page.reports", name: "Reports", roles: ["station"],
        desc: "Generate and export reports for their station." }
    ]
  },
  {
    title: "Queue Actions",
    rules: [
      { key: "recall", name: "Recall a Ticket", roles: ["enforcer", "station"],
        desc: "Notify a ticket's owner on their phone to go to the counter." },
      { key: "prioritize", name: "Prioritize a Ticket", roles: ["enforcer", "station"],
        desc: "Move a waiting ticket to the front of its station's queue." },
      { key: "remove", name: "Remove a Ticket", roles: ["enforcer", "station"],
        desc: "Void a ticket right away. Tickets whose last call runs out are still voided automatically." },
      { key: "hold", name: "Put a Ticket on Hold", roles: ["station"],
        desc: "Put the ticket being served on hold while its owner comes back to the counter." },
      { key: "lastCall", name: "Give a Last Call", roles: ["station"],
        desc: "Give an on-hold ticket whose time ran out a final countdown before it is voided." }
    ]
  },
  {
    title: "Walk-ins",
    rules: [
      { key: "walkin", name: "Make Walk-in Tickets", roles: ["enforcer"],
        desc: "Fill in the Walk-in Form and show the QR code that gives a walk-in their ticket." }
    ]
  }
];

// What each role keeps no matter what, so it can still do its job.
var ROLE_ALWAYS_ALLOWED = {
  station: [
    ["Queue Management", "Open their station's Queue Management page."],
    ["Call Tickets", "Call Next, and call a ticket out of order (Call now)."],
    ["End Transaction", "Mark the ticket being served as completed."],
    ["Enrollment Hand-off", "Send an enrollee on to the next station of their process."],
    ["System Rules", "Read the System Rules (only an administrator changes them)."]
  ],
  enforcer: [
    ["Queue Enforcer", "Open the Queue Enforcer page and its Queue List."],
    ["System Rules", "Read the System Rules (only an administrator changes them)."]
  ]
};

var ROLE_KIND_LABELS = { enforcer: "Queue Enforcer", station: "Queue Management staff" };
var ROLE_RULE_OFF_TITLE = "Turned off in System Rules";

var roleRulesSaved = {};      // settings/roleRules: roles, as saved
var roleRulesDraft = {};      // roleId -> { key: bool }: unsaved switches in Role Rules
var rulesActiveTab = "general";
var rulesSelectedRole = "";

/* ---------- Checks used across the console ---------- */

function roleKindOf(roleId) {
  return roleId === "enforcer" ? "enforcer" : "station";
}

function roleRulesFor(kind) {
  var list = [];
  ROLE_RULE_GROUPS.forEach(function (group) {
    group.rules.forEach(function (rule) { if (rule.roles.indexOf(kind) !== -1) list.push(rule); });
  });
  return list;
}

function savedRoleRule(roleId, key) {
  var role = roleRulesSaved[roleId];
  return !(role && role[key] === false);
}

// Whether the signed-in staff member's role may do `key`. Admins (and anyone signed out) are never limited.
function roleCan(key) {
  var kind = typeof adminKind === "function" ? adminKind() : null;
  if (!kind || kind === "admin") return true;
  return savedRoleRule(kind === "enforcer" ? "enforcer" : adminRole, key);
}

// For the actions: says why and returns true when the role's rules don't allow it.
function roleRuleBlocks(key, action) {
  if (roleCan(key)) return false;
  say("Your role isn't allowed to " + action + ". An administrator can change this in System Rules.");
  return true;
}

// Called by js/firebase.js whenever settings/roleRules changes.
function onRoleRulesChanged(roles) {
  roleRulesSaved = roles && typeof roles === "object" ? roles : {};
  if (typeof isAdminSignedIn === "function" && isAdminSignedIn()) applyAdminAccess(true);
}

/* ---------- The page ---------- */

function setRulesTab(tab) {
  rulesActiveTab = tab === "role" ? "role" : "general";
  renderRules();
}

// Everyone can read the rules; only a full admin can change them.
function canEditRules() {
  return isFullAdmin();
}

// The roles Role Rules can limit: the Queue Enforcer, then each station's staff.
function ruleRoles() {
  return [{ id: "enforcer", name: "Queue Enforcer" }].concat(getSortedStations().map(function (station) {
    return { id: station.id, name: station.name + " Staff" };
  }));
}

function rulesTableHtml(headers, rowsHtml) {
  return '<div class="table-wrap rules-table-wrap"><table class="queue-table settings-table rules-table"><thead><tr>' +
    headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + h.label + '</th>'; }).join("") +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

function rulesSectionHtml(title, tableHtml) {
  return '<section class="panel settings-panel rules-section">' +
    '<div class="panel-header"><h2>' + escapeAdminText(title) + '</h2></div>' + tableHtml +
  '</section>';
}

function renderGeneralRulesBody() {
  var appliesTo = function (rule) {
    return rule.roles.map(function (kind) { return ROLE_KIND_LABELS[kind]; }).join(", ");
  };

  var sectionsHtml = ROLE_RULE_GROUPS.map(function (group) {
    var rowsHtml = group.rules.map(function (rule) {
      return '<tr><td class="settings-strong">' + escapeAdminText(rule.name) + '</td>' +
        '<td class="rules-desc">' + escapeAdminText(rule.desc) + '</td>' +
        '<td class="rules-applies">' + escapeAdminText(appliesTo(rule)) + '</td></tr>';
    }).join("");
    return rulesSectionHtml(group.title, rulesTableHtml([{ label: "Rule" }, { label: "Description" }, { label: "Applies to", cls: "rules-applies" }], rowsHtml));
  }).join("");

  var alwaysHtml = Object.keys(ROLE_ALWAYS_ALLOWED).map(function (kind) {
    return ROLE_ALWAYS_ALLOWED[kind].map(function (item) {
      return '<tr><td class="settings-strong">' + escapeAdminText(item[0]) + '</td>' +
        '<td class="rules-desc">' + escapeAdminText(item[1]) + '</td>' +
        '<td class="rules-applies">' + escapeAdminText(ROLE_KIND_LABELS[kind]) + '</td></tr>';
    }).join("");
  }).join("");

  return '<div class="settings-config-head">' +
      '<div><h2 class="settings-title rules-title">Access Permission</h2>' +
        '<p class="settings-sub">The permissions an administrator can give or take away from each role in Role Rules. Administrators always have every permission.</p></div>' +
    '</div>' +
    sectionsHtml +
    rulesSectionHtml("Always Allowed", rulesTableHtml([{ label: "Rule" }, { label: "Description" }, { label: "Applies to", cls: "rules-applies" }], alwaysHtml));
}

// The switches on screen for a role: the unsaved draft if there is one, else what is saved.
function shownRoleRule(roleId, key) {
  var draft = roleRulesDraft[roleId];
  if (draft && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key];
  return savedRoleRule(roleId, key);
}

function roleRulesDirty() {
  return Object.keys(roleRulesDraft).some(function (roleId) {
    return Object.keys(roleRulesDraft[roleId]).some(function (key) {
      return roleRulesDraft[roleId][key] !== savedRoleRule(roleId, key);
    });
  });
}

function renderRoleRulesBody() {
  var editable = canEditRules();
  var roles = ruleRoles();
  var kind = adminKind();

  // Staff see their own role's rules; an admin picks any role.
  if (!editable) rulesSelectedRole = kind === "enforcer" ? "enforcer" : adminRole;
  if (!roles.some(function (r) { return r.id === rulesSelectedRole; })) rulesSelectedRole = roles[0].id;

  var roleId = rulesSelectedRole;
  var roleKind = roleKindOf(roleId);
  var rules = roleRulesFor(roleKind);
  var allOn = rules.every(function (rule) { return shownRoleRule(roleId, rule.key); });
  var locked = editable ? '' : ' disabled';
  var id = escapeAdminText(roleId);

  var optionsHtml = roles.map(function (role) {
    return '<option value="' + escapeAdminText(role.id) + '"' + (role.id === roleId ? ' selected' : '') + '>' + escapeAdminText(role.name) + '</option>';
  }).join("");

  var sectionsHtml = ROLE_RULE_GROUPS.map(function (group) {
    var mine = group.rules.filter(function (rule) { return rule.roles.indexOf(roleKind) !== -1; });
    if (!mine.length) return "";
    var rowsHtml = mine.map(function (rule) {
      var on = shownRoleRule(roleId, rule.key);
      return '<tr><td class="settings-strong">' + escapeAdminText(rule.name) + '</td>' +
        '<td class="rules-desc">' + escapeAdminText(rule.desc) + '</td>' +
        '<td class="rules-action"><label class="switch"><input type="checkbox" aria-label="Allow ' + escapeAdminText(rule.name) + '"' +
          (on ? ' checked' : '') + locked + ' onchange="setRoleRule(\'' + id + '\', \'' + rule.key + '\', this.checked)"><span class="switch-track"></span></label></td></tr>';
    }).join("");
    return rulesSectionHtml(group.title, rulesTableHtml([{ label: "Rules" }, { label: "Description" }, { label: "Access", cls: "rules-action" }], rowsHtml));
  }).join("");

  var alwaysRows = ROLE_ALWAYS_ALLOWED[roleKind].map(function (item) {
    return '<tr class="rules-always-row"><td class="settings-strong">' + escapeAdminText(item[0]) + '</td>' +
      '<td class="rules-desc">' + escapeAdminText(item[1]) + '</td>' +
      '<td class="rules-action"><span class="rules-always-tag">Always on</span></td></tr>';
  }).join("");

  var dirty = editable && roleRulesDirty();

  return '<div class="settings-config-head">' +
      '<div><h2 class="settings-title rules-title">Role Rules</h2>' +
        '<p class="settings-sub">' + (editable ?
          'Switch off what the selected role shouldn\'t do. The change applies to everyone with that role as soon as you save.' :
          'What your role is allowed to do. Only an administrator can change it.') + '</p></div>' +
      '<select class="enforcer-station-select rules-role-select" aria-label="Role" onchange="selectRulesRole(this.value)"' + locked + '>' + optionsHtml + '</select>' +
    '</div>' +

    (editable ?
      '<div class="rules-allow-all">' +
        '<span>Allow All</span>' +
        '<label class="switch"><input type="checkbox" aria-label="Allow all rules for this role"' + (allOn ? ' checked' : '') +
          ' onchange="setAllRoleRules(\'' + id + '\', this.checked)"><span class="switch-track"></span></label>' +
      '</div>' : '') +

    sectionsHtml +
    rulesSectionHtml("Always Allowed", rulesTableHtml([{ label: "Rules" }, { label: "Description" }, { label: "Access", cls: "rules-action" }], alwaysRows)) +

    (dirty ?
      '<div class="rules-save-bar">' +
        '<span>You have unsaved changes to the role rules.</span>' +
        '<div class="settings-actions">' +
          '<button type="button" class="settings-btn settings-btn-blue" onclick="discardRoleRules()">Discard</button>' +
          '<button type="button" class="settings-btn settings-btn-primary" id="rulesSaveBtn" onclick="confirmSaveRoleRules()">Save Changes</button>' +
        '</div>' +
      '</div>' : '');
}

function renderRules() {
  var area = document.getElementById("adminRulesArea");
  if (!area) return;

  var tabsHtml = [["general", "General Rules"], ["role", "Role Rules"]].map(function (tab) {
    return '<button type="button" class="rules-tab' + (tab[0] === rulesActiveTab ? ' active' : '') + '" role="tab" onclick="setRulesTab(\'' + tab[0] + '\')">' + tab[1] + '</button>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">System Rules</div>' +
      adminHeaderRightHtml() +
    '</div>' +

    (canEditRules() ? '' : '<p class="rules-readonly">You can read these rules, but only an administrator can change them.</p>') +

    '<div class="rules-tabs" role="tablist">' + tabsHtml + '</div>' +

    (rulesActiveTab === "role" ? renderRoleRulesBody() : renderGeneralRulesBody());
}

/* ---------- Editing (admins) ---------- */

function selectRulesRole(roleId) {
  rulesSelectedRole = roleId;
  renderRules();
}

function setRoleRule(roleId, key, on) {
  if (!canEditRules()) return;
  if (!roleRulesDraft[roleId]) roleRulesDraft[roleId] = {};
  roleRulesDraft[roleId][key] = !!on;
  renderRules();
}

function setAllRoleRules(roleId, on) {
  if (!canEditRules()) return;
  roleRulesDraft[roleId] = roleRulesDraft[roleId] || {};
  roleRulesFor(roleKindOf(roleId)).forEach(function (rule) { roleRulesDraft[roleId][rule.key] = !!on; });
  renderRules();
}

function discardRoleRules() {
  roleRulesDraft = {};
  renderRules();
}

// What gets saved: every role's full set of switches (saved values with the drafts on top).
function roleRulesToSave() {
  var roles = {};
  Object.keys(roleRulesSaved).forEach(function (roleId) {
    roles[roleId] = Object.assign({}, roleRulesSaved[roleId]);
  });
  Object.keys(roleRulesDraft).forEach(function (roleId) {
    var rules = roleRulesFor(roleKindOf(roleId));
    roles[roleId] = {};
    rules.forEach(function (rule) { roles[roleId][rule.key] = shownRoleRule(roleId, rule.key); });
  });
  return roles;
}

function confirmSaveRoleRules() {
  if (!canEditRules() || !roleRulesDirty()) return;

  var changed = Object.keys(roleRulesDraft).filter(function (roleId) {
    return Object.keys(roleRulesDraft[roleId]).some(function (key) { return roleRulesDraft[roleId][key] !== savedRoleRule(roleId, key); });
  }).map(function (roleId) {
    var role = ruleRoles().find(function (r) { return r.id === roleId; });
    return role ? role.name : roleId;
  });

  showConfirmModal({
    title: "Save the role rules?",
    message: "The new rules apply right away to everyone with these roles: " + changed.join(", ") + ".",
    confirmLabel: "Save",
    tone: "primary",
    onConfirm: function () {
      return db.collection("settings").doc("roleRules").set({
        roles: roleRulesToSave(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        roleRulesDraft = {};
        sayDone("Role rules saved.");
        renderRules();
      }).catch(function (error) {
        say("Could not save the role rules: " + error.message);
      });
    }
  });
}
