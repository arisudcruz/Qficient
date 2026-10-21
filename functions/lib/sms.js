// Text messages for walk-in tickets made by the Queue Enforcer. Those people have no app and no push token,
// so every alert they should get goes to their mobile number instead.
//
// Providers (set in config.js, sms.provider):
//   "log"        test mode: nothing is sent; each message is written to the `smsLog` collection (free)
//   "semaphore"  Semaphore (semaphore.co), a Philippine SMS gateway; needs the SMS_API_KEY secret
// In the emulator every provider behaves like "log".

// The secrets each provider needs; index.js asks Firebase for exactly these.
const SMS_SECRETS = {
  log: [],
  semaphore: ["SMS_API_KEY"]
};

const SMS_MAX_LENGTH = 306; // two standard SMS parts

// "QFicient: <title>. <body>" in plain characters, so it fits the cheaper standard SMS encoding.
function smsText(message) {
  const title = String(message.title || "").replace(/[!.]+$/, "");
  const text = ("QFicient: " + title + ". " + (message.body || ""))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SMS_MAX_LENGTH ? text.slice(0, SMS_MAX_LENGTH - 3) + "..." : text;
}

// +639171234567 -> 09171234567 (the local form Semaphore expects).
function localNumber(mobile) {
  return String(mobile).replace(/^\+63/, "0");
}

// `secret(name)` returns the value of one of the provider's secrets.
function createSmsSender({ db, FieldValue, config, secret, log }) {
  const settings = config.sms || {};
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true" || !!process.env.FIRESTORE_EMULATOR_HOST;
  const provider = isEmulator ? "log" : (settings.provider || "log");
  const writeLog = log || function () {};

  async function send(mobile, text, tag) {
    if (provider === "log") {
      await db.collection("smsLog").add({ to: mobile, text: text, tag: tag, at: FieldValue.serverTimestamp() });
      writeLog("sms (test mode) to " + mobile + ": " + text);
      return true;
    }

    if (provider === "semaphore") {
      // Trimmed: a pasted key can carry a stray space or line break, which Semaphore would reject.
      const body = new URLSearchParams({ apikey: String(secret("SMS_API_KEY")).trim(), number: localNumber(mobile), message: text });
      if (settings.senderName) body.set("sendername", settings.senderName);

      const response = await fetch("https://api.semaphore.co/api/v4/messages", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
      });
      const answer = await response.text();
      if (!response.ok) throw new Error("Semaphore answered " + response.status + ": " + answer.slice(0, 200));

      // Semaphore can answer 200 and still refuse (a wrong sender name, no credits): a real send is a list of
      // queued messages, each with a message_id.
      let sent = null;
      try { sent = JSON.parse(answer); } catch (e) {}
      if (!Array.isArray(sent) || !sent.length || !sent[0].message_id) {
        throw new Error("Semaphore did not queue the text: " + answer.slice(0, 200));
      }
      writeLog("sms sent to " + mobile + " (" + tag + "), Semaphore message " + sent[0].message_id + " " + (sent[0].status || ""));
      return true;
    }

    throw new Error("Unknown SMS provider \"" + provider + "\" in functions/config.js");
  }

  return { send, provider };
}

module.exports = { createSmsSender, smsText, localNumber, SMS_SECRETS };
