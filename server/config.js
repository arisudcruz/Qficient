// Everything you might want to tune lives here.
module.exports = {
  projectId: process.env.QFICIENT_PROJECT_ID || "qficient",

  // Path to the Firebase service account key (never commit this file).
  serviceAccountFile: process.env.SERVICE_ACCOUNT_FILE || "serviceAccountKey.json",

  // Queue days run on Philippine time (UTC+8), matching the app and firestore.rules.
  tzOffsetMs: 8 * 60 * 60 * 1000,

  // How often expired last calls are checked and voided.
  voidCheckMs: 5 * 1000,

  // How often the server reports that it is alive (the admin console shows a warning if this stops).
  heartbeatMs: 60 * 1000,

  // How often the server checks whether a new queue day has started.
  dayCheckMs: 30 * 1000,

  // Leftover tickets from earlier days (up to this many days back) are voided at the start of each day.
  staleLookbackDays: 7,

  // A push that cannot be delivered within this time is dropped instead of arriving late.
  pushTtlSeconds: 600,

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
