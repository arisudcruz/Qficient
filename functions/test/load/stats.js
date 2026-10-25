// Small helpers shared by the load tests: timing, percentiles and a pass/fail tally.

function now() {
  return Number(process.hrtime.bigint() / 1000000n);
}

// Runs fn and records how long it took (ms), whether it worked, and the error code if not.
async function timed(fn) {
  const start = now();
  try {
    const value = await fn();
    return { ok: true, ms: now() - start, value };
  } catch (error) {
    return { ok: false, ms: now() - start, code: error && (error.code || error.message) };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// { count, avg, p50, p95, p99, max } of a list of millisecond timings.
function summarize(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const sum = sorted.reduce(function (total, v) { return total + v; }, 0);
  return {
    count: sorted.length,
    avg: sorted.length ? Math.round(sum / sorted.length) : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0
  };
}

function timingLine(label, values) {
  const s = summarize(values);
  return label + ": " + s.count + " done · avg " + s.avg + " ms · p50 " + s.p50 + " ms · p95 " + s.p95 + " ms · max " + s.max + " ms";
}

// Counts results by error code, e.g. { "resource-exhausted": 3 }.
function failureCodes(results) {
  const codes = {};
  results.filter(function (r) { return !r.ok; }).forEach(function (r) {
    codes[r.code] = (codes[r.code] || 0) + 1;
  });
  return codes;
}

function createChecks() {
  let failures = 0;
  return {
    check(name, ok, detail) {
      if (!ok) failures++;
      console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || !detail ? "" : "   <-- " + detail));
    },
    info(text) {
      console.log("      " + text);
    },
    failures() {
      return failures;
    }
  };
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return value > 0 ? value : fallback;
}

module.exports = { now, timed, summarize, timingLine, failureCodes, createChecks, numberFromEnv };
