#!/usr/bin/env node
/**
 * Sandbox throughput benchmark for the DataForSEO client.
 *
 * ## What this measures, and what it cannot
 *
 * Every request goes to the **sandbox**, so nothing is billed. That means this
 * measures the *request path* — connection setup, auth, envelope, routing, JSON
 * parsing — and not the vendor's real compute. Production Latency will be higher
 * for anything that actually crawls or models.
 *
 * What it is genuinely for: proving the client's concurrency and retry behaviour
 * holds under load before a production run is the first time we see it, and
 * catching a regression where a change makes the path serially slow.
 *
 *   DATAFORSEO_API_KEY=<base64 login:password> \
 *   DATAFORSEO_BASE_URL=https://sandbox.dataforseo.com \
 *   node scripts/benchmark-dataforseo-sandbox.mjs
 *
 * ## The measured result (2026-10-10, from a Starlink link in Mexico City)
 *
 * | Concurrent | Wall time | status 20000 |
 * |---|---|---|
 * | 1  | 1918 ms | 1/1  |
 * | 5  | 644 ms  | 5/5  |
 * | 10 | 859 ms  | 10/10 |
 * | 20 | 1180 ms | 20/20 |
 * | 30 | 663 ms  | 30/30 |
 * | 50 | 809 ms  | 50/50 |
 *
 * **Wall time is flat with concurrency, and every response is 20000.** No rate
 * limiting was observed at 50 concurrent against the sandbox. The single-request
 * figure (1.9 s) is higher than any batch, which is connection setup amortised
 * across a batch — the same reason a warm pool beats a cold one and why the
 * retry budget matters more than the request budget.
 *
 * ## The caveat that makes those numbers honest
 *
 * A flat curve on a fixture-serving host proves the client is not the bottleneck.
 * It does **not** prove the vendor tolerates 30 concurrent in production, and the
 * rate gate in `src/server/lib/dataforseo/gates.ts` exists precisely because the
 * answer there is different. **Read these numbers as "our client is not
 * serialising", not as "the vendor tolerates this".**
 */

const KEY = process.env.DATAFORSEO_API_KEY;
const BASE =
  process.env.DATAFORSEO_BASE_URL ?? "https://sandbox.dataforseo.com";
const PATH = "/v3/dataforseo_labs/google/keyword_overview/live";

if (!KEY) {
  console.error(
    "Set DATAFORSEO_API_KEY (base64 login:password from app.dataforseo.com/api-access).",
  );
  process.exit(1);
}

/**
 * A representative body: two keywords, which exercises the array shape the
 * endpoint requires (`keywords`, plural — a singular `keyword` is refused with
 * `40501 Invalid Field: 'keywords'`, which is how the first version of this script
 * spent ten minutes).
 */
const BODY = JSON.stringify([
  {
    keywords: ["crm software", "best crm"],
    location_code: 2840,
    language_code: "en",
  },
]);

async function one() {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE}${PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${KEY}`,
        "Content-Type": "application/json",
      },
      body: BODY,
    });
    const payload = await response.json();
    return {
      ms: Date.now() - startedAt,
      status: payload.tasks?.[0]?.status_code,
    };
  } catch (error) {
    return {
      ms: Date.now() - startedAt,
      status: `THREW ${error instanceof Error ? error.message.slice(0, 40) : "unknown"}`,
    };
  }
}

async function batch(concurrency) {
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => one()),
  );
  const ok = results.filter((result) => result.status === 20000).length;
  return { concurrency, ms: Date.now() - startedAt, ok, results };
}

const runs = [];
for (const concurrency of [1, 5, 10, 20, 30, 50]) {
  runs.push(await batch(concurrency));
}

const lines = runs.map((run) => {
  const other = run.results
    .filter((result) => result.status !== 20000)
    .map((result) => result.status);
  return (
    `${String(run.concurrency).padStart(3)} concurrent -> ${String(run.ms).padStart(5)} ms, ` +
    `${String(run.ok).padStart(2)}/${run.concurrency} status 20000` +
    (other.length > 0 ? ` | other: ${[...new Set(other)].join(", ")}` : "")
  );
});

console.log(
  "SANDBOX THROUGHPUT (fixtures — client path only, not vendor compute)",
);
console.log(lines.join("\n"));

const anyFailure = runs.some((run) => run.ok !== run.concurrency);
console.log(
  anyFailure
    ? "\nFAIL: not every request returned 20000. A non-20000 status is a request-shape or auth problem, not a rate limit."
    : "\nPASS: every request returned 20000 at every concurrency level.",
);
process.exit(anyFailure ? 1 : 0);
