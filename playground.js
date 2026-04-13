/**
 * RSHL Playground — Interactive Terminal
 *
 * Store records, query them, see WHY they matched.
 * Evidence-first: every result shows the tokens that drove the score.
 *
 * Usage:
 *   node playground.js          — blank index, start fresh
 *   node playground.js --demo   — preload an infrastructure event stream scenario
 *   node playground.js --memory — preload a personal memory scenario
 *
 * Commands inside the session:
 *   store <text>      — add a record to the index
 *   query <text>      — find the closest matches (with evidence)
 *   list              — show all stored records
 *   clear             — wipe the index
 *   demo              — load MES scenario
 *   memory            — load personal memory scenario
 *   help              — show commands
 *   exit / quit       — close
 */

"use strict";

const readline = require("readline");
const path     = require("path");
const { textVec, cosineSim, debugTokens } = require(path.join(__dirname, "rshl-core"));

// ── Colour helpers ────────────────────────────────────────────────────────────
const G  = s => `\x1b[92m${s}\x1b[0m`;   // green
const R  = s => `\x1b[91m${s}\x1b[0m`;   // red
const Y  = s => `\x1b[93m${s}\x1b[0m`;   // yellow
const B  = s => `\x1b[96m${s}\x1b[0m`;   // cyan
const DIM = s => `\x1b[2m${s}\x1b[0m`;   // dim
const BOLD = s => `\x1b[1m${s}\x1b[0m`;  // bold

// ── Score → label ─────────────────────────────────────────────────────────────
function scoreLabel(s) {
  if (s >= 0.85) return G("strong match");
  if (s >= 0.70) return G("good match");
  if (s >= 0.55) return Y("possible match");
  return R("below threshold — filtered");
}

