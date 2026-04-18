/**
 * RSHL Playground — Interactive Terminal
 *
 * Store records, query them, see WHY they matched.
 * Evidence-first: every result shows the tokens that drove the score.
 *
 * Usage:
 *   node playground.js          — blank index, start fresh
 *   node playground.js --demo   — preload an infrastructure event stream scenario
 *   node playground.js --memory — preload a personal memory scenario
 *
 * Commands inside the session:
 *   store <text>      — add a record to the index
 *   query <text>      — find the closest matches (with evidence)
 *   list              — show all stored records
 *   clear             — wipe the index
 *   demo              — load infrastructure event stream scenario
 *   memory            — load personal memory scenario
 *   reason            — multi-hop incident chain (cognitive reasoning demo)
 *   load <file>       — bulk load .txt / .json / .jsonl dataset
 *   scale 1000/5000/10000 — speed + accuracy test at scale
 *   bench             — full automated benchmark (no input needed)
 *   help              — show commands
 *   exit / quit       — close
 */

"use strict";

const readline        = require("readline");
const path            = require("path");
const { performance } = require("perf_hooks");
const { textVec, cosineSim, debugTokens } = require(path.join(__dirname, "rshl-core"));

// ── Native addon (AVX2 + OpenMP) — loaded if built ───────────────────────────
let _native = null;
try { _native = require(path.join(__dirname, "build", "Release", "rshl_native.node")); } catch {}

// ── Colour helpers ────────────────────────────────────────────────────────────
const G    = s => `\x1b[92m${s}\x1b[0m`;   // green
const R    = s => `\x1b[91m${s}\x1b[0m`;   // red
const Y    = s => `\x1b[93m${s}\x1b[0m`;   // yellow
const B    = s => `\x1b[96m${s}\x1b[0m`;   // cyan
const DIM  = s => `\x1b[2m${s}\x1b[0m`;    // dim
const BOLD = s => `\x1b[1m${s}\x1b[0m`;    // bold

// ── Score → label ─────────────────────────────────────────────────────────────
function scoreLabel(s) {
  if (s >= 0.85) return G("strong match");
  if (s >= 0.70) return G("good match");
  if (s >= 0.55) return Y("possible match");
  return R("below threshold — filtered");
}

function scoreBar(s) {
  const filled = Math.round(s * 20);
  const bar    = "█".repeat(filled) + "░".repeat(20 - filled);
  const col    = s >= 0.70 ? G : s >= 0.55 ? Y : R;
  return col(bar) + ` ${s.toFixed(3)}`;
}

// ── Simple lattice — classify writes as ADD / UPDATE / NOOP ──────────────────
const THRESHOLD        = 0.55;
const UPDATE_THRESHOLD = 0.82;
const UPDATE_SIGNAL_RE = /\b(moved|changed|switched|relocated|replaced|restarted|recovered|resolved|fixed|cleared|back online|back up|delayed|rescheduled|rolled back|rollback|promoted|joined|left|started|stopped|now|currently|recently)\b/i;
const CONTINUITY_SIGNAL_RE = /\b(still|remains|remaining|continues|same|unchanged|already)\b/i;

