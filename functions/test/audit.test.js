// Pure logic tests for the audit trail; no emulator needed:  node test/audit.test.js
const assert = require("assert");
const audit = require("../lib/audit");

const ts = (ms) => ({ toMillis: () => ms });
const stations = { cashier: { name: "Cashier", windows: 2 }, registrar: { name: "Registrar", windows: 1 } };
const station = (id) => stations[id] || { name: id, windows: 1 };
const roleName = (role) => audit.roleLabel(role, (stations[role] || {}).name);
const base = { ticketNo: "CA1-004", stationId: "cashier", status: "waiting", recallCount: 0 };
const t = (over) => Object.assign({}, base, over || {});

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS  " + name);
  } catch (err) {
    console.log("FAIL  " + name + "   <-- " + err.message);
    process.exitCode = 1;
  }
}
const ticket = (before, after) => audit.describeTicketAction(before, after, station);

test("call, with the window at a multi-window station", () => {
  const e = ticket(t(), t({ status: "serving", window: 2 }));
  assert.strictEqual(e.action, "call");
  assert.strictEqual(e.summary, "Called CA1-004 at Cashier, Window 2");
  assert.strictEqual(e.category, "queue");
  assert.strictEqual(e.stationId, "cashier");
});
test("call at a one-window station names no window", () => {
  const e = audit.describeTicketAction(t({ stationId: "registrar", ticketNo: "RE1-001" }), t({ stationId: "registrar", ticketNo: "RE1-001", status: "serving", window: 1 }), station);
  assert.strictEqual(e.summary, "Called RE1-001 at Registrar");
});
test("complete", () => assert.strictEqual(ticket(t({ status: "serving" }), t({ status: "completed" })).action, "complete"));
test("hold", () => assert.strictEqual(ticket(t({ status: "serving" }), t({ status: "skipped" })).action, "hold"));
test("remove vs auto-void", () => {
  assert.strictEqual(ticket(t(), t({ status: "void" })).action, "remove");
  assert.strictEqual(ticket(t({ status: "skipped", lastCalled: true }), t({ status: "void", autoVoided: true, lastCalled: true })).action, "autoVoid");
});
test("last call", () => assert.strictEqual(ticket(t({ status: "skipped" }), t({ status: "skipped", lastCalled: true, lastCallAt: ts(5) })).action, "lastCall"));
test("recall", () => assert.strictEqual(ticket(t(), t({ recallCount: 1, recalledAt: ts(3) })).action, "recall"));
test("prioritize", () => assert.strictEqual(ticket(t(), t({ prioritizedAt: ts(9) })).action, "prioritize"));
test("enrollment hand-off names both stations and numbers", () => {
  const e = ticket(t({ enrollment: true, status: "serving" }), t({ enrollment: true, stationId: "registrar", ticketNo: "RE1-007", status: "waiting" }));
  assert.strictEqual(e.action, "enrollmentNext");
  assert.ok(/CA1-004/.test(e.summary) && /Cashier/.test(e.summary) && /Registrar/.test(e.summary) && /RE1-007/.test(e.summary), e.summary);
});
test("transfer, and a prioritized transfer", () => {
  const plain = ticket(t({ status: "serving" }), t({ stationId: "registrar", ticketNo: "RE1-009", status: "waiting" }));
  assert.strictEqual(plain.action, "transfer");
  assert.strictEqual(plain.summary, "Moved CA1-004 to Registrar as RE1-009");
  const prio = ticket(t({ status: "serving" }), t({ stationId: "registrar", ticketNo: "RE1-009", status: "waiting", prioritizedAt: ts(9) }));
  assert.strictEqual(prio.summary, "Moved CA1-004 to Registrar as RE1-009 (prioritized)");
});
test("server bookkeeping (next-in-line notice) is not an action", () => assert.strictEqual(ticket(t(), t({ nextNotified: true })), null));

test("station created / deleted", () => {
  assert.strictEqual(audit.describeStationChange(null, { name: "Library" }, "library").action, "stationCreate");
  assert.strictEqual(audit.describeStationChange({ name: "Library" }, null, "library").action, "stationDelete");
});
test("station edits list every change", () => {
  const e = audit.describeStationChange({ name: "Cashier", active: true, windows: 1 }, { name: "Cashier Main", active: false, windows: 3 }, "cashier");
  assert.strictEqual(e.action, "stationEdit");
  assert.ok(/renamed/.test(e.summary) && /disabled/.test(e.summary) && /windows 1 → 3/.test(e.summary), e.summary);
});
test("ticket counter bumps and pointer moves are not logged", () => {
  assert.strictEqual(audit.describeStationChange({ name: "Cashier", count: 4 }, { name: "Cashier", count: 5, countDay: "2026-11-08" }, "cashier"), null);
  assert.strictEqual(audit.describeStationChange({ name: "Cashier", nowServingId: "a" }, { name: "Cashier", nowServingId: "b" }, "cashier"), null);
});

