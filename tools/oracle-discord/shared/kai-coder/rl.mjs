// shared/kai-coder/rl.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Kai Coder — Reinforcement-Learning Loop (FOUNDATION module, NEW)
//
// THE LOOP (trial-and-error reinforcement):
//
//   1. A new TASK arrives (a code problem to fix).
//   2. computeSignature() fingerprints it.
//   3. findSimilarPatterns() pulls past attempts at the SAME KIND of problem.
//   4. proposeApproach() ranks them: the highest-scoring past approach that
//      WORKED is proposed first; alternatives follow; if nothing is known, a
//      cold-start "explore" approach is proposed.
//   5. Kai Coder executes the approach IN THE SANDBOX and validates it.
//   6. reinforce() feeds the success/fail result back via recordOutcome():
//        success → score goes UP (and a new winning pattern is learned)
//        fail    → score goes DOWN (so that approach is proposed less next time)
//
//   Over many tasks the store converges on the approaches that actually fix
//   each class of problem — classic exploit/explore reinforcement, persisted.
//
// LATTICE HANDOFF: every reinforce() writes a clean, ingestable outcome record
// (memory-db's lattice-feed.jsonl) so the KAI RSHL lattice can later learn from
// the same success/fail signal. We also expose a detector hook seam (the words
// Kai Coder scans pass through KAI's contradiction+alignment detector).
//
// DEPENDENCY-LIGHT: imports only the sibling memory-db module + stdlib.
// ──────────────────────────────────────────────────────────────────────────────

import {
  computeSignature,
  findSimilarPatterns,
  recordOutcome,
  detectorHook,
} from './memory-db.mjs';

// Tunables for the reinforcement dynamics.
const RL = {
  SIMILARITY_THRESHOLD: 60, // % — how alike a past problem must be to count
  SUCCESS_DELTA: +12,       // score nudge on a win
  FAIL_DELTA:    -15,       // score nudge on a loss (punish a bit harder)
  EXPLORE_FLOOR: 35,        // below this score, prefer exploring a fresh approach
};

// ── Cold-start / exploratory approaches ─────────────────────────────────────────
// When the store has nothing similar, we still need SOMETHING to try. These are
// generic, signature-extension-aware first moves. They are deliberately broad —
// the real fix content comes from kai-coder-agent's LLM; these just steer it.
function coldStartApproaches(sigObj) {
  const ext = sigObj.ext || '';
  const generic = [
    { approach_taken: 'minimal-surgical-edit', rationale: 'Change only the offending line/symbol; preserve all surrounding logic.' },
    { approach_taken: 'guard-and-validate-inputs', rationale: 'Add a null/shape guard around the failing access before using it.' },
    { approach_taken: 'fix-import-or-reference', rationale: 'Resolve a missing/incorrect import or undefined reference.' },
  ];
  if (ext === '.rs') {
    generic.unshift({ approach_taken: 'satisfy-borrow-checker', rationale: 'Adjust ownership/borrowing/lifetimes to satisfy rustc.' });
  } else if (ext === '.py') {
    generic.unshift({ approach_taken: 'fix-indentation-or-import', rationale: 'Correct indentation block or missing import.' });
  }
  return generic.map(a => ({ ...a, source: 'cold-start', score: 50, similarity: 0, successes: 0, failures: 0 }));
}

/**
 * proposeApproach — given a new task, return a ranked plan of approaches.
 *
 * @param {Object} task
 * @param {string} [task.id]
 * @param {string} [task.type]    — error class (e.g. 'ReferenceError')
 * @param {string} [task.message] — error message
 * @param {string} [task.file]    — offending file
 * @param {string} [task.goal]    — human goal (fallback signature source)
 * @param {Object} [opts]
 * @param {number} [opts.threshold] — override similarity threshold
 * @returns {Promise<{
 *   signature, primary, alternatives, fromMemory, detector
 * }>}
 *   - signature   : the computed signature object (sig + canonical)
 *   - primary     : the single best approach to try first
 *   - alternatives: ranked fallbacks (best-first), excluding primary
 *   - fromMemory  : true if primary came from a learned pattern (exploit) vs
 *                   a cold-start explore
 *   - detector    : contradiction/alignment read on the problem text (hook)
 */
