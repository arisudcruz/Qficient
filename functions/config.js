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
  //   When switching to a real provider, also set WALKIN_SMS_ENABLED to true in js/admin-enforcer.js so the walk-in
  //   form tells staff the ticket is texted.
  sms: {
    provider: "semaphore",
    senderName: "QFicient"   // Semaphore only: exactly as registered (active) in the Semaphore account
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
