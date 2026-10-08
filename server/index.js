const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const config = require("./config");
const { createService } = require("./lib/service");

function log(message) {
  console.log(new Date().toISOString() + "  " + message);
}

function initFirebase() {
  // With the Firestore emulator running there is no key to load (used by the tests).
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: config.projectId });
    return;
  }

  const keyPath = path.resolve(__dirname, config.serviceAccountFile);
  if (!fs.existsSync(keyPath)) {
    console.error(
      "Missing service account key: " + keyPath + "\n" +
      "Download it from Firebase console > Project settings > Service accounts > Generate new private key,\n" +
      "then save it in the server folder as serviceAccountKey.json (see server/README.md)."
    );
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(require(keyPath)),
    projectId: config.projectId
  });
}

function sendPush(token, message) {
  // Data-only message: the app's service worker shows it, which avoids duplicate notifications.
  return admin.messaging().send({
    token: token,
    data: Object.assign({ title: message.title, body: message.body }, message.data || {}),
    webpush: {
      headers: { TTL: String(config.pushTtlSeconds), Urgency: "high" }
    }
  });
}

initFirebase();

const service = createService({
  db: admin.firestore(),
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp,
  sendPush: sendPush,
  config: config,
  log: log
});

service.start().catch(function (err) {
  console.error("Could not start: " + err.message);
  process.exit(1);
});

function shutdown() {
  log("shutting down");
  service.stop();
  setTimeout(function () { process.exit(0); }, 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep running through unexpected errors; the process manager restarts us if we do die.
process.on("unhandledRejection", function (err) {
  log("unhandled error: " + (err && err.message ? err.message : err));
});
