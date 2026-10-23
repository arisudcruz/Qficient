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

  // How long a Queue Enforcer's walk-in QR code can be scanned (keep in step with WALKIN_PASS_MINUTES in
  // js/admin-enforcer.js).
  walkinPassMinutes: 10,

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
    enrollmentNext: true,   // an enrollment student is sent on to their next station (and told when it's all done)
    voided: true
  }
};
