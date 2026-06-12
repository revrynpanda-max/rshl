#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import { AI_REGISTRY } from '../shared/identities.mjs';
import { BOT_PORTS } from '../shared/channel-rules.mjs';
import { getSelfOptimizeSnapshot } from '../shared/resource-saver.mjs';
import { invalidateLatticeCache, queryLattice, storeLattice } from '../shared/lattice-bridge.mjs';

const STATE_PATH = 'c:/KAI/tools/oracle-discord/state/ecosystem-manager.json';
const args = new Set(process.argv.slice(2));

function tokenEnvFor(name) {
  if (name === 'Oracle') return 'ORACLE_DISCORD_TOKEN';
  if (name === 'Kai Coder') return 'ORACLE_DISCORD_TOKEN_ORACLE_CODER';
  return `ORACLE_DISCORD_TOKEN_${name.toUpperCase().replace(/\s+/g, '_')}`;
}

async function probe(name, url, timeoutMs = 5000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
    return { name, ok: res.ok, status: res.status, ms: Date.now() - started, body };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, errorType: err.name || 'Error', error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function memoryProbe() {
  const token = `KAI_HEALTH_${Date.now()}`;
  const text = `Synthetic health memory anchor ${token} confirms KAI lattice recall bridge integrity`;
  const stored = await storeLattice(text, 'system-health', 2.0, 'proof_temp', token);
  let hits = [];
  let recalled = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    invalidateLatticeCache();
    await new Promise(r => setTimeout(r, attempt * 500));
    hits = await queryLattice(text, 10);
    recalled = hits.some(h => String(h.text || h.label || '').includes(token));
    if (recalled) break;
  }
  return {
    ok: stored && recalled,
    token,
    stored,
    recalled,
    hitCount: hits.length,
    topHit: hits[0] ? {
      text: String(hits[0].text || hits[0].label || '').slice(0, 180),
      score: Number(hits[0].score ?? hits[0].similarity ?? 0)
    } : null
  };
}

const ipcTargets = [
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

const tokens = Object.keys(AI_REGISTRY).map(name => {
  const env = tokenEnvFor(name);
  return { name, env, configured: Boolean((process.env[env] || '').trim()), length: (process.env[env] || '').trim().length };
});

let managerState = null;
try {
  if (fs.existsSync(STATE_PATH)) managerState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
} catch (err) {
  managerState = { error: err.message };
}

const [probes, governor, memory] = await Promise.all([
  Promise.all(ipcTargets.map(([name, url]) => probe(name, url))),
  getSelfOptimizeSnapshot(false).catch(err => ({ error: err.message })),
  args.has('--skip-memory') ? Promise.resolve({ skipped: true }) : memoryProbe().catch(err => ({ ok: false, error: err.message }))
]);

const configuredPorts = Object.fromEntries(Object.entries(BOT_PORTS).filter(([name]) => name !== 'Oracle Coder'));
const registryPorts = Object.fromEntries(Object.entries(AI_REGISTRY).map(([name, data]) => [name, data.port]));
const portRegistryOk = Object.entries(configuredPorts).every(([name, port]) => registryPorts[name] === port);
const missingTokens = tokens.filter(t => !t.configured).map(t => t.name);
const failedProbes = probes.filter(p => !p.ok).map(p => p.name);
const criticalFailed = failedProbes.filter(name => ['Dashboard', 'CNS', 'OpenJarvis', 'Leo', 'KAI', 'Oracle'].includes(name));

const result = {
  generatedAt: new Date().toISOString(),
  pass: criticalFailed.length === 0 && missingTokens.length === 0 && portRegistryOk && (memory.skipped || memory.ok),
  failedProbes,
  criticalFailed,
  tokens,
  portRegistryOk,
  managerState,
  governor: governor?.tier ? {
    tier: governor.tier,
    profile: governor.profile,
    cpu: governor.sampled?.cpuLoad ?? governor.cpuLoad,
    gpu: governor.sampled?.gpuLoad ?? governor.gpuLoad,
    mem: governor.sampled?.memLoad ?? governor.memLoad,
    projectMemoryMB: governor.project?.memoryMB,
    deniedSpots: Object.entries(governor.spots || {}).filter(([, spot]) => !spot.allowed).map(([name]) => name)
  } : governor,
  memory,
  probes
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