test("staff added, with username and role", () => {
  const e = audit.describeStaffChange(null, { name: "Juan Dela Cruz", username: "juan.cruz", role: "cashier" }, "juan.cruz@staff.qficient.app", roleName);
  assert.strictEqual(e.action, "staffAdd");
  assert.strictEqual(e.summary, "Added Juan Dela Cruz (juan.cruz) as Cashier Staff");
});
test("staff role change", () => {
  const e = audit.describeStaffChange({ name: "Juan", role: "cashier" }, { name: "Juan", role: "enforcer" }, "x", roleName);
  assert.strictEqual(e.action, "staffRole");
  assert.ok(/Cashier Staff → Queue Enforcer/.test(e.summary), e.summary);
});
test("staff removed", () => assert.strictEqual(audit.describeStaffChange({ name: "Juan", role: "cashier" }, null, "x", roleName).action, "staffRemove"));
test("staff save without changes is not logged", () => assert.strictEqual(audit.describeStaffChange({ name: "Juan", role: "cashier" }, { name: "Juan", role: "cashier", updatedAt: 1 }, "x", roleName), null));

test("auto-void timeout change", () => {
  const e = audit.describeSettingsChange("system", { autoVoidMinutes: 1 }, { autoVoidMinutes: 3 }, roleName);
  assert.ok(/from 1 to 3/.test(e.summary), e.summary);
});
test("enrollment process change names the student types", () => {
  const e = audit.describeSettingsChange("enrollment", { flows: { regular: ["cashier"] } }, { flows: { regular: ["cashier", "registrar"], freshman: ["registrar"] } }, roleName);
  assert.ok(/Regular/.test(e.summary) && /Incoming Freshman/.test(e.summary), e.summary);
});
test("role rules change names the role and each switch", () => {
  const e = audit.describeSettingsChange("roleRules", { roles: {} }, { roles: { cashier: { remove: false, recall: true }, enforcer: { walkin: false } } }, roleName);
  assert.strictEqual(e.action, "roleRules");
  assert.ok(/Cashier Staff: Remove off/.test(e.summary) && /Queue Enforcer: Walk-in Tickets off/.test(e.summary) && !/Recall/.test(e.summary), e.summary);
});
test("role rules saved without a real change are not logged", () => {
  assert.strictEqual(audit.describeSettingsChange("roleRules", { roles: { cashier: { remove: true } } }, { roles: { cashier: { remove: true, recall: true } } }, roleName), null);
});

test("Live Board presets: added, changed and removed are each named", () => {
  const stationName = (id) => station(id).name;
  const lobby = { id: "lobby1", name: "Lobby TV", stations: ["cashier", "registrar"] };
  const enroll = { id: "enr001", name: "Enrollment", stations: ["registrar"] };
  let e = audit.describeSettingsChange("liveBoard", null, { presets: [lobby] }, roleName, stationName);
  assert.strictEqual(e.action, "liveBoard");
  assert.strictEqual(e.summary, "Added the Live Board preset \"Lobby TV\" (Cashier, Registrar)");
  e = audit.describeSettingsChange("liveBoard", { presets: [lobby, enroll] }, { presets: [Object.assign({}, lobby, { name: "Hall TV", stations: ["registrar"] })] }, roleName, stationName);
  assert.ok(/Changed the Live Board preset "Lobby TV" to "Hall TV" \(Registrar\)/.test(e.summary) && /Removed the Live Board preset "Enrollment"/.test(e.summary), e.summary);
  assert.strictEqual(audit.describeSettingsChange("liveBoard", { presets: [lobby] }, { presets: [Object.assign({}, lobby)] }, roleName, stationName), null);
});

test("walk-in QR pass", () => {
  const e = audit.describeWalkinPass(null, { ownerName: "Ana Reyes", stationId: "cashier", purpose: "Pay tuition" }, station);
  assert.strictEqual(e.summary, "Made a walk-in QR for Ana Reyes (Cashier, Pay tuition)");
  assert.strictEqual(audit.describeWalkinPass({ ownerName: "x" }, { ownerName: "x", usedAt: 1 }, station), null);
});
test("a priority walk-in QR says so", () => {
  const e = audit.describeWalkinPass(null, { ownerName: "Lola Cruz", stationId: "cashier", purpose: "Pay", priority: true }, station);
  assert.strictEqual(e.summary, "Made a priority walk-in QR for Lola Cruz (Cashier, Pay)");
});
test("lifting a student's block", () => {
  const e = audit.describeJoinStateChange({ blockedUntil: ts(99), ownerName: "Ben", studentNumber: "02000-1" }, { blockedUntil: null, unblockedBy: "admin@qficient.com" });
  assert.strictEqual(e.action, "unblock");
});

test("role labels", () => {
  assert.strictEqual(audit.roleLabel("admin"), "Administrator");
  assert.strictEqual(audit.roleLabel("enforcer"), "Queue Enforcer");
  assert.strictEqual(audit.roleLabel("cashier", "Cashier"), "Cashier Staff");
});

test("only staff are actors: server writes and non-staff are skipped", async () => {
  const deps = { db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }, adminAuth: { getUser: async () => ({ email: "s@x.com", providerData: [{ providerId: "microsoft.com" }] }) } };
  assert.strictEqual(await audit.actorOf(deps, "service_account", "abc"), null);
});

console.log("\n" + passed + " passed");
