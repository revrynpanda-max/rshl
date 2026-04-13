/**
 * RSHL Recall Accuracy Eval
 *
 * Answers the question bench.js cannot: when you store N facts and query
 * with a paraphrase, does the RIGHT memory come back?
 *
 * Measures:
 *   Top-1 accuracy   — correct answer ranked #1
 *   Top-3 accuracy   — correct answer in top 3
 *   MRR              — Mean Reciprocal Rank (1/rank avg — 1.0 = always top-1)
 *   False positive %  — noise entries scoring >= 0.55 on targeted queries
 *   Entity bleed %    — wrong-person facts appearing above threshold
 *
 * Runs at three scales:
 *   Baseline   — only the 30 core facts (no noise)
 *   +500 noise — 30 facts buried in 500 random entries
 *   +5000 noise — 30 facts buried in 5000 random entries
 *
 * Usage:  node eval/recall-accuracy.js
 */

"use strict";

const path = require("path");
const { textVec, cosineSim } = require(path.join(__dirname, "..", "rshl-core"));

// ── Colour helpers ─────────────────────────────────────────────────────────────
const G = s => `\x1b[92m${s}\x1b[0m`;
const R = s => `\x1b[91m${s}\x1b[0m`;
const Y = s => `\x1b[93m${s}\x1b[0m`;
const B = s => `\x1b[96m${s}\x1b[0m`;

// ── Core fact set ──────────────────────────────────────────────────────────────
// Each entry: { id, stored, queries: [...paraphrases], entity }
// 'stored' is what goes into memory.
// 'queries' are paraphrases that should retrieve it as top-1.
// 'entity' is used to measure bleed (Ryan query should not return Sarah facts).

