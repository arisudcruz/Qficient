# QFicient Cloud Functions

These run on Firebase (Google's servers), so no school PC has to stay on. They do five jobs:

| Function | When it runs | What it does |
|---|---|---|
| `onTicketWritten` | Every time a ticket is created or changed | Sends the student a push: **your turn**, **recall**, **skipped**, **last call**, **transferred**, **voided/removed**, and **you're next in line**. |
| `sweepExpiredTickets` | Every minute | Voids skipped tickets whose last call has run out (using your Auto-Void minutes setting) and records a heartbeat so the admin console can warn if it stops. |
| `dailyCleanup` | 12:05 AM Philippine time | Voids leftover tickets from earlier days, frees stations still pointing at them, and deletes old walk-in passes. |
| `joinQueue` | When a student taps Generate Ticket | Creates their ticket on the server: one live ticket per person, a 3-second gap between joins, a 20-second pause after cancelling, 10 tickets per account per day, and the station's daily cap. Limits live in `config.js`. |
| `redeemWalkinPass` | When a walk-in scans the Queue Enforcer's QR code | Checks the one-time pass (`walkinPasses`, valid for `walkinPassMinutes`) and creates the walk-in's ticket, owned by their phone's temporary (anonymous) sign-in, so they get the same alerts as students. Needs **Anonymous** sign-in turned on (Firebase console → Authentication → Sign-in method). |

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

## Load and performance tests

These only ever run on this PC (the scripts refuse to run against anything but the local emulator), never on the live project.

```bash
cd functions && npm run load        # back-end load test + live-update fan-out, in the Firestore emulator
npm run perf:page                   # from the project folder: page speed of the live site (read-only)
```

- **Back-end load** (`test/load/backend.load.js`): growing crowds joining one station in the same instant (10, 25, 50, 100, 300) to find where joins start to fail; joins spread over stations while staff press Call Next; 100 walk-in QR scans at once; one QR scanned by 10 phones at once (must give exactly one ticket). Sizes: `LOAD_STUDENTS`, `LOAD_STATIONS`, `LOAD_WALKINS`; the pass mark for one station is `LOAD_MIN_CROWD` (default 25).
- **Live-update fan-out** (`test/load/fanout.load.js`): 100 open pages watch today's tickets while staff call numbers; checks every page gets every call and counts the reads each page costs, with a day estimate. Sizes: `LOAD_PAGES`, `LOAD_WAITING`, `LOAD_CALLS`, `LOAD_DAY_TICKETS`, `LOAD_DAY_PAGES`, and `READ_PRICE_PER_100K` (set it to the current Firestore price for asia-east2).
- **Page speed** (`../scripts/page-speed.mjs`): downloads the site the way the browser does and reports time to "app ready" (fails over `--budget`, default 3000 ms). `--compare` also times the old one-by-one script loading; pass a URL (e.g. `http://localhost:5173`) to test another copy. In a real browser, `performance.getEntriesByName("qficient-ready")[0].startTime` gives the same moment including the browser's own work.

The emulator is one process on this PC: its times are for comparing runs (before and after a change), not Google's real speed. Pass/fail is on correctness (everyone got a ticket, no duplicate numbers, every page updated), not on emulator times.

## Good to know

- Real delivery to a phone can only be verified on a real device.
- Duplicate deliveries of the same database event are dropped (`pushEvents` collection, cleaned out after 3 days).
- A student whose browser token has expired is cleaned up automatically on the next failed send.
- If students report no pushes, check in order: notifications allowed in the browser, a `deviceTokens/<uid>` document exists, and the function logs for errors.