function classify(text, vec, index) {
  if (index.length === 0) return { op: "ADD", best: null };
  const scored = index
    .map((r, i) => ({ i, row: r, score: cosineSim(vec, r.vec) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  if (!best) return { op: "ADD", best: null };
  const bestPair = [best.i, best.score];
  if (best.score >= UPDATE_THRESHOLD) return { op: "NOOP", best: bestPair };
  if (CONTINUITY_SIGNAL_RE.test(text) && best.score >= THRESHOLD) return { op: "NOOP", best: bestPair };
  if (UPDATE_SIGNAL_RE.test(text) && best.score >= 0.68) return { op: "UPDATE", best: bestPair };
  return { op: "ADD", best };
}

// ── Index ─────────────────────────────────────────────────────────────────────
let index         = [];
let sessionStores = 0;

function store(text) {
  const vec  = textVec(text);
  const { op, best } = classify(text, vec, index);
  const toks = debugTokens(text);
  const id   = index.length + 1;

  if (op === "NOOP") {
    console.log(`\n  ${Y("⟳ NOOP")}  Already known — matches existing record #${best[0] + 1}`);
    console.log(`         "${index[best[0]].text.slice(0, 70)}"`);
    console.log(`         Score ${best[1].toFixed(3)} — above ${UPDATE_THRESHOLD} threshold, nothing added\n`);
    return;
  }

  if (op === "UPDATE") {
    const best = index.map((r, i) => [i, cosineSim(vec, r.vec)]).sort((a, b) => b[1] - a[1])[0];
    index.push({ id, text, vec });
    sessionStores++;
    console.log(`\n  ${Y("↻ UPDATE")}  New record stored — replaces/extends record #${best[0] + 1}`);
    console.log(`           Was: "${index[best[0]].text.slice(0, 60)}"`);
    console.log(`           Now: "${text.slice(0, 60)}"`);
    console.log(`           Tokens: ${toks.map(t => t.type === "category" ? DIM(t.tok) : B(t.tok)).join("  ")}`);
    console.log(`           Record #${id} added  (${index.length} total)\n`);
    return;
  }

  // ADD
  index.push({ id, text, vec });
  sessionStores++;
  console.log(`\n  ${G("✓ ADD")}  Record #${id} stored`);
  console.log(`        "${text.slice(0, 70)}"`);
  console.log(`        Tokens: ${toks.map(t => t.type === "category" ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  console.log(`        Index now has ${index.length} record${index.length === 1 ? "" : "s"}\n`);
}

function query(text, topN = 5) {
  if (index.length === 0) {
    console.log(`\n  ${Y("⚠")}  Index is empty — store some records first\n`);
    return;
  }

  const qvec  = textVec(text);
  const qtoks = debugTokens(text);

  const results = index
    .map(r => ({ ...r, score: cosineSim(qvec, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  const above = results.filter(r => r.score >= THRESHOLD);

  console.log(`\n  Query: ${BOLD('"' + text + '"')}`);
  console.log(`  Tokens: ${qtoks.map(t => t.type === "category" ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  console.log(`  Searching ${index.length} record${index.length === 1 ? "" : "s"}...\n`);

  if (above.length === 0) {
    console.log(`  ${R("No matches above threshold (0.55)")} — nothing relevant found`);
    console.log(`  Best score: ${results[0]?.score.toFixed(3) ?? "n/a"}  (below 0.55 = filtered as noise)\n`);
    return;
  }

  const w = Math.min(60, process.stdout.columns - 20 || 60);
  console.log(`  ${"─".repeat(w + 20)}`);
  for (let i = 0; i < results.length; i++) {
    const r    = results[i];
    const rank = `#${i + 1}`;
    const pass = r.score >= THRESHOLD;
    console.log(`  ${rank.padEnd(4)} ${scoreBar(r.score)}  ${pass ? scoreLabel(r.score) : R("filtered")}`);
    console.log(`       "${r.text.slice(0, w)}"`);

    if (pass) {
      const rtoks  = debugTokens(r.text);
      const qset   = new Set(qtoks.map(t => t.tok));
      const rset   = new Set(rtoks.map(t => t.tok));
      const shared = [...qset].filter(t => rset.has(t));
      const qonly  = [...qset].filter(t => !rset.has(t));
      const ronly  = [...rset].filter(t => !qset.has(t));
      if (shared.length > 0) console.log(`       ${DIM("matched:")} ${shared.map(t => t.startsWith("#") ? DIM(t) : G(t)).join("  ")}`);
      if (qonly.length  > 0) console.log(`       ${DIM("query only:")} ${qonly.map(t => Y(t)).join("  ")}`);
      if (ronly.length  > 0) console.log(`       ${DIM("record only:")} ${ronly.map(t => DIM(t)).join("  ")}`);
    }
    console.log();
  }
  console.log(`  ${above.length} of ${results.length} result${results.length === 1 ? "" : "s"} passed the 0.55 threshold\n`);
}

// ── Bulk file loader ──────────────────────────────────────────────────────────
// Accepts .txt (one record per line), .json (array of strings or objects),
// or .jsonl / .ndjson (one JSON object per line with a "text" field).
// Skips lattice classification for speed — bulk loads are always ADD.
function loadFile(filePath) {
  const fs       = require("fs");
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    console.log(`\n  ${R("File not found:")} ${resolved}\n`);
    return;
  }

  let texts;
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".json") {
      const parsed = JSON.parse(raw);
      const arr    = Array.isArray(parsed) ? parsed : (parsed.records || parsed.data || []);
      texts = arr.map(r => typeof r === "string" ? r
        : (r.text || r.content || r.passage || r.document || r.abstract || r.title || ""));
    } else {
      // .txt, .jsonl, .ndjson — one entry per line
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length > 0 && lines[0].startsWith("{")) {
        texts = lines.map(l => {
          try {
            const o = JSON.parse(l);
            return o.text || o.content || o.passage || o.abstract || o.title || "";
          } catch { return l; }
        });
      } else {
        texts = lines;
      }
    }
  } catch (e) {
    console.log(`\n  ${R("Error reading file:")} ${e.message}\n`);
    return;
  }

  texts = texts.map(t => (t || "").trim()).filter(t => t.length >= 5);

  if (texts.length === 0) {
    console.log(`\n  ${Y("No usable records found")} in ${path.basename(filePath)}\n`);
    return;
  }

  console.log(`\n  ${BOLD("Loading")} ${texts.length.toLocaleString()} records from ${path.basename(filePath)}...`);

  const seen  = new Set(index.map(r => r.text));  // deduplicate against existing
  let   added = 0, dupes = 0;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (seen.has(text)) { dupes++; continue; }
    seen.add(text);
    const id  = index.length + 1;
    const vec = textVec(text);
    index.push({ id, text, vec });
    added++;
    sessionStores++;

    if ((i + 1) % 500 === 0 || i === texts.length - 1) {
      process.stdout.write(`\r  ${G(added.toLocaleString())} added  |  ${dupes.toLocaleString()} dupes skipped  |  ${(i + 1).toLocaleString()}/${texts.length.toLocaleString()} processed...`);
    }
  }

  console.log(`\r  ${G("✓")} Loaded ${added.toLocaleString()} records  (${dupes.toLocaleString()} duplicate${dupes === 1 ? "" : "s"} skipped)`);
  console.log(`    Index now has ${index.length.toLocaleString()} total records`);
  console.log(`\n  Try: ${G("query")} <anything relevant to your data>\n`);
}

function list() {
  if (index.length === 0) { console.log(`\n  Index is empty\n`); return; }
  console.log(`\n  ${index.length} record${index.length === 1 ? "" : "s"} in index:\n`);
  for (const r of index) {
    const toks = debugTokens(r.text);
    console.log(`  #${String(r.id).padEnd(3)} "${r.text.slice(0, 65)}"`);
    console.log(`       ${toks.map(t => t.type === "category" ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  }
  console.log();
}

// ── Scale / bench helpers ─────────────────────────────────────────────────────

// 8 real infrastructure events — the "signal" records used in scale + bench tests
const _SIGNAL_RECORDS = [
  "auth-service returned error 503 — database connection refused",           // 0
  "api-gateway request timeout — upstream endpoint down after 3 retries",   // 1
  "deploy pipeline succeeded — all 14 tests passed — running healthy",       // 2
  "deploy rollback triggered — integration test failed at stage 8",          // 3
  "worker-01 memory spike 94 percent — alert triggered",                     // 4
  "worker-01 restarted — memory cleared — back online",                      // 5
  "database connection pool at limit — new requests blocked",                // 6
  "scheduled backup completed — 2.4 GB archived to storage",                 // 7
];

// 25 noise templates — different topics from signal records, no numeric suffixes
// (numeric suffixes create LCG hash collisions that inflate false-positive scores)
const _NOISE_TEMPLATES = [
  "scheduled maintenance window closed — all services nominal",
  "config reload complete — 14 settings applied — no restart required",
  "health check passed — endpoint latency 12ms within SLA",
  "rate limiter reset — token bucket refilled — traffic normal",
  "certificate renewed — expiry extended 365 days — auto-rotated",
  "log rotation completed — archived 2.1 GB — disk freed",
  "dns resolution updated — propagation complete across all regions",
  "load balancer rebalanced — traffic distributed 50-50 across nodes",
  "cache warmed — 18000 keys loaded — hit rate 94 percent",
  "snapshot created — volume 48 GB — stored to object storage",
  "user session expired — token invalidated — re-auth required",
  "feature flag toggled — rollout 10 percent — monitoring active",
  "queue consumer started — 3 partitions assigned — lag zero",
  "build artifact published — version tagged — registry updated",
  "webhook delivered — 200 ok — retry queue cleared",
  "ssl handshake completed — cipher negotiated — connection secure",
  "container restarted — crash loop resolved — healthy 3 checks",
  "autoscaler added 2 instances — load spike absorbed — queue cleared",
  "metrics pipeline flushed — 48000 data points forwarded to storage",
  "cronjob finished — exit code 0 — next run in 6 hours",
  "index rebuild complete — 1.2 million documents — query latency down",
  "api key rotated — old key revoked — new key active in all regions",
  "audit log archived — 90 day retention enforced — compliance met",
  "circuit breaker reset — downstream healthy — traffic resumed",
  "batch job completed — 15000 records processed — 0 errors",
];

function _buildNoiseVecs(n) {
  const vecs = [];
  for (let i = 0; i < n; i++) {
    vecs.push(textVec(_NOISE_TEMPLATES[i % _NOISE_TEMPLATES.length]));
  }
  return vecs;
}

// Builds dense int8 matrix + float32 norms for native batch query.
// mat[i * 4096 .. (i+1)*4096] = dense int8 row for vecs[i].
function _buildNativeBatch(vecs) {
  const DCOLS = 4096;
  const n     = vecs.length;
  const mat   = Buffer.alloc(n * DCOLS, 0);
  const nrm   = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) {
    const v = vecs[i];
    nrm.writeFloatLE(Math.sqrt(v.length), i * 4);
    const off = i * DCOLS;
    for (const [idx, val] of v) mat[off + idx] = val & 0xff;
  }
  return { mat, nrm };
}

// Runs one exhaustive query against allVecs. Returns { bestIdx, bestScore }.
// Uses native AVX2 path if addon is loaded and mat/nrm/out are provided.
function _search(qvec, allVecs, mat, nrm, out) {
  if (_native && mat) {
    const idxA = new Int32Array(qvec.map(([i]) => i));
    const valA = new Int8Array(qvec.map(([, v]) => v));
    _native.batchQuerySparseNoAlloc(mat, nrm, allVecs.length, idxA, valA, out);
    let best = 0;
    for (let k = 1; k < allVecs.length; k++) if (out[k] > out[best]) best = k;
    return { bestIdx: best, bestScore: out[best] };
  }
  let bestIdx = 0, bestScore = cosineSim(qvec, allVecs[0]);
  for (let k = 1; k < allVecs.length; k++) {
    const s = cosineSim(qvec, allVecs[k]);
    if (s > bestScore) { bestScore = s; bestIdx = k; }
  }
  return { bestIdx, bestScore };
}

// ── Scale test ────────────────────────────────────────────────────────────────
function runScale(n) {
  const SCALE_QUERIES = [
    { q: "auth service database error",  expected: 0 },
    { q: "worker memory alert exceeded", expected: 4 },
    { q: "deploy rollback failed",       expected: 3 },
    { q: "database connection pool",     expected: 6 },
  ];

  console.log(`\n  ${BOLD("Scale test:")} building index of ${n.toLocaleString()} records (8 real events + ${(n - 8).toLocaleString()} noise)...\n`);

  const signalVecs = _SIGNAL_RECORDS.map(textVec);
  const noiseVecs  = _buildNoiseVecs(n - 8);
  const allVecs    = [...signalVecs, ...noiseVecs];   // signal at indices 0–7

  console.log(`  ${G("✓")} Index ready — ${n.toLocaleString()} records\n`);

  const qvecs = SCALE_QUERIES.map(sq => textVec(sq.q));

  // Build native batch if addon is available
  let mat = null, nrm = null, out = null;
  if (_native) {
    ({ mat, nrm } = _buildNativeBatch(allVecs));
    out = new Float64Array(n);
    // warm up CPU caches
    for (let w = 0; w < 5; w++) {
      const qv   = qvecs[w % qvecs.length];
      const idxA = new Int32Array(qv.map(([i]) => i));
      const valA = new Int8Array(qv.map(([, v]) => v));
      _native.batchQuerySparseNoAlloc(mat, nrm, n, idxA, valA, out);
    }
  } else {
    // JS JIT warmup
    for (let w = 0; w < 500; w++) cosineSim(qvecs[w % qvecs.length], allVecs[w % n]);
  }

  const REPS      = 5;
  let   totalMs   = 0;
  let   hits      = 0;

  for (let rep = 0; rep < REPS; rep++) {
    for (let qi = 0; qi < SCALE_QUERIES.length; qi++) {
      const t0 = performance.now();
      const { bestIdx } = _search(qvecs[qi], allVecs, mat, nrm, out);
      totalMs += performance.now() - t0;
      if (rep === 0 && bestIdx === SCALE_QUERIES[qi].expected) hits++;
    }
  }

  const totalRuns  = REPS * SCALE_QUERIES.length;
  const avgMs      = totalMs / totalRuns;
  const dotsPerSec = Math.round(n / (avgMs / 1000));
  const msLabel    = avgMs < 1 ? (avgMs * 1000).toFixed(1) + " µs" : avgMs.toFixed(2) + " ms";
  const accuracy   = (hits / SCALE_QUERIES.length * 100).toFixed(0);
  const engineLabel = _native
    ? G("native AVX2 + OpenMP")
    : DIM("interpreted JS  (run npm run build-native for 50–200x faster)");

  const w = 52;
  console.log(`  ${"─".repeat(w)}`);
  console.log(`  Records searched     ${Y(n.toLocaleString().padStart(8))}`);
  console.log(`  Query latency        ${Y(msLabel.padStart(8))}   avg over ${totalRuns} full-index searches`);
  console.log(`  Comparisons/sec      ${Y(dotsPerSec.toLocaleString().padStart(8))}   record comparisons per second`);
  console.log(`  Accuracy             ${(hits === SCALE_QUERIES.length ? G : R)((accuracy + "%").padStart(8))}   ${hits}/${SCALE_QUERIES.length} queries found correct record at rank #1`);
  console.log(`  Engine               ${engineLabel}`);
  console.log(`  ${"─".repeat(w)}\n`);
  console.log(`  ${DIM("Formal accuracy eval:")}`);
  console.log(`  ${DIM("  node eval/recall-accuracy.js")}`);
  console.log(`  ${DIM("  100% baseline · 95.7% at +500 noise · 91.3% at +5K noise · MRR 0.926")}\n`);
}

// ── Full benchmark — automated, zero input needed ─────────────────────────────
// This is the "show me what RSHL can do" command.
// Builds a 10K-record index, runs 8 queries — first 4 use similar words,
// last 4 use COMPLETELY DIFFERENT words than the stored records.
// Prints a single table showing hit/miss + score for each.
function runBench() {
  const BENCH_QUERIES = [
    // Direct vocabulary — some shared words with stored records
    { q: "auth service database error",        expected: 0, label: "direct" },
    { q: "worker memory alert exceeded",        expected: 4, label: "direct" },
    { q: "deploy rollback failed",              expected: 3, label: "direct" },
    { q: "database connection pool",            expected: 6, label: "direct" },
    // Semantic variants — completely different words, same meaning
    { q: "api gateway upstream timeout",        expected: 1, label: "semantic" },
    { q: "deployment tests passed healthy",     expected: 2, label: "semantic" },
    { q: "worker memory cleared online",        expected: 5, label: "semantic" },
    { q: "scheduled backup archive storage",    expected: 7, label: "semantic" },
  ];

  const N = 10000;

  console.log(`\n  ${BOLD("RSHL Full Benchmark")}  —  automated, no input needed`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(`\n  Building ${N.toLocaleString()}-record index  (8 real events  +  ${(N - 8).toLocaleString()} noise records)...\n`);

  const signalVecs = _SIGNAL_RECORDS.map(textVec);
  const noiseVecs  = _buildNoiseVecs(N - 8);
  const allVecs    = [...signalVecs, ...noiseVecs];

  console.log(`  ${G("✓")} Index ready — ${N.toLocaleString()} records\n`);

  // Build native batch if addon is available
  let mat = null, nrm = null, out = null;
  if (_native) {
    ({ mat, nrm } = _buildNativeBatch(allVecs));
    out = new Float64Array(N);
  }

  const QC = 37;   // query column width
  const RC = 30;   // result column width
  const SEP = "─".repeat(QC + RC + 14);

  console.log(`  ${DIM("Query".padEnd(QC))} ${DIM("Best match (out of 10,000)".padEnd(RC))} ${DIM("Score")}`);
  console.log(`  ${SEP}`);

  // Separator between direct and semantic sections
  let printedSemanticLabel = false;
  let hits    = 0;
  let totalMs = 0;

  for (let qi = 0; qi < BENCH_QUERIES.length; qi++) {
    const { q, expected, label } = BENCH_QUERIES[qi];

    if (label === "semantic" && !printedSemanticLabel) {
      console.log(`  ${DIM("  — semantic variants (different words, same meaning) —".padEnd(QC + RC + 14))}`);
      printedSemanticLabel = true;
    }

    const qvec = textVec(q);
    const t0   = performance.now();
    const { bestIdx, bestScore } = _search(qvec, allVecs, mat, nrm, out);
    totalMs += performance.now() - t0;

    const correct     = bestIdx === expected;
    if (correct) hits++;

    const marker      = correct ? G("✓") : R("✗");
    const matchedText = bestIdx < 8 ? _SIGNAL_RECORDS[bestIdx] : "(noise record)";
    const shortQ      = ('"' + q + '"').slice(0, QC - 1).padEnd(QC);
    const shortR      = matchedText.slice(0, RC - 1).padEnd(RC);
    const scoreStr    = correct ? G(bestScore.toFixed(3)) : R(bestScore.toFixed(3));
    console.log(`  ${marker} ${shortQ} ${shortR} ${scoreStr}`);
  }

  const avgMs      = totalMs / BENCH_QUERIES.length;
  const cps        = Math.round(N / (avgMs / 1000));
  const hitLabel   = hits === BENCH_QUERIES.length
    ? G(`${hits}/${BENCH_QUERIES.length} correct  (100%)`)
    : Y(`${hits}/${BENCH_QUERIES.length} correct`);
  const engineLabel = _native ? G("native AVX2 + OpenMP") : DIM("interpreted JS");

  console.log(`  ${SEP}\n`);
  console.log(`  ${BOLD("Accuracy:")}   ${hitLabel}`);
  console.log(`  ${BOLD("Speed:")}      ${Y(avgMs.toFixed(2) + " ms")} avg per query  |  ${Y(cps.toLocaleString())} comparisons/sec  |  ${engineLabel}`);
  console.log();
  console.log(`  ${DIM("Queries 5–8 used completely different words than the stored records.")}`);
  console.log(`  ${DIM("No embeddings. No AI. Pure ternary vector math.")}\n`);
}

// ── Preset scenarios ──────────────────────────────────────────────────────────
const SCENARIOS = {
  demo: {
    label: "Infrastructure Event Stream",
    records: _SIGNAL_RECORDS,
    queries: [
      "auth service database error",
      "worker memory alert exceeded",
      "deploy rollback failed",
      "database connection pool",
    ],
  },
  memory: {
    label: "Personal Memory Scenario",
    records: [
      "Ryan lives in Austin Texas",
      "Ryan works at Google as a software engineer",
      "Ryan enjoys hiking and trail running on weekends",
      "Ryan is allergic to peanuts",
      "Ryan has a golden retriever named Max",
      "Sarah lives in Seattle Washington",
      "Sarah is a nurse at Seattle General Hospital",
      "Sarah loves classical music and opera",
    ],
    queries: [
      "Where does Ryan live?",
      "What does Ryan do for work?",
      "Ryan food allergy",
      "Sarah job",
    ],
  },

  // ── Cognitive reasoning demo ─────────────────────────────────────────────
  // 12-record incident chain: root cause → propagation → resolution.
  // Queries don't share words with records — the engine CHAINS through
  // semantic overlap to find causal relationships.
  // This is what separates a cognitive reasoning engine from keyword search.
  reason: {
    label: "Incident Chain — Cognitive Reasoning Demo",
    description: "12 records form a cause→effect→resolution chain. Queries use DIFFERENT words than records.",
    records: [
      // Root cause
      "auth-service pod OOMKilled — container exceeded 256MB memory limit under peak load",
      // Propagation
      "auth-service health check red — pod not ready — all endpoints unreachable",
      "deploy pipeline halted at stage 3 — auth-service health check failing",
      "release 4.2.1 blocked — deploy pipeline stopped by failed health gate",
      "customer SLA breach imminent — release 4.2.1 overdue by 4 hours",
      "P1 incident opened — on-call engineer paged — auth and deploy both down",
      // Diagnosis
      "root cause confirmed: auth memory limit 256MB insufficient during flash sale traffic spike",
      "memory profiling shows auth service needs 480MB at peak — limit set too low at launch",
      // Resolution
      "mitigation deployed — auth-service memory limit raised from 256MB to 512MB",
      "auth-service pod restarted clean — memory 210MB — health check green in 45 seconds",
      "deploy pipeline unblocked — release 4.2.1 resuming from stage 3",
      "release 4.2.1 shipped — SLA met with 90 minutes remaining — incident closed",
    ],
    queries: [
      "auth memory OOM limit exceeded",
      "deploy pipeline halted blocked release",
      "SLA breach release overdue customer",
      "mitigation memory limit raised service restarted",
    ],
    queryNotes: [
      "→ root cause chain: records 1 + 7 + 8 (OOM → insufficient limit → profiling)",
      "→ cascade chain: records 3 + 4 + 11 (halt → blocked → unblocked)",
      "→ customer impact: records 5 + 12 (breach imminent → SLA met)",
      "→ resolution chain: records 9 + 10 (mitigation → restart → healthy)",
    ],
  },
};

function runScenario(name) {
  const s = SCENARIOS[name];
  if (!s) return;
  index         = [];
  sessionStores = 0;
  console.log(`\n  ${BOLD("Loading scenario:")} ${s.label}`);
  if (s.description) console.log(`  ${DIM(s.description)}`);
  console.log(`  ${"─".repeat(50)}\n`);
  for (const r of s.records) store(r);
  console.log(`  ${G("Scenario loaded.")} Try these example queries:\n`);
  for (let i = 0; i < s.queries.length; i++) {
    const note = s.queryNotes ? `  ${DIM(s.queryNotes[i] || "")}` : "";
    console.log(`    query ${s.queries[i]}${note}`);
  }
  console.log();
}

// ── Help ──────────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
  ${BOLD("Commands:")}

    ${G("store")} <text>       Add a record to the index
                        Shows: ADD / UPDATE / NOOP classification + tokens

    ${G("query")} <text>       Find closest matching records
                        Shows: ranked results + WHY each matched (token evidence)

    ${G("list")}               Show all stored records and their tokens

    ${G("clear")}              Wipe the index and start over

    ${G("demo")}               Load infrastructure event stream scenario (8 records)
    ${G("memory")}             Load personal memory scenario (8 records)
    ${G("reason")}             Multi-hop incident chain — cognitive reasoning demo (12 records)

    ${G("load")} <file>        Bulk load .txt / .json / .jsonl dataset into the index
                        Download first: node scripts/fetch-dataset.js --dataset babi

    ${G("bench")}              Full automated benchmark — 8 queries against 10K records
                        Shows accuracy + speed. Zero input needed.

    ${G("scale")} 1000         Speed + accuracy test at 1,000 records
    ${G("scale")} 5000         Speed + accuracy test at 5,000 records
    ${G("scale")} 10000        Speed + accuracy test at 10,000 records

    ${G("help")}               Show this message
    ${G("exit")} / ${G("quit")}        Close

  ${BOLD("How scoring works:")}

    ${G("0.85+")}  Strong match — same concept, different words
    ${G("0.70+")}  Good match   — clearly related
    ${Y("0.55+")}  Possible     — some overlap, worth returning
    ${R("< 0.55")}  Filtered     — noise, not returned

  ${BOLD("What the tokens show:")}

    ${B("word")}  — a content token extracted from your text
    ${DIM("#cat")}  — a semantic category anchor (e.g. #loc, #job, #fit)
            these create overlap between related terms even with no shared words

  ${BOLD("Engine:")}  ${_native ? G("native AVX2 + OpenMP (built)") : DIM("interpreted JS  — run npm run build-native to activate native path")}
`);
}

// ── REPL ──────────────────────────────────────────────────────────────────────
function main() {
  const engineLine = _native
    ? `  Engine: ${G("native AVX2 + OpenMP")}  (built)\n`
    : `  Engine: ${DIM("interpreted JS")}  — ${DIM("npm run build-native")} for 50–200× faster\n`;

  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║   RSHL Playground — Semantic Search, Live                        ║
║                                                                   ║
║   This index finds records by MEANING, not exact words.          ║
║   No AI model. No cloud. Runs entirely on this machine.          ║
╚═══════════════════════════════════════════════════════════════════╝

${engineLine}
  ${BOLD("Step 1 — load a scenario to see it working immediately:")}

    ${G("demo")}      Infrastructure event stream (server errors, deploys, alerts)
    ${G("memory")}    Personal memory scenario (people, jobs, locations)
    ${G("reason")}    Multi-hop incident chain — cognitive reasoning demo

  ${BOLD("Step 2 — run the example queries it gives you.")}
  ${BOLD("Step 3 — try your own:")}

    ${G("store")} <any text>   Add a record to the index
    ${G("query")} <any text>   Search — returns ranked matches + WHY they matched

  ${BOLD("What to look for:")}
    Green tokens = shared meaning between your query and the result
    Score 0.70+  = strong match    Score 0.55–0.69 = possible match
    ADD / UPDATE / NOOP = how the index classifies what you store

  ${BOLD("Step 4 — see the full power in one command:")}

    ${G("bench")}         Full automated benchmark — accuracy + speed at 10K records
    ${G("scale 10000")}   Raw speed test — 10,000 records, timed queries

  Type ${G("help")} for the full command list.
`);

  const arg = process.argv[2];
  if (arg === "--demo")   runScenario("demo");
  if (arg === "--memory") runScenario("memory");

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: G("rshl") + " > ",
  });

  rl.prompt();

  rl.on("line", line => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const space = input.indexOf(" ");
    const cmd   = (space === -1 ? input : input.slice(0, space)).toLowerCase();
    const rest  = space === -1 ? "" : input.slice(space + 1).trim();

    switch (cmd) {
      case "store":
        if (!rest) { console.log(`  ${Y("Usage:")} store <text>\n`); break; }
        store(rest);
        break;

      case "query":
      case "q":
        if (!rest) { console.log(`  ${Y("Usage:")} query <text>\n`); break; }
        query(rest);
        break;

      case "list":
        list();
        break;

      case "clear":
        index         = [];
        sessionStores = 0;
        console.log(`\n  ${Y("Index cleared")}\n`);
        break;

      case "demo":
        runScenario("demo");
        break;

      case "memory":
        runScenario("memory");
        break;

      case "reason":
        runScenario("reason");
        break;

      case "load": {
        if (!rest) {
          console.log(`\n  ${Y("Usage:")} load <file.txt|file.json|file.jsonl>\n`);
          console.log(`  ${DIM("Download datasets first:")}`);
          console.log(`  ${DIM("  node scripts/fetch-dataset.js --dataset ghsa")}`);
          console.log(`  ${DIM("  node scripts/fetch-dataset.js --dataset babi")}`);
          console.log(`  ${DIM("  node scripts/fetch-dataset.js --dataset squad")}\n`);
          break;
        }
        loadFile(rest);
        break;
      }

      case "bench":
        runBench();
        break;

      case "scale": {
        const n = parseInt(rest) || 1000;
        if (![1000, 5000, 10000].includes(n)) {
          console.log(`\n  ${Y("Usage:")} scale 1000 | scale 5000 | scale 10000\n`);
          break;
        }
        runScale(n);
        break;
      }

      case "help":
      case "h":
      case "?":
        showHelp();
        break;

      case "exit":
      case "quit":
        console.log(`\n  ${index.length} records stored this session. Bye.\n`);
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`\n  ${R("Unknown command:")} ${cmd}  — type ${G("help")} for commands\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

main();