const FACTS = [
  // ── Location ──
  { id: "ryan-location",
    stored:  "Ryan lives in Austin Texas",
    queries: ["where does Ryan live", "Ryan's home city", "Ryan's location", "what city is Ryan in"],
    entity: "Ryan" },

  { id: "sarah-location",
    stored:  "Sarah lives in Seattle Washington",
    queries: ["where does Sarah live", "Sarah's home city", "Sarah location"],
    entity: "Sarah" },

  { id: "tom-location",
    stored:  "Tom is based in Chicago Illinois",
    queries: ["where does Tom live", "Tom's city", "Tom location"],
    entity: "Tom" },

  // ── Job ──
  { id: "ryan-job",
    stored:  "Ryan works at Google as a software engineer",
    queries: ["Ryan's job", "where does Ryan work", "Ryan employer", "Ryan occupation"],
    entity: "Ryan" },

  { id: "sarah-job",
    stored:  "Sarah is a nurse at Seattle General Hospital",
    queries: ["Sarah's job", "where does Sarah work", "Sarah occupation"],
    entity: "Sarah" },

  { id: "tom-job",
    stored:  "Tom is a high school math teacher in Chicago",
    queries: ["Tom's job", "where does Tom work", "Tom occupation"],
    entity: "Tom" },

  // ── Food preferences ──
  { id: "ryan-food",
    stored:  "Ryan's favorite food is sushi",
    queries: ["what food does Ryan like", "Ryan's preferred meal", "Ryan food preference"],
    entity: "Ryan" },

  { id: "sarah-food",
    stored:  "Sarah likes tacos and Mexican food",
    queries: ["what food does Sarah like", "Sarah food preference", "Sarah favorite meal"],
    entity: "Sarah" },

  // ── Hobbies ──
  { id: "ryan-hobby",
    stored:  "Ryan enjoys hiking and trail running on weekends",
    queries: ["Ryan's hobbies", "what does Ryan do for fun", "Ryan weekend activities"],
    entity: "Ryan" },

  { id: "sarah-hobby",
    stored:  "Sarah enjoys painting watercolors and reading",
    queries: ["Sarah hobbies", "what does Sarah do for fun", "Sarah free time activities"],
    entity: "Sarah" },

  { id: "tom-hobby",
    stored:  "Tom plays chess and watches classic films",
    queries: ["Tom hobbies", "what does Tom enjoy", "Tom's pastimes"],
    entity: "Tom" },

  // ── Health ──
  { id: "ryan-allergy",
    stored:  "Ryan is allergic to peanuts",
    queries: ["Ryan allergy", "what is Ryan allergic to", "Ryan food restriction"],
    entity: "Ryan" },

  { id: "sarah-allergy",
    stored:  "Sarah is lactose intolerant",
    queries: ["Sarah allergy", "Sarah food restriction", "what is Sarah intolerant to"],
    entity: "Sarah" },

  // ── Deadlines / projects ──
  { id: "ryan-project",
    stored:  "Ryan's project deadline is next Friday",
    queries: ["Ryan deadline", "when is Ryan's project due", "Ryan project timeline"],
    entity: "Ryan" },

  { id: "tom-project",
    stored:  "Tom has a deadline to submit grades by end of the month",
    queries: ["Tom deadline", "when does Tom submit grades", "Tom work deadline"],
    entity: "Tom" },

  // ── Personal facts ──
  { id: "ryan-age",
    stored:  "Ryan is 28 years old",
    queries: ["how old is Ryan", "Ryan age", "Ryan's age"],
    entity: "Ryan" },

  { id: "sarah-age",
    stored:  "Sarah is 34 years old",
    queries: ["how old is Sarah", "Sarah age", "Sarah's age"],
    entity: "Sarah" },

  { id: "tom-age",
    stored:  "Tom is 52 years old",
    queries: ["how old is Tom", "Tom age", "Tom's age"],
    entity: "Tom" },

  // ── Preferences ──
  { id: "ryan-music",
    stored:  "Ryan listens to hip hop and jazz music",
    queries: ["Ryan music taste", "what music does Ryan like", "Ryan's favorite genre"],
    entity: "Ryan" },

  { id: "sarah-music",
    stored:  "Sarah loves classical music and opera",
    queries: ["Sarah music taste", "what music does Sarah like", "Sarah's favorite genre"],
    entity: "Sarah" },

  // ── Transport ──
  { id: "ryan-car",
    stored:  "Ryan drives a blue Toyota Camry",
    queries: ["Ryan's car", "what does Ryan drive", "Ryan vehicle"],
    entity: "Ryan" },

  { id: "tom-car",
    stored:  "Tom rides a bicycle to work every day",
    queries: ["Tom transport", "how does Tom commute", "Tom commute"],
    entity: "Tom" },

  // ── Pet ──
  { id: "ryan-pet",
    stored:  "Ryan has a golden retriever named Max",
    queries: ["Ryan's pet", "does Ryan have a dog", "Ryan's dog name"],
    entity: "Ryan" },

  { id: "sarah-pet",
    stored:  "Sarah has two cats named Luna and Mochi",
    queries: ["Sarah's pets", "does Sarah have a cat", "Sarah's cats"],
    entity: "Sarah" },

  // ── Misc ──
  { id: "ryan-language",
    stored:  "Ryan is learning Spanish",
    queries: ["what language is Ryan learning", "Ryan's language study", "Ryan Spanish"],
    entity: "Ryan" },

  { id: "tom-language",
    stored:  "Tom speaks fluent French and German",
    queries: ["what languages does Tom speak", "Tom language skills", "Tom French"],
    entity: "Tom" },

  { id: "ryan-remote",
    stored:  "Ryan works remotely from home full time",
    queries: ["does Ryan work from home", "Ryan works from home", "Ryan remote work"],
    entity: "Ryan" },

  { id: "sarah-schedule",
    stored:  "Sarah works night shifts at the hospital",
    queries: ["Sarah work schedule", "when does Sarah work", "Sarah shift hours"],
    entity: "Sarah" },

  { id: "ryan-goal",
    stored:  "Ryan wants to run a marathon this year",
    queries: ["Ryan fitness goal", "Ryan's goal", "Ryan marathon goal"],
    entity: "Ryan" },

  { id: "tom-goal",
    stored:  "Tom is saving money to buy a house",
    queries: ["Tom financial goal", "Tom's goal", "what is Tom saving for"],
    entity: "Tom" },
];

// ── Noise templates ────────────────────────────────────────────────────────────
// Unrelated facts — should NOT score >= 0.55 on any of the targeted queries.
const NOISE_TEMPLATES = [
  "the capital of {C} is {X}",
  "photosynthesis converts sunlight into {X} using chlorophyll",
  "the speed of light is approximately {N} meters per second",
  "Jupiter has {N} known moons as of {Y}",
  "the {X} treaty was signed in {Y} after the {C} conflict",
  "water boils at {N} degrees Celsius at sea level",
  "the {X} algorithm runs in O(n log n) time complexity",
  "mount {X} is the tallest peak in the {C} range",
  "the {X} river flows through {N} countries in {C}",
  "dinosaurs went extinct approximately {N} million years ago",
  "the {X} programming language was created in {Y}",
  "a human cell contains approximately {N} mitochondria on average",
  "the french revolution began in {Y} with the storming of the {X}",
  "black holes form when stars {X} under their own gravitational {C}",
  "the {X} symphony was composed in {Y} during the {C} period",
  "neurons transmit signals using {X} and {C} ion channels",
  "the stock market crashed in {Y} due to {X} speculation",
  "carbon dioxide has a molecular weight of {N} grams per mole",
  "the {X} vaccine was developed using {C} messenger RNA technology",
  "ancient {C} built pyramids aligned with {X} star constellations",
];

