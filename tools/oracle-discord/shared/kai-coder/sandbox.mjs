// shared/kai-coder/sandbox.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Kai Coder — Isolated Working Sandbox (FOUNDATION module, NEW)
//
// PURPOSE
//   A per-task, throwaway working directory where Kai Coder can stage candidate
//   file changes and run *dry* validation WITHOUT ever touching live source.
//   Live files are only ever READ (to seed the sandbox); they are NEVER written
//   here. Promotion to production is a separate, deliberate step owned by the
//   existing kai-coder-agent / toolserver `apply` path and gated on approval.
//
//   Layout (one dir per task):
//       c:/KAI/tools/oracle-discord/state/kai-coder-sandbox/<taskId>/
//         ├─ staged/        ← candidate file versions live here
//         └─ meta.json      ← what was staged, when, validation results
//
// SAFETY INVARIANTS
//   1. createSandbox() only ever creates dirs UNDER SANDBOX_ROOT.
//   2. stageFile() writes only under <task>/staged/. The relative target path
//      is sanitized so "..\.." can't escape the sandbox.
//   3. seedFromLive() READS a live file and copies its current content into the
//      sandbox as a baseline — it never writes back.
//   4. dryTest() runs `node --check` (JS/MJS) or a shape sanity pass; it spawns
//      no long-running processes and writes nothing outside the sandbox.
//   5. cleanup() removes only the task's own sandbox subtree.
//
// DEPENDENCY-LIGHT: stdlib only (fs, path, child_process).
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SANDBOX_ROOT = 'c:/KAI/tools/oracle-discord/state/kai-coder-sandbox';
const PROJECT_ROOT = path.resolve('c:/KAI');

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

// Sanitize a caller-supplied relative path so it can NEVER escape the staged dir.
function safeRel(relPath) {
  // Strip drive letters and absolute roots, normalize separators, drop '..'.
  let rel = String(relPath || '').replace(/^[a-zA-Z]:[\\/]/, '').replace(/\\/g, '/');
  // If an absolute project path was passed, make it project-relative.
  const projPosix = PROJECT_ROOT.replace(/\\/g, '/').toLowerCase();
  if (rel.toLowerCase().startsWith(projPosix)) rel = rel.slice(projPosix.length);
  rel = rel.replace(/^\/+/, '');
  // Remove any path segments that try to climb out.
  const parts = rel.split('/').filter(p => p && p !== '.' && p !== '..');
  return parts.join('/');
}

/**
 * createSandbox — make (or reuse) an isolated working dir for a task.
 * @param {string} taskId
 * @returns {Object} handle { taskId, dir, stagedDir, metaPath }
 */
export function createSandbox(taskId) {
  const safeId = String(taskId || `task_${Date.now()}`).replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = path.join(SANDBOX_ROOT, safeId);
  const stagedDir = path.join(dir, 'staged');
  const metaPath = path.join(dir, 'meta.json');
  ensureDir(stagedDir);
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({
      taskId: safeId, createdAt: Date.now(), staged: [], validations: []
    }, null, 2), 'utf8');
  }
  return { taskId: safeId, dir, stagedDir, metaPath };
}

function readMeta(handle) {
  try { return JSON.parse(fs.readFileSync(handle.metaPath, 'utf8')); }
  catch (_) { return { taskId: handle.taskId, staged: [], validations: [] }; }
}
function writeMeta(handle, meta) {
  try { fs.writeFileSync(handle.metaPath, JSON.stringify(meta, null, 2), 'utf8'); } catch (_) {}
}

/**
 * seedFromLive — copy a LIVE file's current content into the sandbox as a
 * read-only baseline (so a dry test sees realistic surroundings). Never writes
 * back to the live file.
 * @param {Object} handle  — from createSandbox()
 * @param {string} livePath — absolute or project-relative path to a real file
 * @returns {Object} { ok, rel, content?, error? }
 */
export function seedFromLive(handle, livePath) {
  const abs = path.isAbsolute(livePath) ? livePath : path.join(PROJECT_ROOT, livePath);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(PROJECT_ROOT)) return { ok: false, error: 'live path outside project root' };
  if (!fs.existsSync(resolved)) return { ok: false, error: `live file not found: ${livePath}` };
  let content;
  try { content = fs.readFileSync(resolved, 'utf8'); }
  catch (e) { return { ok: false, error: e.message }; }

  const rel = safeRel(path.relative(PROJECT_ROOT, resolved));
  const dest = path.join(handle.stagedDir, rel);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content, 'utf8');
  return { ok: true, rel, content, stagedPath: dest };
}

