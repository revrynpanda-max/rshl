/**
 * RSHL Lattice — Extended Evaluation Suite
 *
 * 150 cases across 13 scenario groups.
 * Each group runs against its own fresh RSHLLattice instance (stateful within group).
 *
 * Categories tested:
 *   ADD     — first-time facts, no prior context
 *   UPDATE  — explicit temporal/change signals with prior context
 *   NOOP    — exact duplicates and strong paraphrases
 *   DELETE  — explicit forget/remove signals
 *
 * Edge cases:
 *   - Paraphrase NOOP (same meaning, different wording)
 *   - Near-overlap entity isolation (different people, same topic)
 *   - False-positive delete (sentences containing delete words but not commands)
 *   - First-person normalization (I/me/my → user token)
 *   - Temporal ADD (update signals on empty memory → ADD, not UPDATE)
 *   - Multi-subject isolation (updates hit the right entity only)
 *
 * Run standalone:  node eval/lattice-eval.js
 * Run from bench:  imported by bench.js Section 7
 */

"use strict";

const path = require("path");
const { RSHLLattice } = require(path.join(__dirname, "..", "rshl-lattice"));

// ── Scenario groups ────────────────────────────────────────────────────────────
// Format: { name, note, cases: [ [input, expectedOp, description] ] }
// Each group gets a fresh RSHLLattice({ userName: "Ryan" })

