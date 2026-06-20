#!/usr/bin/env node
import { DIM, SparseVec, encode } from '../../../RSHL_USB/rshl-core-v3.mjs';
import { evaluateSelfOptimize, TIERS } from '../shared/resource-saver.mjs';
import { buildProofSummary, recordProofMetric, writeProofArtifacts } from '../shared/proof-metrics.mjs';
import { invalidateLatticeCache, queryLattice, storeLattice } from '../shared/lattice-bridge.mjs';

const startedAt = Date.now();
const args = new Set(process.argv.slice(2));

function hires() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function passLane(summary, data = {}) {
  return { pass: true, summary, ...data };
}

function failLane(summary, data = {}) {
  return { pass: false, summary, ...data };
}

function generate600CellVertices() {
  const phi = (1 + Math.sqrt(5)) / 2;
  const vertices = [];
  const add = (w, x, y, z) => vertices.push([w, x, y, z]);
  for (const v of [1, -1]) {
    add(v, 0, 0, 0); add(0, v, 0, 0); add(0, 0, v, 0); add(0, 0, 0, v);
  }
  for (let i = 0; i < 16; i++) {
    add(i & 1 ? -0.5 : 0.5, i & 2 ? -0.5 : 0.5, i & 4 ? -0.5 : 0.5, i & 8 ? -0.5 : 0.5);
  }
  const vals = [0.5 * phi, 0.5, 0.5 / phi, 0];
  const perms = [
    [0, 1, 2, 3], [0, 2, 3, 1], [0, 3, 1, 2],
    [1, 2, 0, 3], [1, 3, 2, 0], [1, 0, 3, 2],
    [2, 0, 1, 3], [2, 3, 0, 1], [2, 1, 3, 0],
    [3, 1, 0, 2], [3, 2, 1, 0], [3, 0, 2, 1]
  ];
  for (const p of perms) {
    const base = p.map(i => vals[i]);
    for (let mask = 0; mask < 16; mask++) {
      add(...base.map((v, i) => v !== 0 && (mask & (1 << i)) ? -v : v));
    }
  }
  const seen = new Set();
  return vertices.filter(v => {
    const key = v.map(n => n.toFixed(5)).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectTo4d(vec) {
  const q = [0, 0, 0, 0];
  for (const idx of vec.nz) {
    const s = vec.data[idx];
    q[0] += s * Math.sin(idx * 0.12345);
    q[1] += s * Math.cos(idx * 0.23456);
    q[2] += s * Math.sin(idx * 0.34567);
    q[3] += s * Math.cos(idx * 0.45678);
  }
  const mag = Math.sqrt(q.reduce((sum, n) => sum + n * n, 0)) || 1;
  return q.map(n => n / mag);
}

function dot4(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function snapTo600(q, vertices) {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const d = dot4(q, vertices[i]);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

function noisyCopy(vec, flipEvery = 11, dropEvery = 7) {
  const data = new Int8Array(vec.data);
  const nz = [];
  for (let k = 0; k < vec.nz.length; k++) {
    const idx = vec.nz[k];
    if (k % dropEvery === 0) {
      data[idx] = 0;
      continue;
    }
    if (k % flipEvery === 0) data[idx] = -data[idx];
    if (data[idx] !== 0) nz.push(idx);
  }
  return new SparseVec(data, nz);
}

function runGovernorProof() {
  const scenarios = [
    {
      name: 'interactive-normal',
      input: { profile: 'interactive', cpuLoad: 28, gpuLoad: 12, memLoad: 48, totalMemMB: 40960, freeMemMB: 21000, projectMemMB: 2200, projectProcessCount: 12, vitals: { phi_g: 1.1, chi: 0.02 } },
      tier: TIERS.NORMAL
    },
    {
      name: 'overnight-reduced',
      input: { profile: 'overnight', cpuLoad: 76, gpuLoad: 35, memLoad: 79, totalMemMB: 40960, freeMemMB: 7600, projectMemMB: 8200, projectProcessCount: 28, vitals: { phi_g: 1.05, chi: 0.04 } },
      tier: TIERS.REDUCED
    },
    {
      name: 'proof-protect',
      input: { profile: 'proof-run', cpuLoad: 87, gpuLoad: 80, memLoad: 88, totalMemMB: 40960, freeMemMB: 4800, projectMemMB: 9800, projectProcessCount: 34, vitals: { phi_g: 0.72, chi: 0.16 } },
      tier: TIERS.PROTECT
    }
  ];

  const results = scenarios.map(s => {
    const snapshot = evaluateSelfOptimize(s.input);
    return {
      name: s.name,
      expectedTier: s.tier,
      actualTier: snapshot.tier,
      oracleAllowed: snapshot.spots.Oracle.allowed,
      kaiAllowed: snapshot.spots.KAI.allowed,
      leoAllowed: snapshot.spots.Leo.allowed,
      socialAllowed: snapshot.spots.Gemini.allowed,
      hasMemoryTotals: Number.isFinite(snapshot.totalMemMB) && Number.isFinite(snapshot.freeMemMB)
    };
  });

  const pass = results.every(r =>
    r.expectedTier === r.actualTier &&
    r.oracleAllowed &&
    r.kaiAllowed &&
    r.hasMemoryTotals &&
    (r.actualTier !== TIERS.PROTECT || r.leoAllowed)
  );
  recordProofMetric('governor_pass', pass ? 1 : 0);
  return pass ? passLane('Governor profiles, protected lanes, and snapshot schema passed.', { scenarios: results })
              : failLane('Governor proof failed one or more tier/lane/schema checks.', { scenarios: results });
}

function runPolychoraProof() {
  const categories = {
    memory: ['lattice', 'recall', 'episodic', 'anchor', 'claim'],
    geometry: ['polychora', 'quaternion', 'vertex', 'simplex', 'rotation'],
    emotion: ['valence', 'dopamine', 'cortisol', 'habenula', 'trust'],
    compute: ['governor', 'cpu', 'gpu', 'budget', 'throttle'],
    language: ['syntax', 'phrase', 'token', 'semantic', 'grammar'],
    repair: ['self-heal', 'scar', 'failure', 'diagnostic', 'recovery']
  };
  const corpus = [];
  for (const [category, words] of Object.entries(categories)) {
    for (let i = 0; i < 18; i++) {
      const a = words[i % words.length];
      const b = words[(i * 2 + 1) % words.length];
      const c = words[(i * 3 + 2) % words.length];
      const text = `${category} ${a} ${b} ${c} proof sample ${i}`;
      corpus.push({ category, text, vec: encode(text) });
    }
  }

  const vertices = generate600CellVertices();
  const mapped = corpus.map(row => ({
    ...row,
    q: projectTo4d(row.vec),
    vertex: snapTo600(projectTo4d(row.vec), vertices)
  }));

  const byVertex = new Map();
  for (const row of mapped) {
    if (!byVertex.has(row.vertex)) byVertex.set(row.vertex, []);
    byVertex.get(row.vertex).push(row);
  }
  let puritySum = 0;
  let purityGroups = 0;
  for (const rows of byVertex.values()) {
    if (rows.length < 2) continue;
    const counts = {};
    for (const row of rows) counts[row.category] = (counts[row.category] || 0) + 1;
    puritySum += Math.max(...Object.values(counts)) / rows.length;
    purityGroups++;
  }
  const vertexPurity = purityGroups ? puritySum / purityGroups : 0;

  let flatTop3 = 0;
  let polyTop3 = 0;
  let noiseFlatTop1 = 0;
  let noisePolySameCategory = 0;
  const queryRows = mapped.filter((_, i) => i % 5 === 0);
  const start = hires();
  for (const qRow of queryRows) {
    const flat = mapped
      .filter(row => row !== qRow)
      .map(row => ({ row, score: qRow.vec.cosine(row.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (flat.some(x => x.row.category === qRow.category)) flatTop3++;

    const poly = mapped
      .filter(row => row !== qRow)
      .map(row => ({ row, score: dot4(qRow.q, row.q) + (qRow.vertex === row.vertex ? 0.15 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (poly.some(x => x.row.category === qRow.category)) polyTop3++;

    const noisy = noisyCopy(qRow.vec);
    const noisyQ = projectTo4d(noisy);
    const noisyVertex = snapTo600(noisyQ, vertices);
    const flatNoise = mapped.map(row => ({ row, score: noisy.cosine(row.vec) })).sort((a, b) => b.score - a.score)[0];
    if (flatNoise?.row === qRow) noiseFlatTop1++;
    const polyNoise = mapped.map(row => ({ row, score: dot4(noisyQ, row.q) + (noisyVertex === row.vertex ? 0.15 : 0) })).sort((a, b) => b.score - a.score)[0];
    if (polyNoise?.row?.category === qRow.category) noisePolySameCategory++;
  }
  const elapsedMs = hires() - start;
  const randomBaseline = 1 / Object.keys(categories).length;
  const result = {
    corpusSize: corpus.length,
    vertexCount: vertices.length,
    occupiedVertices: byVertex.size,
    vertexPurity: Number(vertexPurity.toFixed(4)),
    randomBaseline: Number(randomBaseline.toFixed(4)),
    flatRecallAt3: Number((flatTop3 / queryRows.length).toFixed(4)),
    polychoraRecallAt3: Number((polyTop3 / queryRows.length).toFixed(4)),
    noiseFlatTop1: Number((noiseFlatTop1 / queryRows.length).toFixed(4)),
    noisePolychoraSameCategory: Number((noisePolySameCategory / queryRows.length).toFixed(4)),
    elapsedMs: Number(elapsedMs.toFixed(2)),
    dim: DIM
  };
  const pass = vertices.length === 120 &&
    result.vertexPurity > randomBaseline &&
    result.flatRecallAt3 >= 0.5 &&
    result.polychoraRecallAt3 >= 0.5;
  recordProofMetric('polychora_pass', pass ? 1 : 0);
  return pass ? passLane('Polychora comparison emitted measurable structure above random baseline.', result)
              : failLane('Polychora comparison ran, but one or more evidence thresholds failed.', result);
}

async function probe(name, url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
    return { name, ok: res.ok, status: res.status, ms: Date.now() - started, body };
  } catch (err) {
    return { name, ok: false, errorType: err.name || 'Error', error: err.message || String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function runFullSystemProof() {
  const targets = [
    ['Dashboard', 'http://127.0.0.1:3001/health'],
    ['CNS', 'http://127.0.0.1:3334/api/status'],
    ['OpenJarvis', 'http://127.0.0.1:8080/health'],
    ['Leo', 'http://127.0.0.1:3400/health'],
    ['KAI', 'http://127.0.0.1:3401/health'],
    ['Gemini', 'http://127.0.0.1:3402/health'],
    ['Claudey', 'http://127.0.0.1:3403/health'],
    ['X', 'http://127.0.0.1:3404/health'],
    ['Groq', 'http://127.0.0.1:3405/health'],
    ['Analyst', 'http://127.0.0.1:3406/health'],
    ['Researcher', 'http://127.0.0.1:3407/health'],
    ['Kai Coder', 'http://127.0.0.1:3408/health'],
    ['Oracle', 'http://127.0.0.1:3410/health']
  ];
  const probes = await Promise.all(targets.map(([name, url]) => probe(name, url)));
  const cns = probes.find(p => p.name === 'CNS')?.body || {};
  const token = `KAI_PROOF_${Date.now()}`;
  const proofText = `Synthetic proof memory anchor ${token} confirms KAI lattice recall bridge integrity`;
  let ingestion = { attempted: true, ok: false, token, cleanup: 'logical namespace only; delete API unavailable' };
  try {
    const stored = await storeLattice(proofText, 'proof-suite', 2.0, 'proof_temp', token);
    let hits = [];
    let recalled = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      invalidateLatticeCache();
      await new Promise(r => setTimeout(r, attempt * 500));
      hits = await queryLattice(proofText, 10);
      recalled = hits.some(h => String(h.text || h.label || '').includes(token));
      if (recalled) break;
    }
    ingestion = {
      ...ingestion,
      stored,
      recalled,
      ok: stored && recalled,
      hitCount: hits.length,
      topHit: hits[0] ? {
        text: String(hits[0].text || hits[0].label || '').slice(0, 180),
        score: Number(hits[0].score ?? hits[0].similarity ?? 0)
      } : null
    };
  } catch (err) {
    ingestion.error = err.message;
  }

  const pass = probes.every(p => p.ok) && ingestion.ok;
  recordProofMetric('full_system_pass', pass ? 1 : 0);
  if (ingestion.ok) recordProofMetric('memory_ingestion_pass', 1);
  else recordProofMetric('memory_ingestion_pass', 0);
  return pass ? passLane('All ecosystem probes and synthetic memory ingestion passed.', {
    probes,
    ingestion,
    lattice: {
      totalCells: cns.total_cells ?? cns.lattice_size ?? null,
      rawPhiG: cns.phi_g ?? null,
      boundedPhiG: Number.isFinite(Number(cns.phi_g)) ? Math.max(0, Math.min(1, Number(cns.phi_g))) : null,
      chi: cns.chi ?? null,
      synapses: cns.synapses ?? null
    }
  }) : failLane('One or more ecosystem probes or synthetic memory ingestion checks failed.', { probes, ingestion });
}

const run = {
  generatedAt: new Date().toISOString(),
  audience: 'serious-builders',
  lanes: {
    efficiencyStability: runGovernorProof(),
    polychoraNovelty: runPolychoraProof(),
    fullSystemAlive: await runFullSystemProof()
  },
  elapsedMs: Date.now() - startedAt
};
run.pass = Object.values(run.lanes).every(lane => lane.pass);

const summary = buildProofSummary({ latestProof: run });
const paths = writeProofArtifacts(summary);
recordProofMetric('suite_pass', run.pass ? 1 : 0);
recordProofMetric('suite_elapsed_ms', run.elapsedMs);

const output = args.has('--summary')
  ? { pass: run.pass, lanes: Object.fromEntries(Object.entries(run.lanes).map(([k, v]) => [k, { pass: v.pass, summary: v.summary }])), paths }
  : { ...run, paths };

console.log(JSON.stringify(output, null, 2));
process.exit(run.pass ? 0 : 1);
