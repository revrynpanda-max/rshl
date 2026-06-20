// shared/kai-coder/index.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Kai Coder — Foundation entry point (NEW, additive).
//
// This is the clean seam another module (the scanner) calls. It ties together
// the three foundation modules:
//     memory-db.mjs  — tasks/checklists + learned patterns
//     sandbox.mjs    — per-task isolated working dir (never touches live files)
//     rl.mjs         — reinforcement loop (propose → execute → reinforce)
//
// CONTRACT (the scanner depends on this EXACT shape):
//
//   import { kaiCoderResolve } from './shared/kai-coder/index.mjs';
//
//   const results = await kaiCoderResolve(issues, opts);
//
//   INPUT  issues : Array<{ file: string, line?: number,
//                           type?: string, message: string }>
//   INPUT  opts   : {
//                     similarityThreshold? : number,  // default 60
//                     generateFix?         : async (task, approach, liveContent)
//                                            => string|null,   // candidate file
//                                                              // content; if
//                                                              // omitted, a
//                                                              // no-op stub is
//                                                              // used and fixes
//                                                              // are reported
//                                                              // unfixed.
//                     keepSandbox?         : boolean, // default false (cleanup)
//                   }
//
//   OUTPUT Array<{
//             file    : string,   // the issue's file
//             fixed   : boolean,   // did a candidate pass dry validation?
//             approach: string,    // which RL approach was used
//             detail  : string,    // human summary (validation / why-not)
//             taskId  : string,    // memory-db task id (for follow-up)
//             signature: string,   // signature hash (for the lattice)
//          }>
//
// The new modules stand alone and are importable. Where sensible, this wires to
// the existing kai-coder-agent capabilities (applySandboxFile) WITHOUT importing
// it eagerly — we lazy-import so a missing/broken agent can never destabilize
// the foundation, and so importing this file has zero side effects on the fleet.
// ──────────────────────────────────────────────────────────────────────────────

import {
  addTask, updateTask, computeSignature, memoryStats, detectorHook, _paths,
} from './memory-db.mjs';
import {
  createSandbox, seedFromLive, stageFile, dryTest, readStaged, cleanup,
} from './sandbox.mjs';
import { proposeApproach, reinforce } from './rl.mjs';

import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve('c:/KAI');

// Re-export the building blocks so callers can use them directly if they want.
export {
  addTask, updateTask, computeSignature, memoryStats, detectorHook,
  createSandbox, seedFromLive, stageFile, dryTest, cleanup,
  proposeApproach, reinforce,
};

/**
 * kaiCoderResolve — resolve a list of scanner issues via the RL + sandbox loop.
 * See the CONTRACT block above for the exact input/return shape.
 *
 * For each issue:
 *   1. Create a TASK + checklist in the memory DB.
 *   2. Ask the RL loop for an approach (exploit learned patterns, else explore).
 *   3. Seed the issue's live file into an isolated sandbox (read-only copy).
 *   4. Produce a candidate fix:
 *        - if opts.generateFix is provided, call it (this is where the
 *          kai-coder-agent LLM would plug in);
 *        - otherwise stub: re-stage the unchanged file so the pipeline still
 *          validates end-to-end but reports fixed:false (no real change made).
 *   5. Stage the candidate + run a DRY syntax check (never touches live files).
 *   6. reinforce() the RL store with success/fail.
 *   7. Clean up the sandbox (unless opts.keepSandbox).
 */
