import fs from 'fs';
import path from 'path';
import { aggregateMetric, latestMetric, queryMetrics, recordMetric } from './metrics-store.mjs';

const PROOF_DIR = 'c:/KAI/tools/oracle-discord/state/proof';
const LATEST_JSON = path.join(PROOF_DIR, 'latest-proof.json');
const LATEST_MD = path.join(PROOF_DIR, 'latest-proof.md');

const WINDOWS = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '24h': 24 * 60 * 60_000
};

function ensureProofDir() {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
}

function numericAgg(source, metric, windowMs, tagMatch = null) {
  const agg = aggregateMetric(source, metric, windowMs, tagMatch);
  if (!agg) return null;
  return {
    n: agg.n,
    avg: Number(agg.avg.toFixed(4)),
    min: Number(agg.min.toFixed(4)),
    max: Number(agg.max.toFixed(4))
  };
}

function latestValue(source, metric, tagMatch = null) {
  const rec = latestMetric(source, metric, tagMatch);
  return rec ? rec.value : null;
}

export function boundedPhi(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function recordProofMetric(metric, value, tags = {}) {
  recordMetric('proof-suite', metric, value, tags);
}

function summarizeWindow(windowMs) {
  const rawPhi = numericAgg('rust-engine', 'phi_g', windowMs);
  const rawPhiLatest = latestValue('rust-engine', 'phi_g');
  return {
    hardware: {
      cpuPct: numericAgg('performance-monitor', 'cpu_pct', windowMs),
      gpuPct: numericAgg('performance-monitor', 'gpu_pct', windowMs),
      memPct: numericAgg('performance-monitor', 'mem_pct', windowMs)
    },
    governor: {
      latestTier: latestValue('proof-governor', 'tier'),
      projectMemoryMB: numericAgg('proof-governor', 'project_memory_mb', windowMs),
      projectPressure: numericAgg('proof-governor', 'project_pressure', windowMs),
      drift: numericAgg('proof-governor', 'drift', windowMs),
      processCount: numericAgg('proof-governor', 'process_count', windowMs),
      actions: queryMetrics({
        source: 'proof-governor',
        metric: 'action',
        since: Date.now() - windowMs,
        limit: 50
      }).map(r => ({ at: new Date(r.ts).toISOString(), action: r.value, tags: r.tags || {} }))
    },
    lattice: {
      cells: numericAgg('rust-engine', 'cells', windowMs),
      rawPhiG: rawPhi,
      boundedPhiG: rawPhi ? {
        n: rawPhi.n,
        avg: boundedPhi(rawPhi.avg),
        min: boundedPhi(rawPhi.min),
        max: boundedPhi(rawPhi.max)
      } : null,
      latestRawPhiG: rawPhiLatest,
      latestBoundedPhiG: boundedPhi(rawPhiLatest),
      chi: numericAgg('rust-engine', 'chi', windowMs)
    },
    tasks: {
      deferred: numericAgg('proof-task', 'deferred', windowMs),
      completed: numericAgg('proof-task', 'completed', windowMs),
      failures: numericAgg('proof-task', 'failure', windowMs)
    }
  };
}

export function buildProofSummary(extra = {}) {
  const windows = {};
  for (const [label, ms] of Object.entries(WINDOWS)) {
    windows[label] = summarizeWindow(ms);
  }

  let latestProof = null;
  try {
    if (fs.existsSync(LATEST_JSON)) {
      const parsed = JSON.parse(fs.readFileSync(LATEST_JSON, 'utf8'));
      let candidate = parsed;
      while (candidate?.latestProof && !candidate.lanes) candidate = candidate.latestProof;
      latestProof = candidate;
    }
  } catch {}

  return {
    generatedAt: new Date().toISOString(),
    audience: 'serious-builders',
    windows,
    latestProof,
    ...extra
  };
}

export function renderProofMarkdown(summary) {
  const latest = summary.latestProof;
  const w30 = summary.windows?.['30m'] || {};
  const gov = w30.governor || {};
  const lattice = w30.lattice || {};
  const hw = w30.hardware || {};
  const lines = [
    '# KAI Proof Report',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    '## Current Evidence',
    '',
    `- Governor tier: ${gov.latestTier || 'unknown'}`,
    `- CPU avg 30m: ${hw.cpuPct?.avg ?? 'n/a'}%`,
    `- GPU avg 30m: ${hw.gpuPct?.avg ?? 'n/a'}%`,
    `- Memory avg 30m: ${hw.memPct?.avg ?? 'n/a'}%`,
    `- Project memory avg 30m: ${gov.projectMemoryMB?.avg ?? 'n/a'} MB`,
    `- Lattice cells avg 30m: ${lattice.cells?.avg ?? 'n/a'}`,
    `- raw phi_g avg 30m: ${lattice.rawPhiG?.avg ?? 'n/a'}`,
    `- bounded phi_g avg 30m: ${lattice.boundedPhiG?.avg ?? 'n/a'}`,
    `- chi avg 30m: ${lattice.chi?.avg ?? 'n/a'}`,
    '',
    '## Latest Proof Suite',
    ''
  ];

  if (latest?.lanes) {
    for (const [name, lane] of Object.entries(latest.lanes)) {
      lines.push(`- ${name}: ${lane.pass ? 'PASS' : 'FAIL'} (${lane.summary || 'no summary'})`);
    }
  } else {
    lines.push('- No proof suite artifact has been generated yet.');
  }

  if (gov.actions?.length) {
    lines.push('', '## Recent Governor Actions', '');
    for (const action of gov.actions.slice(-8)) {
      lines.push(`- ${action.at}: ${action.action}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function writeProofArtifacts(summary) {
  ensureProofDir();
  const artifact = {
    pass: summary.latestProof?.pass ?? null,
    lanes: summary.latestProof?.lanes ?? null,
    ...summary
  };
  fs.writeFileSync(LATEST_JSON, JSON.stringify(artifact, null, 2), 'utf8');
  fs.writeFileSync(LATEST_MD, renderProofMarkdown(summary), 'utf8');
  return { jsonPath: LATEST_JSON, markdownPath: LATEST_MD };
}

export const proofPaths = {
  dir: PROOF_DIR,
  latestJson: LATEST_JSON,
  latestMarkdown: LATEST_MD
};

/**
 * Detects if the global phi (phi_g) has plateaued over the last N readings.
 * Useful for the RSI loop to know when to stop aggressive optimization and focus on consolidation.
 */
export function detectPhiPlateau(windowTicks = 10, varianceThreshold = 0.0001) {
  const recent = queryMetrics({
    source: 'rust-engine',
    metric: 'phi_g',
    limit: windowTicks
  });
  
  if (!recent || recent.length < windowTicks) return false;
  
  const values = recent.map(r => r.value).filter(v => Number.isFinite(v));
  if (values.length < windowTicks) return false;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  
  // If variance is extremely low, we've flatlined
  return variance < varianceThreshold;
}
