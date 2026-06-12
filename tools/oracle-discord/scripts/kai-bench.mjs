// ── KAI BENCHMARK SUITE ──────────────────────────────────────────────────────
// Sequential, clean-formatted benchmark battery. Run it under each fleet
// configuration with a label, and it builds a comparison history:
//
//   node scripts/kai-bench.mjs --label engine-only      (just kai.exe running)
//   node scripts/kai-bench.mjs --label essential-fleet  (core + helpers)
//   node scripts/kai-bench.mjs --label full-fleet       (everyone awake)
//   node scripts/kai-bench.mjs --compare                (table of all saved runs)
//
// Tests run ONE AT A TIME, each reported in its own clean section:
//   T1 Vitals snapshot (neurons, synapses, phi, chi, mood — the boid/spiral state)
//   T2 Status latency (the engine's reflexes)
//   T3 Query latency — sequential (pure memory-engine speed)
//   T4 Query latency — concurrent (memory engine under parallel demand)
//   T5 Synapse/density read (boid wiring telemetry)
//   T6 Generation (native reply — the full cognitive pipeline)  [--gen]
//   T7 Vitals delta (did the workout change his mental state?)
//
// Then: HARDWARE EXTRAPOLATION — measured numbers scaled to datacenter-class
// hardware with HONEST, documented assumptions (estimates, not measurements).
import fs from 'fs';

const KAI = 'http://127.0.0.1:3334';
const OUT_DIR = 'c:/KAI/scratch/bench';
const argIdx = process.argv.indexOf('--label');
const LABEL = argIdx !== -1 ? (process.argv[argIdx + 1] || 'unlabeled') : 'unlabeled';
const DO_GEN = process.argv.includes('--gen');
const COMPARE_ONLY = process.argv.includes('--compare');

const QUERIES = [
  'fibonacci torsion', 'spiral state coherence', 'what is the lattice',
  'consolidation gates', 'boid swarm reorganization', 'hippocampus patterns',
  'sparse ternary vectors', 'epistemic immune system', 'language warehouse',
  'ryan creator', 'three angle protocol', 'synaptic layer hebbian'
];

const hr = (t) => console.log(`\n${'═'.repeat(62)}\n  ${t}\n${'═'.repeat(62)}`);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function jfetch(url, opts = {}, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, ms: Date.now() - t0, status: res.status, data: res.ok ? await res.json().catch(() => null) : null };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
}

async function getVitals() {
  const [st, sess, syn] = await Promise.all([
    jfetch(`${KAI}/api/status`),
    jfetch(`${KAI}/api/session`),
    jfetch(`${KAI}/api/synapse/status`)
  ]);
  return {
    cells: st.data?.total_cells ?? null,
    synapses: st.data?.synapses ?? null,
    phi_g: st.data?.phi_g ?? null,
    cpu: st.data?.cpu ?? null,
    ram: st.data?.ram ?? null,
    tick: sess.data?.vitals?.tick ?? null,
    chi: sess.data?.vitals?.chi ?? null,
    rho: sess.data?.vitals?.rho ?? null,
    mood: sess.data?.vitals?.mood ?? null,
    valence: sess.data?.vitals?.valence ?? null,
    density: syn.data?.density_per_cell ?? null,
    grounded: syn.data?.neurons_with_outgoing ?? null
  };
}

function printVitals(v, title) {
  hr(title);
  console.log(`  Neurons (cells)      : ${v.cells?.toLocaleString?.() ?? '?'}`);
  console.log(`  Synapses             : ${v.synapses?.toLocaleString?.() ?? '?'}`);
  console.log(`  Synapse density/cell : ${v.density?.toFixed?.(4) ?? '?'}   (boid wiring)`);
  console.log(`  Grounded neurons     : ${v.grounded?.toLocaleString?.() ?? '?'}   (geometric bridges)`);
  console.log(`  Phi (integration)    : ${v.phi_g?.toFixed?.(4) ?? '?'}`);
  console.log(`  Chi (conflict)       : ${v.chi?.toFixed?.(4) ?? '?'}`);
  console.log(`  Rho / Valence        : ${v.rho?.toFixed?.(3) ?? '?'} / ${v.valence?.toFixed?.(3) ?? '?'}`);
  console.log(`  Mood / Tick          : ${v.mood ?? '?'} / ${v.tick ?? '?'}   (spiral clock)`);
  console.log(`  Host (engine view)   : CPU ${v.cpu ?? '?'}, RAM ${v.ram ?? '?'}`);
}

