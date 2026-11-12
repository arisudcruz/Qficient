// Pure logic tests; no emulator needed:  node test/events.test.js
const assert = require("assert");
const { describeChange, onlyChanged, affectsQueueFront, compareQueueOrder } = require("../lib/events");

const notify = { serving: true, recall: true, skipped: true, lastCall: true, next: true, transferred: true, voided: true, enrollmentNext: true };
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

test("windows: a station with several windows names the window in the alerts", () => {
  const multi = Object.assign({}, ctx, { stationWindows: () => 3 });
  const serving = describeChange(base, Object.assign({}, base, { status: "serving", window: 2 }), multi, notify);
  assert.ok(/Cashier, Window 2/.test(serving.message.body) && /Please go to Window 2/.test(serving.message.body), serving.message.body);
  const recall = describeChange(Object.assign({}, base, { status: "serving", window: 2 }), Object.assign({}, base, { status: "serving", window: 2, recallCount: 1 }), multi, notify);
  assert.ok(/Cashier Window 2 is calling/.test(recall.message.body), recall.message.body);
});
test("windows: a one-window station never mentions a window", () => {
  const one = Object.assign({}, ctx, { stationWindows: () => 1 });
  const serving = describeChange(base, Object.assign({}, base, { status: "serving", window: 1 }), one, notify);
  assert.ok(!/Window/.test(serving.message.body) && /Please go to the counter/.test(serving.message.body), serving.message.body);
});
test("windows: without window info (older callers) nothing changes", () => {
  const serving = describeChange(base, Object.assign({}, base, { status: "serving", window: 2 }), ctx, notify);
  assert.ok(!/Window/.test(serving.message.body), serving.message.body);
});

const enrolling = Object.assign({}, base, { enrollment: true, enrollmentFlow: ["cashier", "registrar", "admission"], enrollmentStep: 0, purpose: "Enrollment" });
test("enrollment: moving on to the next station is 'enrollmentNext', not 'transferred'", () => {
  const change = describeChange(Object.assign({}, enrolling, { status: "serving" }),
    Object.assign({}, enrolling, { stationId: "registrar", ticketNo: "RE1-004", enrollmentStep: 1, status: "waiting" }), ctx, notify);
  assert.strictEqual(change.type, "enrollmentNext");
  assert.ok(/Registrar/.test(change.message.title) && /RE1-004/.test(change.message.body) && /step 2 of 3/.test(change.message.body), change.message.body);
});
test("enrollment: the next-step alert can be switched off", () => assert.strictEqual(type(Object.assign({}, enrolling, { status: "serving" }),
  Object.assign({}, enrolling, { stationId: "registrar", enrollmentStep: 1, status: "waiting" }), Object.assign({}, notify, { enrollmentNext: false })), null));
test("enrollment: a regular transfer is still 'transferred'", () => assert.strictEqual(type(Object.assign({}, base, { status: "serving" }), Object.assign({}, base, { stationId: "registrar", status: "waiting" })), "transferred"));
test("enrollment: being called works as before", () => assert.strictEqual(type(enrolling, Object.assign({}, enrolling, { status: "serving" })), "serving"));

test("onlyChanged ignores the listed bookkeeping field", () => assert.ok(onlyChanged(base, Object.assign({}, base, { nextNotified: "cashier" }), ["nextNotified"])));
test("onlyChanged notices any other change", () => assert.ok(!onlyChanged(base, Object.assign({}, base, { nextNotified: "cashier", status: "serving" }), ["nextNotified"])));

test("affectsQueueFront: new ticket", () => assert.ok(affectsQueueFront(null, base)));
test("affectsQueueFront: status change", () => assert.ok(affectsQueueFront(base, Object.assign({}, base, { status: "serving" }))));
test("affectsQueueFront: prioritize", () => assert.ok(affectsQueueFront(base, Object.assign({}, base, { prioritizedAt: ts(9) }))));
test("affectsQueueFront: a recall does not", () => assert.ok(!affectsQueueFront(base, Object.assign({}, base, { recallCount: 1 }))));

test("queue order: arrival order", () => assert.ok(compareQueueOrder({ createdAt: ts(1) }, { createdAt: ts(2) }) < 0));
test("queue order: prioritized first", () => assert.ok(compareQueueOrder({ createdAt: ts(9), prioritizedAt: ts(5) }, { createdAt: ts(1) }) < 0));
test("queue order: earliest prioritized first", () => assert.ok(compareQueueOrder({ createdAt: ts(9), prioritizedAt: ts(5) }, { createdAt: ts(1), prioritizedAt: ts(6) }) < 0));

