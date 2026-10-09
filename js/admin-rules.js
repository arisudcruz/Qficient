// Layout only: placeholder rule catalog until the real permission data is wired up.
var rulesCatalog = [
  {
    section: "Dashboard",
    rules: [
      ["Access Dashboard", "Allows the user to access the Dashboard and view available dashboard information."],
      ["View Overview Information", "Allows the user to view summary cards and key system information."],
      ["View Station Analytics", "Allows the user to view station performance, queue statistics, and related analytics."],
      ["View Activity Logs", "Allows the user to view records of activities and actions performed in the system."]
    ]
  },
  {
    section: "Queue Management",
    rules: [
      ["Access Queue Management", "Allows the user to access the Queue Management page."],
      ["View Queue Information", "Allows the user to view waiting, serving, and queue status information."],
      ["Call the Next Queue", "Allows the user to call the next available queue."],
      ["Recall a Queue", "Allows the user to recall the currently called queue."],
      ["Skip a Queue", "Allows the user to skip the current queue and proceed to the next queue."],
      ["Remove a Queue", "Allows the user to remove a queue from the active queue list."]
    ]
  },
  {
    section: "Queue Enforcer",
    rules: [
      ["Access Queue Enforcer", "Allows the user to access the Queue Enforcer page."],
      ["View Current Serving", "Allows the user to view queues currently being served."],
      ["Create a Queue Ticket", "Allows the user to manually create a queue ticket when a station is unavailable."],
      ["Manage Enforced Queues", "Allows the user to manage queues created through Queue Enforcer."]
    ]
  },
  {
    section: "Notification",
    rules: [
      ["Access Notifications", "Allows the user to access the Notification section."],
      ["View Notifications", "Allows the user to view available notifications."],
      ["Delete Notifications", "Allows the user to remove notifications."]
    ]
  },
  {
    section: "Live Board",
    rules: [
      ["Access Live Boards", "Allows the user to access the Live Board section."],
      ["View Live Boards", "Allows the user to view live boards."]
    ]
  },
  {
    section: "Settings — System Configuration",
    rules: [
      ["Access System Configuration", "Allows the user to access system configuration settings."],
      ["View System Configuration", "Allows the user to view system configuration values and settings."],
      ["Update System Configuration", "Allows the user to modify system configuration, such as the Auto-Void Timeout."]
    ]
  },
  {
    section: "Settings — Service Stations",
    rules: [
      ["Access Service Stations", "Allows the user to access system configuration settings."],
      ["View Service Stations", "Allows the user to view system configuration values and settings."],
      ["Create Service Stations", "Allows the user to create a new service station."],
      ["Edit Service Stations", "Allows the user to modify service station details and configuration."],
      ["Enable Service Stations", "Allows the user to activate a disabled service station."],
      ["Disable Service Stations", "Allows the user to deactivate an active service station."],
      ["Delete Service Stations", "Allows the user to permanently remove a service station."]
    ]
  },
  {
    section: "Settings — Roles",
    rules: [
      ["Access Roles", "Allows the user to access role management."],
      ["View Roles", "Allows the user to view configured roles."],
      ["Create Roles", "Allows the user to create a new role."],
      ["Edit Roles", "Allows the user to modify role details."],
      ["Delete Roles", "Allows the user to permanently remove a role."],
      ["Manage Role Rules", "Allows the user to assign and manage permissions for roles."]
    ]
  }
];

var rulesActiveTab = "general";
var rulesRoleOptions = ["Cashier", "Registrar", "Admission"];

function setRulesTab(tab) {
  rulesActiveTab = tab;
  renderRules();
}

// Everyone can read the rules; only a full admin can change them.
function canEditRules() {
  return isFullAdmin();
}

function renderGeneralRulesBody() {
  var editable = canEditRules();

  var sectionsHtml = rulesCatalog.map(function (group, groupIndex) {
    var rowsHtml = group.rules.map(function (rule, ruleIndex) {
      return '<tr><td class="settings-strong">' + escapeAdminText(rule[0]) + '</td>' +
        '<td class="rules-desc">' + escapeAdminText(rule[1]) + '</td>' +
        (editable ? '<td class="rules-action"><button type="button" class="settings-btn settings-btn-blue" onclick="openEditRuleModal(' + groupIndex + ', ' + ruleIndex + ')">Edit</button></td>' : '') +
        '</tr>';
    }).join("");

    return '<section class="panel settings-panel rules-section">' +
      '<div class="panel-header"><h2>' + escapeAdminText(group.section) + '</h2></div>' +
      '<div class="table-wrap rules-table-wrap"><table class="queue-table settings-table rules-table"><thead><tr>' +
        '<th>Rules</th><th>Description</th>' + (editable ? '<th class="rules-action">Action</th>' : '') + '</tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody></table></div>' +
    '</section>';
  }).join("");

  return '<div class="settings-config-head">' +
      '<div><h2 class="settings-title rules-title">Access Permission</h2>' +
        '<p class="settings-sub">Configure the available permission rules for system access and actions. These rules can be assigned to roles to control what each user is allowed to perform.</p></div>' +
      (editable ? '<div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="openCreateRuleModal()">+ Create New Rule</button>' +
      '</div>' : '') +
    '</div>' +

    '<div class="rules-general-head">' +
      '<h3 class="rules-general-title">General Rule</h3>' +
      '<p class="settings-sub">Define the master list of permissions available across the system. These rules represent the actions and areas that can be authorized for users.</p>' +
    '</div>' +

    sectionsHtml;
}

