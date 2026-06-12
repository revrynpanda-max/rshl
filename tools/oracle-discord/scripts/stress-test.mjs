// ── KAI ECOSYSTEM STRESS TEST ───────────────────────────────────────────────
// Finds the system's real limits and verifies the resource governor protects
// the host. Safe by default: read-only load (queries + health probes).
// Ingestion burst is OPT-IN via --ingest (writes low-strength stress cells).
//
// Usage:
//   node scripts/stress-test.mjs              # standard run (~3-4 min)
//   node scripts/stress-test.mjs --quick      # short run (~1 min)
//   node scripts/stress-test.mjs --ingest     # include ingest burst phase
//
// Output: console summary + markdown report in C:\KAI\scratch\
import fs from 'fs';

const KAI = 'http://127.0.0.1:3334';
const SELF_OPT = 'c:/KAI/tools/oracle-discord/state/self_optimize_state.json';
const BOT_PORTS = { Dashboard: 3001, Leo: 3400, KAI: 3401, Gemini: 3402, Claudey: 3403, X: 3404, Groq: 3405, Analyst: 3406, 'Kai Coder': 3408, Oracle: 3410 };
const QUICK = process.argv.includes('--quick');
const DO_INGEST = process.argv.includes('--ingest');

const QUERIES = [
  'fibonacci torsion', 'spiral state coherence', 'what is the lattice',
  'consolidation gates', 'ryan creator', 'boid swarm reorganization',
  'hippocampus patterns', 'sparse ternary vectors', 'epistemic immune system',
  'language warehouse'
];

const results = { phases: [], hostSamples: [], tierChanges: [], started: new Date().toISOString() };

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function jfetch(url, opts = {}, timeoutMs = 10000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, status: res.status };
    return { ok: true, ms, data: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

async function sampleHost(tag) {
  const r = await jfetch(`${KAI}/api/status`, {}, 5000);
  let tier = null;
  try { tier = JSON.parse(fs.readFileSync(SELF_OPT, 'utf8')).tier; } catch (_) {}
  if (r.ok && r.data) {
    const cpu = parseFloat(String(r.data.cpu).replace('%', '')) || 0;
    const ramMatch = /(\d+)GB \/ (\d+)GB/.exec(String(r.data.ram) || '');
    const ramPct = ramMatch ? Math.round(100 * ramMatch[1] / ramMatch[2]) : 0;
    const sample = { tag, cpu, ramPct, tier, cells: r.data.total_cells, ts: Date.now() };
    results.hostSamples.push(sample);
    const last = results.tierChanges[results.tierChanges.length - 1];
    if (!last || last.tier !== tier) results.tierChanges.push({ tag, tier, ts: Date.now() });
    return sample;
  }
  return null;
}

async function phaseBaseline() {
  console.log('\n══ PHASE 0: BASELINE (10s idle observation) ══');
  for (let i = 0; i < (QUICK ? 3 : 5); i++) {
    const s = await sampleHost('baseline');
    if (s) console.log(`  cpu=${s.cpu}% ram=${s.ramPct}% tier=${s.tier} cells=${s.cells?.toLocaleString?.()}`);
    await new Promise(r => setTimeout(r, 2000));
  }
  const cpus = results.hostSamples.filter(s => s.tag === 'baseline').map(s => s.cpu);
  results.phases.push({ name: 'baseline', cpuAvg: cpus.reduce((a, b) => a + b, 0) / (cpus.length || 1) });
}

async function phaseQueryFlood() {
  console.log('\n══ PHASE 1: LATTICE QUERY FLOOD (ramping concurrency) ══');
  const ramp = QUICK ? [2, 8] : [2, 4, 8, 16, 24];
  for (const conc of ramp) {
    const latencies = [];
    let failures = 0;
    let shed = 0; // 429s = admission control working as designed, NOT failures
    const rounds = QUICK ? 2 : 4;
    for (let round = 0; round < rounds; round++) {
      const batch = Array.from({ length: conc }, (_, i) =>
        jfetch(`${KAI}/api/rshl/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: QUERIES[(round * conc + i) % QUERIES.length], n: 5 })
        }, 20000)
      );
      const out = await Promise.all(batch);
      for (const r of out) {
        if (r.ok) latencies.push(r.ms);
        else if (r.status === 429) shed++;
        else failures++;
      }
      await sampleHost(`flood-c${conc}`);
    }
    const p50 = pct(latencies, 0.5), p95 = pct(latencies, 0.95);
    console.log(`  concurrency=${conc}: p50=${p50}ms p95=${p95}ms shed=${shed} failures=${failures}/${conc * rounds}`);
    results.phases.push({ name: `query-flood-c${conc}`, p50, p95, shed, failures, total: conc * rounds });
    // SAFETY VALVE: stop ramping if the engine is choking
    if (failures > conc * rounds * 0.5 || p95 > 15000) {
      console.log('  ⚠️ Engine saturating — stopping ramp here (this IS the limit).');
      results.phases.push({ name: 'limit-found', at: `concurrency=${conc}` });
      break;
    }
  }
}

async function phaseHealthStorm() {
  console.log('\n══ PHASE 2: HEALTH-ENDPOINT STORM (monitoring load) ══');
  const rounds = QUICK ? 5 : 15;
  let ok = 0, fail = 0;
  const latencies = [];
  for (let i = 0; i < rounds; i++) {
    const probes = Object.entries(BOT_PORTS).map(([name, port]) =>
      jfetch(`http://127.0.0.1:${port}/health`, {}, 3000).then(r => ({ name, ...r }))
    );
    const out = await Promise.all(probes);
    for (const r of out) { if (r.ok) { ok++; latencies.push(r.ms); } else fail++; }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`  probes ok=${ok} unreachable=${fail} (sleeping bots count as unreachable) p95=${pct(latencies, 0.95)}ms`);
  results.phases.push({ name: 'health-storm', ok, fail, p95: pct(latencies, 0.95) });
}

async function phaseIngestBurst() {
  if (!DO_INGEST) { console.log('\n══ PHASE 3: INGEST BURST — skipped (run with --ingest to enable) ══'); return; }
  console.log('\n══ PHASE 3: INGEST BURST (low-strength stress cells) ══');
  const latencies = [];
  let failures = 0;
  const batches = QUICK ? 3 : 8;
  for (let b = 0; b < batches; b++) {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      text: `[STRESS-TEST] synthetic load cell ${Date.now()}-${b}-${i} — safe to prune`,
      region: 'stress_test', source: 'stress_test', strength: 0.05
    }));
    const r = await jfetch(`${KAI}/api/bulk-ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries })
    }, 30000);
    if (r.ok) latencies.push(r.ms); else failures++;
    await sampleHost('ingest');
  }
  console.log(`  batches=${batches} p95=${pct(latencies, 0.95)}ms failures=${failures}`);
  results.phases.push({ name: 'ingest-burst', p95: pct(latencies, 0.95), failures });
}

async function phaseGeneration() {
  if (!process.argv.includes('--gen')) { console.log('\n══ PHASE 4: GENERATION LOAD — skipped (run with --gen) ══'); return; }
  console.log('\n══ PHASE 4: GENERATION LOAD (native replies — the heavy path) ══');
  const prompts = ['What are you?', 'What is the lattice?', 'How do you learn?'];
  const lat = [];
  for (const p of prompts) {
    const r = await jfetch(`${KAI}/api/oracle-turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Oracle', text: p })
    }, 90_000);
    console.log(`  "${p}" → ${r.ok ? r.ms + 'ms' : 'FAILED (' + (r.err || r.status) + ')'}`);
    if (r.ok) lat.push(r.ms);
    await sampleHost('generation');
  }
  results.phases.push({ name: 'generation', p50: pct(lat, 0.5), worst: Math.max(...lat, 0), completed: lat.length, total: prompts.length });
}