const WORDS = ["alpha","beta","gamma","delta","epsilon","zeta","omega","sigma",
               "corona","nexus","prime","ultra","meta","terra","apex","nova",
               "vector","matrix","kernel","tensor","lambda","proxy","cipher"];
const COUNTRIES = ["Brazil","Egypt","Norway","Vietnam","Morocco","Iceland","Peru","Kenya"];
const YEARS = ["1847","1923","1965","1991","2003","2014","2019","2022"];

function makeNoise(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tmpl = NOISE_TEMPLATES[i % NOISE_TEMPLATES.length];
    const s = tmpl
      .replace(/\{X\}/g, WORDS[i % WORDS.length])
      .replace(/\{C\}/g, COUNTRIES[i % COUNTRIES.length])
      .replace(/\{N\}/g, String(100 + (i * 37) % 900))
      .replace(/\{Y\}/g, YEARS[i % YEARS.length]);
    out.push(s);
  }
  return out;
}

// ── Recall engine ──────────────────────────────────────────────────────────────
function buildIndex(facts, noiseTexts) {
  const index = [];
  for (const f of facts) {
    index.push({ id: f.id, text: f.stored, entity: f.entity, vec: textVec(f.stored) });
  }
  for (let i = 0; i < noiseTexts.length; i++) {
    index.push({ id: `noise-${i}`, text: noiseTexts[i], entity: "noise", vec: textVec(noiseTexts[i]) });
  }
  return index;
}

