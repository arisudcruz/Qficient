// Checks what each SMS provider sends, with the network call replaced by a stand-in (nothing leaves the PC).
//   node test/sms.test.js
const assert = require("assert");
const { createSmsSender, smsText, localNumber, SMS_SECRETS } = require("../lib/sms");

delete process.env.FUNCTIONS_EMULATOR;
delete process.env.FIRESTORE_EMULATOR_HOST;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("PASS  " + name);
  } catch (err) {
    failures++;
    console.log("FAIL  " + name + "   <-- " + err.message);
  }
}

// A stand-in for fetch that remembers the request and answers like the provider would.
function fakeFetch(status, answer) {
  const calls = [];
  global.fetch = async function (url, options) {
    calls.push({ url: url, options: options });
    return { ok: status >= 200 && status < 300, status: status, text: async () => answer || "" };
  };
  return calls;
}

const secrets = { SMS_API_KEY: "test-semaphore-key" };
const secret = (name) => secrets[name];
const logged = [];
const db = { collection: () => ({ add: async (doc) => { logged.push(doc); } }) };
const FieldValue = { serverTimestamp: () => "now" };

(async () => {
  await test("text is plain, prefixed and short", () => {
    const text = smsText({ title: "It's your turn!", body: "Ticket CA-012 is now being served at Cashier. 🔔" });
    assert.strictEqual(text, "QFicient: It's your turn. Ticket CA-012 is now being served at Cashier.");
  });

  await test("local number form for Semaphore", () => assert.strictEqual(localNumber("+639171234567"), "09171234567"));

  await test("each provider names the secrets it needs", () => {
    assert.deepStrictEqual(SMS_SECRETS.log, []);
    assert.deepStrictEqual(SMS_SECRETS.semaphore, ["SMS_API_KEY"]);
  });

  await test("semaphore: posts the key, local number and text", async () => {
    const calls = fakeFetch(200, "[]");
    const sms = createSmsSender({ db, FieldValue, secret, config: { sms: { provider: "semaphore", senderName: "QFICIENT" } } });
    await sms.send("+639171234567", "QFicient: hello", "t");
    const body = new URLSearchParams(calls[0].options.body.toString());
    assert.strictEqual(calls[0].url, "https://api.semaphore.co/api/v4/messages");
    assert.strictEqual(body.get("apikey"), "test-semaphore-key");
    assert.strictEqual(body.get("number"), "09171234567");
    assert.strictEqual(body.get("message"), "QFicient: hello");
    assert.strictEqual(body.get("sendername"), "QFICIENT");
  });

  await test("log: nothing is sent, the text is saved", async () => {
    const calls = fakeFetch(200, "");
    const sms = createSmsSender({ db, FieldValue, secret, config: { sms: { provider: "log" } } });
    await sms.send("+639171234567", "QFicient: hello", "t9");
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(logged[logged.length - 1].tag, "t9");
  });

  await test("an unknown provider is an error, not a silent skip", async () => {
    const sms = createSmsSender({ db, FieldValue, secret, config: { sms: { provider: "pigeon" } } });
    await assert.rejects(sms.send("+639171234567", "x", "t"), /Unknown SMS provider/);
  });

  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