async function phaseSoak() {
  const soakIdx = process.argv.indexOf('--soak');
  if (soakIdx === -1) return;
  const minutes = Math.min(120, Math.max(1, parseInt(process.argv[soakIdx + 1], 10) || 10));
  console.log(`\n══ PHASE 5: SOAK (${minutes} min endurance — stability over time) ══`);
  const end = Date.now() + minutes * 60_000;
  const lat = [];
  let fails = 0;
  while (Date.now() < end) {
    const r = await jfetch(`${KAI}/api/rshl/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[Math.floor(Math.random() * QUERIES.length)], n: 3 })
    }, 15_000);
    if (r.ok) lat.push(r.ms); else fails++;
    await sampleHost('soak');
    await new Promise(r2 => setTimeout(r2, 30_000));
  }
  const firstHalf = lat.slice(0, Math.floor(lat.length / 2));
  const secondHalf = lat.slice(Math.floor(lat.length / 2));
  const driftMsg = firstHalf.length && secondHalf.length
    ? `latency drift ${pct(firstHalf, 0.5)}ms → ${pct(secondHalf, 0.5)}ms over the soak`
    : 'insufficient samples';
  console.log(`  Soak done: ${lat.length} ok, ${fails} failed — ${driftMsg}`);
  results.phases.push({ name: `soak-${minutes}min`, ok: lat.length, fails, p50First: pct(firstHalf, 0.5), p50Second: pct(secondHalf, 0.5) });
}

function loadPreviousRun() {
  try {
    const files = fs.readdirSync('c:/KAI/scratch')
      .filter(f => /^stress-report-\d+\.json$/.test(f))
      .sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(`c:/KAI/scratch/${files[files.length - 1]}`, 'utf8'));
  } catch (_) { return null; }
}

function report() {
  const cpus = results.hostSamples.map(s => s.cpu);
  const rams = results.hostSamples.map(s => s.ramPct);
  const maxCpu = Math.max(...cpus, 0), maxRam = Math.max(...rams, 0);
  const capCpu = 75, capRam = 85;
  const previous = loadPreviousRun();

  const lines = [];
  lines.push(`# KAI Ecosystem Stress Report`);
  lines.push(`Run: ${results.started}  |  Mode: ${QUICK ? 'quick' : 'standard'}${DO_INGEST ? ' +ingest' : ''}`);
  lines.push(``);
  lines.push(`## Host Protection (the verdict that matters)`);
  lines.push(`- Max CPU observed: **${maxCpu}%** (cap ${capCpu}%) → ${maxCpu <= capCpu ? '✅ governor held the line' : '❌ CAP EXCEEDED — governor needs tuning'}`);
  lines.push(`- Max RAM observed: **${maxRam}%** (cap ${capRam}%) → ${maxRam <= capRam ? '✅ within cap' : '❌ CAP EXCEEDED'}`);
  lines.push(`- Governor tier transitions during load: ${results.tierChanges.map(t => `${t.tag}→${t.tier}`).join(', ') || 'none'}`);
  lines.push(``);
  lines.push(`## Phase Results`);
  for (const p of results.phases) lines.push(`- \`${p.name}\`: ${JSON.stringify(p)}`);
  lines.push(``);
  lines.push(`## Interpretation Guide`);
  lines.push(`- p95 latency rising sharply between concurrency steps = that's the engine's comfortable ceiling.`);
  lines.push(`- "limit-found" marker = the measured saturation point; keep normal load below ~half of it.`);
  lines.push(`- Tier flipping to REDUCED/PROTECT during load = the governor doing its job (good).`);
  lines.push(`- If CPU exceeded the cap WITHOUT a tier change, the governor reacted too slowly — tell Claude.`);

  // ── COMPARISON WITH PREVIOUS RUN — is the system getting BETTER? ─────────
  if (previous) {
    lines.push(``, `## Comparison vs previous run (${previous.started})`);
    const prevMax = previous.maxCpu ?? '?';
    lines.push(`- Max CPU: ${prevMax}% → **${maxCpu}%** ${typeof prevMax === 'number' ? (maxCpu <= prevMax ? '✅ better/equal' : '⚠️ worse') : ''}`);
    const findP = (run, name) => (run.phases || []).find(p => p.name === name);
    for (const phaseName of ['query-flood-c8', 'query-flood-c16', 'query-flood-c24']) {
      const a = findP(previous, phaseName), b = findP(results, phaseName);
      if (a && b) lines.push(`- ${phaseName} p95: ${a.p95}ms → **${b.p95}ms** ${b.p95 <= a.p95 ? '✅' : '⚠️'}${b.shed ? ` (shed=${b.shed} — admission control active)` : ''}`);
    }
  }

  const md = lines.join('\n');
  const ts = Date.now();
  const out = `c:/KAI/scratch/stress-report-${ts}.md`;
  try { fs.writeFileSync(out, md); console.log(`\n📄 Report written: ${out}`); } catch (e) { console.log(md); }
  // JSON sidecar — machine-readable history so every future run auto-compares
  try {
    fs.writeFileSync(`c:/KAI/scratch/stress-report-${ts}.json`,
      JSON.stringify({ started: results.started, maxCpu, maxRam, phases: results.phases, tierChanges: results.tierChanges }, null, 2));
  } catch (_) {}

  console.log(`\n══ VERDICT ══`);
  console.log(`  Max CPU ${maxCpu}% (cap ${capCpu}) | Max RAM ${maxRam}% (cap ${capRam})`);
  console.log(`  ${maxCpu <= capCpu && maxRam <= capRam ? '✅ Host protected under stress.' : '❌ Caps exceeded — governor tuning needed.'}`);
  if (previous) {
    const prevMax = previous.maxCpu;
    if (typeof prevMax === 'number') console.log(`  vs last run: max CPU ${prevMax}% → ${maxCpu}% ${maxCpu <= prevMax ? '(better/equal ✅)' : '(worse ⚠️)'}`);
  }
}

(async () => {
  console.log('KAI ECOSYSTEM STRESS TEST — safe/read-only unless --ingest');
  const alive = await jfetch(`${KAI}/api/status`, {}, 5000);
  if (!alive.ok) {
    console.error('❌ KAI engine not reachable at ' + KAI + ' — start the fleet first.');
    process.exit(1);
  }
  await phaseBaseline();
  await phaseQueryFlood();
  await phaseHealthStorm();
  await phaseIngestBurst();
  await phaseGeneration();
  await phaseSoak();
  report();
})();
