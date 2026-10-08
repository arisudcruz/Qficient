// Pure logic tests; no emulator needed:  node test/events.test.js
const assert = require("assert");
const { describeChange, onlyChanged, affectsQueueFront, compareQueueOrder } = require("../lib/events");

const notify = { serving: true, recall: true, skipped: true, lastCall: true, next: true, transferred: true, voided: true };
const ctx = { stationName: (id) => (id === "registrar" ? "Registrar" : "Cashier"), voidMinutes: 2 };
const ts = (ms) => ({ toMillis: () => ms });
const base = { ticketNo: "CA-001", stationId: "cashier", ownerId: "u1", status: "waiting", recallCount: 0 };

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
const type = (before, after, n) => {
  const change = describeChange(before, after, ctx, n || notify);
  return change ? change.type : null;
};

test("waiting -> serving is 'serving'", () => assert.strictEqual(type(base, Object.assign({}, base, { status: "serving" })), "serving"));
test("serving -> skipped is 'skipped'", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { status: "skipped" })), "skipped"));
test("recall count going up is 'recall'", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { status: "serving", recallCount: 1 })), "recall"));
test("last call on a skipped ticket is 'lastCall'", () => assert.strictEqual(type(Object.assign({}, base, { status: "skipped" }), Object.assign({}, base, { status: "skipped", lastCalled: true, lastCallAt: ts(5) })), "lastCall"));
test("recall on a skipped ticket is 'recall', not 'lastCall'", () => assert.strictEqual(type(Object.assign({}, base, { status: "skipped" }), Object.assign({}, base, { status: "skipped", recallCount: 1 })), "recall"));
test("moving station while waiting is 'transferred'", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { stationId: "registrar", status: "waiting" })), "transferred"));
test("becoming void is 'void'", () => assert.strictEqual(type(Object.assign({}, base, { status: "skipped" }), Object.assign({}, base, { status: "void", autoVoided: true })), "void"));
test("auto-void and manual remove use different wording", () => {
  const skipped = Object.assign({}, base, { status: "skipped" });
  const auto = describeChange(skipped, Object.assign({}, base, { status: "void", autoVoided: true }), ctx, notify);
  const manual = describeChange(skipped, Object.assign({}, base, { status: "void" }), ctx, notify);
  assert.notStrictEqual(auto.message.body, manual.message.body);
});
test("verifying a ticket says nothing", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { status: "serving", verified: true })), null));
test("a brand-new ticket says nothing", () => assert.strictEqual(describeChange(null, base, ctx, notify), null));
test("completed says nothing", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { status: "completed" })), null));
test("cancelled says nothing", () => assert.strictEqual(type(base, Object.assign({}, base, { status: "cancelled" })), null));
test("a notification can be switched off", () => assert.strictEqual(type(base, Object.assign({}, base, { status: "serving" }), Object.assign({}, notify, { serving: false })), null));
test("messages use the voidMinutes setting", () => {
  const change = describeChange(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { status: "skipped" }), ctx, notify);
  assert.ok(/2 minutes/.test(change.message.body), change.message.body);
});
test("messages use the station name", () => {
  const change = describeChange(base, Object.assign({}, base, { status: "serving" }), ctx, notify);
  assert.ok(/Cashier/.test(change.message.body) && /CA-001/.test(change.message.body));
});

test("onlyChanged ignores the listed bookkeeping field", () => assert.ok(onlyChanged(base, Object.assign({}, base, { nextNotified: "cashier" }), ["nextNotified"])));
test("onlyChanged notices any other change", () => assert.ok(!onlyChanged(base, Object.assign({}, base, { nextNotified: "cashier", status: "serving" }), ["nextNotified"])));

test("affectsQueueFront: new ticket", () => assert.ok(affectsQueueFront(null, base)));
test("affectsQueueFront: status change", () => assert.ok(affectsQueueFront(base, Object.assign({}, base, { status: "serving" }))));
test("affectsQueueFront: prioritize", () => assert.ok(affectsQueueFront(base, Object.assign({}, base, { prioritizedAt: ts(9) }))));
test("affectsQueueFront: a recall does not", () => assert.ok(!affectsQueueFront(base, Object.assign({}, base, { recallCount: 1 }))));

test("queue order: arrival order", () => assert.ok(compareQueueOrder({ createdAt: ts(1) }, { createdAt: ts(2) }) < 0));
test("queue order: prioritized first", () => assert.ok(compareQueueOrder({ createdAt: ts(9), prioritizedAt: ts(5) }, { createdAt: ts(1) }) < 0));
test("queue order: earliest prioritized first", () => assert.ok(compareQueueOrder({ createdAt: ts(9), prioritizedAt: ts(5) }, { createdAt: ts(1), prioritizedAt: ts(6) }) < 0));

console.log("\n" + passed + " passed" + (process.exitCode ? ", with failures" : ""));