/**
 * stageFile — write a CANDIDATE version of a file into the sandbox. This is the
 * proposed fix. It does NOT touch the live file.
 * @param {Object} handle
 * @param {string} relPath — project-relative target path (where it WOULD go live)
 * @param {string} content — full candidate file content
 * @returns {Object} { ok, rel, stagedPath, error? }
 */
export function stageFile(handle, relPath, content) {
  const rel = safeRel(relPath);
  if (!rel) return { ok: false, error: 'invalid/empty target path' };
  const dest = path.join(handle.stagedDir, rel);
  // Guard: dest must remain under stagedDir.
  if (!path.resolve(dest).startsWith(path.resolve(handle.stagedDir))) {
    return { ok: false, error: 'path traversal blocked' };
  }
  try {
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, content, 'utf8');
  } catch (e) { return { ok: false, error: e.message }; }

  const meta = readMeta(handle);
  if (!meta.staged.includes(rel)) meta.staged.push(rel);
  meta.updatedAt = Date.now();
  writeMeta(handle, meta);
  return { ok: true, rel, stagedPath: dest };
}

/**
 * dryTest — validate a staged file WITHOUT running it for real.
 *   - Shape sanity: non-empty, no NUL bytes (mid-write corruption guard).
 *   - Syntax: `node --check` for .mjs/.js/.cjs. Other types pass shape-only
 *     (no validator wired — explicitly reported as 'skipped').
 * Spawns at most one short-lived `node --check`. Writes nothing outside sandbox.
 * @param {Object} handle
 * @param {string} relPath
 * @returns {Promise<{file, valid, check, error?}>}
 */
export async function dryTest(handle, relPath) {
  const rel = safeRel(relPath);
  const staged = path.join(handle.stagedDir, rel);
  const result = { file: rel, valid: false, check: 'none', error: null };

  // (a) Shape sanity.
  let buf;
  try { buf = fs.readFileSync(staged); }
  catch (e) { result.error = `staged file unreadable: ${e.message}`; return record(handle, result); }
  if (buf.length === 0) { result.error = 'staged file is empty'; return record(handle, result); }
  if (buf.indexOf(0) >= 0) { result.error = `NUL byte at offset ${buf.indexOf(0)} (corruption?)`; return record(handle, result); }

  // (b) Syntax by extension.
  if (/\.(mjs|js|cjs)$/.test(rel)) {
    result.check = 'node --check';
    try {
      await execFileAsync(process.execPath, ['--check', staged], { timeout: 8000, windowsHide: true });
      result.valid = true;
    } catch (e) {
      result.valid = false;
      result.error = String(e.stderr || e.message).slice(0, 500);
    }
  } else {
    // No syntax validator for this type — shape sanity already passed.
    result.check = 'skipped (no validator for extension)';
    result.valid = true;
  }
  return record(handle, result);
}

function record(handle, result) {
  const meta = readMeta(handle);
  meta.validations = meta.validations || [];
  meta.validations.push({ ...result, at: Date.now() });
  writeMeta(handle, meta);
  return result;
}

/**
 * readStaged — read back a staged candidate's content (for diffing/applying by
 * the caller). Never reads outside the sandbox.
 */
export function readStaged(handle, relPath) {
  const rel = safeRel(relPath);
  const staged = path.join(handle.stagedDir, rel);
  try { return { ok: true, rel, content: fs.readFileSync(staged, 'utf8') }; }
  catch (e) { return { ok: false, rel, error: e.message }; }
}

/** listStaged — relative paths of everything staged for this task. */
export function listStaged(handle) {
  return readMeta(handle).staged || [];
}

/** sandboxSummary — meta snapshot (what was staged + validation history). */
export function sandboxSummary(handle) {
  return readMeta(handle);
}

/**
 * cleanup — remove ONLY this task's sandbox subtree. Safe-guarded to refuse
 * deleting anything that isn't under SANDBOX_ROOT.
 * @param {Object} handle
 * @returns {boolean} removed
 */
export function cleanup(handle) {
  const target = path.resolve(handle.dir);
  if (!target.startsWith(path.resolve(SANDBOX_ROOT))) return false; // never escape
  try { fs.rmSync(target, { recursive: true, force: true }); return true; }
  catch (_) { return false; }
}

export const _sandboxPaths = { SANDBOX_ROOT, PROJECT_ROOT };