function compareRuns() {
  let files = [];
  try { files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).sort(); } catch (_) {}
  if (!files.length) { console.log('No saved bench runs yet.'); return; }
  const runs = files.map(f => JSON.parse(fs.readFileSync(`${OUT_DIR}/${f}`, 'utf8')));
  hr('BENCH HISTORY — ALL CONFIGURATIONS');
  console.log(`  ${'label'.padEnd(18)}${'date'.padEnd(12)}${'q-p50'.padEnd(9)}${'q-p95'.padEnd(9)}${'c4-p95'.padEnd(9)}${'status'.padEnd(9)}${'qps'.padEnd(7)}cells`);
  for (const r of runs) {
    console.log(`  ${String(r.label).padEnd(18)}${String(r.date).slice(5, 16).padEnd(12)}${String(r.seqP50 ?? '-').padEnd(9)}${String(r.seqP95 ?? '-').padEnd(9)}${String(r.concP95 ?? '-').padEnd(9)}${String(r.statusMs ?? '-').padEnd(9)}${String(r.qps ?? '-').padEnd(7)}${r.cells?.toLocaleString?.() ?? '-'}`);
  }
  console.log('\n  Lower latency + higher qps = better. Compare engine-only vs fleets to see the cost of company.');
}

(async () => {
  if (COMPARE_ONLY) { compareRuns(); return; }

  console.log(`KAI BENCHMARK SUITE — configuration label: "${LABEL}"${DO_GEN ? ' (+generation)' : ''}`);
  const alive = await jfetch(`${KAI}/api/status`, {}, 6000);
  if (!alive.ok) { console.error('❌ Engine not reachable. Start kai.exe first.'); process.exit(1); }

  // ── T1: VITALS SNAPSHOT (before) ─────────────────────────────────────────
  const v0 = await getVitals();
  printVitals(v0, 'T1 — VITALS SNAPSHOT (pre-workout: the organism at rest)');

  // ── T2: STATUS LATENCY ───────────────────────────────────────────────────
  hr('T2 — STATUS LATENCY (engine reflexes, 10 pings)');
  const statusLat = [];
  for (let i = 0; i < 10; i++) { const r = await jfetch(`${KAI}/api/status`, {}, 8000); if (r.ok) statusLat.push(r.ms); }
  const statusMs = pct(statusLat, 0.5);
  console.log(`  p50=${statusMs}ms  p95=${pct(statusLat, 0.95)}ms  (${statusLat.length}/10 ok)`);

  // ── T3: SEQUENTIAL QUERY LATENCY ─────────────────────────────────────────
  hr('T3 — MEMORY ENGINE, SEQUENTIAL (24 queries, one at a time)');
  const seqLat = [];
  let seqFail = 0;
  const t3start = Date.now();
  for (let i = 0; i < 24; i++) {
    const r = await jfetch(`${KAI}/api/rshl/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[i % QUERIES.length], n: 5 })
    }, 20000);
    if (r.ok) seqLat.push(r.ms); else seqFail++;
  }
  const qps = +(seqLat.length / ((Date.now() - t3start) / 1000)).toFixed(2);
  const seqP50 = pct(seqLat, 0.5), seqP95 = pct(seqLat, 0.95);
  console.log(`  p50=${seqP50}ms  p95=${seqP95}ms  fails=${seqFail}  throughput=${qps} queries/sec`);
  console.log(`  (each query = full multi-layer encode + lattice scan over ${v0.cells?.toLocaleString?.()} cells)`);

  // ── T4: CONCURRENT QUERY LATENCY ─────────────────────────────────────────
  hr('T4 — MEMORY ENGINE, CONCURRENT (4-way parallel, 3 waves)');
  const concLat = [];
  let concShed = 0, concFail = 0;
  for (let w = 0; w < 3; w++) {
    const wave = await Promise.all(Array.from({ length: 4 }, (_, i) => jfetch(`${KAI}/api/rshl/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[(w * 4 + i) % QUERIES.length], n: 5 })
    }, 25000)));
    for (const r of wave) { if (r.ok) concLat.push(r.ms); else if (r.status === 429) concShed++; else concFail++; }
  }
  const concP95 = pct(concLat, 0.95);
  console.log(`  p50=${pct(concLat, 0.5)}ms  p95=${concP95}ms  shed=${concShed}  fails=${concFail}`);

  // ── T5: SYNAPSE / BOID TELEMETRY READ ────────────────────────────────────
  hr('T5 — SYNAPSE TELEMETRY (boid wiring read, 5 pings)');
  const synLat = [];
  for (let i = 0; i < 5; i++) { const r = await jfetch(`${KAI}/api/synapse/status`, {}, 10000); if (r.ok) synLat.push(r.ms); }
  console.log(`  p50=${pct(synLat, 0.5)}ms  (density=${v0.density?.toFixed?.(4)}, grounded=${v0.grounded?.toLocaleString?.()})`);

  // ── T6: GENERATION (optional) ────────────────────────────────────────────
  let genP50 = null;
  if (DO_GEN) {
    hr('T6 — FULL COGNITIVE PIPELINE (native generation, 3 prompts)');
    const genLat = [];
    for (const p of ['What are you?', 'What is the lattice made of?', 'How do you learn new words?']) {
      const r = await jfetch(`${KAI}/api/oracle-turn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Oracle', text: p })
      }, 120000);
      console.log(`  "${p}" → ${r.ok ? r.ms + 'ms' : 'FAILED'}`);
      if (r.ok) genLat.push(r.ms);
    }
    genP50 = pct(genLat, 0.5);
  } else {
    hr('T6 — GENERATION: skipped (add --gen to include)');
  }

  // ── T7: VITALS DELTA ─────────────────────────────────────────────────────
  const v1 = await getVitals();
  hr('T7 — VITALS DELTA (did the workout change his mind-state?)');
  console.log(`  Phi:   ${v0.phi_g?.toFixed?.(4)} → ${v1.phi_g?.toFixed?.(4)}`);
  console.log(`  Chi:   ${v0.chi?.toFixed?.(4)} → ${v1.chi?.toFixed?.(4)}`);
  console.log(`  Tick:  ${v0.tick} → ${v1.tick}  (spiral advanced ${(v1.tick ?? 0) - (v0.tick ?? 0)} steps)`);
  console.log(`  Mood:  ${v0.mood} → ${v1.mood}`);

  // ── HARDWARE EXTRAPOLATION ───────────────────────────────────────────────
  hr('HARDWARE EXTRAPOLATION — honest estimates, not measurements');
  console.log(`  Measured on THIS host (Ryzen-class laptop, 12 threads, 39GB):`);
  console.log(`    ${qps} queries/sec sequential, p50 ${seqP50}ms over ${v0.cells?.toLocaleString?.()} cells\n`);
  console.log(`  RSHL is CPU + memory-bandwidth bound (sparse integer ops, no GPU math),`);
  console.log(`  so scaling assumptions are core-count × bandwidth, with honest caveats:\n`);
  const targets = [
    { name: 'EPYC 9654 server (96c, 12ch DDR5)', coreX: 8, bwX: 6, note: 'single high-end CPU node' },
    { name: 'Dual-EPYC datacenter node (192c)', coreX: 16, bwX: 12, note: 'OpenAI/Anthropic-class CPU host' },
    { name: 'Groq LPU node', coreX: null, bwX: null, note: 'LPU = deterministic matmul streams; RSHL sparse ops would need a port — latency floor likely sub-ms IF ported, unproven' },
    { name: 'H100 GPU node', coreX: null, bwX: null, note: 'GPU helps only if lattice ops are rewritten as batched tensor ops; current engine would NOT use it' },
    { name: 'Apple M-series NPU / phone NPU', coreX: 0.8, bwX: 1.5, note: 'NPUs skip sparse-int workloads; CPU cores + unified memory do the work — efficiency/watt is the win' }
  ];
  for (const t of targets) {
    if (t.coreX) {
      const est = +(qps * Math.min(t.coreX, t.bwX) * 0.7).toFixed(1); // 0.7 = parallel-efficiency haircut
      console.log(`  • ${t.name}`);
      console.log(`      est. ~${est} q/s (${Math.round(est / qps)}× this laptop) — ${t.note}`);
    } else {
      console.log(`  • ${t.name}`);
      console.log(`      no honest multiplier — ${t.note}`);
    }
  }
  console.log(`\n  CAVEATS: linear-ish scaling assumed for an embarrassingly-parallel query`);
  console.log(`  load; single-query latency improves with memory bandwidth, not cores;`);
  console.log(`  the 0.7 factor covers lock contention and NUMA. Real numbers require`);
  console.log(`  running this same suite on the target hardware — which this suite makes`);
  console.log(`  trivially possible: copy the folder, run the command, compare labels.`);

  // ── SAVE ─────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const record = {
    label: LABEL, date: new Date().toISOString(),
    cells: v0.cells, synapses: v0.synapses, phi: v0.phi_g, density: v0.density,
    statusMs, seqP50, seqP95, qps, concP95, concShed, genP50
  };
  const file = `${OUT_DIR}/bench-${LABEL.replace(/[^a-z0-9-]/gi, '_')}-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  hr('SAVED');
  console.log(`  ${file}`);
  console.log(`  Run again under other fleet configs, then:  node scripts/kai-bench.mjs --compare`);
})();
