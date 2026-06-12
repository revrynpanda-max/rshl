// ── CODEX CLAIM VERIFIER ─────────────────────────────────────────────────────
// "Did he do a 100% complete job?" — tests the Codex's claims against the
// ACTUAL codebase and the LIVE engine, then proposes fixes for any gaps.
//
// What it checks:
//   1. Every `src/*.rs` file path mentioned in the Codex → does the file exist?
//   2. Every backticked `function()` name → is it defined somewhere in src/?
//   3. Signature constants (b=0.306349, D=16,384, 4% sparsity, Φ threshold 2.9,
//      coherence floor 0.40, physics floor 0.55...) → present in source?
//   4. Live engine claims → /api/status answers, lattice non-empty, synapses real.
//
// Output:
//   - scratch/codex-claim-report.md          (human + KAI readable)
//   - state/codex_claim_proposals.json       (gaps, queued for Oracle → Ryan approval)
//   - optional: --discord posts a summary embed for Oracle's channel
//
// Run from C:\KAI:   node tools/oracle-discord/scripts/codex-claim-verifier.mjs
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CODEX = ['The KAI Codex.md', 'WHITEPAPER.md'].map(f => path.join(ROOT, f)).find(p => fs.existsSync(p));
const SRC = path.join(ROOT, 'src');
const REPORT = path.join(ROOT, 'scratch', 'codex-claim-report.md');
const PROPOSALS = path.join(ROOT, 'tools', 'oracle-discord', 'state', 'codex_claim_proposals.json');
const DISCORD = process.argv.includes('--discord');

if (!CODEX || !fs.existsSync(SRC)) {
  console.error('Need The KAI Codex.md and src/ — run from C:\\KAI');
  process.exit(1);
}
const codex = fs.readFileSync(CODEX, 'utf8');

// ── Load all Rust source into one searchable blob (with per-file map) ───────
const rsFiles = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith('.rs')) rsFiles.push(p);
  }
})(SRC);
const srcBlob = rsFiles.map(p => `\n////FILE:${p}\n` + fs.readFileSync(p, 'utf8')).join('\n');
console.log(`Loaded ${rsFiles.length} Rust files (${(srcBlob.length / 1024).toFixed(0)} KB)`);

// The Codex also documents the Python learning pipeline and the JS ecosystem —
// claims about those must be checked against THOSE sources, not just Rust.
let auxBlob = '';
const auxFiles = [];
for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.py')) auxFiles.push(path.join(ROOT, f));
(function walkJs(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f.includes('.bak')) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJs(p, depth + 1);
    else if (f.endsWith('.mjs') || f.endsWith('.py')) auxFiles.push(p);
  }
})(path.join(ROOT, 'tools', 'oracle-discord'));
for (const p of auxFiles) { try { auxBlob += `\n////FILE:${p}\n` + fs.readFileSync(p, 'utf8'); } catch (_) {} }
console.log(`Loaded ${auxFiles.length} Python/JS files (${(auxBlob.length / 1024).toFixed(0)} KB)`);

const results = { verified: [], failed: [], unverifiable: [] };
function check(kind, claim, ok, detail = '') {
  (ok ? results.verified : results.failed).push({ kind, claim, detail });
}

// ── 1. File-path claims ──────────────────────────────────────────────────────
const pathClaims = [...new Set((codex.match(/`(src\/[a-z0-9_\/]+\.rs)`/gi) || []).map(s => s.replace(/`/g, '')))];
for (const rel of pathClaims) {
  const abs = path.join(ROOT, rel.replace(/\//g, path.sep));
  check('file', rel, fs.existsSync(abs), fs.existsSync(abs) ? 'exists' : 'FILE NOT FOUND');
}

// ── 2. Function-name claims ──────────────────────────────────────────────────
const fnClaims = [...new Set((codex.match(/`([a-z_][a-z0-9_]{3,})\(\)`/g) || []).map(s => s.replace(/[`()]/g, '')))];
for (const fn of fnClaims) {
  // A claim holds if the function is DEFINED in Rust (fn x), Python (def x),
  // or JS (function x / const x = ...), OR if it's a std-lib method the code
  // USES (e.g. `.count_ones(`) — the Codex references both kinds.
  const definedRust = new RegExp(`fn\\s+${fn}\\b`).test(srcBlob);
  const definedAux = new RegExp(`(def\\s+${fn}\\b|function\\s+${fn}\\b|(const|let)\\s+${fn}\\s*=)`).test(auxBlob);
  const usedAsMethod = srcBlob.includes(`.${fn}(`);
  const ok = definedRust || definedAux || usedAsMethod;
  const where = definedRust ? 'defined in src/' : definedAux ? 'defined in pipeline/ecosystem (Python/JS)' : usedAsMethod ? 'std method used in src/' : 'NOT FOUND anywhere';
  check('function', `${fn}()`, ok, where);
}

// ── 3. Signature constants ───────────────────────────────────────────────────
const constants = [
  { name: 'SpiralState b = 0.306349', pat: /0\.306349/ },
  { name: 'Dimension D = 16,384', pat: /16384|16_384/ },
  { name: 'Sparsity 4% (0.04)', pat: /0\.04\b/ },
  { name: 'Confidence phase transition 2.9', pat: /2\.9\b/ },
  { name: 'Coherence floor 0.40', pat: /0\.40\b|0\.4(?![0-9])/ },
  { name: 'Physics resonance floor 0.55', pat: /0\.55\b/ },
  { name: 'Three-angle protocol marker', pat: /three-angle|three_angle|angle3/i },
  { name: 'Fibonacci torsion marker', pat: /fibonacci/i },
  { name: 'Boid flock_lattice', pat: /flock_lattice/ },
  { name: 'Hippocampus consolidation', pat: /consolidate_into_universe/ },
];
for (const c of constants) {
  const ok = c.pat.test(srcBlob);
  check('constant', c.name, ok, ok ? 'found in source' : 'NOT FOUND in source');
}