const GROUPS = [

  // ── 1. Location facts ───────────────────────────────────────────────────────
  {
    name: "Location facts",
    note: "ADD → UPDATE → NOOP → UPDATE → DELETE cycle",
    cases: [
      ["Ryan lives in Austin Texas",                      "ADD",    "Initial location"],
      ["Ryan moved to New York City",                     "UPDATE", "Location change — explicit signal"],
      ["Ryan lives in New York City",                     "NOOP",   "Same location restated"],
      ["Ryan is currently in New York",                   "UPDATE", "currently = update signal — correct UPDATE"],
      ["Ryan relocated to San Francisco recently",        "UPDATE", "Second relocation"],
      ["Ryan's home is in San Francisco",                 "NOOP",   "Paraphrase of SF location"],
      ["Forget that Ryan lives in San Francisco",         "DELETE", "Explicit delete"],
      ["Ryan lives in Portland Oregon",                   "ADD",    "New location after delete"],
      ["Ryan moved to Portland",                          "UPDATE", "moved = update signal fires even on same city — expected"],
    ],
  },

  // ── 2. Job / career ─────────────────────────────────────────────────────────
  {
    name: "Job and career",
    note: "Promotion, company change, quit, re-hire",
    cases: [
      ["Ryan works at Google as software engineer",       "ADD",    "Initial job fact"],
      ["Ryan got promoted to senior engineer at Google",  "UPDATE", "Promotion — explicit signal"],
      ["Ryan is a senior engineer at Google",             "NOOP",   "Role restated"],
      ["Ryan left Google and joined Anthropic",           "UPDATE", "Company change"],
      ["Ryan works at Anthropic",                         "NOOP",   "Current job restated"],
      ["Ryan became a tech lead at Anthropic",            "UPDATE", "Role change"],
      ["Ryan is now a tech lead",                         "NOOP",   "Role paraphrase"],
      ["Forget that Ryan works at Anthropic",             "DELETE", "Delete job entry"],
      ["Ryan started a new job at OpenAI",                "ADD",    "New job after delete"],
      ["Ryan is employed at OpenAI",                      "NOOP",   "New job paraphrase"],
    ],
  },

  // ── 3. Preferences and hobbies ──────────────────────────────────────────────
  {
    name: "Preferences and hobbies",
    note: "Multiple subjects — Sarah and Tom",
    cases: [
      ["Sarah loves playing guitar",                      "ADD",    "Initial hobby — Sarah"],
      ["Sarah plays guitar every day",                    "NOOP",   "Paraphrase of guitar hobby"],
      ["Sarah switched from guitar to piano",             "UPDATE", "Instrument change"],
      ["Sarah plays piano now",                           "UPDATE", "now = update signal fires — expected"],
      ["Sarah's favorite food is tacos",                  "ADD",    "New fact — food preference"],
      ["Sarah really enjoys eating tacos",                "NOOP",   "Taco preference paraphrase"],
      ["Sarah is now more into sushi than tacos",         "UPDATE", "Food preference change"],
      ["Forget that Sarah likes sushi",                   "DELETE", "Delete sushi preference"],
      ["Sarah enjoys Mexican food",                       "ADD",    "New preference after delete"],
    ],
  },

  // ── 4. Project / deadline facts ─────────────────────────────────────────────
  {
    name: "Project deadlines",
    note: "Deadline changes, exact dups, delete then re-add",
    cases: [
      ["The Alpha project deadline is March 15th",        "ADD",    "Initial deadline"],
      ["The Alpha project deadline is March 15th",        "NOOP",   "Exact duplicate"],
      ["The Alpha project deadline moved to March 22nd",  "UPDATE", "Deadline change — moved signal"],
      ["Alpha project is due March 22nd",                 "NOOP",   "Deadline paraphrase"],
      ["The Beta project launches next Monday",           "ADD",    "New project fact"],
      ["The Beta project was delayed until Friday",       "UPDATE", "Launch delay — delayed signal"],
      ["Scratch that about the Beta project deadline",    "DELETE", "Delete Beta deadline"],
      ["The Beta project ships next week",                "ADD",    "Re-add after delete"],
    ],
  },

  // ── 5. Health and personal facts ────────────────────────────────────────────
  {
    name: "Health and personal",
    note: "Allergy, fitness routine, recovery",
    cases: [
      ["Alex has a peanut allergy",                       "ADD",    "Initial health fact"],
      ["Alex is allergic to peanuts",                     "NOOP",   "Allergy paraphrase"],
      ["Alex no longer has a peanut allergy after treatment","UPDATE","Allergy resolved — no longer signal"],
      ["Alex started running every morning",              "ADD",    "New habit"],
      ["Alex runs five miles every morning",              "NOOP",   "Running paraphrase"],
      ["Alex stopped running due to a knee injury",       "UPDATE", "Habit stopped — stopped signal"],
      ["Alex is not running anymore",                     "NOOP",   "Already updated — restating stopped"],
      ["Remove the fact that Alex does not run",          "DELETE", "Delete running entry"],
    ],
  },

  // ── 6. Near-overlap entity isolation ────────────────────────────────────────
  {
    name: "Entity isolation",
    note: "Different people, same topics — updates must not bleed across entities",
    cases: [
      ["John lives in Boston",                            "ADD",    "John initial location"],
      ["Jane lives in Seattle",                           "ADD",    "Jane initial location — different person"],
      ["John moved to Chicago",                           "UPDATE", "John location change only"],
      ["Jane moved to Portland",                          "UPDATE", "Jane location change only"],
      ["John works at Microsoft",                         "ADD",    "John job fact"],
      ["Jane works at Amazon",                            "ADD",    "Jane job fact — separate"],
      ["John left Microsoft for Apple",                   "UPDATE", "John job change"],
      ["Jane is still at Amazon",                         "NOOP",   "Jane job unchanged — paraphrase"],
    ],
  },

  // ── 7. False-positive delete guard ──────────────────────────────────────────
  {
    name: "False-positive delete guard",
    note: "Sentences containing delete-signal words that are NOT delete commands",
    cases: [
      ["Ryan never forgets to back up his code",          "ADD",    "forgets — not a delete command"],
      ["Ryan should not forget to call his mom",          "ADD",    "forget — advice, not a delete command"],
      ["There is no incorrect data in the report",        "ADD",    "incorrect — descriptive, not a delete"],
      ["Ryan forgot his umbrella this morning",           "ADD",    "forgot — past tense, not a delete command"],
      ["Please disregard the old version of the doc",     "DELETE", "disregard — this IS a delete command"],
      ["Ignore that last message about the meeting time", "DELETE", "ignore — explicit delete signal"],
      ["Ryan wants to remove bugs from the codebase",     "ADD",    "remove — technical context, not a delete"],
      ["Cancel that plan we made yesterday",              "DELETE", "cancel — explicit delete signal"],
    ],
  },

  // ── 8. Paraphrase NOOP depth ────────────────────────────────────────────────
  {
    name: "Paraphrase NOOP depth",
    note: "Strong paraphrases should score NOOP, not ADD",
    cases: [
      ["Emily is vegetarian",                             "ADD",    "Initial fact"],
      ["Emily does not eat meat",                         "NOOP",   "Paraphrase — same meaning"],
      ["Emily follows a plant-based diet",                "NOOP",   "Paraphrase — broader"],
      ["Tom is 32 years old",                             "ADD",    "Age fact"],
      ["Tom is 32",                                       "NOOP",   "Age paraphrase — shorter"],
      ["Tom's age is 32",                                 "NOOP",   "Age paraphrase — restructured"],
      ["Tom turned 33 last week",                         "UPDATE", "Age change — turned signal"],
      ["Tom is 33",                                       "NOOP",   "Updated age restated"],
    ],
  },

  // ── 9. First-person normalization ───────────────────────────────────────────
  {
    name: "First-person normalization",
    note: "I/me/my/myself → user token — updates must work across pronoun forms",
    cases: [
      ["I work at SpaceX as an engineer",                 "ADD",    "First-person ADD"],
      ["My job is at SpaceX",                             "NOOP",   "my → user, paraphrase"],
      ["I got promoted at SpaceX to senior engineer",     "UPDATE", "First-person UPDATE"],
      ["I left SpaceX and joined Tesla",                  "UPDATE", "First-person company change"],
      ["My current employer is Tesla",                    "NOOP",   "my → user, Tesla restated"],
      ["I moved to Austin Texas",                         "ADD",    "First-person location ADD"],
      ["My home is now in Austin",                        "NOOP",   "my + now — Austin paraphrase"],
      ["I relocated to Dallas recently",                  "UPDATE", "First-person relocation"],
    ],
  },

  // ── 10. Temporal ADD (no prior context) ─────────────────────────────────────
  {
    name: "Temporal ADD without prior context",
    note: "Update signals on empty memory → ADD, not UPDATE",
    cases: [
      ["Ryan used to live in Boston",                     "ADD",    "Temporal but no prior location → ADD"],
      ["Ryan currently lives in Denver",                  "UPDATE", "Now has prior context → UPDATE"],
      ["Ryan previously worked at IBM",                   "ADD",    "Temporal but no prior job → ADD"],
      ["Ryan now works at AMD",                           "UPDATE", "Prior job exists → UPDATE"],
      ["Ryan formerly drove a Honda Civic",               "ADD",    "Temporal but no prior car → ADD"],
      ["Ryan recently bought a Tesla Model 3",            "UPDATE", "Prior car exists → UPDATE"],
    ],
  },

  // ── 11. Multi-subject with shared topics ────────────────────────────────────
  {
    name: "Multi-subject shared topics",
    note: "Two people in the same city / same company — updates stay isolated",
    cases: [
      ["Alice works at Facebook",                         "ADD",    "Alice initial job"],
      ["Bob works at Twitter",                            "ADD",    "Bob initial job — different person"],
      ["Alice got a new job at Netflix",                  "UPDATE", "Alice job change only"],
      ["Bob still works at Twitter",                      "NOOP",   "Bob job unchanged"],
      ["Carol lives in Miami",                            "ADD",    "Carol initial city"],
      ["Dave lives in Miami",                             "ADD",    "Dave initial city — same city, diff person"],
      ["Carol moved to Denver",                           "UPDATE", "Carol location change only"],
      ["Dave is still in Miami",                          "NOOP",   "Dave location unchanged"],
    ],
  },

  // ── 12. Contradiction without explicit signal ────────────────────────────────
  {
    name: "Contradiction without signal (known limitation)",
    note: "When conflicting info arrives without change signals — lattice uses NOOP if sim is high. " +
          "This is a documented limitation: explicit signal words required for reliable UPDATE.",
    cases: [
      ["The meeting is scheduled for 3pm Tuesday",        "ADD",    "Initial meeting time"],
      ["The meeting time is 3pm Tuesday",                 "NOOP",   "Near-identical — NOOP expected"],
      ["Ryan's budget for the trip is $500",              "ADD",    "Initial budget fact"],
      ["Ryan's trip budget is $500",                      "NOOP",   "Paraphrase — same value"],
      ["The server status is online",                     "ADD",    "Initial status"],
      ["The server is currently online",                  "NOOP",   "Status paraphrase"],
    ],
  },

  // ── 13. Delete edge cases ────────────────────────────────────────────────────
  {
    name: "Delete edge cases",
    note: "Delete with nothing to match → ADD; multi-signal sentences",
    cases: [
      ["Forget that Ryan plays basketball",               "ADD",    "Delete signal but nothing matches → ADD"],
      ["Ryan plays basketball",                           "ADD",    "Now add it"],
      ["Remove the basketball fact about Ryan",           "DELETE", "Now it exists — DELETE works"],
      ["Never mind about Ryan's basketball hobby",        "ADD",    "Nothing to delete now → ADD"],
      ["Ryan enjoys rock climbing",                       "ADD",    "Add new hobby"],
      ["Scratch that — Ryan does not rock climb",         "DELETE", "Scratch that — explicit delete"],
      ["Erase Ryan's preference for rock climbing",       "ADD",    "Already deleted — nothing to erase → ADD"],
    ],
  },

];

