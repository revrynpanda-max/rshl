/**
 * KAI Hippocampus — HTTP Direct Write Path
 * ─────────────────────────────────────────
 * Architecture (unchanged vs new):
 *
 *   Discord  →  Lattice  →  Hippocampus    ← UNCHANGED (Discord always lattice-first)
 *   HTTP POST  ──────────→  Hippocampus    ← NEW: this module
 *   KAI Engine  ─────────→  Hippocampus    ← UNCHANGED (internal IPC)
 *
 * Why two paths?
 *   The lattice path ensures Discord content is cross-indexed and available
 *   for all agents to resonate on before it lands in long-term memory.
 *   The direct HTTP path is for trusted internal services (Oracle, Phoenix,
 *   AR Kaiverse, external tools) that already have canonical content and
 *   don't need lattice broadcast.
 *
 * Port : 3415  (set HIPPO_HTTP_PORT to override)
 *
 * Endpoints:
 *   GET  /api/hippocampus/status
 *   POST /api/hippocampus/write          { content, type, tag, source, energy, valence, ttl, metadata }
 *   POST /api/hippocampus/recall         { type, tag, limit, since, minEnergy }
 *   POST /api/hippocampus/cluster-list
 *   POST /api/hippocampus/expire-sweep   (manual TTL sweep)
 *
 * Usage from other modules:
 *   import { hippoWrite, hippoRecall } from './hippocampus-http-write.mjs';
 *   await hippoWrite({ content: 'Oracle said...', type: 'dialogue', tag: 'oracle', source: 'oracle' });
 */

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer } from 'http';

// ─── Config ────────────────────────────────────────────────────────────────
const HIPPO_PORT  = parseInt(process.env.HIPPO_HTTP_PORT || '3415', 10);
const HIPPO_DIR   = 'state/hippocampus';
const INDEX_FILE  = `${HIPPO_DIR}/index.json`;
const WRITE_LOG   = `${HIPPO_DIR}/http-write-log.jsonl`;

// ─── Boot ──────────────────────────────────────────────────────────────────
fs.mkdirSync(HIPPO_DIR, { recursive: true });

let INDEX = {
  clusters:     {},
  totalWrites:  0,
  httpWrites:   0,
  latticeWrites: 0,
  lastWrite:    null,
  startedAt:    Date.now()
};

if (fs.existsSync(INDEX_FILE)) {
  try { INDEX = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { /* corrupt index — start fresh */ }
}

function saveIndex() {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(INDEX, null, 2));
}

// ─── Cluster helpers ───────────────────────────────────────────────────────
function clusterFile(type, tag) {
  const safe = `${type}_${tag}`.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(HIPPO_DIR, `cluster_${safe}.jsonl`);
}

// ─── Core write ───────────────────────────────────────────────────────────
/**
 * hippoWrite — write a memory entry via HTTP path (not lattice).
 *
 * @param {object} payload
 *   content   {string}  required — the memory text / structured data
 *   type      {string}  'memory' | 'dialogue' | 'claim' | 'signal' | 'event' | 'dream'
 *   tag       {string}  sub-label, e.g. 'oracle', 'phoenix', 'user:ryan'
 *   source    {string}  originating service, defaults to 'http'
 *   energy    {number}  0–2, importance weight (default 1.0)
 *   valence   {number}  -1–1, emotional tone (default 0)
 *   ttl       {number|null}  ms until expiry, null = permanent
 *   metadata  {object}  any extra fields
 *
 * @returns {{ ok: true, id, type, tag, route: 'http-direct' }}
 */
export function hippoWrite(payload = {}) {
  const {
    content,
    type     = 'memory',
    tag      = 'general',
    source   = 'http',
    energy   = 1.0,
    valence  = 0,
    ttl      = null,
    metadata = {}
  } = payload;

  if (!content) throw new Error('[Hippocampus] content is required');

  const id  = crypto.randomUUID();
  const ts  = Date.now();
  const entry = {
    id, content, type, tag, source,
    energy: parseFloat(energy) || 1.0,
    valence: parseFloat(valence) || 0,
    ttl,
    metadata,
    ts,
    route: 'http-direct'
  };

  // Append to cluster file
  fs.appendFileSync(clusterFile(type, tag), JSON.stringify(entry) + '\n');

  // Append to write log (lightweight index line)
  fs.appendFileSync(WRITE_LOG, JSON.stringify({
    id, type, tag, source, energy: entry.energy, ts
  }) + '\n');

  // Update index
  const ck = `${type}:${tag}`;
  if (!INDEX.clusters[ck]) INDEX.clusters[ck] = { count: 0, lastWrite: null, file: clusterFile(type, tag) };
  INDEX.clusters[ck].count++;
  INDEX.clusters[ck].lastWrite = ts;
  INDEX.totalWrites++;
  INDEX.httpWrites++;
  INDEX.lastWrite = ts;
  saveIndex();

  return { ok: true, id, type, tag, route: 'http-direct' };
}