function renderRoleRulesBody() {
  var locked = canEditRules() ? '' : ' disabled';
  var roleOptionsHtml = rulesRoleOptions.map(function (name) {
    return '<option>' + escapeAdminText(name) + '</option>';
  }).join("");

  var sectionsHtml = rulesCatalog.map(function (group) {
    var rowsHtml = group.rules.map(function (rule) {
      return '<tr><td class="settings-strong">' + escapeAdminText(rule[0]) + '</td>' +
        '<td class="rules-desc">' + escapeAdminText(rule[1]) + '</td>' +
        '<td class="rules-action"><label class="switch"><input type="checkbox" aria-label="Allow ' + escapeAdminText(rule[0]) + '"' + locked + '><span class="switch-track"></span></label></td></tr>';
    }).join("");

    return '<section class="panel settings-panel rules-section">' +
      '<div class="panel-header"><h2>' + escapeAdminText(group.section) + '</h2></div>' +
      '<div class="table-wrap rules-table-wrap"><table class="queue-table settings-table rules-table"><thead><tr>' +
        '<th>Rules</th><th>Description</th><th class="rules-action">Access</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody></table></div>' +
    '</section>';
  }).join("");

  return '<div class="settings-config-head">' +
      '<div><h2 class="settings-title rules-title">Role Rules</h2>' +
        '<p class="settings-sub">Assign permissions to the selected role to control which features and actions its users can access.</p></div>' +
      '<select class="enforcer-station-select" aria-label="Role">' + roleOptionsHtml + '</select>' +
    '</div>' +

    '<div class="rules-allow-all">' +
      '<span>Allow All</span>' +
      '<label class="switch"><input type="checkbox" checked aria-label="Allow all rules"' + locked + '><span class="switch-track"></span></label>' +
    '</div>' +

    sectionsHtml;
}

function renderRules() {
  var area = document.getElementById("adminRulesArea");
  if (!area) return;

  var tabsHtml = [["general", "General Rules"], ["role", "Role"], ["station", "Station"]].map(function (tab) {
    var attrs = tab[0] === "station" ? '' : ' onclick="setRulesTab(\'' + tab[0] + '\')"';
    return '<button type="button" class="rules-tab' + (tab[0] === rulesActiveTab ? ' active' : '') + '" role="tab"' + attrs + '>' + tab[1] + '</button>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">System Rules</div>' +
      '<div class="settings-header-user"><span>' + escapeAdminText(adminDisplayName()) + '</span><button type="button" class="settings-logout" onclick="adminLogout()">Logout</button></div>' +
    '</div>' +

    (canEditRules() ? '' : '<p class="rules-readonly">You can read these rules, but only an administrator can change them.</p>') +

    '<div class="rules-tabs" role="tablist">' + tabsHtml + '</div>' +

    (rulesActiveTab === "role" ? renderRoleRulesBody() : renderGeneralRulesBody());
}

function openCreateRuleModal() {
  if (!canEditRules()) return;

  showFormModal("Create New Rule",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">New Rule</h3>' +
      '<div class="modal-field"><label for="newRuleName">Rule Name</label>' +
        '<input type="text" id="newRuleName" class="modal-input" placeholder="Rule name here..." maxlength="60"></div>' +
      '<div class="modal-field"><label for="newRuleDescription">Description</label>' +
        '<input type="text" id="newRuleDescription" class="modal-input" placeholder="Description here..." maxlength="160"></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="clearCreateRuleForm()">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary" onclick="confirmCreateRule()">Create Rule</button>' +
      '</div>' +
    '</div>');
}

function clearCreateRuleForm() {
  document.getElementById("newRuleName").value = "";
  document.getElementById("newRuleDescription").value = "";
}

function confirmCreateRule() {
  showConfirmModal({
    title: "Create Rule?",
    message: "The rule details are ready to be saved. Creating this rule will add it to your system.",
    confirmLabel: "Create Rule",
    tone: "danger",
    onConfirm: function () {}
  });
}

function openEditRuleModal(groupIndex, ruleIndex) {
  if (!canEditRules()) return;

  var rule = rulesCatalog[groupIndex].rules[ruleIndex];

  showFormModal("Edit Rule",
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Edit Rule Name</h3>' +
      '<div class="modal-field"><label>Current Rule Name</label><input type="text" class="modal-input" value="' + escapeAdminText(rule[0]) + '" readonly></div>' +
      '<div class="modal-field"><label for="editRuleName">New Rule Name</label>' +
        '<input type="text" id="editRuleName" class="modal-input" placeholder="New rule name" maxlength="60"></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="document.getElementById(\'editRuleName\').value = \'\'">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary">Save Changes</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Edit Description</h3>' +
      '<div class="modal-field"><label>Edit Description</label><textarea class="modal-input modal-textarea" rows="2" readonly>' + escapeAdminText(rule[1]) + '</textarea></div>' +
      '<div class="modal-field"><label for="editRuleDescription">New Description</label>' +
        '<textarea id="editRuleDescription" class="modal-input modal-textarea" rows="2" placeholder="New description" maxlength="160"></textarea></div>' +
      '<div class="settings-actions modal-actions-end">' +
        '<button type="button" class="settings-btn settings-btn-blue" onclick="document.getElementById(\'editRuleDescription\').value = \'\'">Clear All</button>' +
        '<button type="button" class="settings-btn settings-btn-primary">Save Changes</button>' +
      '</div>' +
    '</div>' +
    '<hr class="modal-divider">' +
    '<div class="modal-section">' +
      '<h3 class="modal-section-title">Delete Rule</h3>' +
      '<p class="modal-help">Deleting this rule will permanently remove it from the system and may affect any data, devices, or configurations associated with it. This action cannot be undone.</p>' +
      '<div class="modal-actions-end"><button type="button" class="settings-btn settings-btn-primary">Delete Rule</button></div>' +
    '</div>');
}
