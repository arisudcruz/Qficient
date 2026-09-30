var settingsStations = [
  { name: "Cashier", active: true },
  { name: "Registrar", active: false },
  { name: "Admission", active: true }
];

var settingsRoles = [
  { name: "Cashier", members: 2, locked: false },
  { name: "Registrar", members: 2, locked: false },
  { name: "Admission", members: 2, locked: false },
  { name: "Queue Enforcer", members: 2, locked: true },
  { name: "Admin", members: 2, locked: true }
];

var settingsRoleMembers = [
  { email: "kimfrane@gmail.com", role: "Cashier" },
  { email: "arizzupogi@gmail.com", role: "Cashier" }
];

function renderSettings() {
  var area = document.getElementById("adminSettingsArea");
  if (!area) return;

  var stationRowsHtml = settingsStations.map(function (station) {
    var badge = station.active ?
      '<span class="status-badge compact station-active">Active</span>' :
      '<span class="status-badge compact station-inactive">Inactive</span>';
    var toggleBtn = station.active ?
      '<button type="button" class="settings-btn settings-btn-red">Disable</button>' :
      '<button type="button" class="settings-btn settings-btn-green">Enable</button>';

    return '<tr><td class="settings-strong">' + escapeAdminText(station.name) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-blue">Edit</button>' + toggleBtn +
      '</div></td></tr>';
  }).join("");

  var roleRowsHtml = settingsRoles.map(function (role) {
    var deleteBtn = role.locked ?
      '<button type="button" class="settings-icon-btn settings-icon-red" disabled title="System role - cannot be deleted">🗑</button>' :
      '<button type="button" class="settings-icon-btn settings-icon-red" title="Delete role">🗑</button>';

    return '<tr><td class="settings-strong">' + escapeAdminText(role.name) + '</td>' +
      '<td class="settings-center">' + role.members + ' 👤</td>' +
      '<td><div class="settings-actions">' +
        '<button type="button" class="settings-icon-btn settings-icon-blue" title="Edit role">✎</button>' + deleteBtn +
      '</div></td></tr>';
  }).join("");

  var roleOptionsHtml = function (selected) {
    return settingsRoles.map(function (role) {
      return '<option' + (role.name === selected ? ' selected' : '') + '>' + escapeAdminText(role.name) + '</option>';
    }).join("");
  };

  var memberRowsHtml = settingsRoleMembers.map(function (member) {
    return '<tr><td class="settings-strong">' + escapeAdminText(member.email) + '</td>' +
      '<td><select class="settings-select" disabled>' + roleOptionsHtml(member.role) + '</select></td></tr>';
  }).join("");

  area.innerHTML =
    '<div class="dashboard-header">' +
      '<div class="header-greeting">System Settings</div>' +
      '<div class="settings-header-user"><span>QFicient Admin</span><button type="button" class="settings-logout">Logout</button></div>' +
    '</div>' +

    '<div class="settings-config-head">' +
      '<div><h2 class="settings-title">System Configuration</h2>' +
        '<p class="settings-sub">Manage global queue rules, user roles and setup service stations</p></div>' +
      '<div class="settings-actions">' +
        '<button type="button" class="settings-btn settings-btn-muted" disabled>Save Changes</button>' +
        '<button type="button" class="settings-btn settings-btn-muted" disabled>Cancel</button>' +
      '</div>' +
    '</div>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Queue Rules &amp; Timeouts</h2></div>' +
      '<label class="settings-field-label">Auto-Void Timeout Minute</label>' +
      '<p class="settings-help">*Controls the number of minutes a queue entry can remain active before it is automatically voided. Once the configured timeout is reached, the system automatically marks the queue entry as void.</p>' +
      '<input type="text" class="settings-input" value="' + (AUTO_VOID_WINDOW_MS / 60000) + '" readonly>' +
    '</section>' +

    '<section class="panel settings-panel">' +
      '<div class="panel-header"><h2>Service Station</h2>' +
        '<button type="button" class="settings-btn settings-btn-primary">+ Add New Station</button></div>' +
      '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Station</th><th>Status</th><th>Action</th></tr></thead>' +
        '<tbody>' + stationRowsHtml + '</tbody></table></div>' +
    '</section>' +

    '<div class="settings-grid">' +
      '<section class="panel settings-panel">' +
        '<div class="panel-header"><h2>Roles</h2>' +
          '<button type="button" class="settings-btn settings-btn-primary">+ Add New Role</button></div>' +
        '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>Roles</th><th class="settings-center">Members</th><th>Action</th></tr></thead>' +
          '<tbody>' + roleRowsHtml + '</tbody></table></div>' +
      '</section>' +
      '<section class="panel settings-panel">' +
        '<div class="panel-header"><h2>Cashier Members</h2>' +
          '<button type="button" class="settings-btn settings-btn-primary">Save Changes</button></div>' +
        '<div class="table-wrap"><table class="queue-table settings-table"><thead><tr><th>User</th><th>Role</th></tr></thead>' +
          '<tbody>' + memberRowsHtml + '</tbody></table></div>' +
      '</section>' +
    '</div>';
}
