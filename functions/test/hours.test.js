// Window hours logic (lib/hours.js) and the pages' copy of it (js/window-hours.js); no emulator needed:
//   node test/hours.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { hoursState, hoursClosedText, minutesText } = require("../lib/hours");

const TZ = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// Monday 16 November 2026, midnight in Manila; at(d, h, m) is d days later at h:m Manila time.
const MONDAY = Date.UTC(2026, 10, 16) - TZ;
const at = (d, h, m) => MONDAY + d * DAY + ((h * 60) + (m || 0)) * 60 * 1000;

const weekday = { open: true, start: 480, end: 1020 }; // 8:00 AM - 5:00 PM
const closed = { open: false, start: 480, end: 1020 };
const cfg = {
  enabled: true,
  days: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: { open: true, start: 480, end: 720 }, sun: closed },
  lastJoinMinutes: 30
};

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
const state = (now, c) => hoursState(c === undefined ? cfg : c, TZ, now);

test("no schedule saved: always open", () => {
  const s = state(at(6, 23), null);
  assert.ok(s.open && s.joinOpen && !s.enabled);
  assert.strictEqual(hoursClosedText(s), "");
});
test("switched off: always open", () => assert.ok(state(at(6, 3), Object.assign({}, cfg, { enabled: false })).joinOpen));
test("before opening: closed, opens later today", () => {
  const s = state(at(0, 7, 59));
  assert.ok(!s.open && !s.joinOpen && s.reason === "beforeOpen", JSON.stringify(s));
  assert.strictEqual(hoursClosedText(s), "The windows are closed. They open today at 8:00 AM.");
  assert.strictEqual(s.nextOpenMs, at(0, 8));
});
test("at opening: open", () => assert.ok(state(at(0, 8)).joinOpen));
test("during the day: open, with today's closing time", () => {
  const s = state(at(1, 12));
  assert.ok(s.open && s.joinOpen && s.reason === "");
  assert.strictEqual(s.closesAtMs, at(1, 17));
  assert.strictEqual(s.joinStopsAtMs, at(1, 16, 30));
});
test("last minute before new tickets stop: still open", () => assert.ok(state(at(2, 16, 29)).joinOpen));
test("inside the last 30 minutes: open but no new tickets", () => {
  const s = state(at(2, 16, 30));
  assert.ok(s.open && !s.joinOpen && s.reason === "lastJoin", JSON.stringify(s));
  assert.strictEqual(hoursClosedText(s), "The windows have stopped taking new tickets for today. They close at 5:00 PM.");
});
test("with no last-join minutes, tickets until closing", () => assert.ok(state(at(2, 16, 59), Object.assign({}, cfg, { lastJoinMinutes: 0 })).joinOpen));
test("at the closing minute: closed, opens tomorrow", () => {
  const s = state(at(3, 17));
  assert.ok(!s.open && s.reason === "afterClose");
  assert.strictEqual(hoursClosedText(s), "The windows are closed. They open tomorrow at 8:00 AM.");
});
test("Saturday afternoon: closed, opens on Monday (Sunday is closed)", () => {
  const s = state(at(5, 13));
  assert.strictEqual(hoursClosedText(s), "The windows are closed. They open on Monday at 8:00 AM.");
  assert.strictEqual(s.nextOpenMs, at(7, 8));
});
test("Sunday: closed day", () => {
  const s = state(at(6, 10));
  assert.ok(!s.open && s.reason === "closedDay" && s.today === null);
  assert.strictEqual(hoursClosedText(s), "The windows are closed. They open tomorrow at 8:00 AM.");
});
test("only one open day: next week's", () => {
  const onlyMon = { enabled: true, days: { mon: weekday }, lastJoinMinutes: 0 };
  const s = state(at(0, 18), onlyMon);
  assert.strictEqual(s.nextOpenDays, 7);
  assert.strictEqual(hoursClosedText(s), "The windows are closed. They open on Monday at 8:00 AM.");
});
test("every day closed: just closed", () => {
  const s = state(at(0, 10), { enabled: true, days: {}, lastJoinMinutes: 0 });
  assert.strictEqual(hoursClosedText(s), "The windows are closed.");
});
test("a broken day (end before start) counts as closed", () => {
  const s = state(at(0, 10), Object.assign({}, cfg, { days: Object.assign({}, cfg.days, { mon: { open: true, start: 900, end: 600 } }) }));
  assert.ok(!s.open && s.reason === "closedDay");
});
test("a nonsense last-join value is ignored", () => assert.ok(state(at(0, 16, 50), Object.assign({}, cfg, { lastJoinMinutes: 999 })).joinOpen));
test("times read like a clock", () => {
  assert.strictEqual(minutesText(0), "12:00 AM");
  assert.strictEqual(minutesText(480), "8:00 AM");
  assert.strictEqual(minutesText(725), "12:05 PM");
  assert.strictEqual(minutesText(1439), "11:59 PM");
});

// The pages' copy must give the same answers.
const sandbox = { QUEUE_TZ_OFFSET_MS: TZ, DAY_MS: DAY, setInterval: function () {}, serverNow: function () { return 0; } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "js", "window-hours.js"), "utf8"), sandbox);
test("the pages' copy agrees with the server every 10 minutes for two weeks", () => {
  const configs = [null, cfg, Object.assign({}, cfg, { lastJoinMinutes: 0 }), { enabled: true, days: { wed: weekday }, lastJoinMinutes: 45 }];
  configs.forEach(function (c) {
    for (let t = at(0, 0); t < at(14, 0); t += 10 * 60 * 1000) {
      const server = hoursState(c, TZ, t);
      const page = sandbox.hoursState(c, t);
      assert.strictEqual(JSON.stringify(page), JSON.stringify(server), "at " + new Date(t).toISOString());
      assert.strictEqual(sandbox.hoursClosedText(page), hoursClosedText(server));
    }
  });
});
test("the pages read the form's times", () => {
  assert.strictEqual(sandbox.hoursFromInput("08:30"), 510);
  assert.strictEqual(sandbox.hoursFromInput("24:00"), null);
  assert.strictEqual(sandbox.hoursInputValue(1020), "17:00");
});
test("the TV's short opening text", () => {
  assert.strictEqual(sandbox.nextOpenShortText(state(at(5, 13))), "Opens Mon 8:00 AM");
  assert.strictEqual(sandbox.nextOpenShortText(state(at(3, 18))), "Opens tomorrow 8:00 AM");
  assert.strictEqual(sandbox.nextOpenShortText(state(at(3, 7))), "Opens 8:00 AM");
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", with failures" : ""));
