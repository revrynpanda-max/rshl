/**
 * connectivity.mjs — the fleet's single source of truth for "are we online?".
 *
 * Why this exists: this is a PORTABLE laptop server (hotspot/tether). When the
 * connection drops mid-run, anything that reaches the internet (Gemini Live voice,
 * web search, cloud providers) starts failing — and some of it used to PANIC:
 * the voice bridge would burn its 3 reconnect attempts in a couple seconds, all
 * fail, and give up, leaving Leo dead even after the internet came back.
 *
 * The doctrine here:
 *   • Internet-dependent features ASK isOnline() before acting, and when offline
 *     they go DORMANT (stop hammering, no crash) and wait — they do NOT give up.
 *   • Local features (the Rust engine, the lattice, local memory) never depend on
 *     this and keep running the whole time — dormant-but-aware, not dead.
 *   • The instant the connection returns, everything resumes automatically.
 *
 * Detection uses a raw TCP connect to well-known anycast IPs (1.1.1.1:443,
 * 8.8.8.8:53) — NOT a DNS lookup, because the OS caches DNS and would lie about
 * being online during an outage. A TCP handshake only completes if we're truly on.
 */
import net from 'net';
import { EventEmitter } from 'events';

// Anycast IPs that are up essentially always; raw TCP so no DNS dependency.
const PROBES = [
  { host: '1.1.1.1', port: 443 },  // Cloudflare HTTPS
  { host: '8.8.8.8', port: 53 },   // Google DNS
  { host: '1.0.0.1', port: 443 },  // Cloudflare secondary
];
const INTERVAL_ONLINE_MS  = 15_000; // relaxed polling while healthy
const INTERVAL_OFFLINE_MS = 5_000;  // poll faster while down so we recover quickly
const FAILS_TO_DECLARE_OFFLINE = 2; // debounce: need 2 misses (avoid blips flapping)
const PROBE_TIMEOUT_MS = 3_000;

function tcpProbe({ host, port }, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    let sock;
    try {
      sock = net.createConnection({ host, port });
    } catch (_) { return resolve(false); }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

class Connectivity extends EventEmitter {
  constructor() {
    super();
    this._online = true;          // optimistic at boot; first probe corrects it
    this._fails = 0;
    this._timer = null;
    this._started = false;
    this._lastChange = Date.now();
    this._wentOfflineAt = 0;
  }

  isOnline() { return this._online; }
  getStatus() {
    return {
      online: this._online,
      since: this._lastChange,
      offlineForMs: this._online ? 0 : Date.now() - (this._wentOfflineAt || this._lastChange),
    };
  }

  async _probeOnce() {
    for (const p of PROBES) {
      if (await tcpProbe(p)) return true;
    }
    return false;
  }

  async _tick() {
    let reachable = false;
    try { reachable = await this._probeOnce(); } catch (_) { reachable = false; }

    if (reachable) {
      this._fails = 0;
      if (!this._online) this._transition(true);
    } else {
      this._fails++;
      if (this._online && this._fails >= FAILS_TO_DECLARE_OFFLINE) this._transition(false);
    }
    this._schedule();
  }

  _transition(online) {
    this._online = online;
    this._lastChange = Date.now();
    if (!online) {
      this._wentOfflineAt = Date.now();
      console.warn('[Connectivity] 🔴 Internet LOST — internet features going dormant (will auto-resume). Local engine/memory stay alive.');
    } else {
      const downSec = Math.round((Date.now() - (this._wentOfflineAt || Date.now())) / 1000);
      console.log(`[Connectivity] 🟢 Internet RESTORED after ~${downSec}s — internet features resuming.`);
    }
    try { this.emit(online ? 'online' : 'offline', this.getStatus()); } catch (_) {}
    try { this.emit('change', this.getStatus()); } catch (_) {}
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    const delay = this._online ? INTERVAL_ONLINE_MS : INTERVAL_OFFLINE_MS;
    this._timer = setTimeout(() => this._tick().catch(() => {}), delay);
    if (this._timer.unref) this._timer.unref(); // never keep the process alive just for this
  }

  start() {
    if (this._started) return this;
    this._started = true;
    this._tick().catch(() => {}); // immediate first check
    return this;
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._started = false;
  }

  /** Resolves immediately if online, otherwise the next time we come back online. */
  whenOnline() {
    if (this._online) return Promise.resolve();
    return new Promise((resolve) => this.once('online', () => resolve()));
  }
}

// One shared monitor per process. Auto-start on first import so every feature
// that imports it gets a live signal without extra wiring.
export const connectivity = new Connectivity().start();
export function isOnline() { return connectivity.isOnline(); }
export function whenOnline() { return connectivity.whenOnline(); }
export function onConnectivityChange(fn) { connectivity.on('change', fn); return () => connectivity.off('change', fn); }
