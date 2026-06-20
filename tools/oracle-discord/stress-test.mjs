#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  stress-test.mjs  —  KAI fleet ON-DEMAND stress / chaos harness
// ─────────────────────────────────────────────────────────────────────────────
//
//  STANDALONE. Run MANUALLY when the fleet is already up. NOT part of startup.
//  Reads/queries the live surface, ramps load to find the breaking point, then
//  attacks each endpoint with malformed input — and reports the holes down to
//  the file/function level.
//
//  This file does NOT import or modify any live fleet code. Node stdlib only
//  (global fetch + AbortSignal, Promise-batched worker pools).
//
//  ── HOW TO RUN ──────────────────────────────────────────────────────────────
//    node stress-test.mjs                      # all reachable services, safe pass
//    node stress-test.mjs --dry-run            # plan only; sends zero traffic
//    node stress-test.mjs --target engine      # one service: engine|openjarvis|
//                                              #   ollama|dashboard
//    node stress-test.mjs --max-concurrency 20 # cap the ramp ceiling
//    node stress-test.mjs --include-heavy      # also ramp LLM endpoints
//                                              #   (oracle-turn / chat) — slow
//    node stress-test.mjs --include-writes     # also exercise write endpoints
//                                              #   (rshl/store, bulk-ingest) with
//                                              #   clearly-marked test payloads
//                                              #   into region="stress-test"
//
//  ── SAFETY ──────────────────────────────────────────────────────────────────
//    • Default run is READ/QUERY ONLY. No writes, no LLM hammering.
//    • Write endpoints are gated behind --include-writes and only ever write to
//      region="stress-test", source="stress-test-harness" so they are trivially
//      identifiable / purgeable. Never touches production regions.
//    • Heavy LLM endpoints are gated behind --include-heavy and ramp at a capped
//      ceiling (HEAVY_MAX_CONC) so a casual run will not melt the model.
//    • Every request is wrapped — the harness classifies failures and NEVER
//      crashes itself. Worst case: an endpoint is marked DOWN/BROKEN.
//
//  ── OUTPUT ──────────────────────────────────────────────────────────────────
//    • Console: live progress + final summary table + prioritized fix list.
//    • File:    stress-report.md (next to this script).
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dirname, 'stress-report.md');

// ── CLI flags ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    target: 'all',
    maxConcurrency: 50,
    dryRun: false,
    includeHeavy: false,
    includeWrites: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--include-heavy') a.includeHeavy = true;
    else if (t === '--include-writes') a.includeWrites = true;
    else if (t === '--target') a.target = (argv[++i] || 'all').toLowerCase();
    else if (t.startsWith('--target=')) a.target = t.slice('--target='.length).toLowerCase();
    else if (t === '--max-concurrency') a.maxConcurrency = parseInt(argv[++i], 10) || 50;
    else if (t.startsWith('--max-concurrency=')) a.maxConcurrency = parseInt(t.slice('--max-concurrency='.length), 10) || 50;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(`KAI fleet stress-test.mjs
  --target <engine|openjarvis|ollama|dashboard|all>   (default all)
  --max-concurrency <n>                               (default 50)
  --include-heavy                                     ramp LLM endpoints too
  --include-writes                                    exercise write endpoints (test region)
  --dry-run                                           plan only, send no traffic`);
  process.exit(0);
}

// ── Tunables ─────────────────────────────────────────────────────────────────
const RAMP_STEPS = [1, 5, 20, 50].filter(c => c <= ARGS.maxConcurrency);
if (RAMP_STEPS.length === 0) RAMP_STEPS.push(ARGS.maxConcurrency);
const HEAVY_MAX_CONC = Math.min(5, ARGS.maxConcurrency); // never hammer the model
const REQUESTS_PER_RAMP_STEP = 30;     // total requests at each concurrency level
const HEAVY_REQUESTS_PER_STEP = 6;     // far fewer for LLM endpoints
const DEFAULT_TIMEOUT_MS = 15_000;     // normal endpoints
const HEAVY_TIMEOUT_MS = 90_000;       // LLM generation can be slow
const HEALTH_TIMEOUT_MS = 2_500;
const ERROR_RATE_BREAK = 0.10;         // >10% errors at a step = breaking point
const P95_BREAK_MS = 10_000;           // p95 over this = degraded breaking point

// ── Failure classification ───────────────────────────────────────────────────
const FAIL = {
  TIMEOUT: 'timeout',
  CONN_REFUSED: 'connection-refused',
  SERVER_5XX: 'server-5xx',
  CLIENT_4XX: 'client-4xx',
  RATE_LIMITED: 'rate-limited-429',
  BAD_SHAPE: 'unexpected-response-shape',
  NETWORK: 'network-error',
  CRASH_SUSPECT: 'crash-suspect', // conn dropped mid-flight / refused after being up
};