// ── 4. Live engine claims ────────────────────────────────────────────────────
async function liveChecks() {
  try {
    const r = await fetch('http://127.0.0.1:3334/api/status', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('status ' + r.status);
    const s = await r.json();
    check('live', 'Engine answers /api/status', true, `cells=${s.total_cells}`);
    check('live', 'Lattice is non-empty (learning has occurred)', (s.total_cells || 0) > 1000, `cells=${s.total_cells}`);
    check('live', 'Synaptic layer active', (s.synapses || 0) > 0, `synapses=${s.synapses}`);
    check('live', 'Global Phi computable', typeof s.phi_g === 'number', `phi_g=${s.phi_g}`);
  } catch (e) {
    results.unverifiable.push({ kind: 'live', claim: 'Live engine checks', detail: `engine offline: ${e.message} — start the fleet and re-run` });
  }
}

// ── Report + proposals ───────────────────────────────────────────────────────
function emit() {
  const total = results.verified.length + results.failed.length;
  const pctNum = total ? (100 * results.verified.length / total) : 0;
  const pct = pctNum.toFixed(1);

  const lines = [];
  lines.push(`# Codex Claim Verification — "Did I do a 100% complete job?"`);
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## Verdict: **${pct}% of machine-checkable claims verified** (${results.verified.length}/${total}${results.unverifiable.length ? `, ${results.unverifiable.length} unverifiable this run` : ''})`);
  lines.push(``);
  if (results.failed.length) {
    lines.push(`## ❌ FAILED CLAIMS — proposed for repair (Oracle → Ryan approval required)`);
    results.failed.forEach(f => lines.push(`- [${f.kind}] ${f.claim} — ${f.detail}`));
  } else {
    lines.push(`## ✅ No failed claims. The Codex tells the truth about the code.`);
  }
  if (results.unverifiable.length) {
    lines.push(``, `## ⏳ Unverifiable this run`);
    results.unverifiable.forEach(u => lines.push(`- [${u.kind}] ${u.claim} — ${u.detail}`));
  }
  lines.push(``, `## ✅ Verified (${results.verified.length})`);
  results.verified.forEach(v => lines.push(`- [${v.kind}] ${v.claim}`));

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join('\n'));

  // Proposal queue: Oracle reads this; nothing is changed without Ryan's approval.
  const proposals = results.failed.map(f => ({
    id: `CODEX-${f.kind.toUpperCase()}-${f.claim.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}`,
    kind: f.kind,
    claim: f.claim,
    finding: f.detail,
    proposal: f.kind === 'file' || f.kind === 'function'
      ? 'Either implement the missing item in src/, or correct the Codex to match reality. Requires Ryan approval.'
      : 'Verify the constant/marker and update whichever side (code or Codex) is wrong. Requires Ryan approval.',
    status: 'PENDING_ORACLE_REVIEW',
    ts: Date.now()
  }));
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true });
  fs.writeFileSync(PROPOSALS, JSON.stringify({ generated: new Date().toISOString(), completeness: pct + '%', proposals }, null, 2));

  console.log(`\n══ VERDICT: ${pct}% verified (${results.verified.length}/${total}) ══`);
  if (results.failed.length) {
    console.log(`❌ ${results.failed.length} gap(s) found — proposals queued for Oracle → Ryan:`);
    results.failed.forEach(f => console.log(`   - [${f.kind}] ${f.claim}: ${f.detail}`));
  } else {
    console.log('✅ No gaps. 100% of checkable claims hold.');
  }
  console.log(`Report: ${REPORT}`);
  console.log(`Proposals: ${PROPOSALS}`);
  return { pct, proposals };
}

async function postDiscord(pct, proposals) {
  if (!DISCORD) return;
  try {
    // Same webhook the learning pipeline uses (Oracle's update channel)
    const py = fs.readFileSync(path.join(ROOT, 'overnight_pipeline.py'), 'utf8');
    const hook = (py.match(/DISCORD_WEBHOOK_URL\s*=\s*"([^"]+)"/) || [])[1];
    if (!hook) return;
    const desc = proposals.length
      ? `**Completeness: ${pct}%**\n\n**Gaps proposed for repair (awaiting Ryan's approval):**\n` + proposals.slice(0, 10).map(p => `• [${p.kind}] ${p.claim} — ${p.finding}`).join('\n')
      : `**Completeness: ${pct}%** — every machine-checkable claim in the Codex holds. ✅`;
    await fetch(hook + '?wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: '🔬 Codex Claim Verification', description: desc.slice(0, 3900), color: proposals.length ? 15105570 : 3066993 }] }),
      signal: AbortSignal.timeout(8000)
    });
    console.log('Summary posted to Discord.');
  } catch (e) { console.log('Discord post skipped:', e.message); }
}

(async () => {
  await liveChecks();
  const { pct, proposals } = emit();
  await postDiscord(pct, proposals);
})();
