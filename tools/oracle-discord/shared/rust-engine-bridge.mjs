// shared/rust-engine-bridge.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 9: Rust engine instrumentation via HTTP polling (NO Rust changes).
//
// The Rust kai.exe Oracle server already exposes /api/session on port 3334
// with the lattice's vitals (cells, phi_g, chi, rho, valence, mood, tick).
// We just poll it every 15s and translate the response into metrics. The
// Rust side stays unchanged — pure read-side instrumentation.
//
// Emits to the metrics store as source='rust-engine':
//   cells           lattice cell count
//   phi_g           goal-aligned emergence
//   chi             contradiction / friction
//   rho             cognitive density
//   valence         drive valence (-1..+1)
//   tick            heartbeat tick (monotonic counter)
//   reachable       1 if last poll succeeded, 0 if not
// ──────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { recordMetric } from './metrics-store.mjs';

const URL_HOST = '127.0.0.1';
const URL_PORT = parseInt(process.env.KAI_ORACLE_PORT || '3334', 10);
const URL_PATH = '/api/session';
const TICK_MS  = 15_000;

let _interval = null;

function fetchOnce() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: URL_HOST, port: URL_PORT, path: URL_PATH, method: 'GET', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch (e) { resolve({ ok: false, err: 'parse: ' + e.message }); }
        });
      }
    );
    req.on('error',   () => resolve({ ok: false, err: 'unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.end();
  });
}

async function tick() {
  const r = await fetchOnce();
  if (!r.ok) {
    recordMetric('rust-engine', 'reachable', 0, { err: r.err || ('http_' + r.status) });
    return;
  }
  recordMetric('rust-engine', 'reachable', 1);

  // The /api/session response may have vitals at root or nested under .vitals.
  // Handle both shapes defensively.
  const d = r.data;
  const v = d?.vitals || d || {};
  const num = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : null;

  if (num(v.cells) !== null)       recordMetric('rust-engine', 'cells',    v.cells);
  if (num(v.phi_g) !== null)       recordMetric('rust-engine', 'phi_g',    v.phi_g);
  if (num(v.chi) !== null)         recordMetric('rust-engine', 'chi',      v.chi);
  if (num(v.rho) !== null)         recordMetric('rust-engine', 'rho',      v.rho);
  if (num(v.valence) !== null)     recordMetric('rust-engine', 'valence',  v.valence);
  if (num(v.tick) !== null)        recordMetric('rust-engine', 'tick',     v.tick);
  if (num(v.cell_count) !== null)  recordMetric('rust-engine', 'cells',    v.cell_count); // alt name
  if (typeof v.mood === 'string')  recordMetric('rust-engine', 'mood',     v.mood);
}

export function startRustEngineBridge({ tickMs = TICK_MS } = {}) {
  if (_interval) return;
  console.log(`[rust-engine-bridge] polling http://${URL_HOST}:${URL_PORT}${URL_PATH} every ${tickMs/1000}s`);
  tick();
  _interval = setInterval(tick, tickMs);
}

export function stopRustEngineBridge() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}
