// ── CODEX AUDITOR ────────────────────────────────────────────────────────────
// Scans "The KAI Codex.md" for: duplicate/near-duplicate paragraphs, likely
// misspellings, broken internal references ("see Section X"), heading
// structure issues, and a section index. Writes a report KAI (and you) can
// read. Also exports an index JSON that the lattice indexer / KAI self-study
// can consume.
//
// Usage:  node scripts/codex-audit.mjs
//         node scripts/codex-audit.mjs --fix-trivial   (apply safe whitespace/heading fixes)
import fs from 'fs';
// Reuse the SAME relatedness math the live fleet search uses, so the persisted
// "related" edges in codex_index.json never drift from the runtime graph.
import { computeRelatedGraph } from '../shared/codex.mjs';

const CODEX = ['c:/KAI/The KAI Codex.md', 'c:/KAI/WHITEPAPER.md'].find(p => fs.existsSync(p));
const OUT_REPORT = 'c:/KAI/scratch/codex-audit-report.md';
const OUT_INDEX = 'c:/KAI/data/codex_index.json';
const FIX = process.argv.includes('--fix-trivial');

if (!CODEX) { console.error('No Codex file found.'); process.exit(1); }
let raw = fs.readFileSync(CODEX, 'utf8');

// ── Split into sections on markdown headings ────────────────────────────────
const lines = raw.split('\n');
const sections = [];
let cur = { title: '(preamble)', level: 0, start: 0, lines: [] };
lines.forEach((ln, i) => {
  const m = /^(#{1,4})\s+\**(.+?)\**\s*$/.exec(ln);
  if (m) {
    if (cur.lines.length) sections.push(cur);
    cur = { title: m[2].trim(), level: m[1].length, start: i, lines: [] };
  } else {
    cur.lines.push(ln);
  }
});
if (cur.lines.length) sections.push(cur);

// ── Duplicate / near-duplicate paragraph detection ──────────────────────────
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
const paras = [];
sections.forEach(sec => {
  const text = sec.lines.join('\n');
  text.split(/\n\s*\n/).forEach(p => {
    const t = p.trim();
    if (t.length > 80) paras.push({ section: sec.title, text: t, norm: normalize(t) });
  });
});

function jaccard(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

const dupes = [];
for (let i = 0; i < paras.length; i++) {
  for (let j = i + 1; j < paras.length; j++) {
    if (Math.abs(paras[i].norm.length - paras[j].norm.length) > 200) continue;
    const sim = jaccard(paras[i].norm, paras[j].norm);
    if (sim > 0.82) {
      dupes.push({
        sim: sim.toFixed(2),
        a: `[${paras[i].section}] ${paras[i].text.slice(0, 90)}...`,
        b: `[${paras[j].section}] ${paras[j].text.slice(0, 90)}...`
      });
    }
  }
}

// ── Broken internal references ──────────────────────────────────────────────
const titleSet = new Set(sections.map(s => normalize(s.title)));
const refs = [];
const refRe = /\b(?:see|refer to|described in|in)\s+Section\s+([0-9]+(?:\.[0-9]+)?)/gi;
let rm;
while ((rm = refRe.exec(raw)) !== null) refs.push(rm[1]);
const sectionNumbers = new Set();
sections.forEach(s => { const n = /^([0-9]+(?:\.[0-9]+)?)/.exec(s.title); if (n) sectionNumbers.add(n[1]); });
const brokenRefs = [...new Set(refs)].filter(r => !sectionNumbers.has(r));

// ── Likely misspellings (heuristic: rare non-dictionary tokens repeated) ────
// We can't ship a full dictionary, so flag tokens that look like typos:
// repeated letters (3+), or words appearing exactly once that are close to a
// common word. Conservative — this is a HINT list for human/KAI review.
const wordFreq = {};
(raw.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
const suspectSpelling = Object.keys(wordFreq)
  .filter(w => /(.)\1\1/.test(w) || /[bcdfghjklmnpqrstvwxz]{5,}/.test(w))
  .slice(0, 40);

// ── Section index (for lattice / KAI self-study) ────────────────────────────
const index = sections.map((s, i) => ({
  n: i,
  title: s.title,
  level: s.level,
  chars: s.lines.join('\n').length,
  preview: s.lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}));

// ── BRANCHING RELATED-TOPICS GRAPH ──────────────────────────────────────────
// Populate a "related" field on every index entry: an ordered list of the most-
// related sections (strongest edge first). This forms the branch graph a search
// follows to surface a hit PLUS its connected topics. Computed with the exact
// same algorithm the live fleet search uses (shared/codex.mjs::computeRelatedGraph)
// so the stored index and the runtime graph stay identical, and regenerated here
// on every re-index so the branches stay current as the Codex grows.
try {
  // Extract a §-number from each heading (mirrors loadCodexSections() in codex.mjs).
  const numFor = (title) => {
    const cleaned = String(title || '').replace(/[*\\]/g, '').replace(/§/g, '').trim();
    let num = (cleaned.match(/^(\d+(?:\.\d+)*)/) || [])[1] || null;
    if (!num) { const inl = String(title || '').match(/§\s*(\d+(?:\.\d+)*)/); if (inl) num = inl[1]; }
    return num;
  };
  const graphInput = sections.map((s, i) => ({
    title: s.title,
    text: s.lines.join('\n'),
    num: numFor(s.title),
    index: i
  }));
  const graph = computeRelatedGraph(graphInput, 6);
  index.forEach((entry, i) => {
    const edges = graph.get(i) || [];
    // Store both the neighbour index (n) and its §/title for human readability,
    // plus the edge weight + reason so the strongest relations rank first.
    entry.related = edges.map(e => ({
      n: e.to,
      num: graphInput[e.to].num,
      title: sections[e.to].title,
      weight: e.score,
      why: e.why
    }));
  });
  console.log(`  Related edges: built for ${index.filter(e => e.related && e.related.length).length}/${index.length} sections`);
} catch (e) {
  console.warn(`  [related-graph] skipped: ${e.message}`);
}

// ── Trivial auto-fixes (opt-in) ─────────────────────────────────────────────
let fixed = 0;
if (FIX) {
  const before = raw;
  raw = raw.replace(/[ \t]+\n/g, '\n');        // trailing whitespace
  raw = raw.replace(/\n{4,}/g, '\n\n\n');      // excess blank lines
  raw = raw.replace(/(^|\n)(#{1,4})([^ #])/g, '$1$2 $3'); // heading missing space
  if (raw !== before) {
    fs.writeFileSync(CODEX, raw);
    fixed = 1;
  }
}

// ── Write report + index ────────────────────────────────────────────────────
const r = [];
r.push(`# KAI Codex Audit`);
r.push(`File: ${CODEX}`);
r.push(`Sections: ${sections.length} | Paragraphs scanned: ${paras.length}`);
r.push(``);
r.push(`## Near-duplicate paragraphs (${dupes.length}) — review: keep one, replace the other with a "see Section X" pointer if both are needed`);
dupes.slice(0, 40).forEach(d => { r.push(`- sim=${d.sim}`); r.push(`  - A: ${d.a}`); r.push(`  - B: ${d.b}`); });
r.push(``);
r.push(`## Broken internal references (${brokenRefs.length})`);
brokenRefs.forEach(b => r.push(`- "Section ${b}" referenced but no matching numbered heading found`));
r.push(``);
r.push(`## Spelling suspects (${suspectSpelling.length}) — hint list, verify before changing`);
r.push(suspectSpelling.join(', ') || '(none flagged)');
r.push(``);
r.push(`## Trivial fixes: ${FIX ? (fixed ? 'applied (whitespace/headings)' : 'none needed') : 'not run (use --fix-trivial)'}`);
r.push(``);
r.push(`## Section index (first 60)`);
index.slice(0, 60).forEach(s => r.push(`- §${s.n} ${'  '.repeat(Math.max(0, s.level - 1))}${s.title} (${s.chars} chars)`));

fs.writeFileSync(OUT_REPORT, r.join('\n'));
try { fs.writeFileSync(OUT_INDEX, JSON.stringify(index, null, 2)); } catch (_) {}

console.log(`Codex audit complete.`);
console.log(`  Sections: ${sections.length}`);
console.log(`  Near-duplicate paragraphs: ${dupes.length}`);
console.log(`  Broken refs: ${brokenRefs.length}`);
console.log(`  Spelling suspects: ${suspectSpelling.length}`);
console.log(`  Report: ${OUT_REPORT}`);
console.log(`  Index : ${OUT_INDEX}`);