function queryIndex(index, queryText, topK = 5) {
  const qVec = textVec(queryText);
  return index
    .map(entry => ({ ...entry, score: cosineSim(qVec, entry.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Run one scale level ────────────────────────────────────────────────────────
function runScale(label, facts, noiseCount) {
  const noise   = makeNoise(noiseCount);
  const index   = buildIndex(facts, noise);
  const THRESHOLD = 0.55;

  let totalQueries = 0;
  let top1Hits     = 0;
  let top3Hits     = 0;
  let recipRankSum = 0;
  let fpCount      = 0;   // noise entries >= threshold on a targeted query
  let fpChecks     = 0;   // total (query × noise entries checked)
  let bleedCount   = 0;   // wrong-entity fact above threshold
  let bleedChecks  = 0;

  const failures = [];

  for (const fact of facts) {
    for (const q of fact.queries) {
      totalQueries++;
      const results = queryIndex(index, q, index.length);

      // Top-1 / Top-3
      const rank = results.findIndex(r => r.id === fact.id) + 1; // 1-indexed, 0 if not found
      if (rank === 1) top1Hits++;
      if (rank >= 1 && rank <= 3) top3Hits++;
      recipRankSum += rank > 0 ? 1 / rank : 0;

      // False positive rate — noise entries above threshold
      for (const r of results) {
        if (r.entity === "noise") {
          fpChecks++;
          if (r.score >= THRESHOLD) fpCount++;
        }
      }

      // Entity bleed — wrong person's fact above threshold
      for (const r of results) {
        if (r.entity !== "noise" && r.entity !== fact.entity && r.id !== fact.id) {
          bleedChecks++;
          if (r.score >= THRESHOLD) bleedCount++;
        }
      }

      // Record failure if not top-1
      if (rank !== 1) {
        failures.push({
          query:    q,
          expected: fact.id,
          got:      results[0]?.id ?? "—",
          got_score: +(results[0]?.score ?? 0).toFixed(3),
          expected_rank: rank,
          expected_score: rank > 0 ? +results[rank-1].score.toFixed(3) : 0,
        });
      }
    }
  }

  const top1Pct  = (top1Hits  / totalQueries * 100).toFixed(1);
  const top3Pct  = (top3Hits  / totalQueries * 100).toFixed(1);
  const mrr      = (recipRankSum / totalQueries).toFixed(3);
  const fpPct    = fpChecks   > 0 ? (fpCount   / fpChecks   * 100).toFixed(2) : "0.00";
  const bleedPct = bleedChecks > 0 ? (bleedCount / bleedChecks * 100).toFixed(2) : "0.00";

  return { label, noiseCount, totalQueries, top1Hits, top3Hits,
           top1Pct, top3Pct, mrr, fpPct, bleedPct, failures,
           indexSize: index.length };
}

// ── Print results ──────────────────────────────────────────────────────────────
function printResult(r) {
  const pass = pct => parseFloat(pct) >= 80 ? G(pct+"%") : parseFloat(pct) >= 60 ? Y(pct+"%") : R(pct+"%");
  const inv  = pct => parseFloat(pct) <= 1  ? G(pct+"%") : parseFloat(pct) <= 5  ? Y(pct+"%") : R(pct+"%");

  console.log(`\n  ── ${B(r.label)}  (index size: ${r.indexSize.toLocaleString()} entries, ${r.totalQueries} queries) ──`);
  console.log(`  Top-1 accuracy:    ${pass(r.top1Pct).padEnd(20)} ${r.top1Hits}/${r.totalQueries} correct as rank-1`);
  console.log(`  Top-3 accuracy:    ${pass(r.top3Pct).padEnd(20)} ${r.top3Hits}/${r.totalQueries} in top 3`);
  console.log(`  MRR:               ${r.mrr.padEnd(8)}               (1.0 = always top-1; 0.5 = always rank-2)`);
  console.log(`  False positive %:  ${inv(r.fpPct).padEnd(20)} noise entries scoring >= 0.55`);
  console.log(`  Entity bleed %:    ${inv(r.bleedPct).padEnd(20)} wrong-person facts above threshold`);

  if (r.failures.length > 0) {
    console.log(`\n  Failures (${r.failures.length}) — queries where correct answer was not rank-1:`);
    for (const f of r.failures) {
      const rankStr = f.expected_rank > 0 ? `rank ${f.expected_rank}` : "not found";
      console.log(`    ${R("✗")} "${f.query}"`);
      console.log(`       expected: ${f.expected} (score ${f.expected_score}, ${rankStr})`);
      console.log(`       got:      ${f.got} (score ${f.got_score})`);
    }
  } else {
    console.log(`\n  ${G("✓ Zero failures")} — every query returned the correct memory as rank-1`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║   RSHL Recall Accuracy Eval                                 ║");
console.log("║   Does the right memory come back when you query?           ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log(`\n  Facts:   ${FACTS.length} distinct facts  (${FACTS.map(f=>f.queries.length).reduce((a,b)=>a+b,0)} total paraphrase queries)`);
console.log("  Entities: Ryan, Sarah, Tom");
console.log("  Scales:   baseline (no noise) → +500 noise → +5000 noise");
console.log("  Metric:   Top-1, Top-3, MRR, false positive %, entity bleed %");
console.log("\n  Threshold: 0.55  (matches production KAI setting)\n");

const t0 = process.hrtime.bigint();

const r0    = runScale("Baseline — 30 facts, no noise",          FACTS, 0);
const r500  = runScale("+500 noise entries  (total 530)",        FACTS, 500);
const r5000 = runScale("+5000 noise entries  (total 5030)",      FACTS, 5000);

const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;

printResult(r0);
printResult(r500);
printResult(r5000);

// ── Summary table ──────────────────────────────────────────────────────────────
console.log("\n\n  ══ Summary ════════════════════════════════════════════════════");
console.log("  ┌─────────────────────────┬────────┬────────┬───────┬────────┬──────────┐");
console.log("  │ Scale                   │ Top-1  │ Top-3  │  MRR  │ FP %   │ Bleed %  │");
console.log("  ├─────────────────────────┼────────┼────────┼───────┼────────┼──────────┤");
for (const r of [r0, r500, r5000]) {
  const lbl = r.label.split("—")[0].trim().padEnd(23);
  console.log(`  │ ${lbl} │ ${r.top1Pct.padStart(5)}% │ ${r.top3Pct.padStart(5)}% │ ${r.mrr} │ ${r.fpPct.padStart(5)}% │ ${r.bleedPct.padStart(7)}% │`);
}
console.log("  └─────────────────────────┴────────┴────────┴───────┴────────┴──────────┘");

console.log(`\n  What this means:`);
console.log(`  Top-1   — the exact right memory was #1 result for that query`);
console.log(`  Top-3   — right memory was in the top 3 (useful for LLM context injection)`);
console.log(`  MRR     — closer to 1.0 means consistently high rank, even when not #1`);
console.log(`  FP %    — how often total noise pollutes above the recall threshold`);
console.log(`  Bleed % — how often a different person's fact leaks into the wrong query`);
console.log(`\n  Eval complete in ${elapsed.toFixed(0)}ms`);