export async function proposeApproach(task = {}, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : RL.SIMILARITY_THRESHOLD;
  const sigObj = computeSignature({
    type: task.type,
    message: task.message || task.goal || '',
    file: task.file,
  });

  // Contradiction + alignment read (stubbed detector — clean seam to KAI's real
  // detector). The "words being scanned" are the problem statement itself.
  const problemText = `${task.type || ''} ${task.message || task.goal || ''} @ ${task.file || ''}`.trim();
  const detector = await detectorHook(problemText).catch(() => null);

  // Pull what we've learned for this kind of problem.
  const known = findSimilarPatterns(sigObj, threshold, { limit: 8 });

  // Partition into winners (have a success) and known-losers.
  const winners = known.filter(p => (p.successes || 0) > 0);

  let ranked;
  let fromMemory;
  if (winners.length > 0) {
    // EXPLOIT: lead with the highest-scoring proven approach.
    ranked = winners.map(p => ({
      approach_taken: p.approach_taken,
      score: p.score,
      similarity: p.similarity,
      successes: p.successes || 0,
      failures: p.failures || 0,
      evidence: p.evidence || '',
      source: 'memory',
      rationale: `Worked before on a ${p.similarity}%-similar problem (score ${p.score}).`,
    }));
    fromMemory = true;

    // If even the best winner is weak, blend in an exploratory option so we
    // don't get stuck reinforcing a mediocre fix (explore vs exploit).
    if ((ranked[0].score || 0) < RL.EXPLORE_FLOOR) {
      ranked = ranked.concat(coldStartApproaches(sigObj).slice(0, 1));
    }
  } else if (known.length > 0) {
    // We've only SEEN failures for this signature. Try cold-start approaches
    // first, but remember the failed ones so we can avoid re-proposing them.
    const failedApproaches = new Set(known.map(p => p.approach_taken));
    ranked = coldStartApproaches(sigObj).filter(a => !failedApproaches.has(a.approach_taken));
    if (ranked.length === 0) ranked = coldStartApproaches(sigObj); // all tried → retry best generic
    fromMemory = false;
  } else {
    // COLD START: nothing known at all.
    ranked = coldStartApproaches(sigObj);
    fromMemory = false;
  }

  const [primary, ...alternatives] = ranked;
  return { signature: sigObj, primary, alternatives, fromMemory, detector };
}

/**
 * reinforce — record the outcome of an executed approach and update its score.
 *
 * @param {Object} task   — same shape as proposeApproach's task (for signature)
 * @param {Object} result
 * @param {string}  result.approach_taken — which approach was actually run
 * @param {boolean} result.success        — did it validate/fix?
 * @param {string}  [result.context]      — file/subsystem hint
 * @param {string}  [result.evidence]     — syntax-check output, diff, test log
 * @param {number}  [result.delta]        — explicit score nudge (else success/
 *                                          fail defaults are used)
 * @returns {Promise<Object>} the stored/updated pattern row
 */
export async function reinforce(task = {}, result = {}) {
  const sigObj = computeSignature({
    type: task.type,
    message: task.message || task.goal || '',
    file: task.file,
  });

  const success = !!result.success;
  const delta = typeof result.delta === 'number'
    ? result.delta
    : (success ? RL.SUCCESS_DELTA : RL.FAIL_DELTA);

  const row = recordOutcome({
    signature: sigObj,
    context: result.context || task.file || '',
    approach_taken: result.approach_taken || '(unspecified)',
    outcome: success ? 'success' : 'fail',
    delta,
    evidence: result.evidence || '',
  });

  return row;
}

export const _rlConfig = RL;