function scoreBar(s) {
  const filled = Math.round(s * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const col = s >= 0.70 ? G : s >= 0.55 ? Y : R;
  return col(bar) + ` ${s.toFixed(3)}`;
}

// ── Simple lattice — classify writes as ADD / UPDATE / NOOP ──────────────────
const THRESHOLD = 0.55;
const UPDATE_THRESHOLD = 0.82;  // high — only truly duplicate records qualify as NOOP/UPDATE

function classify(vec, index) {
  if (index.length === 0) return "ADD";
  const best = index.map(r => cosineSim(vec, r.vec)).reduce((a, b) => Math.max(a, b), 0);
  if (best >= UPDATE_THRESHOLD) return "NOOP";
  if (best >= THRESHOLD)        return "UPDATE";
  return "ADD";
}

// ── Index ─────────────────────────────────────────────────────────────────────
let index = [];
let sessionStores = 0;

function store(text) {
  const vec  = textVec(text);
  const op   = classify(vec, index);
  const toks = debugTokens(text);
  const id   = index.length + 1;

  if (op === "NOOP") {
    // Find what it matched
    const best = index.map((r,i) => [i, cosineSim(vec, r.vec)])
                      .sort((a,b) => b[1]-a[1])[0];
    console.log(`\n  ${Y("⟳ NOOP")}  Already known — matches existing record #${best[0]+1}`);
    console.log(`         "${index[best[0]].text.slice(0,70)}"`);
    console.log(`         Score ${best[1].toFixed(3)} — above ${UPDATE_THRESHOLD} threshold, nothing added\n`);
    return;
  }

  if (op === "UPDATE") {
    const best = index.map((r,i) => [i, cosineSim(vec, r.vec)])
                      .sort((a,b) => b[1]-a[1])[0];
    index.push({ id, text, vec });
    sessionStores++;
    console.log(`\n  ${Y("↻ UPDATE")}  New record stored — replaces/extends record #${best[0]+1}`);
    console.log(`           Was: "${index[best[0]].text.slice(0,60)}"`);
    console.log(`           Now: "${text.slice(0,60)}"`);
    console.log(`           Tokens: ${toks.map(t => t.type==='category' ? DIM(t.tok) : B(t.tok)).join("  ")}`);
    console.log(`           Record #${id} added  (${index.length} total)\n`);
    return;
  }

  // ADD
  index.push({ id, text, vec });
  sessionStores++;
  console.log(`\n  ${G("✓ ADD")}  Record #${id} stored`);
  console.log(`        "${text.slice(0,70)}"`);
  console.log(`        Tokens: ${toks.map(t => t.type==='category' ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  console.log(`        Index now has ${index.length} record${index.length===1?'':'s'}\n`);
}

function query(text, topN = 5) {
  if (index.length === 0) {
    console.log(`\n  ${Y("⚠")}  Index is empty — store some records first\n`);
    return;
  }

  const qvec  = textVec(text);
  const qtoks = debugTokens(text);

  const results = index
    .map(r => ({ ...r, score: cosineSim(qvec, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  const above = results.filter(r => r.score >= THRESHOLD);

  console.log(`\n  Query: ${BOLD('"' + text + '"')}`);
  console.log(`  Tokens: ${qtoks.map(t => t.type==='category' ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  console.log(`  Searching ${index.length} record${index.length===1?'':'s'}...\n`);

  if (above.length === 0) {
    console.log(`  ${R("No matches above threshold (0.55)")} — nothing relevant found`);
    console.log(`  Best score: ${results[0]?.score.toFixed(3) ?? "n/a"}  (below 0.55 = filtered as noise)\n`);
    return;
  }

  // Results table
  const w = Math.min(60, process.stdout.columns - 20 || 60);
  console.log(`  ${"─".repeat(w + 20)}`);
  for (let i = 0; i < results.length; i++) {
    const r    = results[i];
    const rank = `#${i + 1}`;
    const pass = r.score >= THRESHOLD;
    const label = pass ? scoreLabel(r.score) : R("filtered");
    console.log(`  ${rank.padEnd(4)} ${scoreBar(r.score)}  ${label}`);
    console.log(`       ${pass ? '' : DIM('')}"${r.text.slice(0, w)}"`);

    // Evidence — show token overlap
    if (pass) {
      const rtoks  = debugTokens(r.text);
      const qset   = new Set(qtoks.map(t => t.tok));
      const rset   = new Set(rtoks.map(t => t.tok));
      const shared = [...qset].filter(t => rset.has(t));
      const qonly  = [...qset].filter(t => !rset.has(t));
      const ronly  = [...rset].filter(t => !qset.has(t));

      if (shared.length > 0) {
        console.log(`       ${DIM("matched:")} ${shared.map(t => t.startsWith('#') ? DIM(t) : G(t)).join("  ")}`);
      }
      if (qonly.length > 0) {
        console.log(`       ${DIM("query only:")} ${qonly.map(t => Y(t)).join("  ")}`);
      }
      if (ronly.length > 0) {
        console.log(`       ${DIM("record only:")} ${ronly.map(t => DIM(t)).join("  ")}`);
      }
    }
    console.log();
  }
  console.log(`  ${above.length} of ${results.length} result${results.length===1?'':'s'} passed the 0.55 threshold\n`);
}

function list() {
  if (index.length === 0) {
    console.log(`\n  Index is empty\n`);
    return;
  }
  console.log(`\n  ${index.length} record${index.length===1?'':'s'} in index:\n`);
  for (const r of index) {
    const toks = debugTokens(r.text);
    console.log(`  #${String(r.id).padEnd(3)} "${r.text.slice(0,65)}"`);
    console.log(`       ${toks.map(t => t.type==='category' ? DIM(t.tok) : B(t.tok)).join("  ")}`);
  }
  console.log();
}

// ── Preset scenarios ──────────────────────────────────────────────────────────
const SCENARIOS = {
  demo: {
    label: "Infrastructure Event Stream",
    records: [
      // Service errors
      "auth-service returned error 503 — database connection refused",
      "api-gateway request timeout — upstream endpoint down after 3 retries",
      // Deploys
      "deploy pipeline succeeded — all 14 tests passed — running healthy",
      "deploy rollback triggered — integration test failed at stage 8",
      // Worker / resource
      "worker-01 memory spike 94 percent — alert triggered",
      "worker-01 restarted — memory cleared — back online",
      // Infrastructure
      "database connection pool at limit — new requests blocked",
      "scheduled backup completed — 2.4 GB archived to storage",
    ],
    queries: [
      "auth service database error",
      "worker memory alert exceeded",
      "deploy rollback failed",
      "database connection pool",
    ],
  },
  memory: {
    label: "Personal Memory Scenario",
    records: [
      "Ryan lives in Austin Texas",
      "Ryan works at Google as a software engineer",
      "Ryan enjoys hiking and trail running on weekends",
      "Ryan is allergic to peanuts",
      "Ryan has a golden retriever named Max",
      "Sarah lives in Seattle Washington",
      "Sarah is a nurse at Seattle General Hospital",
      "Sarah loves classical music and opera",
    ],
    queries: [
      "Where does Ryan live?",
      "What does Ryan do for work?",
      "Ryan food allergy",
      "Sarah job",
    ],
  },
};

function runScenario(name) {
  const s = SCENARIOS[name];
  if (!s) return;
  index = [];
  sessionStores = 0;
  console.log(`\n  ${BOLD("Loading scenario:")} ${s.label}`);
  console.log(`  ${"─".repeat(50)}\n`);
  for (const r of s.records) store(r);
  console.log(`  ${G("Scenario loaded.")} Try these example queries:\n`);
  for (const q of s.queries) {
    console.log(`    query ${q}`);
  }
  console.log();
}

// ── Help ──────────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
  ${BOLD("Commands:")}

    ${G("store")} <text>       Add a record to the index
                        Shows: ADD / UPDATE / NOOP classification + tokens

    ${G("query")} <text>       Find closest matching records
                        Shows: ranked results + WHY each matched (token evidence)

    ${G("list")}               Show all stored records and their tokens

    ${G("clear")}              Wipe the index and start over

    ${G("demo")}               Load infrastructure event stream scenario (8 records)
    ${G("memory")}             Load personal memory scenario (8 records)

    ${G("help")}               Show this message
    ${G("exit")} / ${G("quit")}        Close

  ${BOLD("How scoring works:")}

    ${G("0.85+")}  Strong match — same concept, different words
    ${G("0.70+")}  Good match   — clearly related
    ${Y("0.55+")}  Possible     — some overlap, worth returning
    ${R("< 0.55")}  Filtered     — noise, not returned

  ${BOLD("What the tokens show:")}

    ${B("word")}  — a content token extracted from your text
    ${DIM("#cat")}  — a semantic category anchor (e.g. #loc, #job, #fit)
            these create overlap between related terms even with no shared words
`);
}

// ── REPL ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   RSHL Playground — Live Evidence Terminal                   ║
║   Store records · Query them · See WHY they matched          ║
╚═══════════════════════════════════════════════════════════════╝

  Type ${G("help")} for commands.  Type ${G("demo")} or ${G("memory")} to load a preset scenario.
  Type ${G("store <text>")} to add a record, ${G("query <text>")} to search.
`);

  // Auto-load from flag
  const arg = process.argv[2];
  if (arg === "--demo")   runScenario("demo");
  if (arg === "--memory") runScenario("memory");

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: G("rshl") + " > ",
  });

  rl.prompt();

  rl.on("line", line => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const space = input.indexOf(" ");
    const cmd   = space === -1 ? input.toLowerCase() : input.slice(0, space).toLowerCase();
    const rest  = space === -1 ? "" : input.slice(space + 1).trim();

    switch (cmd) {
      case "store":
        if (!rest) { console.log(`  ${Y("Usage:")} store <text>\n`); break; }
        store(rest);
        break;

      case "query":
      case "q":
        if (!rest) { console.log(`  ${Y("Usage:")} query <text>\n`); break; }
        query(rest);
        break;

      case "list":
        list();
        break;

      case "clear":
        index = [];
        sessionStores = 0;
        console.log(`\n  ${Y("Index cleared")}\n`);
        break;

      case "demo":
        runScenario("demo");
        break;

      case "memory":
        runScenario("memory");
        break;

      case "help":
      case "h":
      case "?":
        showHelp();
        break;

      case "exit":
      case "quit":
        console.log(`\n  ${index.length} records stored this session. Bye.\n`);
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`\n  ${R("Unknown command:")} ${cmd}  — type ${G("help")} for commands\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

main();
