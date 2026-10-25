// Page speed test: how long QFicient takes to download everything it needs before it can start, loading the files
// the way the browser does (the page, then the libraries in its head, then the views and app scripts together).
// Read-only GET requests, no sign-in.
//   npm run perf:page                              live site, 3 runs
//   node scripts/page-speed.mjs http://localhost:5173 --runs 5 --budget 2000
//   node scripts/page-speed.mjs --compare          also times the old one-by-one script loading
// Exits with 1 when the median time to "app ready" is over the budget (default 3000 ms).
//
// It measures downloads only. The browser's own work after that (running the scripts, Firebase sign-in, loading
// the queue) shows up in a real browser as performance.getEntriesByName("qficient-ready") (see js/view-loader.js).

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const base = (args.find((a) => /^https?:\/\//.test(a)) || "https://qficient.vercel.app").replace(/\/+$/, "");
const runs = Math.max(1, Number(option("runs", 3)));
const budgetMs = Number(option("budget", 3000));
const compare = args.includes("--compare");

const clock = () => performance.now();

async function get(url) {
  const start = clock();
  const response = await fetch(url, { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
  const body = await response.text();
  if (!response.ok) throw new Error(url + " answered " + response.status);
  return { url, ms: clock() - start, bytes: Buffer.byteLength(body), body };
}

function absolute(src) {
  return /^https?:\/\//.test(src) ? src : base + "/" + src.replace(/^\/+/, "");
}

// The files listed in an array in js/view-loader.js, e.g. var appScripts = [ ... ];
function listFrom(source, name) {
  const match = new RegExp("var " + name + " = \\[([\\s\\S]*?)\\];").exec(source);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

async function onePageLoad() {
  const start = clock();
  const html = await get(base + "/");
  const htmlDone = clock() - start;

  // The head: stylesheets and scripts load in parallel, and the page waits for all of them.
  const head = html.body.split("</head>")[0];
  const headFiles = [...head.matchAll(/<script[^>]+src="([^"]+)"/g), ...head.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map((m) => absolute(m[1]));
  const headResults = await Promise.all(headFiles.map(get));
  const headDone = clock() - start;

  // view-loader.js starts the views and every app script together.
  const loader = await get(base + "/js/view-loader.js");
  const appFiles = listFrom(loader.body, "viewFiles").concat(listFrom(loader.body, "appScripts")).map(absolute);
  const appResults = await Promise.all(appFiles.map(get));
  const readyDone = clock() - start;

  let oneByOne = null;
  if (compare) {
    const sequentialStart = clock();
    for (const url of listFrom(loader.body, "appScripts").map(absolute)) await get(url);
    oneByOne = clock() - sequentialStart;
  }

  const all = [html, loader].concat(headResults, appResults);
  return {
    htmlDone, headDone, readyDone, oneByOne,
    files: all.length,
    bytes: all.reduce((sum, f) => sum + f.bytes, 0),
    slowest: all.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
  };
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const ms = (value) => Math.round(value) + " ms";

console.log("\nPage speed test: " + base + " (" + runs + " run" + (runs === 1 ? "" : "s") + ")\n");
const results = [];
for (let i = 0; i < runs; i++) {
  const r = await onePageLoad();
  results.push(r);
  console.log("  run " + (i + 1) + ": page " + ms(r.htmlDone) + " · libraries " + ms(r.headDone) + " · app ready " + ms(r.readyDone) +
    (r.oneByOne !== null ? " · old one-by-one scripts alone " + ms(r.oneByOne) : ""));
}

const last = results[results.length - 1];
const ready = median(results.map((r) => r.readyDone));
console.log("\n  Median: page " + ms(median(results.map((r) => r.htmlDone))) + " · libraries " + ms(median(results.map((r) => r.headDone))) +
  " · app ready " + ms(ready));
if (compare) console.log("  Old one-by-one loading of the app scripts alone (median): " + ms(median(results.map((r) => r.oneByOne))));
console.log("  " + last.files + " files, " + (last.bytes / 1024).toFixed(0) + " KB (uncompressed)");
console.log("  Slowest files: " + last.slowest.map((f) => (f.url === base + "/" ? "index.html" : f.url.replace(base + "/", "")) + " " + ms(f.ms)).join(", "));

const pass = ready <= budgetMs;
console.log("\n" + (pass ? "PASS" : "FAIL") + "  app ready in " + ms(ready) + " (budget " + ms(budgetMs) + ")\n");
process.exit(pass ? 0 : 1);