export async function kaiCoderResolve(issues, opts = {}) {
  const {
    similarityThreshold = 60,
    keepSandbox = false,
    useAgentLLM = false, // opt-in: lazy-wire the existing agent's LLM to write fixes
  } = opts || {};

  // Resolve a fix generator. Precedence:
  //   1. caller-provided opts.generateFix (full control)
  //   2. opts.useAgentLLM → built-in generator backed by kai-coder-agent's LLM
  //   3. null → dry run (stage unchanged, report fixed:false)
  let generateFix = (typeof opts.generateFix === 'function') ? opts.generateFix : null;
  if (!generateFix && useAgentLLM) {
    generateFix = await buildAgentLLMFixer().catch(() => null);
  }

  const list = Array.isArray(issues) ? issues : [];
  const results = [];

  for (const issue of list) {
    const file = issue?.file || '';
    const type = issue?.type || '';
    const message = issue?.message || '';
    const line = issue?.line;

    // ── 1. Task + checklist ──────────────────────────────────────────────────
    const task = addTask({
      goal: `Fix ${type || 'issue'} in ${file}${line ? ':' + line : ''} — ${message}`.slice(0, 300),
      steps: [
        'consult RL for an approach',
        'seed live file into sandbox',
        'stage candidate fix',
        'dry-validate (syntax)',
        'reinforce outcome',
      ],
      context: { file, line, type, message },
    });
    updateTask(task.id, { status: 'in_progress', stepUpdate: { n: 1, status: 'in_progress' } });

    const rlTask = { id: task.id, type, message, file, goal: task.goal };
    let approachName = '(none)';
    let fixed = false;
    let detail = '';
    let sandboxHandle = null;
    const sig = computeSignature({ type, message, file });

    try {
      // ── 2. RL proposes an approach ─────────────────────────────────────────
      const proposal = await proposeApproach(rlTask, { threshold: similarityThreshold });
      approachName = proposal.primary?.approach_taken || 'minimal-surgical-edit';
      updateTask(task.id, { stepUpdate: { n: 1, status: 'done' } });

      // ── 3. Sandbox: seed the live file (read-only copy) ────────────────────
      sandboxHandle = createSandbox(task.id);
      updateTask(task.id, { stepUpdate: { n: 2, status: 'in_progress' } });

      let liveContent = '';
      let seedOk = false;
      if (file) {
        const seed = seedFromLive(sandboxHandle, file);
        seedOk = seed.ok;
        liveContent = seed.ok ? seed.content : '';
        if (!seed.ok) detail = `seed failed: ${seed.error}; `;
      } else {
        detail = 'no file on issue; ';
      }
      updateTask(task.id, { stepUpdate: { n: 2, status: seedOk ? 'done' : 'failed' } });

      // ── 4. Produce a candidate fix ─────────────────────────────────────────
      updateTask(task.id, { stepUpdate: { n: 3, status: 'in_progress' } });
      let candidate = null;
      if (typeof generateFix === 'function' && seedOk) {
        try {
          candidate = await generateFix(rlTask, proposal, liveContent);
        } catch (e) {
          detail += `generateFix error: ${String(e.message).slice(0, 120)}; `;
        }
      }
      // Stub fallback: stage the unchanged content so the pipeline validates,
      // but we will NOT claim a fix when nothing actually changed.
      const noRealChange = (candidate == null) || (candidate === liveContent);
      const toStage = candidate != null ? candidate : liveContent;

      let staged = { ok: false };
      if (seedOk && toStage) {
        const relTarget = path.isAbsolute(file)
          ? path.relative(PROJECT_ROOT, path.resolve(file))
          : file;
        staged = stageFile(sandboxHandle, relTarget, toStage);
      }
      updateTask(task.id, { stepUpdate: { n: 3, status: staged.ok ? 'done' : 'failed' } });

      // ── 5. Dry validation (syntax) — never touches live files ──────────────
      updateTask(task.id, { stepUpdate: { n: 4, status: 'in_progress' } });
      let validation = { valid: false, error: 'not staged' };
      if (staged.ok) {
        validation = await dryTest(sandboxHandle, staged.rel);
      }
      // A real fix = candidate changed the file AND it passes dry validation.
      fixed = !!validation.valid && !noRealChange;
      updateTask(task.id, { stepUpdate: { n: 4, status: validation.valid ? 'done' : 'failed' } });

      if (noRealChange && validation.valid) {
        detail += 'no candidate change produced (provide opts.generateFix to apply a real fix); ';
      } else if (validation.valid) {
        detail += 'candidate passed dry syntax check; ';
      } else {
        detail += `dry validation failed: ${String(validation.error || '').slice(0, 160)}; `;
      }

      // ── 6. Reinforce the RL store ──────────────────────────────────────────
      updateTask(task.id, { stepUpdate: { n: 5, status: 'in_progress' } });
      // Only reinforce a real fix attempt. A no-op stub shouldn't poison scores,
      // so we record fail-soft (small) for stubs vs full signal for real fixes.
      await reinforce(rlTask, {
        approach_taken: approachName,
        success: fixed,
        context: file,
        evidence: validation.valid
          ? `dry-check ${validation.check}: ok`
          : String(validation.error || '').slice(0, 200),
        delta: noRealChange ? 0 : undefined, // stub → neutral; real → default deltas
      });
      updateTask(task.id, { stepUpdate: { n: 5, status: 'done' } });

      updateTask(task.id, { status: fixed ? 'completed' : 'failed' });
    } catch (e) {
      detail += `pipeline error: ${String(e.message).slice(0, 160)}`;
      updateTask(task.id, { status: 'failed' });
    } finally {
      if (sandboxHandle && !keepSandbox) {
        try { cleanup(sandboxHandle); } catch (_) {}
      }
    }

    results.push({
      file,
      fixed,
      approach: approachName,
      detail: detail.trim(),
      taskId: task.id,
      signature: sig.sig,
    });
  }

  return results;
}