function classifyError(err) {
  const msg = (err && (err.message || String(err))) || '';
  const code = err && err.code;
  const name = err && err.name;
  if (name === 'AbortError' || /aborted|timeout|timed out/i.test(msg)) return FAIL.TIMEOUT;
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|connection refused/i.test(msg)) return FAIL.CONN_REFUSED;
  if (code === 'ECONNRESET' || /ECONNRESET|socket hang up|reset by peer/i.test(msg)) return FAIL.CRASH_SUSPECT;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return FAIL.NETWORK;
  return FAIL.NETWORK;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Single request primitive — never throws. Returns a structured result.
// ─────────────────────────────────────────────────────────────────────────────
async function doRequest({ url, method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, expect }) {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = { method, signal: ctrl.signal, headers: {} };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, init);
    const latency = performance.now() - started;
    // Drain body (bounded) so the socket frees; capture a sample for shape checks.
    let text = '';
    try { text = await res.text(); } catch { /* ignore drain errors */ }
    const sample = text.slice(0, 400);

    if (res.status === 429) {
      return { ok: false, latency, status: res.status, failType: FAIL.RATE_LIMITED, sample };
    }
    if (res.status >= 500) {
      return { ok: false, latency, status: res.status, failType: FAIL.SERVER_5XX, sample };
    }
    if (res.status >= 400) {
      // 4xx is EXPECTED behaviour for chaos/malformed probes; caller decides.
      return { ok: false, latency, status: res.status, failType: FAIL.CLIENT_4XX, sample };
    }
    // 2xx/3xx — optionally validate shape.
    if (typeof expect === 'function') {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      const good = (() => { try { return expect(parsed, text, res); } catch { return false; } })();
      if (!good) return { ok: false, latency, status: res.status, failType: FAIL.BAD_SHAPE, sample };
    }
    return { ok: true, latency, status: res.status, sample };
  } catch (err) {
    const latency = performance.now() - started;
    return { ok: false, latency, status: 0, failType: classifyError(err), sample: (err && err.message) || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Promise-batched worker pool: run `total` jobs, `concurrency` in flight.
// ─────────────────────────────────────────────────────────────────────────────
async function runPool(total, concurrency, makeJob) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results.push(await makeJob(i));
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Latency / error stats ────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function summarize(results) {
  const ok = results.filter(r => r.ok);
  const lat = ok.map(r => r.latency).sort((a, b) => a - b);
  const failCounts = {};
  for (const r of results) {
    if (!r.ok) failCounts[r.failType] = (failCounts[r.failType] || 0) + 1;
  }
  const total = results.length;
  const errors = total - ok.length;
  return {
    total,
    okCount: ok.length,
    errorCount: errors,
    errorRate: total ? errors / total : 0,
    p50: Math.round(percentile(lat, 50)),
    p95: Math.round(percentile(lat, 95)),
    p99: Math.round(percentile(lat, 99)),
    max: Math.round(lat[lat.length - 1] || 0),
    failCounts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVICE + ENDPOINT REGISTRY
//  Endpoints discovered from:
//    • C:\KAI\src\bridge\oracle_server.rs  (engine :3334 route table, line ~556)
//    • shared/openjarvis.mjs, scripts/system-health.mjs  (OpenJarvis :8080)
//    • Ollama standard API (:11434)
//    • dashboard-server.mjs  (:3001)
//  Flags per endpoint:
//    safe        — pure read/query, ramp freely
//    heavy       — invokes an LLM / heavy generation; gated by --include-heavy
//    write       — mutates lattice state; gated by --include-writes (test region)
//    fn          — the Rust/JS handler, for file/function-level reporting
// ─────────────────────────────────────────────────────────────────────────────
const ENGINE = 'http://127.0.0.1:3334';
const OPENJARVIS = 'http://127.0.0.1:8080';
const OLLAMA = 'http://127.0.0.1:11434';
const DASHBOARD = 'http://127.0.0.1:3001';

// A growing test payload generator (small → large) for ramp/chaos sizing.
function bigText(approxBytes) {
  const unit = 'The lattice hums and the oracle considers the query. ';
  return unit.repeat(Math.ceil(approxBytes / unit.length)).slice(0, approxBytes);
}

const SERVICES = {
  engine: {
    label: 'KAI Engine (Rust CNS)',
    base: ENGINE,
    health: { method: 'GET', path: '/api/session', expect: (j) => j && typeof j === 'object' },
    sourceHint: 'C:\\KAI\\src\\bridge\\oracle_server.rs',
    endpoints: [
      {
        name: 'GET /api/session',
        method: 'GET', path: '/api/session',
        fn: 'handle_client → session lock (oracle_server.rs:557)',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      {
        name: 'GET /api/status',
        method: 'GET', path: '/api/status',
        fn: 'handle_status (oracle_server.rs:628)',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      {
        name: 'POST /api/rshl/query',
        method: 'POST', path: '/api/rshl/query',
        fn: 'handle_rshl_query (oracle_server.rs:5286); admission via QueryAdmission::acquire',
        safe: true,
        // body sized per-step by ramp; baseline normal payload:
        normalBody: { query: 'what is the lattice', n: 5 },
        rampBody: (bytes) => ({ query: bigText(bytes), n: 5 }),
        // Hits respond as an array of QueryHit; 429 is a designed brake, not a failure.
        expect: (j) => Array.isArray(j),
        tolerate429: true,
      },
      {
        name: 'POST /api/rshl/query-multi-hop',
        method: 'POST', path: '/api/rshl/query-multi-hop',
        fn: 'handle_rshl_query_multi_hop (oracle_server.rs:5323)',
        safe: true,
        normalBody: { query: 'how does memory connect', n: 5, hops: 3 },
        rampBody: (bytes) => ({ query: bigText(bytes), n: 5, hops: 3 }),
        expect: (j) => Array.isArray(j),
        tolerate429: true,
      },
      {
        name: 'GET /api/web-search',
        method: 'GET', path: '/api/web-search?query=kai+lattice+test',
        fn: 'web_search_duckduckgo (oracle_server.rs:610) — external DuckDuckGo round-trip',
        safe: true,
        external: true, // depends on outbound internet
        expect: (_j, text) => typeof text === 'string',
      },
      {
        name: 'GET /api/synapse/status',
        method: 'GET', path: '/api/synapse/status',
        fn: 'handle_synapse_status (oracle_server.rs:630)',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      {
        name: 'GET /api/jobs/status',
        method: 'GET', path: '/api/jobs/status',
        fn: 'handle_jobs_status (oracle_server.rs:670)',
        safe: true,
        expect: (j) => j !== undefined,
      },
      {
        name: 'GET /api/tools/registry',
        method: 'GET', path: '/api/tools/registry',
        fn: 'handle_tool_registry (oracle_server.rs:604)',
        safe: true,
        expect: (j) => j !== undefined,
      },
      // ── HEAVY: invokes LLM / generation. Gated by --include-heavy. ──
      {
        name: 'POST /api/oracle-turn',
        method: 'POST', path: '/api/oracle-turn',
        fn: 'handle_discord_turn (oracle_server.rs:1384) — stores msg + generates AI turn',
        heavy: true,
        // NOTE: this WRITES a social-digest cell. We mark from/user_id as test
        // identity so the digest is identifiable, and only run under --include-heavy.
        normalBody: { from: 'stress-test-harness', text: 'ping: stress harness normal-pass probe', user_id: 'stress-test-uid' },
        rampBody: (bytes) => ({ from: 'stress-test-harness', text: 'stress: ' + bigText(bytes), user_id: 'stress-test-uid' }),
        expect: (_j) => true, // any 2xx counts; shape varies
        timeoutMs: HEAVY_TIMEOUT_MS,
      },
      {
        name: 'POST /api/chat',
        method: 'POST', path: '/api/chat',
        fn: 'handle_chat → kai_chat (oracle_server.rs:5239) — provider LLM call',
        heavy: true,
        normalBody: { message: 'stress harness normal-pass probe', user_id: 'stress-test-uid' },
        rampBody: (bytes) => ({ message: bigText(bytes), user_id: 'stress-test-uid' }),
        expect: (_j) => true,
        timeoutMs: HEAVY_TIMEOUT_MS,
      },
      // ── WRITE: mutates the lattice. Gated by --include-writes. Test region. ──
      {
        name: 'POST /api/rshl/store',
        method: 'POST', path: '/api/rshl/store',
        fn: 'handle_rshl_store → store_or_reinforce (oracle_server.rs:5377)',
        write: true,
        normalBody: { text: 'stress-test marker entry', region: 'stress-test', source: 'stress-test-harness', strength: 0.1, user_id: 'stress-test-uid' },
        rampBody: (bytes) => ({ text: bigText(bytes), region: 'stress-test', source: 'stress-test-harness', strength: 0.1, user_id: 'stress-test-uid' }),
        expect: (_j, text) => typeof text === 'string',
      },
      {
        name: 'POST /api/bulk-ingest',
        method: 'POST', path: '/api/bulk-ingest',
        fn: 'handle_bulk_ingest (oracle_server.rs:5414)',
        write: true,
        normalBody: { entries: [
          { text: 'stress-test bulk marker a', region: 'stress-test', source: 'stress-test-harness', strength: 0.1, user_id: 'stress-test-uid' },
          { text: 'stress-test bulk marker b', region: 'stress-test', source: 'stress-test-harness', strength: 0.1, user_id: 'stress-test-uid' },
        ] },
        rampBody: (bytes) => ({ entries: Array.from({ length: 5 }, (_, k) => ({
          text: 'stress ' + k + ' ' + bigText(Math.floor(bytes / 5)),
          region: 'stress-test', source: 'stress-test-harness', strength: 0.1, user_id: 'stress-test-uid',
        })) }),
        expect: (_j) => true,
      },
    ],
  },

  openjarvis: {
    label: 'OpenJarvis (cognitive core)',
    base: OPENJARVIS,
    health: { method: 'GET', path: '/health', expect: () => true },
    sourceHint: 'external OpenJarvis service (:8080); callers in shared/openjarvis.mjs',
    endpoints: [
      {
        name: 'GET /health',
        method: 'GET', path: '/health',
        fn: 'OpenJarvis /health',
        safe: true,
        expect: () => true,
      },
      {
        name: 'GET /v1/models',
        method: 'GET', path: '/v1/models',
        fn: 'OpenJarvis /v1/models (probed in scripts/kai-scanner.mjs:157)',
        safe: true,
        expect: (j) => j !== undefined,
      },
      {
        name: 'GET /search',
        method: 'GET', path: '/search?q=kai+lattice+test',
        fn: 'OpenJarvis /search (shared/openjarvis.mjs:1185)',
        safe: true,
        external: true,
        expect: () => true,
      },
    ],
  },

  ollama: {
    label: 'Ollama (local model server)',
    base: OLLAMA,
    health: { method: 'GET', path: '/api/tags', expect: () => true },
    sourceHint: 'Ollama :11434 (callers: shared/openjarvis.mjs, consolidate-memory.mjs)',
    endpoints: [
      {
        name: 'GET /api/tags',
        method: 'GET', path: '/api/tags',
        fn: 'Ollama /api/tags (model list)',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      {
        name: 'GET /api/version',
        method: 'GET', path: '/api/version',
        fn: 'Ollama /api/version',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      // Generation is heavy; gated.
      {
        name: 'POST /api/generate',
        method: 'POST', path: '/api/generate',
        fn: 'Ollama /api/generate (shared/openjarvis.mjs, consolidate-memory.mjs:26)',
        heavy: true,
        // model intentionally generic; if absent Ollama returns 404 → classified, not fatal.
        normalBody: { model: 'llama3', prompt: 'reply with the single word: ok', stream: false },
        rampBody: (bytes) => ({ model: 'llama3', prompt: bigText(bytes), stream: false }),
        expect: () => true,
        timeoutMs: HEAVY_TIMEOUT_MS,
      },
    ],
  },

  dashboard: {
    label: 'Dashboard server',
    base: DASHBOARD,
    health: { method: 'GET', path: '/health', expect: () => true },
    sourceHint: 'C:\\KAI\\tools\\oracle-discord\\dashboard-server.mjs',
    endpoints: [
      {
        name: 'GET /health',
        method: 'GET', path: '/health',
        fn: 'dashboard-server.mjs:61 (health probe, also pings CNS :3334/api/session)',
        safe: true,
        expect: (j) => j && typeof j === 'object',
      },
      {
        name: 'GET /api/proof/summary',
        method: 'GET', path: '/api/proof/summary',
        fn: 'dashboard-server.mjs:21 → buildProofSummary',
        safe: true,
        expect: (j) => j !== undefined,
      },
      {
        name: 'GET /api/session (proxied → :3334)',
        method: 'GET', path: '/api/session',
        fn: 'dashboard-server.mjs:40 proxy → engine handle_client',
        safe: true,
        expect: (j) => j !== undefined,
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Chaos payloads — sent to each POST endpoint to surface unhandled errors.
//  Each entry: { label, body (raw string or undefined), expectGraceful }
//  "Graceful" = server responds with 4xx/2xx and stays up. Bad = 5xx / crash /
//  connection drop / timeout.
// ─────────────────────────────────────────────────────────────────────────────
const CHAOS_BODIES = [
  { label: 'empty body', raw: '' },
  { label: 'not json', raw: 'this is definitely not json {' },
  { label: 'empty json object', raw: '{}' },
  { label: 'null', raw: 'null' },
  { label: 'array instead of object', raw: '[1,2,3]' },
  { label: 'wrong types', raw: '{"query": 12345, "n": "five"}' },
  { label: 'deeply nested', raw: '{"query":' + '['.repeat(200) + '1' + ']'.repeat(200) + '}' },
  { label: 'unicode / control chars', raw: '{"query":"\\u0000\\uffff\\ud800 emoji 🧠🔥"}' },
  { label: 'huge string 2MB', raw: () => JSON.stringify({ query: bigText(2_000_000), n: 5 }) },
  { label: 'sql-ish injection text', raw: '{"query":"\'; DROP TABLE lattice; --"}' },
  { label: 'huge n', raw: '{"query":"x","n":999999999}' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Output helpers
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
function log(...a) { console.log(...a); }
function hdr(s) { log('\n' + C.bold + C.cyan + s + C.reset); }

// ─────────────────────────────────────────────────────────────────────────────
//  Per-endpoint runners
// ─────────────────────────────────────────────────────────────────────────────
async function normalPass(base, ep) {
  const url = base + ep.path;
  const body = ep.method === 'POST' ? (ep.normalBody ?? {}) : undefined;
  const r = await doRequest({
    url, method: ep.method, body,
    timeoutMs: ep.timeoutMs || DEFAULT_TIMEOUT_MS,
    expect: ep.expect,
  });
  // A designed 429 brake counts as "working as intended" for tolerant endpoints.
  const pass = r.ok || (ep.tolerate429 && r.failType === FAIL.RATE_LIMITED);
  return { url, result: r, pass };
}

async function rampPass(base, ep) {
  const isHeavy = !!ep.heavy;
  const perStep = isHeavy ? HEAVY_REQUESTS_PER_STEP : REQUESTS_PER_RAMP_STEP;
  const concSteps = isHeavy ? RAMP_STEPS.filter(c => c <= HEAVY_MAX_CONC) : RAMP_STEPS;
  // Payload size ramp (bytes): small → large
  const sizeForStep = [200, 2_000, 20_000, 100_000];
  const steps = [];
  let breakingPoint = null;

  for (let si = 0; si < concSteps.length; si++) {
    const conc = concSteps[si];
    const bytes = sizeForStep[Math.min(si, sizeForStep.length - 1)];
    const body = ep.method === 'POST'
      ? (ep.rampBody ? ep.rampBody(bytes) : (ep.normalBody ?? {}))
      : undefined;

    const results = await runPool(perStep, conc, () => doRequest({
      url: base + ep.path, method: ep.method, body,
      timeoutMs: ep.timeoutMs || DEFAULT_TIMEOUT_MS,
      expect: ep.expect,
    }));

    // Reclassify tolerated 429 as non-error for the rate computation.
    const adj = results.map(r => (ep.tolerate429 && r.failType === FAIL.RATE_LIMITED)
      ? { ...r, ok: true } : r);
    const s = summarize(adj);
    s.concurrency = conc;
    s.payloadBytes = bytes;
    s.rate429 = results.filter(r => r.failType === FAIL.RATE_LIMITED).length / results.length;
    steps.push(s);

    const degraded = s.errorRate > ERROR_RATE_BREAK || s.p95 > P95_BREAK_MS;
    if (degraded && !breakingPoint) {
      breakingPoint = {
        concurrency: conc,
        payloadBytes: bytes,
        errorRate: s.errorRate,
        p95: s.p95,
        failCounts: s.failCounts,
        rate429: s.rate429,
      };
    }
    process.stdout.write(
      `    ${C.gray}ramp c=${String(conc).padStart(2)} size=${String(bytes).padStart(7)}B  ` +
      `p50=${String(s.p50).padStart(5)}ms p95=${String(s.p95).padStart(6)}ms  ` +
      `err=${(s.errorRate * 100).toFixed(0).padStart(3)}%  429=${(s.rate429 * 100).toFixed(0)}%${C.reset}\n`
    );
  }
  return { steps, breakingPoint };
}

async function chaosPass(base, ep) {
  if (ep.method !== 'POST') return { findings: [] }; // chaos targets POST bodies
  const findings = [];
  for (const c of CHAOS_BODIES) {
    const raw = typeof c.raw === 'function' ? c.raw() : c.raw;
    const r = await doRequest({
      url: base + ep.path, method: 'POST', body: raw,
      timeoutMs: ep.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    // GRACEFUL = server stayed up and answered with a 2xx or 4xx.
    // BAD = 5xx, timeout, connection refused/reset (crash suspect).
    const graceful = (r.status >= 200 && r.status < 500);
    findings.push({
      probe: c.label,
      status: r.status,
      failType: r.ok ? null : r.failType,
      latency: Math.round(r.latency),
      graceful,
      sample: (r.sample || '').slice(0, 120),
    });
    if (!graceful) {
      process.stdout.write(`    ${C.red}CHAOS HOLE${C.reset} ${ep.name} ⟵ "${c.label}" → ` +
        `${r.status || r.failType}\n`);
    }
  }
  return { findings };
}

// ── Health check a whole service ─────────────────────────────────────────────
async function healthCheck(svc) {
  const r = await doRequest({
    url: svc.base + svc.health.path,
    method: svc.health.method,
    timeoutMs: HEALTH_TIMEOUT_MS,
    expect: svc.health.expect,
  });
  return { up: r.ok, detail: r };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date();
  log(C.bold + '\n╔══════════════════════════════════════════════════════════════╗');
  log('║   KAI FLEET STRESS / CHAOS TEST  —  on-demand, live-safe       ║');
  log('╚══════════════════════════════════════════════════════════════╝' + C.reset);
  log(`${C.dim}target=${ARGS.target}  maxConcurrency=${ARGS.maxConcurrency}  ` +
      `dryRun=${ARGS.dryRun}  includeHeavy=${ARGS.includeHeavy}  includeWrites=${ARGS.includeWrites}${C.reset}`);
  log(`${C.dim}ramp steps: ${RAMP_STEPS.join(' → ')} concurrent${C.reset}`);

  const targets = ARGS.target === 'all'
    ? Object.keys(SERVICES)
    : Object.keys(SERVICES).filter(k => k === ARGS.target);

  if (targets.length === 0) {
    log(C.red + `Unknown --target "${ARGS.target}". Valid: ${Object.keys(SERVICES).join(', ')}, all` + C.reset);
    process.exit(2);
  }

  const report = {
    startedAt: startedAt.toISOString(),
    args: ARGS,
    services: {},
  };

  for (const key of targets) {
    const svc = SERVICES[key];
    hdr(`■ ${svc.label}  (${svc.base})`);

    if (ARGS.dryRun) {
      const plan = svc.endpoints.map(e => {
        const tag = e.heavy ? (ARGS.includeHeavy ? 'HEAVY' : 'HEAVY-skipped')
          : e.write ? (ARGS.includeWrites ? 'WRITE(test-region)' : 'WRITE-skipped')
          : 'safe';
        return `    [${tag}] ${e.name}  →  ${e.fn}`;
      });
      log(plan.join('\n'));
      report.services[key] = { label: svc.label, base: svc.base, dryRun: true, plan };
      continue;
    }

    // 1) HEALTH
    const health = await healthCheck(svc);
    if (!health.up) {
      const why = health.detail.failType || `status ${health.detail.status}`;
      log(`  ${C.yellow}DOWN / unreachable${C.reset} (${why}) — skipping cleanly.`);
      report.services[key] = {
        label: svc.label, base: svc.base, reachable: false,
        reason: why, sourceHint: svc.sourceHint,
      };
      continue;
    }
    log(`  ${C.green}reachable${C.reset} (health p=${Math.round(health.detail.latency)}ms)`);

    const svcReport = {
      label: svc.label, base: svc.base, reachable: true,
      sourceHint: svc.sourceHint, endpoints: [],
    };

    for (const ep of svc.endpoints) {
      // Gating
      if (ep.heavy && !ARGS.includeHeavy) {
        log(`  ${C.gray}— ${ep.name}: HEAVY, skipped (use --include-heavy)${C.reset}`);
        svcReport.endpoints.push({ name: ep.name, fn: ep.fn, skipped: 'heavy' });
        continue;
      }
      if (ep.write && !ARGS.includeWrites) {
        log(`  ${C.gray}— ${ep.name}: WRITE, skipped (use --include-writes)${C.reset}`);
        svcReport.endpoints.push({ name: ep.name, fn: ep.fn, skipped: 'write' });
        continue;
      }

      log(`  ${C.bold}▸ ${ep.name}${C.reset}  ${C.gray}${ep.fn}${C.reset}` +
          (ep.external ? `  ${C.yellow}(external dep)${C.reset}` : ''));

      // 2) NORMAL PASS
      const np = await normalPass(svc.base, ep);
      log(`    normal: ${np.pass ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset} ` +
          `status=${np.result.status || np.result.failType} ` +
          `${Math.round(np.result.latency)}ms`);

      // 3) RAMP PASS
      const ramp = await rampPass(svc.base, ep);
      if (ramp.breakingPoint) {
        log(`    ${C.yellow}breaking point${C.reset}: c=${ramp.breakingPoint.concurrency} ` +
            `size=${ramp.breakingPoint.payloadBytes}B ` +
            `err=${(ramp.breakingPoint.errorRate * 100).toFixed(0)}% ` +
            `p95=${ramp.breakingPoint.p95}ms`);
      } else {
        log(`    ${C.green}no breaking point${C.reset} within ramp (max c=${RAMP_STEPS[RAMP_STEPS.length - 1]})`);
      }

      // 4) CHAOS PASS
      const chaos = await chaosPass(svc.base, ep);
      const holes = chaos.findings.filter(f => !f.graceful);
      if (chaos.findings.length) {
        log(`    chaos: ${holes.length ? C.red + holes.length + ' hole(s)' : C.green + 'all graceful'}${C.reset} ` +
            `${C.gray}(${chaos.findings.length} probes)${C.reset}`);
      }

      svcReport.endpoints.push({
        name: ep.name,
        fn: ep.fn,
        flags: { heavy: !!ep.heavy, write: !!ep.write, external: !!ep.external },
        normal: {
          pass: np.pass,
          status: np.result.status,
          failType: np.result.failType || null,
          latencyMs: Math.round(np.result.latency),
          sample: (np.result.sample || '').slice(0, 160),
        },
        ramp: ramp.steps,
        breakingPoint: ramp.breakingPoint,
        chaos: chaos.findings,
      });
    }

    report.services[key] = svcReport;
  }

  report.finishedAt = new Date().toISOString();

  // ── Build prioritized fix list ─────────────────────────────────────────────
  const fixes = buildFixList(report);
  report.fixes = fixes;

  // ── Write markdown + print summary ─────────────────────────────────────────
  const md = renderMarkdown(report);
  try {
    writeFileSync(REPORT_PATH, md, 'utf8');
    log(`\n${C.green}report written:${C.reset} ${REPORT_PATH}`);
  } catch (e) {
    log(`\n${C.red}could not write report:${C.reset} ${e.message}`);
  }

  printSummary(report);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prioritized fix list — derive "what to fix/reinforce" from findings.
// ─────────────────────────────────────────────────────────────────────────────
function buildFixList(report) {
  const fixes = [];
  for (const [key, svc] of Object.entries(report.services)) {
    if (svc.dryRun) continue;
    if (svc.reachable === false) {
      fixes.push({
        severity: 'INFO',
        where: svc.label,
        fn: svc.sourceHint,
        issue: `Service unreachable at run time (${svc.reason}). If it should be up, check the launcher / process.`,
      });
      continue;
    }
    for (const ep of svc.endpoints || []) {
      if (ep.skipped) continue;
      // Normal-pass failures = highest priority (basic function broken).
      if (ep.normal && !ep.normal.pass) {
        fixes.push({
          severity: 'HIGH',
          where: `${svc.label} ${ep.name}`,
          fn: ep.fn,
          issue: `Normal-use call failed (status=${ep.normal.status || ep.normal.failType}). ` +
                 `Basic function does not respond correctly under normal payload.`,
        });
      }
      // Chaos holes = unhandled error / crash suspect.
      const holes = (ep.chaos || []).filter(f => !f.graceful);
      for (const h of holes) {
        fixes.push({
          severity: h.failType === FAIL.CRASH_SUSPECT || h.failType === FAIL.TIMEOUT ? 'HIGH' : 'MEDIUM',
          where: `${svc.label} ${ep.name}`,
          fn: ep.fn,
          issue: `Chaos probe "${h.probe}" → ${h.status || h.failType}. ` +
                 `Add input validation / size cap so malformed input returns 4xx, not ${h.failType || '5xx'}.`,
        });
      }
      // Breaking point = capacity ceiling to reinforce.
      if (ep.breakingPoint) {
        const bp = ep.breakingPoint;
        const dominant = Object.entries(bp.failCounts || {}).sort((a, b) => b[1] - a[1])[0];
        fixes.push({
          severity: 'MEDIUM',
          where: `${svc.label} ${ep.name}`,
          fn: ep.fn,
          issue: `Degrades at concurrency=${bp.concurrency}, payload=${bp.payloadBytes}B ` +
                 `(err=${(bp.errorRate * 100).toFixed(0)}%, p95=${bp.p95}ms` +
                 (dominant ? `, mostly ${dominant[0]}` : '') + `). ` +
                 `Reinforce: backpressure / timeout / queue here.`,
        });
      }
    }
  }
  const order = { HIGH: 0, MEDIUM: 1, INFO: 2, LOW: 3 };
  fixes.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return fixes;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Markdown report
// ─────────────────────────────────────────────────────────────────────────────
function renderMarkdown(report) {
  const L = [];
  L.push('# KAI Fleet Stress / Chaos Report');
  L.push('');
  L.push(`- **Run:** ${report.startedAt} → ${report.finishedAt}`);
  L.push(`- **Flags:** target=\`${report.args.target}\`, maxConcurrency=${report.args.maxConcurrency}, ` +
         `includeHeavy=${report.args.includeHeavy}, includeWrites=${report.args.includeWrites}`);
  L.push(`- **Ramp steps:** ${RAMP_STEPS.join(' → ')} concurrent; payloads 200B → 100KB; ` +
         `breaking-point thresholds: errorRate>${ERROR_RATE_BREAK * 100}% or p95>${P95_BREAK_MS}ms`);
  L.push('');

  // Prioritized fixes first — the headline.
  L.push('## What to fix / reinforce (prioritized)');
  L.push('');
  if (!report.fixes.length) {
    L.push('_No issues found in this run. Every reachable endpoint answered normally, survived chaos, and held through the ramp._');
  } else {
    L.push('| # | Severity | Where | Function (file) | Issue |');
    L.push('|---|----------|-------|-----------------|-------|');
    report.fixes.forEach((f, i) => {
      L.push(`| ${i + 1} | **${f.severity}** | ${f.where} | \`${f.fn}\` | ${f.issue} |`);
    });
  }
  L.push('');

  // Per-service detail.
  for (const [key, svc] of Object.entries(report.services)) {
    L.push(`## ${svc.label}  \`${svc.base}\``);
    if (svc.dryRun) {
      L.push('');
      L.push('_Dry run — planned probes only, no traffic sent:_');
      L.push('');
      svc.plan.forEach(p => L.push('- ' + p.trim()));
      L.push('');
      continue;
    }
    if (svc.reachable === false) {
      L.push('');
      L.push(`**UNREACHABLE** — ${svc.reason}. Skipped. Source: \`${svc.sourceHint}\``);
      L.push('');
      continue;
    }
    L.push('');
    L.push(`Source: \`${svc.sourceHint}\``);
    L.push('');
    for (const ep of svc.endpoints) {
      L.push(`### ${ep.name}`);
      L.push(`- Handler: \`${ep.fn}\``);
      if (ep.skipped) { L.push(`- _Skipped (${ep.skipped}); enable with --include-${ep.skipped}._`); L.push(''); continue; }
      // Normal
      const n = ep.normal;
      L.push(`- **Normal:** ${n.pass ? 'PASS' : 'FAIL'} — status ${n.status || n.failType}, ${n.latencyMs}ms`);
      // Ramp table
      if (ep.ramp && ep.ramp.length) {
        L.push('- **Ramp:**');
        L.push('');
        L.push('  | concurrency | payload | p50 | p95 | p99 | err% | 429% |');
        L.push('  |---|---|---|---|---|---|---|');
        for (const s of ep.ramp) {
          L.push(`  | ${s.concurrency} | ${s.payloadBytes}B | ${s.p50}ms | ${s.p95}ms | ${s.p99}ms | ` +
                 `${(s.errorRate * 100).toFixed(0)}% | ${(s.rate429 * 100).toFixed(0)}% |`);
        }
        L.push('');
      }
      if (ep.breakingPoint) {
        const bp = ep.breakingPoint;
        L.push(`- **Breaking point:** concurrency=${bp.concurrency}, payload=${bp.payloadBytes}B, ` +
               `err=${(bp.errorRate * 100).toFixed(0)}%, p95=${bp.p95}ms` +
               (Object.keys(bp.failCounts || {}).length ? `, fails: ${JSON.stringify(bp.failCounts)}` : ''));
      } else {
        L.push(`- **Breaking point:** none within ramp ceiling.`);
      }
      // Chaos
      if (ep.chaos && ep.chaos.length) {
        const holes = ep.chaos.filter(f => !f.graceful);
        L.push(`- **Chaos:** ${ep.chaos.length} probes, ${holes.length} hole(s).`);
        if (holes.length) {
          L.push('');
          L.push('  | probe | result | type |');
          L.push('  |---|---|---|');
          for (const h of holes) {
            L.push(`  | ${h.probe} | ${h.status || '—'} | ${h.failType || 'non-graceful'} |`);
          }
          L.push('');
        }
      }
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('### Failure-type legend');
  L.push('- `timeout` — no response within the endpoint timeout.');
  L.push('- `connection-refused` — nothing listening (service died / never up).');
  L.push('- `crash-suspect` — socket reset/hang-up mid-flight (possible handler panic / dropped connection).');
  L.push('- `server-5xx` — handler returned 500-class (unhandled internal error).');
  L.push('- `client-4xx` — 400-class; EXPECTED for chaos/malformed probes (graceful rejection).');
  L.push('- `rate-limited-429` — designed admission brake (e.g. QueryAdmission on /api/rshl/query). Healthy.');
  L.push('- `unexpected-response-shape` — 2xx but body did not match expected contract.');
  L.push('');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Console summary
// ─────────────────────────────────────────────────────────────────────────────
function printSummary(report) {
  hdr('═══ SUMMARY ═══');
  for (const [key, svc] of Object.entries(report.services)) {
    if (svc.dryRun) { log(`  ${svc.label}: ${C.gray}dry-run planned${C.reset}`); continue; }
    if (svc.reachable === false) { log(`  ${svc.label}: ${C.yellow}DOWN${C.reset} (${svc.reason})`); continue; }
    const eps = (svc.endpoints || []).filter(e => !e.skipped);
    const normalFails = eps.filter(e => e.normal && !e.normal.pass).length;
    const withBP = eps.filter(e => e.breakingPoint).length;
    const holes = eps.reduce((acc, e) => acc + (e.chaos || []).filter(f => !f.graceful).length, 0);
    log(`  ${C.bold}${svc.label}${C.reset}: ${eps.length} endpoints tested, ` +
        `${normalFails ? C.red : C.green}${normalFails} normal-fail${C.reset}, ` +
        `${withBP} hit a breaking point, ` +
        `${holes ? C.red : C.green}${holes} chaos hole(s)${C.reset}`);
  }

  hdr('═══ TOP FIXES ═══');
  if (!report.fixes.length) {
    log(`  ${C.green}No issues found. System held up across normal, ramp, and chaos.${C.reset}`);
  } else {
    report.fixes.slice(0, 12).forEach((f, i) => {
      const col = f.severity === 'HIGH' ? C.red : f.severity === 'MEDIUM' ? C.yellow : C.gray;
      log(`  ${col}${String(i + 1).padStart(2)}. [${f.severity}]${C.reset} ${f.where}`);
      log(`      ${C.gray}${f.fn}${C.reset}`);
      log(`      ${f.issue}`);
    });
    if (report.fixes.length > 12) log(`  ${C.gray}…and ${report.fixes.length - 12} more in stress-report.md${C.reset}`);
  }
  log('');
}

// ── entry ────────────────────────────────────────────────────────────────────
main().catch(err => {
  // Last-resort guard — the harness itself must never crash the run.
  console.error(C.red + 'Harness fatal (unexpected): ' + (err && err.stack || err) + C.reset);
  process.exit(1);
});
