// Everything you might want to tune lives here.
module.exports = {
  // Keep this the same as your Firestore database region (asia-east2 = Hong Kong).
  region: "asia-east2",

  // Queue days run on Philippine time (UTC+8), matching the app and firestore.rules.
  tzOffsetMs: 8 * 60 * 60 * 1000,

  // Leftover tickets from earlier days (up to this many days back) are voided each night.
  staleLookbackDays: 7,

  // A push that cannot be delivered within this time is dropped instead of arriving late.
  pushTtlSeconds: 600,

  // Safety cap so a bug can never run up a large bill.
  maxInstances: 5,

  // Switch individual notifications on or off.
  notify: {
    serving: true,
    recall: true,
    skipped: true,
    lastCall: true,
    next: true,
    transferred: true,
    voided: true
  }
};
