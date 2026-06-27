/**
 * Tracked module-level intervals + ordered shutdown hooks.
 * Pure timer registry — no Discord imports.
 */

const _intervals = new Set();
const _shutdownHooks = [];
let _handlersInstalled = false;

export function startModuleInterval(fn, ms) {
  const h = setInterval(fn, ms);
  if (typeof h.unref === 'function') h.unref();
  _intervals.add(h);
  return h;
}

export function clearModuleIntervals() {
  for (const h of _intervals) {
    try { clearInterval(h); } catch (_) {}
  }
  _intervals.clear();
}

export function getModuleIntervalCount() {
  return _intervals.size;
}

export function registerShutdownHook(fn) {
  if (typeof fn === 'function') _shutdownHooks.push(fn);
}

export function runShutdownHooks() {
  for (const fn of _shutdownHooks) {
    try { fn(); } catch (_) {}
  }
}

export function installShutdownHandlers() {
  if (_handlersInstalled) return;
  _handlersInstalled = true;
  const run = () => runShutdownHooks();
  process.on('exit', run);
  process.on('SIGINT', () => { run(); process.exit(0); });
  process.on('SIGTERM', () => { run(); process.exit(0); });
}