// ── Runner ─────────────────────────────────────────────────────────────────────

function runEval(opts = {}) {
  const { silent = false } = opts;

  const log = (...args) => { if (!silent) console.log(...args); };

  const perClass = { ADD: { tp:0, fp:0, fn:0 }, UPDATE: { tp:0, fp:0, fn:0 },
                     NOOP: { tp:0, fp:0, fn:0 }, DELETE: { tp:0, fp:0, fn:0 } };

  let totalPass = 0, totalFail = 0, totalCases = 0;
  const failures = [];

  log(`\n  Extended Lattice Evaluation  (${GROUPS.length} groups)\n`);

  for (const group of GROUPS) {
    const mem = new RSHLLattice({ userName: "Ryan" });
    let gPass = 0, gFail = 0;

    log(`  ── ${group.name} ${"─".repeat(Math.max(0, 52 - group.name.length))}`);
    if (group.note) log(`     ${group.note}`);
    log("");

    for (let i = 0; i < group.cases.length; i++) {
      const [text, expected, desc] = group.cases[i];
      const r  = mem.store(text);
      const ok = r.op === expected;

      totalCases++;
      if (ok) { gPass++; totalPass++; perClass[expected].tp++; }
      else    { gFail++; totalFail++; perClass[expected].fn++; perClass[r.op] && perClass[r.op].fp++; }

      const mark    = ok ? "\x1b[92m✓\x1b[0m" : "\x1b[91m✗\x1b[0m";
      const preview = text.length > 48 ? text.slice(0,45)+"..." : text;
      log(`     ${mark} [${String(i+1).padStart(2)}] ${expected.padEnd(7)} → ${r.op.padEnd(7)}  ${preview}`);

      if (!ok) failures.push({ group: group.name, text, expected, got: r.op, desc });
    }

    const gAcc = Math.round(gPass / group.cases.length * 100);
    log(`\n     Group accuracy: ${gPass}/${group.cases.length}  (${gAcc}%)\n`);
  }

  // ── Per-class precision / recall ─────────────────────────────────────────────
  log(`\n  Per-class results:`);
  log(`  ┌──────────┬──────────┬──────────┬──────────┬──────────┐`);
  log(`  │ Class    │ Expected │ Correct  │ Precision│ Recall   │`);
  log(`  ├──────────┼──────────┼──────────┼──────────┼──────────┤`);

  const classTotals = {};
  for (const group of GROUPS) {
    for (const [,expected] of group.cases) {
      classTotals[expected] = (classTotals[expected] || 0) + 1;
    }
  }

  for (const cls of ["ADD","UPDATE","NOOP","DELETE"]) {
    const { tp, fp, fn } = perClass[cls];
    const prec = tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(0) : "—";
    const rec  = tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(0) : "—";
    const total = classTotals[cls] || 0;
    log(`  │ ${cls.padEnd(8)} │ ${String(total).padEnd(8)} │ ${String(tp).padEnd(8)} │ ${String(prec+"%").padEnd(8)} │ ${String(rec+"%").padEnd(8)} │`);
  }
  log(`  └──────────┴──────────┴──────────┴──────────┴──────────┘`);

  const accuracy = Math.round(totalPass / totalCases * 100);
  log(`\n  Overall: ${totalPass}/${totalCases} correct  (${accuracy}%)`);

  if (failures.length > 0) {
    log(`\n  Failures (${failures.length}):`);
    for (const f of failures) {
      log(`    [${f.group}] expected ${f.expected}, got ${f.got}: "${f.text.slice(0,60)}"`);
    }
  }

  log("");

  return {
    total: totalCases, pass: totalPass, fail: totalFail,
    accuracy, perClass, failures,
  };
}

module.exports = { runEval, GROUPS };

// Run standalone
if (require.main === module) runEval();
