import http from 'http';
import { execSync } from 'child_process';

/**
 * Very simple IPC server for bots to receive signals from Oracle
 */
const _bootedAt = Date.now();

// ── BUG 1: stop the endless 'IPC port in use' flood ───────────────────────────
// Previously a second copy of a bot (e.g. a duplicate KAI / Gemini spawned by an
// overlapping launcher or a Phoenix relaunch) could NEVER bind its port, so it
// retried every 3s FOREVER and buried the log. We now:
//   1) On EADDRINUSE, probe the holder's /health. If it ANSWERS, a healthy
//      instance owns the port -> THIS process is the duplicate -> log once and
//      exit cleanly. We NEVER kill a healthy instance.
//   2) If /health does NOT answer but the port is bound (a stale/zombie of the
//      same app), reclaim it Leo-style (netstat + taskkill of the orphan PID),
//      then retry once.
//   3) Cap total bind attempts at KAI_IPC_MAX_BIND_RETRIES (default 5); after
//      that, log ONE clear line and exit instead of retrying indefinitely.
const MAX_BIND_RETRIES = Math.max(1, parseInt(process.env.KAI_IPC_MAX_BIND_RETRIES || '5', 10) || 5);
const BIND_RETRY_MS = Math.max(500, parseInt(process.env.KAI_IPC_BIND_RETRY_MS || '3000', 10) || 3000);

// Probe the LIVE holder of this port and return its IDENTITY.
// Returns { healthy: true, name } if the holder answers /health, else
// { healthy: false }. The /health body carries the holder's bot name, so the
// caller can tell a true self-duplicate apart from a port COLLISION (a
// different bot squatting the port due to a misconfigured port map).
async function _probeHolder(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return { healthy: false };
    const info = await res.json().catch(() => null);
    return { healthy: true, name: info && info.name ? info.name : 'unknown' };
  } catch (e) {
    return { healthy: false };
  }
}

// Reclaim a port held by a DEAD/orphan listener of the same app (Leo-style).
// Only ever called AFTER _holderIsHealthy() returned false, so we never kill a
// healthy instance. Windows-only; on other platforms it is a safe no-op.
function _reclaimDeadPort(port, name) {
  if (process.platform !== 'win32') return false;
  let killed = false;
  try {
    const protectedPids = new Set([0, process.pid, process.ppid]);
    const output = execSync('netstat -ano -p tcp').toString();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      const localPort = Number(parts[1].split(':').pop());
      const pid = parseInt(parts[4]);
      if (localPort === port && pid && !protectedPids.has(pid)) {
        console.warn('[' + name + '] Reclaiming port ' + port + ' from dead/orphan listener PID ' + pid + '...');
        try { execSync('taskkill /F /PID ' + pid); killed = true; } catch (_) {}
      }
    }
  } catch (e) {}
  return killed;
}

