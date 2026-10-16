// Text messages for walk-in tickets made by the Queue Enforcer. Those people have no app and no push token,
// so every alert they should get goes to their mobile number instead.
//
// Providers (set in config.js, sms.provider):
//   "log"        test mode: nothing is sent; each message is written to the `smsLog` collection (free)
//   "semaphore"  Semaphore (semaphore.co), a Philippine SMS gateway; needs the SMS_API_KEY secret
//   "android"    an Android phone running "SMS Gateway for Android" (sms-gate.app) in cloud mode; the phone sends
//                the text from its own SIM. Needs the SMS_GATEWAY_USER and SMS_GATEWAY_PASSWORD secrets (the
//                username and password shown in the app's Cloud Server section).
// In the emulator every provider behaves like "log".

// The secrets each provider needs; index.js asks Firebase for exactly these.
const SMS_SECRETS = {
  log: [],
  semaphore: ["SMS_API_KEY"],
  android: ["SMS_GATEWAY_USER", "SMS_GATEWAY_PASSWORD"]
};

const ANDROID_GATEWAY_URL = "https://api.sms-gate.app/3rdparty/v1/messages";

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
      const body = new URLSearchParams({ apikey: secret("SMS_API_KEY"), number: localNumber(mobile), message: text });
      if (settings.senderName) body.set("sendername", settings.senderName);

      const response = await fetch("https://api.semaphore.co/api/v4/messages", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
      });
      if (!response.ok) throw new Error("Semaphore answered " + response.status + ": " + (await response.text()).slice(0, 200));
      writeLog("sms sent to " + mobile + " (" + tag + ")");
      return true;
    }

    if (provider === "android") {
      const login = Buffer.from(secret("SMS_GATEWAY_USER") + ":" + secret("SMS_GATEWAY_PASSWORD")).toString("base64");
      const response = await fetch(settings.androidUrl || ANDROID_GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + login },
        body: JSON.stringify({ textMessage: { text: text }, phoneNumbers: [mobile] })
      });
      if (!response.ok) throw new Error("SMS gateway answered " + response.status + ": " + (await response.text()).slice(0, 200));
      writeLog("sms handed to the Android gateway for " + mobile + " (" + tag + ")");
      return true;
    }

    throw new Error("Unknown SMS provider \"" + provider + "\" in functions/config.js");
  }

  return { send, provider };
}

module.exports = { createSmsSender, smsText, localNumber, SMS_SECRETS };