// No-show strikes (lib/strikes.js)
const { isNoShow } = require("../lib/strikes");
const messages = require("../lib/messages");
const held = Object.assign({}, base, { status: "skipped", lastCalled: true });
const autoVoid = Object.assign({}, base, { status: "void", autoVoided: true });
test("no-show: a ticket voided when the last call ran out counts", () => assert.ok(isNoShow(held, autoVoid)));
test("no-show: a ticket removed by staff doesn't count", () => assert.ok(!isNoShow(held, Object.assign({}, base, { status: "void" }))));
test("no-show: the nightly cleanup of earlier days doesn't count", () => assert.ok(!isNoShow(held, Object.assign({}, autoVoid, { staleCleanup: true }))));
test("no-show: voided because the window hours closed doesn't count", () => assert.ok(!isNoShow(held, Object.assign({}, autoVoid, { closedVoid: true }))));
test("void at closing: the push says the windows closed, not a strike", () => {
  const change = describeChange(base, Object.assign({}, base, { status: "void", autoVoided: true, closedVoid: true }), ctx, notify);
  assert.strictEqual(change.type, "void");
  assert.strictEqual(change.message.title, "Windows closed");
  assert.ok(/doesn't count against you/.test(change.message.body) && /CA-001/.test(change.message.body), change.message.body);
});
test("no-show: walk-in tickets don't count", () => assert.ok(!isNoShow(held, Object.assign({}, autoVoid, { manual: true }))));
test("no-show: old walk-in owners (manual:) don't count", () => assert.ok(!isNoShow(held, Object.assign({}, autoVoid, { ownerId: "manual:x" }))));
test("no-show: a ticket that was already void doesn't count again", () => assert.ok(!isNoShow(autoVoid, Object.assign({}, autoVoid, { recallCount: 1 }))));
test("no-show: the block message gives the time in Manila", () => assert.ok(/Tue, Oct 27, 3:15 PM/.test(messages.noShowBlocked(Date.UTC(2026, 9, 27, 7, 15), 3, 7).body)));
test("no-show: the strike message says how many are left", () => assert.ok(/strike 2 of 3/.test(messages.noShowStrike(base, 2, 3, 7, 24).title)));

// Cancel limit (lib/strikes.js)
const { isOwnerCancel } = require("../lib/strikes");
const waitingT = Object.assign({}, base, { status: "waiting", ownerId: "student-1" });
const cancelledT = Object.assign({}, waitingT, { status: "cancelled" });
test("cancel: the owner cancelling a waiting ticket counts", () => assert.ok(isOwnerCancel(waitingT, cancelledT)));
test("cancel: cancelling an on-hold ticket counts", () => assert.ok(isOwnerCancel(Object.assign({}, waitingT, { status: "skipped" }), cancelledT)));
test("cancel: a ticket already cancelled doesn't count again", () => assert.ok(!isOwnerCancel(cancelledT, Object.assign({}, cancelledT, { read: true }))));
test("cancel: a removed (void) ticket isn't a cancel", () => assert.ok(!isOwnerCancel(waitingT, Object.assign({}, waitingT, { status: "void" }))));
test("cancel: walk-in tickets don't count", () => assert.ok(!isOwnerCancel(waitingT, Object.assign({}, cancelledT, { manual: true }))));
test("cancel: old walk-in and no-phone owners don't count", () => assert.ok(
  !isOwnerCancel(waitingT, Object.assign({}, cancelledT, { ownerId: "manual:x" })) && !isOwnerCancel(waitingT, Object.assign({}, cancelledT, { ownerId: "nophone:x" }))));
test("cancel: a new ticket (no before) isn't a cancel", () => assert.ok(!isOwnerCancel(null, cancelledT)));
test("cancel: the warning says how many of the limit", () => assert.ok(/3 of 5 today/.test(messages.cancelWarning(base, 3, 5).title)));
test("cancel: the block message gives the time in Manila", () => assert.ok(/You cancelled 5 tickets today/.test(messages.cancelBlocked(Date.UTC(2026, 9, 27, 16, 0), 5).body) &&
  /Wed, Oct 28, 12:00 AM/.test(messages.cancelBlocked(Date.UTC(2026, 9, 27, 16, 0), 5).body)));

console.log("\n" + passed + " passed" + (process.exitCode ? ", with failures" : ""));
