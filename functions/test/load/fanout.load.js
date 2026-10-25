// Live-update fan-out test against the Firestore emulator: many open student pages watch today's tickets (the same
// query the app uses) while staff call numbers. It measures how quickly each change reaches every page and how many
// documents each page reads, which is what Firestore bills.
//   firebase emulators:exec --only firestore --project demo-qficient "node functions/test/load/run.js"
// Sizes: LOAD_PAGES (open pages), LOAD_WAITING (tickets already in line), LOAD_CALLS (Call Next presses).
// Cost line: LOAD_DAY_TICKETS (tickets in a busy day) and READ_PRICE_PER_100K (US$, check Firestore pricing for
// asia-east2; the default is only a placeholder for the estimate).
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const config = require("../../config");
const { startOfTodayMs } = require("../../lib/time");
const { callNext } = require("./backend.load");
const { now, timingLine, createChecks, numberFromEnv } = require("./stats");

if (!/^(127\.0\.0\.1|localhost):/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("Refusing to run: the load test only runs against the local Firestore emulator.");
  process.exit(2);
}

const PAGES = numberFromEnv("LOAD_PAGES", 100);
const WAITING = numberFromEnv("LOAD_WAITING", 60);
const CALLS = Math.min(numberFromEnv("LOAD_CALLS", 20), WAITING); // each call serves one waiting ticket
const DAY_TICKETS = numberFromEnv("LOAD_DAY_TICKETS", 1000);
const READ_PRICE_PER_100K = numberFromEnv("READ_PRICE_PER_100K", 0.06);
const STATION = "fanout";

const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-qficient" });
const db = app.firestore();
const Timestamp = admin.firestore.Timestamp;

// Starts from an empty day so the read counts are only this test's tickets.
async function wipeTickets() {
  for (;;) {
    const snap = await db.collection("tickets").limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// One open page: its own connection, listening to today's tickets like js/firebase.js does.
function openPage(index, sentAt, ready) {
  const pageApp = admin.initializeApp({ projectId: "demo-qficient" }, "page" + index + "_" + Date.now());
  const pageDb = pageApp.firestore();
  const page = { app: pageApp, reads: 0, firstLoadMs: 0, latencies: [], seen: new Set(), stop: null };
  const opened = now();
  let first = true;

  page.stop = pageDb.collection("tickets")
    .where("createdAt", ">=", Timestamp.fromMillis(startOfTodayMs(config.tzOffsetMs, Date.now())))
    .onSnapshot(function (snap) {
      if (first) {
        first = false;
        page.reads += snap.size;
        page.firstLoadMs = now() - opened;
        ready();
        return;
      }
      const changes = snap.docChanges();
      page.reads += changes.length;
      const at = now();
      changes.forEach(function (change) {
        // Waiting tickets are served in order, so ticket k first changes on the k-th Call Next. (When changes arrive
        // close together Firestore merges them, so the page may see it already completed; that still counts.)
        const seq = Number(change.doc.id.slice(2)) + 1;
        if (sentAt[seq] && !page.seen.has(seq)) {
          page.seen.add(seq);
          page.latencies.push(at - sentAt[seq]);
        }
      });
    });
  return page;
}

async function run() {
  const t = createChecks();
  console.log("\n=== Live-update fan-out: " + PAGES + " open pages, " + WAITING + " in line, " + CALLS + " Call Next presses ===\n");

  await wipeTickets();
  await db.collection("stations").doc(STATION).set({ name: "Fan-out Station", code: "FO1", count: WAITING, active: true, nowServingId: null });
  for (let i = 0; i < WAITING; i += 400) {
    const batch = db.batch();
    for (let j = i; j < Math.min(WAITING, i + 400); j++) {
      batch.set(db.collection("tickets").doc("fo" + String(j).padStart(5, "0")), {
        ticketNo: "FO1-" + String(j + 1).padStart(3, "0"), stationId: STATION, ownerId: "fan" + j, ownerName: "Fan " + j,
        studentNumber: "", studentType: "regular", purpose: "Load test", status: "waiting", verified: false,
        createdAt: Timestamp.fromMillis(Date.now() - (WAITING - j) * 1000)
      });
    }
    await batch.commit();
  }

  // Open every page and wait until each has its first list of tickets.
  const sentAt = {};
  let readyCount = 0;
  let allReady;
  const ready = new Promise((resolve) => { allReady = resolve; });
  const pages = Array.from({ length: PAGES }, (_, i) => openPage(i, sentAt, function () {
    readyCount++;
    if (readyCount === PAGES) allReady();
  }));
  await ready;
  const firstLoads = pages.map((p) => p.firstLoadMs);
  const initialReads = pages.reduce((sum, p) => sum + p.reads, 0) / PAGES;
  t.info(timingLine("Page first load (all tickets of today)", firstLoads));

  // Staff call numbers; the pages time when each newly served ticket reaches them.
  for (let seq = 1; seq <= CALLS; seq++) {
    sentAt[seq] = now();
    await callNext(STATION);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 2000));

  const latencies = [].concat.apply([], pages.map((p) => p.latencies));
  const delivered = pages.filter((p) => p.seen.size === CALLS).length;
  // Delivery times on the emulator (one process on this PC) are for comparing runs, not Google's real speed.
  t.info(timingLine("Change reaches each open page (emulator time)", latencies));
  t.check("fan-out: every open page received every call (" + delivered + "/" + PAGES + ")", delivered === PAGES);

  // Reads: what one open page costs to load, and per staff action after that.
  const totalReads = pages.reduce((sum, p) => sum + p.reads, 0) / PAGES;
  const perCall = (totalReads - initialReads) / CALLS;
  t.info("Reads per open page: " + Math.round(initialReads) + " to load today's tickets, then about " + perCall.toFixed(1) + " per Call Next");
  const dayReadsPerPage = DAY_TICKETS + DAY_TICKETS * perCall;
  t.info("Estimate for a busy day (" + DAY_TICKETS + " tickets, each called once): about " + Math.round(dayReadsPerPage).toLocaleString() +
    " reads per page kept open all day, ≈ US$" + (dayReadsPerPage / 100000 * READ_PRICE_PER_100K).toFixed(3) +
    " per page at US$" + READ_PRICE_PER_100K + " per 100k reads (set READ_PRICE_PER_100K to the current asia-east2 price)");
  const dayPages = numberFromEnv("LOAD_DAY_PAGES", 3000);
  t.info("For " + dayPages.toLocaleString() + " pages open all day: about " + Math.round(dayReadsPerPage * dayPages / 1e6 * 10) / 10 +
    " million reads ≈ US$" + (dayReadsPerPage * dayPages / 100000 * READ_PRICE_PER_100K).toFixed(2) + " (LOAD_DAY_PAGES)");

  pages.forEach((p) => p.stop());
  await Promise.all(pages.map((p) => p.app.delete()));
  return t.failures();
}

module.exports = { run };

if (require.main === module) {
  run().then((failures) => {
    console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
  }).catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