// ─── Core recall ──────────────────────────────────────────────────────────
/**
 * hippoRecall — retrieve memories from a cluster.
 *
 * @param {object} opts
 *   type       cluster type (default 'memory')
 *   tag        cluster tag (default 'general')
 *   limit      max entries returned (default 20)
 *   since      unix ms — only entries after this (default 0)
 *   minEnergy  minimum energy weight (default 0)
 *
 * @returns {object[]}  entries, most-recent first, TTL-expired entries excluded
 */
export function hippoRecall(opts = {}) {
  const {
    type      = 'memory',
    tag       = 'general',
    limit     = 20,
    since     = 0,
    minEnergy = 0
  } = opts;

  const file = clusterFile(type, tag);
  if (!fs.existsSync(file)) return [];

  const now = Date.now();
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e =>
      e &&
      e.ts >= since &&
      e.energy >= minEnergy &&
      (!e.ttl || e.ts + e.ttl > now)  // TTL check
    )
    .slice(-Math.min(limit, 500))
    .reverse();
}

// ─── TTL sweep ─────────────────────────────────────────────────────────────
function expireSweep() {
  const now  = Date.now();
  let swept  = 0;

  for (const ck of Object.keys(INDEX.clusters)) {
    const [type, tag] = ck.split(':');
    const file = clusterFile(type, tag);
    if (!fs.existsSync(file)) continue;

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const alive = lines.filter(l => {
      try {
        const e = JSON.parse(l);
        return !e.ttl || e.ts + e.ttl > now;
      } catch { return false; }
    });
    if (alive.length < lines.length) {
      swept += lines.length - alive.length;
      fs.writeFileSync(file, alive.join('\n') + (alive.length ? '\n' : ''));
    }
  }

  return swept;
}

// ─── HTTP server ───────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data',  chunk => body += chunk);
    req.on('end',   () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'X-KAI-Module':   'hippocampus-http',
    'Content-Length': Buffer.byteLength(json)
  });
  res.end(json);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${HIPPO_PORT}`);
  const p   = url.pathname;

  try {

    // ── Status ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && p === '/api/hippocampus/status') {
      return send(res, 200, {
        ok:      true,
        port:    HIPPO_PORT,
        note:    'Discord → Lattice → Hippocampus route unchanged. This port = direct HTTP only.',
        ...INDEX
      });
    }

    // ── Write ───────────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/api/hippocampus/write') {
      const body   = await readBody(req);
      const result = hippoWrite(body);
      return send(res, 200, result);
    }

    // ── Recall ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/api/hippocampus/recall') {
      const body     = await readBody(req);
      const memories = hippoRecall(body);
      return send(res, 200, { ok: true, count: memories.length, memories });
    }

    // ── Cluster list ────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/api/hippocampus/cluster-list') {
      const clusters = Object.entries(INDEX.clusters).map(([key, v]) => ({ key, ...v }));
      return send(res, 200, { ok: true, total: INDEX.totalWrites, clusters });
    }

    // ── Manual TTL sweep ────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/api/hippocampus/expire-sweep') {
      const swept = expireSweep();
      return send(res, 200, { ok: true, swept });
    }

    send(res, 404, { error: 'unknown endpoint', available: [
      'GET  /api/hippocampus/status',
      'POST /api/hippocampus/write',
      'POST /api/hippocampus/recall',
      'POST /api/hippocampus/cluster-list',
      'POST /api/hippocampus/expire-sweep'
    ]});

  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(HIPPO_PORT, () => {
  console.log(`[KAI Hippocampus HTTP] Direct write path live → :${HIPPO_PORT}`);
  console.log(`[KAI Hippocampus HTTP] Discord route unchanged: Discord → Lattice → Hippocampus`);
  console.log(`[KAI Hippocampus HTTP] Direct write: POST :${HIPPO_PORT}/api/hippocampus/write`);
});

// Auto-sweep TTL entries every 10 minutes
setInterval(expireSweep, 10 * 60 * 1000);

export default { hippoWrite, hippoRecall };
