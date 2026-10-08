# QFicient notification server

A small always-on program that does two jobs for the queue system. It runs on one school PC, separate from the website, and uses only free Firebase features (no Blaze plan needed).

1. **Push notifications.** It watches today's tickets and sends a push to the student when something changes:
   - "It's your turn!" (ticket becomes **serving**)
   - "Please go to the counter" (**Recall**)
   - "You were skipped" (**Skip**)
   - "Last call" (**Last Call**)
   - "You're next in line" (first waiting ticket while someone is being served)
   - "Ticket transferred" (**Transfer Ticket**)
   - "Ticket voided" / "Ticket removed"
2. **Automatic voiding.** Skipped tickets whose last call has run out are voided on their own, even when nobody has Queue Management open. At the start of each queue day (Philippine time) it also voids tickets left over from earlier days.

It writes a heartbeat to Firestore every minute. If it stops, the admin console shows a "Notification server is offline" banner.

## What you need

- A Windows PC that stays **on and online during all queue hours**, with sleep and hibernate turned off.
- [Node.js](https://nodejs.org) (LTS version, 18 or newer).
- A Firebase **service account key** for the `qficient` project (below).

## One-time setup

1. **Install Node.js** (LTS). Check it with `node --version` in a terminal.
2. **Get the key.** In the Firebase console open **Project settings → Service accounts → Generate new private key**. A `.json` file downloads.
3. **Put the key in this folder** and rename it to `serviceAccountKey.json`. The path is `server/serviceAccountKey.json`.
4. **Install and start:**

   ```bash
   cd server
   npm install
   npm start
   ```

   You should see `notifier running for queue day ...`. Leave it running and check the admin console: the offline banner disappears within a minute.

> **The key is a master password to your Firebase project.** It bypasses all security rules. Never commit it, email it or share it. `server/serviceAccountKey*.json` is already in `.gitignore`. If it ever leaks, delete it under Project settings → Service accounts → Manage service account permissions → Keys, and generate a new one.

## Start automatically and restart if it stops

Pick **one**.

### Option A: Task Scheduler (built into Windows)

1. Open **Task Scheduler → Create Task**.
2. **General:** name it `QFicient notifier`; choose **Run whether user is logged on or not**.
3. **Triggers:** New → **At startup**.
4. **Actions:** New → Start a program
   - Program: `node` (or the full path, e.g. `C:\Program Files\nodejs\node.exe`)
   - Arguments: `index.js`
   - Start in: the full path of this `server` folder
5. **Settings:** tick **If the task fails, restart every 1 minute** (up to 999 times) and untick **Stop the task if it runs longer than**.
6. Right-click the task → **Run**. Reboot once to confirm it starts by itself.

### Option B: NSSM (runs it as a Windows service)

1. Download [NSSM](https://nssm.cc) and run `nssm install QFicientNotifier`.
2. Path: `C:\Program Files\nodejs\node.exe`, Startup directory: this `server` folder, Arguments: `index.js`.
3. On the **I/O** tab, set Output and Error files (for example `server\notifier.log`) to keep a log.
4. `nssm start QFicientNotifier`.

## Keep the PC awake

**Settings → System → Power**: set sleep to **Never** while plugged in. Also disable "Allow the computer to turn off this device" for the network adapter, and pause Windows automatic restarts during queue hours if you can.

## Configuration

Edit `config.js`. You can switch individual notifications on or off under `notify`, change how often tickets are checked, or change the lookback for leftover tickets.

## Testing

The logic is tested against the Firestore emulator with a fake push sender, so no real key or phone is needed:

```bash
npm install -g firebase-tools        # once
firebase emulators:exec --only firestore --project demo-qficient "node server/test/run.js"
```

Real delivery to a phone can only be checked on a real device: open the site on a phone, allow notifications, join the queue, then press **Call Next** from the admin console.

## Good to know

- **Events while the program is off are not sent afterwards.** When it starts, it only records what already exists and then reacts to new changes.
- **Push delivery is best effort.** It needs the student to have allowed notifications. On iPhone, the site must first be added to the Home Screen. A push that cannot be delivered within 10 minutes is dropped.
- **Dead device tokens** (for example an uninstalled browser) are deleted automatically.
- **Cost:** free. The server reads only today's tickets and keeps them in memory, so it uses a small amount of the free Firestore quota.
- If the server is down, the admin page still voids expired tickets, but only while someone has **Queue Management** open.
