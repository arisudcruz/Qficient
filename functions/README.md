# QFicient Cloud Functions

These run on Firebase (Google's servers), so no school PC has to stay on. They do four jobs:

| Function | When it runs | What it does |
|---|---|---|
| `onTicketWritten` | Every time a ticket is created or changed | Sends the student a push: **your turn**, **recall**, **skipped**, **last call**, **transferred**, **voided/removed**, and **you're next in line**. |
| `sweepExpiredTickets` | Every minute | Voids skipped tickets whose last call has run out (using your Auto-Void minutes setting) and records a heartbeat so the admin console can warn if it stops. |
| `dailyCleanup` | 12:05 AM Philippine time | Voids leftover tickets from earlier days and frees stations still pointing at them. |
| `joinQueue` | When a student or guest taps Generate Ticket | Creates their ticket on the server: one live ticket per person, a 3-second gap between joins, a 20-second pause after cancelling, 10 tickets per account per day, and the station's daily cap. Limits live in `config.js`. |

Tickets are voided up to about a minute after their last call expires (the admin page still voids them to the second while Queue Management is open).

Pushes are *data-only* messages; the app's service worker (`public/firebase-messaging-sw.js`) displays them. Students must allow notifications, and on iPhone the site must first be added to the Home Screen.

## Deploy (you run these)

You need the Blaze plan on the `qficient` project. Open a terminal in the project folder:

```bash
npm install -g firebase-tools   # once
firebase login                  # once; opens a browser
firebase use qficient
```

Then deploy **in this order**:

1. **Rules and indexes.** The new app writes fields that the old rules reject, and the "next in line" push needs a database index:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```

   The index takes a few minutes to build (Firebase console → Firestore → Indexes: wait for *Enabled*).

2. **Functions:**

   ```bash
   firebase deploy --only functions
   ```

   The first deploy asks to enable a few Google Cloud APIs (Cloud Build, Artifact Registry, Cloud Scheduler, Eventarc). Say yes. It can take several minutes.

3. **The website** (your usual hosting).

After deploying, the "Notification service is offline" banner in the admin console should disappear within about a minute.

## Keep the bill at zero

A queue this size should stay inside Blaze's free allowances. To be safe:

- In the Google Cloud console open **Billing → Budgets & alerts** and create a budget of about **$1** with email alerts.
- `config.js` caps each function at 5 instances so a bug can't scale out of control.

## Check that it works

- Firebase console → **Functions** shows `onTicketWritten`, `sweepExpiredTickets` and `dailyCleanup`; open **Logs** to see `push sent: ...` lines.
- On a phone: open the site, allow notifications, join a queue, then press **Call Next** from the admin console. The push should arrive within a few seconds.

## Changing behavior

Edit `config.js` (region, which notifications are on, how many days back the cleanup looks) and `lib/messages.js` (the wording), then run `firebase deploy --only functions` again. The region must stay the same as your Firestore database (`asia-east2`).

## Tests

```bash
cd functions && npm install
node test/events.test.js                    # logic only, no emulator
firebase emulators:exec --only functions,firestore --project demo-qficient "node functions/test/emulator.test.js"
```

The emulator test runs the real functions and checks every notification, the dedupe protection, dead-token cleanup, auto-void and the daily cleanup. In the emulator, pushes are written to a `testPushLog` collection instead of being sent.

## Good to know

- Real delivery to a phone can only be verified on a real device.
- Duplicate deliveries of the same database event are dropped (`pushEvents` collection, cleaned out after 3 days).
- A student whose browser token has expired is cleaned up automatically on the next failed send.
- If students report no pushes, check in order: notifications allowed in the browser, a `deviceTokens/<uid>` document exists, and the function logs for errors.