// `opts.routes` (optional) lets a SINGLE bot register extra READ-ONLY GET routes
// on its IPC server without changing this shared signature for the others. It is a
// map of { '/path': () => objectToJsonify }. The handler is sync, best-effort, and
// NEVER allowed to take the server down (any throw → 500 with an error field).
// Used by kai.mjs to expose GET /drives (in-process drive/metacognition values).
export function startBotServer(port, name, onTrigger, opts = {}) {
  let _bindAttempts = 0;
  const extraRoutes = (opts && opts.routes && typeof opts.routes === 'object') ? opts.routes : null;
  const server = http.createServer((req, res) => {
    // ── HEALTH PROBE — used by Oracle's heartbeat-monitor (Stage 11) ──
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name,
        pid: process.pid,
        uptime_ms: Date.now() - _bootedAt,
        rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        ts: Date.now(),
      }));
      return;
    }
    // ── EXTRA READ-ONLY GET ROUTES (opt-in per bot) ──
    if (req.method === 'GET' && extraRoutes) {
      const pathOnly = String(req.url || '').split('?')[0];
      const fn = extraRoutes[pathOnly];
      if (typeof fn === 'function') {
        try {
          const payload = fn();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload == null ? {} : payload));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e && e.message ? e.message : 'route error' }));
        }
        return;
      }
    }
    if (req.method === 'POST' && (req.url === '/trigger' || req.url === '/signal')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        // Respond immediately so the caller doesn't time out waiting for the handler
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
        // Run the async callback separately so its awaits actually execute
        Promise.resolve(onTrigger(JSON.parse(body))).catch(e => {
          console.error(`[IPC] onTrigger error:`, e.message);
        });
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      _bindAttempts++;
      // Resolve the situation asynchronously: is the holder healthy (true
      // duplicate -> we exit) or dead (zombie -> reclaim and retry)?
      (async () => {
        const holder = await _probeHolder(port);
        if (holder.healthy && holder.name === name) {
          console.error('[' + name + '] IPC port ' + port + ' is already owned by a HEALTHY ' + name + ' instance. This is a duplicate launch — exiting cleanly so it stops flooding.');
          // Exit 0: a healthy instance is already serving, so this duplicate is
          // simply not needed. 0 avoids the ecosystem-manager auto-respawn loop.
          process.exit(0);
          return;
        }
        if (holder.healthy && holder.name !== name) {
          // IDENTITY MISMATCH — this is NOT a self-duplicate, it is a PORT
          // COLLISION: a DIFFERENT live bot holds our port (misconfigured port
          // map in shared/identities.mjs). Do NOT pretend to be a healthy
          // self-duplicate, and do NOT kill the other bot. Log loudly and exit;
          // the ecosystem-manager's repeated-clean-exit backoff (Fix 4) stops
          // this from tight-respawn-looping.
          console.error('[' + name + '] PORT COLLISION: ' + name + ' port ' + port + ' is held by a DIFFERENT healthy bot (' + holder.name + '). Fix the port map in shared/identities.mjs. Exiting — will NOT kill ' + holder.name + '.');
          process.exit(0);
          return;
        }
        if (_bindAttempts >= MAX_BIND_RETRIES) {
          console.error('[' + name + '] IPC port ' + port + ' still unbindable after ' + _bindAttempts + ' attempts and no healthy holder. Giving up to avoid an infinite retry flood — exiting.');
          process.exit(1);
          return;
        }
        // Stale/zombie holder of the same app: reclaim it, then retry.
        const reclaimed = _reclaimDeadPort(port, name);
        const waitMs = reclaimed ? 1000 : BIND_RETRY_MS;
        console.warn('[' + name + '] IPC port ' + port + ' in use by a dead/orphan listener — ' + (reclaimed ? 'reclaimed, ' : '') + 'retrying in ' + waitMs + 'ms (attempt ' + _bindAttempts + '/' + MAX_BIND_RETRIES + ')...');
        setTimeout(() => {
          try { server.close(); } catch (_) {}
          server.listen(port, '127.0.0.1');
        }, waitMs);
      })();
    } else {
      console.error('[' + name + '] IPC server error:', err.message);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[${name}] IPC server listening on ${port}`);
  });
  
  return server;
}

/**
 * Send a signal from Oracle to a specific bot
 */
export async function sendBotSignal(port, payload) {
  if (!port) {
    console.warn(`[IPC] Attempted to signal bot on invalid port: ${port}`);
    return;
  }
  try {
    // GUARD: a 4s timeout so a hung/half-open bot socket can't keep this fetch
    // open indefinitely. Without it, repeated signaling to a wedged bot piled
    // up outbound connections (a slow resource leak under any signal storm).
    await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000)
    });
  } catch (e) {
    const transient = /fetch failed|ECONNREFUSED|connection refused|ECONNRESET|socket hang up/i;
    if (!transient.test(e.message)) {
      console.warn(`[IPC] Failed to signal bot on port ${port}:`, e.message);
    }
  }
}
