// Everything you might want to tune lives here.
module.exports = {
  // Keep this the same as your Firestore database region (asia-east2 = Hong Kong).
  region: "asia-east2",

  // Queue days run on Philippine time (UTC+8), matching the app and firestore.rules.
  tzOffsetMs: 8 * 60 * 60 * 1000,

  // Leftover tickets from earlier days (up to this many days back) are voided each night.
  staleLookbackDays: 7,

  // Students' notification history (the Notifications tab) is deleted after this many days.
  notificationHistoryDays: 7,

  // A push that cannot be delivered within this time is dropped instead of arriving late.
  pushTtlSeconds: 600,

  // Safety cap so a bug can never run up a large bill.
  maxInstances: 5,

  // Text messages for walk-in tickets made by the Queue Enforcer (they have no app to get push alerts).
  //   provider "log":       test mode, nothing is sent; messages are saved in the smsLog collection (free)
  //   provider "semaphore": real SMS through semaphore.co. First run
  //                           firebase functions:secrets:set SMS_API_KEY
  //                         paste the Semaphore API key, then deploy the functions.
  //   provider "android":   an Android phone with a SIM running "SMS Gateway for Android" (sms-gate.app) in
  //                         Cloud Server mode sends the texts. First run both of these and paste the username
  //                         and password shown in the app, then deploy the functions:
  //                           firebase functions:secrets:set SMS_GATEWAY_USER
  //                           firebase functions:secrets:set SMS_GATEWAY_PASSWORD
  sms: {
    provider: "android",
    senderName: "",  // Semaphore only: a sender name approved in your account; leave empty for the default
    androidUrl: ""   // Android only: leave empty for the app's public cloud server
  },

  // Limits on joining the queue (enforced by the joinQueue function, per account).
  joinMinIntervalMs: 3 * 1000,   // shortest gap between two joins
  cancelCooldownMs: 20 * 1000,   // wait after cancelling a ticket before joining again
  maxJoinsPerDay: 10,            // tickets one account can create in a queue day

  // Switch individual notifications on or off.
  notify: {
    serving: true,
    recall: true,
    skipped: true,
    lastCall: true,
    next: true,
    transferred: true,
    voided: true,
    manualCreated: true   // the walk-in's ticket number, texted when the Queue Enforcer creates it
  }
};
