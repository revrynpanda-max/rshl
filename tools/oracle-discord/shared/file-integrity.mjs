// shared/file-integrity.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 5: file integrity (checksum + watcher).
//
// PURPOSE
//   The sync layer between the running ecosystem and disk has been corrupting
//   files this session (truncations, null-byte padding). This module gives
//   the system the ability to NOTICE on its own: it records SHA256 of every
//   tracked source file, and on startup (or on demand) compares current state
//   vs the stored snapshot. Drift → metrics + log; serious drift (file
//   shrunk drastically, became unparseable, NUL bytes appeared) → correlation
//   alert.
//
// USAGE
//   import { snapshot, verify, watchOnce } from './file-integrity.mjs';
//   snapshot();          // capture baseline (call after a known-good commit)
//   verify();            // compare current files to baseline; returns drift list
//   watchOnce();         // verify() + emit any drift as metrics
//
// SCOPE
//   By default: every .mjs / .js / .cjs / .rs / .toml under the project root.
//   Skips node_modules, .git, target, sandbox, .bak files, state/, logs/.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { recordMetric } from './metrics-store.mjs';

function resolveRoot() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..');
  } catch (_) {
    return process.env.KAI_PROJECT_ROOT || 'c:/KAI/tools/oracle-discord';
  }
}
const ROOT = resolveRoot();
const SNAPSHOT_FILE = path.join(ROOT, 'state', 'file-integrity-snapshot.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'sandbox', '.kai-backups', 'state', 'logs', 'scratch']);
const TRACK_EXT = new Set(['.mjs', '.js', '.cjs', '.rs', '.toml', '.json']);

function walkTracked(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.includes('.bak') || e.name.endsWith('.bak')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTracked(full, out);
    else if (TRACK_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const nuls = buf.indexOf(0);   // first NUL position (-1 if clean)
    return {
      sha,
      size: buf.length,
      nul_offset: nuls >= 0 ? nuls : null,
      ends_with_newline: buf.length > 0 && buf[buf.length - 1] === 0x0A,
    };
  } catch (_) { return null; }
}

/** Take a snapshot of every tracked file and persist it. Returns count. */
export function snapshot() {
  const files = walkTracked(ROOT);
  const out = {};
  for (const f of files) {
    const h = hashFile(f);
    if (h) out[path.relative(ROOT, f)] = h;
  }
  try { fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true }); } catch (_) {}
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ ts: Date.now(), root: ROOT, files: out }, null, 2));
  return Object.keys(out).length;
}

/**
 * Compare current files to the saved snapshot.
 * Returns { added, removed, changed, corrupted, total_tracked }.
 * "corrupted" highlights drift that LOOKS like sync damage:
 *   - NUL bytes present where there were none before
 *   - file shrunk by >25%
 *   - file no longer ends in a newline (often a sign of truncation)
 */
export function verify() {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
  catch (_) { return { error: 'no snapshot — run snapshot() first' }; }

  const files = walkTracked(ROOT);
  const currentRel = new Set(files.map(f => path.relative(ROOT, f)));
  const snapRel = new Set(Object.keys(snap.files));

  const added = [...currentRel].filter(f => !snapRel.has(f));
  const removed = [...snapRel].filter(f => !currentRel.has(f));
  const changed = [];
  const corrupted = [];

  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (!snap.files[rel]) continue;
    const prev = snap.files[rel];
    const cur = hashFile(f);
    if (!cur || cur.sha === prev.sha) continue;
    changed.push({ file: rel, prev, cur });

    // Corruption heuristics:
    const corruptedSigns = [];
    if (cur.nul_offset !== null && prev.nul_offset === null) corruptedSigns.push('NUL bytes appeared');
    if (cur.size < prev.size * 0.75) corruptedSigns.push(`shrank ${prev.size}->${cur.size} bytes`);
    if (prev.ends_with_newline && !cur.ends_with_newline) corruptedSigns.push('lost trailing newline (possible mid-write truncation)');
    if (corruptedSigns.length) corrupted.push({ file: rel, signs: corruptedSigns, prev, cur });
  }

  return {
    snapshot_ts: snap.ts,
    total_tracked: snapRel.size,
    added, removed, changed_count: changed.length, corrupted,
  };
}

/**
 * Run verify() and emit drift to the metrics store + console.
 * Returns the same shape as verify().
 */
export function watchOnce({ emitConsole = true } = {}) {
  const res = verify();
  if (res.error) return res;

  recordMetric('file-integrity', 'tracked_count', res.total_tracked);
  recordMetric('file-integrity', 'changed_count', res.changed_count);
  recordMetric('file-integrity', 'corrupted_count', res.corrupted.length);

  if (res.corrupted.length && emitConsole) {
    console.warn(`🚨 [file-integrity] ${res.corrupted.length} files show sync-corruption signatures:`);
    for (const c of res.corrupted) {
      console.warn(`   - ${c.file}: ${c.signs.join('; ')}`);
      recordMetric('file-integrity', 'corruption_event', 1, {
        file: c.file, signs: c.signs.join(','),
      });
    }
  }
  return res;
}

let _interval = null;
export function startIntegrityWatcher({ intervalMs = 5 * 60_000 } = {}) {
  if (_interval) return;
  // Take an initial snapshot if none exists — first run establishes baseline.
  try {
    fs.statSync(SNAPSHOT_FILE);
  } catch (_) {
    const n = snapshot();
    console.log(`[file-integrity] baseline snapshot created (${n} files tracked)`);
  }
  watchOnce();
  _interval = setInterval(() => watchOnce(), intervalMs);
  console.log(`[file-integrity] watcher started (interval=${intervalMs/1000}s)`);
}
export function stopIntegrityWatcher() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}