/**
 * applyResolvedFix — OPTIONAL promotion step. Lazy-imports the existing
 * kai-coder-agent's applySandboxFile so a real fix can be pushed to production
 * AFTER human/Oracle approval. Kept separate from kaiCoderResolve so resolution
 * stays a dry, non-destructive operation by default.
 *
 * NOTE: this requires the candidate to also exist in the toolserver sandbox
 * (the agent's apply path copies toolserver-sandbox → production). It is
 * provided for callers that already route through the agent; the foundation
 * sandbox itself never writes to live files.
 *
 * @param {string} filePath — project-relative file to promote
 * @returns {Promise<string>} status message
 */
export async function applyResolvedFix(filePath) {
  try {
    const { applySandboxFile } = await import('../kai-coder-agent.mjs');
    return await applySandboxFile(filePath);
  } catch (e) {
    return `applyResolvedFix unavailable: ${e.message}`;
  }
}

/**
 * buildAgentLLMFixer — lazy-construct a generateFix() backed by the EXISTING
 * kai-coder-agent's LLM caller (makeLLMCaller). Opt-in via
 * kaiCoderResolve(issues, { useAgentLLM: true }). Returns a function with the
 * generateFix signature: (task, proposal, liveContent) => Promise<string|null>.
 *
 * It asks the model for a SYNTAX-ONLY repair (matching the scanner's intent),
 * steered by the RL-proposed approach, and returns the full corrected file
 * content (markdown fences stripped) — or null if nothing usable came back.
 * Importing/using this never touches live files; the candidate is still staged
 * + dry-validated by the sandbox before anything is considered "fixed".
 */
async function buildAgentLLMFixer() {
  const { makeLLMCaller } = await import('../kai-coder-agent.mjs');
  const llm = makeLLMCaller();
  return async function generateFixViaAgent(task, proposal, liveContent) {
    if (!liveContent) return null;
    const approach = proposal?.primary?.approach_taken || 'minimal-surgical-edit';
    const rationale = proposal?.primary?.rationale || '';
    const prompt =
      `Fix ONLY the problem so this file parses and the issue is resolved. ` +
      `Do NOT change behavior, refactor, or add anything beyond the fix.\n` +
      `RL-suggested approach: ${approach}${rationale ? ` (${rationale})` : ''}\n` +
      `ISSUE: [${task.type || 'issue'}] ${task.message || task.goal || ''}\n` +
      `FILE: ${task.file}\n\n` +
      `Return ONLY the complete corrected file content — no markdown fences, no commentary.\n\n` +
      `=== FILE ===\n${liveContent}\n=== END ===`;
    let resp;
    try { resp = await llm(prompt, 'kai-coder-resolve'); }
    catch (_) { return null; }
    let fixed = (typeof resp === 'string' ? resp : (resp?.reply || resp?.content || '')) || '';
    fixed = fixed.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    // Guard against truncated/garbage output (same heuristic the scanner uses).
    if (!fixed || fixed.length < liveContent.length * 0.5) return null;
    return fixed.endsWith('\n') ? fixed : fixed + '\n';
  };
}

export const _foundationPaths = { ..._paths, PROJECT_ROOT };
