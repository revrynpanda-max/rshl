// ── THE KAI CODEX — shared lookup for the WHOLE fleet ───────────────────────
// Every bot (not just Leo) can query the 250-page whitepaper. Sections are
// split on headings, scored by term hits (title hits weighted), top matches
// returned at full depth. "random" queries return random sections.
import fs from 'fs';
import path from 'path';

// THE KAI CODEX *IS* THE WHITEPAPER — they are ONE document, not two sources.
// "The KAI Codex.md" is the single canonical / living document. WHITEPAPER.md is
// only an older snapshot kept on disk; it is used ONLY as a last-resort fallback
// for the genuine case that the canonical Codex file is missing. It must never be
// presented or searched as a SEPARATE doc alongside the Codex (see WHITEPAPER_RE
// exclusion in listDocs / searchDocs below).
const CODEX_PATHS = ['c:/KAI/The KAI Codex.md', 'c:/KAI/WHITEPAPER.md'];
// Matches the stale WHITEPAPER.md snapshot so the doc tools can exclude it and
// never conflate it with the canonical Codex.
const WHITEPAPER_RE = /(^|[\\/])whitepaper\.md$/i;
let _codexSections = null;
let _codexMtime = 0;

export function loadCodexSections() {
  const CODEX_PATH = CODEX_PATHS.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || CODEX_PATHS[0];
  // LIVE RELOAD: the cache invalidates when the document changes on disk —
  // Codex edits reach every running bot within seconds, no restarts needed.
  let mtime = 0;
  try { mtime = fs.statSync(CODEX_PATH).mtimeMs; } catch (_) {}
  if (_codexSections && mtime === _codexMtime) return _codexSections;
  _codexMtime = mtime;
  try {
    const raw = fs.readFileSync(CODEX_PATH, 'utf8');
    // Split on heading levels 1-4 (was 1-3) so the 20 #### subsections at the
    // bottom of the Codex become their own searchable sections instead of being
    // swallowed by their parent — Leo couldn't find that content before.
    const parts = raw.split(/\n(?=#{1,4} )/);
    const WPP = 278; // words per page (matches codex_get_page)
    let wc = 0;
    _codexSections = parts.map((s, i) => {
      const title = ((s.match(/^#{1,4} \**(.+?)\**\s*$/m) || [])[1] || s.slice(0, 60)).trim();
      // Extract a section number from the heading regardless of scheme:
      // "§14.44", "14.44", "26.1.1", "1.  Why RSHL...", "Part V — ... (§21)".
      const cleaned = title.replace(/[*\\]/g, '').replace(/§/g, '').trim();
      let num = (cleaned.match(/^(\d+(?:\.\d+)*)/) || [])[1] || null;
      if (!num) { const inl = title.match(/§\s*(\d+(?:\.\d+)*)/); if (inl) num = inl[1]; }
      const page = Math.floor(wc / WPP) + 1;
      wc += (s.match(/\S+/g) || []).length;
      return { title, text: s, index: i, num, page };
    });
  } catch (e) {
    console.warn(`[Codex] Could not load KAI Codex at ${CODEX_PATH}: ${e.message}`);
    _codexSections = [];
  }
  return _codexSections;
}

// ── Plain-language → technical alias map ────────────────────────────────────
// The Codex is full of jargon (hippocampus, phasor coherence, polychora). Someone
// who DOESN'T know the terms — "how does it remember?", "is it conscious?", "what
// makes it fast?" — would never hit the right section by keyword alone. This maps
// everyday words onto the real terms so naive questions still land. Aliases score
// at HALF weight so they guide without drowning out exact matches.
const CODEX_SYNONYMS = {
  remember: ['memory', 'hippocampus', 'consolidation', 'recall', 'persistence'],
  memory:   ['hippocampus', 'consolidation', 'region', 'universe', 'persistence'],
  forget:   ['decay', 'pruning', 'archive', 'tribunal'],
  learn:    ['training', 'curriculum', 'hebbian', 'plasticity', 'pipeline'],
  learning: ['training', 'curriculum', 'hebbian', 'plasticity'],
  smart:    ['emergence', 'phi', 'reasoning', 'epistemic', 'confidence'],
  think:    ['reasoning', 'cognition', 'epistemic', 'inference'],
  thinking: ['reasoning', 'cognition', 'epistemic'],
  conscious:['emergence', 'phi', 'metacognition', 'self-model'],
  aware:    ['emergence', 'metacognition', 'ambient', 'self-model'],
  feel:     ['emotion', 'drive', 'valence', 'mirror neuron', 'dopamine'],
  feeling:  ['emotion', 'valence', 'drive'],
  emotion:  ['valence', 'drive', 'mirror neuron', 'amygdala'],
  dream:    ['consolidation', 'sleep', 'replay', 'idle'],
  sleep:    ['consolidation', 'replay', 'idle', 'dream'],
  voice:    ['speech', 'tts', 'leo', 'gemini', 'audio'],
  talk:     ['speech', 'voice', 'social', 'conversation'],
  speak:    ['speech', 'voice', 'tts'],
  fix:      ['self-healing', 'phoenix', 'repair', 'recovery'],
  heal:     ['self-healing', 'phoenix', 'repair', 'recovery'],
  crash:    ['phoenix', 'recovery', 'resurrection', 'survival'],
  die:      ['death', 'survival', 'phoenix', 'pain'],
  death:    ['survival', 'phoenix', 'resurrection'],
  fast:     ['performance', 'benchmark', 'throughput', 'latency'],
  slow:     ['performance', 'throttle', 'governor', 'latency'],
  speed:    ['performance', 'benchmark', 'throughput'],
  frequency:['rf', 'sensor', 'spectrum', 'tinysa'],
  sensor:   ['sensory', 'rf', 'thermal', 'infrared', 'ambient'],
  see:      ['vision', 'sensory', 'thermal', 'image'],
  hear:     ['audio', 'voice', 'speech', 'sensory'],
  math:     ['mathematical', 'torsion', 'fibonacci', 'phasor', 'spiral', 'geometry'],
  geometry: ['polychora', '600-cell', 'srht', 'quantum'],
  quantum:  ['born', 'srht', 'polychora', 'probability'],
  build:    ['development', 'oracle', 'bootstrap', 'paradigm'],
  built:    ['development', 'oracle', 'bootstrap'],
  fleet:    ['oracle', 'agent', 'roster', 'sovereign'],
  business: ['openoracle', 'work', 'industrial', 'commercial'],
  cloud:    ['deployment', 'codespaces', 'public', 'portal'],
  vector:   ['ternary', 'sparse', 'hyperdimensional', 'encoding'],
  confidence:['epistemic', 'phi', 'calibration', 'verification'],
  version:  ['system state', 'update', 'latest'],
  safe:     ['epistemic', 'verification', 'firewall', 'permission'],
};

function expandQueryTerms(terms) {
  const out = new Set(terms);
  for (const t of terms) {
    const aliases = CODEX_SYNONYMS[t];
    if (Array.isArray(aliases)) for (const a of aliases) out.add(a);
  }
  return out; // Set; callers check membership of original terms for weighting
}

// ── BRANCHING RELATED-TOPICS GRAPH ──────────────────────────────────────────
// Every section is a node; edges link it to its most-related siblings. A search
// can then surface the matched node PLUS its related branch (the cluster of
// linked topics), not just one isolated hit. Relatedness is a blend of:
//   (a) explicit cross-references in the prose ("see §X", "§14.9", "Section N"),
//   (b) shared key terms / concept overlap (TF-style weighting of rare terms),
//   (c) synonym overlap via the CODEX_SYNONYMS alias map above.
// The result is the SAME algorithm used by scripts/codex-audit.mjs to bake a
// persistent "related" field into data/codex_index.json on every re-index — so
// the live graph and the stored index never drift apart.

// Stopwords reused for keyword extraction (broad — kills boilerplate so only
// content-bearing terms drive term-overlap edges).
const _RELATED_STOP = new Set(['the','and','for','with','from','that','this','have','has','had','are','was','were','will','would','should','can','could','its','his','her','they','them','then','than','into','out','not','but','all','any','one','two','via','per','use','used','uses','each','more','most','also','only','over','under','when','what','how','why','who','which','§','section','sections','see','refer','described','codex','kai','rshl']);

function _relatedTermSet(text) {
  const freq = new Map();
  const toks = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9\-]{2,}/g) || [];
  for (const t of toks) {
    if (_RELATED_STOP.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq;
}

// Pull explicit §-number / "Section N" cross-references out of a section body.
function _explicitRefs(text) {
  const out = new Set();
  const s = String(text || '');
  let m;
  const reA = /§\s*(\d+(?:\.\d+)*)/g;            // §14.9, §6.3
  while ((m = reA.exec(s)) !== null) out.add(m[1]);
  const reB = /\b(?:see|refer to|described in|in)\s+section\s+(\d+(?:\.\d+)*)/gi;
  while ((m = reB.exec(s)) !== null) out.add(m[1]);
  return out;
}

// Core graph builder. `sections` is an array of { title, text, num?, index? }.
// Returns Map(index -> [{ to, score, why }]) ordered strongest-first.
// `topK` caps stored neighbours per node. Exported so the audit re-indexer can
// reuse the exact same relatedness math.
export function computeRelatedGraph(sections, topK = 6) {
  const n = sections.length;
  // Document frequency for IDF-style weighting: rare shared terms matter more.
  const df = new Map();
  const termSets = new Array(n);
  for (let i = 0; i < n; i++) {
    const sec = sections[i];
    const set = _relatedTermSet((sec && sec.title ? sec.title + ' ' : '') + (sec && (sec.text || sec.preview) || ''));
    termSets[i] = set;
    for (const t of set.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log(1 + n / (1 + (df.get(t) || 0)));

  // Expand each section's terms with synonyms so alias overlap counts too.
  const expanded = termSets.map(set => {
    const e = new Set(set.keys());
    for (const t of set.keys()) { const al = CODEX_SYNONYMS[t]; if (Array.isArray(al)) for (const a of al) e.add(a); }
    return e;
  });

  const explicit = sections.map(s => _explicitRefs(s && (s.text || s.preview)));

  const graph = new Map();
  for (let i = 0; i < n; i++) {
    const edges = [];
    const eiTerms = expanded[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let score = 0;
      const why = [];
      // (a) explicit cross-reference — strongest signal, bidirectional.
      const sj = sections[j];
      if (sj && sj.num && explicit[i].has(sj.num)) { score += 12; why.push('xref'); }
      const si = sections[i];
      if (si && si.num && explicit[j].has(si.num)) { score += 8; why.push('xref-back'); }
      // (b)+(c) term + synonym overlap, IDF-weighted.
      let overlap = 0, shared = 0;
      for (const t of eiTerms) { if (expanded[j].has(t)) { overlap += idf(t); shared++; } }
      if (shared > 0) { score += overlap * 0.6; why.push('terms'); }
      if (score > 0.0001) edges.push({ to: j, score: +score.toFixed(3), why: why.join('+') });
    }
    edges.sort((a, b) => b.score - a.score);
    graph.set(i, edges.slice(0, topK));
  }
  return graph;
}

// Cached live graph for the running fleet, invalidated when the Codex changes.
let _relatedGraph = null, _relatedGraphMtime = -1;
function _liveRelatedGraph() {
  const sections = loadCodexSections();
  if (_relatedGraph && _codexMtime === _relatedGraphMtime && _relatedGraph.size === sections.length) {
    return { graph: _relatedGraph, sections };
  }
  _relatedGraph = computeRelatedGraph(sections, 6);
  _relatedGraphMtime = _codexMtime;
  return { graph: _relatedGraph, sections };
}

// Expand a set of seed section indices into their related branch (1–2 hops,
// deduped, ranked). Returns an ordered array of section objects (excluding the
// seeds). depth=1 default; size caps how many related sections come back.
export function relatedBranch(seedIndices, depth = 1, size = 5) {
  const { graph, sections } = _liveRelatedGraph();
  const seeds = new Set(seedIndices);
  const acc = new Map(); // idx -> best accumulated score
  let frontier = [...seedIndices];
  for (let hop = 0; hop < Math.max(1, depth); hop++) {
    const next = [];
    const decay = Math.pow(0.5, hop); // 2nd-hop links count for less
    for (const fi of frontier) {
      const edges = graph.get(fi) || [];
      for (const e of edges) {
        if (seeds.has(e.to)) continue;
        const add = e.score * decay;
        acc.set(e.to, Math.max(acc.get(e.to) || 0, add));
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, size)
    .map(([idx]) => sections[idx])
    .filter(Boolean);
}

export function consultCodex(query, maxChars = 12000) {
  const sections = loadCodexSections();
  if (!sections.length) return null;

  if (/\b(random|another|something (new|else)|surprise)\b/i.test(String(query))) {
    const picks = [];
    const used = new Set();
    while (picks.length < 2 && used.size < sections.length) {
      const i = Math.floor(Math.random() * sections.length);
      if (used.has(i)) continue;
      used.add(i);
      if (sections[i].text.trim().length > 200) picks.push(sections[i]);
    }
    if (picks.length) {
      return picks.map(sec => `\n--- ${sec.title} ---\n${sec.text.slice(0, Math.floor(maxChars / 2))}`).join('\n').slice(0, maxChars);
    }
  }

  // Drop noise words so "what / how / does / the…" don't match boilerplate and
  // drown the real terms.
  const STOP = new Set(['the','and','for','what','how','does','did','was','are','you','your','yours','that','this','with','from','have','has','had','can','could','will','would','should','about','tell','show','explain','give','know','why','who','whom','where','when','which','into','out','its','his','her','they','them','then','than','some','any','all','get','got','now','one','two','also','just','like','really','actually','please','was','were']);
  const terms = String(query).toLowerCase().split(/[^a-z0-9.=]+/).filter(t => t.length > 2 && !STOP.has(t));
  if (!terms.length) return null;
  // Adjacent word pairs from the ORIGINAL query order — for a proximity bonus so
  // "fibonacci torsion" favours the section with those words TOGETHER, not scattered.
  const bigrams = [];
  for (let i = 0; i + 1 < terms.length; i++) bigrams.push(`${terms[i]} ${terms[i + 1]}`);
  // Expand plain-language words to technical aliases so naive queries still hit.
  const origSet = new Set(terms);
  const searchTerms = [...expandQueryTerms(terms)];

  // RECENCY-SENSITIVE queries (version, current status, latest update, today):
  // the NEWEST facts live in the dated "SYSTEM STATE SUMMARY" entries at the
  // BOTTOM of the Codex. Plain term-scoring buried them, so Leo kept reporting
  // stale versions. For these queries we boost late-document + SYSTEM STATE
  // sections so the current truth surfaces first.
  const recencySensitive = /\b(version|v\d|latest|current|recent|today|now|status|update|state|9\.\d|8\.\d)\b/i.test(String(query));
  const total = sections.length || 1;

  // Navigation sections (the Table of Contents, the plain-language Index) contain
  // EVERY term, so they used to out-score real content and get returned for almost
  // any query. They're for navigating, not answering — exclude them from scoring.
  const isNavSection = (t) => /table of contents|how to use this index|quick[- ]?reference index|reader'?s? index|plain[- ]?language index/i.test(String(t || ''));

  const scored = sections
    .map(sec => {
      if (isNavSection(sec.title)) return { sec, score: 0 };
      const titleL = sec.title.toLowerCase();
      const hay = sec.text.toLowerCase();
      let score = 0;
      let matchedDistinct = 0; // how many of YOUR distinct words this section has
      for (const t of searchTerms) {
        const w = origSet.has(t) ? 1 : 0.5; // alias terms guide at half weight
        let here = false;
        if (titleL.includes(t)) { score += 5 * w; here = true; }
        let idx = -1, n = 0;
        while ((idx = hay.indexOf(t, idx + 1)) !== -1 && n < 20) n++;
        score += n * w;
        if (n > 0) here = true;
        if (here && origSet.has(t)) matchedDistinct++;
      }
      // COVERAGE: reward a section that hits MORE of your distinct words rather than
      // one word repeated — matching 3 of 3 query words beats one word 20 times.
      if (terms.length > 1) score += (matchedDistinct / terms.length) * matchedDistinct * 6;
      // PROXIMITY: strong bonus when your words appear TOGETHER (the actual topic),
      // not scattered across an unrelated section.
      for (const bg of bigrams) {
        if (titleL.includes(bg)) score += 10;
        if (hay.includes(bg)) score += 12;
      }
      if (score > 0 && recencySensitive) {
        // later in the doc = newer; small proportional nudge (max +4)
        score += ((sec.index || 0) / total) * 4;
        if (/system state summary/i.test(sec.title)) score += 3;
      }
      return { sec, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // Return up to 4 top sections (was 2) so Leo gets fuller context and is far
  // less likely to fill gaps by hallucinating.
  const perSec = Math.floor(maxChars / 4);
  let out = '';
  const primaryIdx = [];
  for (const { sec } of scored.slice(0, 4)) {
    primaryIdx.push(sec.index);
    out += `\n--- ${sec.title} ---\n${sec.text.slice(0, perSec)}\n`;
    if (out.length >= maxChars) break;
  }
  // BRANCHING INDEX: surface the related branch of the matched node(s) so the
  // reader can follow linked topics. Additive — appended after the primary
  // hits, clearly grouped, and only as a compact pointer list (titles + §) so
  // it never crowds out the real answer. Depth/size configurable via env.
  try {
    const depth = Number(process.env.CODEX_BRANCH_DEPTH) || 1;
    const size = Number(process.env.CODEX_BRANCH_SIZE) || 4;
    if (size > 0 && out.length < maxChars) {
      const branch = relatedBranch(primaryIdx, depth, size);
      if (branch.length) {
        const lines = branch.map(s => `  • ${s.num ? '§' + s.num + ' ' : ''}${s.title}`).join('\n');
        out += `\n--- RELATED BRANCH (linked topics — follow with codex_section) ---\n${lines}\n`;
      }
    }
  } catch (_) { /* never let branch expansion break the primary answer */ }
  return out.slice(0, maxChars);
}

// Sequential narration support: fetch a section by number (1-based) for
// "read me the Codex a page at a time" requests.
export function codexSectionCount() {
  return loadCodexSections().length;
}
export function getCodexSection(n, maxChars = 7000) {
  const sections = loadCodexSections();
  if (!sections.length) return null;
  const idx = Math.max(0, Math.min(sections.length - 1, (Number(n) || 1) - 1));
  const sec = sections[idx];
  return {
    number: idx + 1,
    total: sections.length,
    title: sec.title,
    text: sec.text.slice(0, maxChars)
  };
}

// Quick check: is this message about KAI / the system itself?
const KAI_TOPIC_RE = /\b(kai|rshl|lattice|codex|whitepaper|hyperdimensional|sparse ?vec|fibonacci torsion|spiral ?state|boid|hippocampus|consolidat|synap|universe cell|epistemic)\b/i;
export function isKaiTopic(text) {
  return KAI_TOPIC_RE.test(String(text || ''));
}

// Query the live lattice (KAI's Rust engine) — same call Leo uses.
// ENGINE BODYGUARD (June 2026): the social fleet's grounding queries were
// hammering the engine into constant timeouts. Three protections:
//   1. 60s result cache — identical questions don't re-hit the engine
//   2. max 2 in-flight queries per process — excess returns null instantly
//   3. circuit breaker — 2 timeouts within 60s pauses all queries for 90s
//      (the engine is choking; silence is the kind response)
const _latCache = new Map(); // query -> {result, ts}
let _latInFlight = 0;
let _latTimeouts = [];
let _latBreakerUntil = 0;

export async function queryLatticeRaw(query, n = 5, timeoutMs = 5000) {
  const key = `${query}|${n}`;
  const cached = _latCache.get(key);
  if (cached && Date.now() - cached.ts < 60_000) return cached.result;
  if (Date.now() < _latBreakerUntil) return null;          // engine cooling down
  if (_latInFlight >= 2) return null;                       // don't stack load

  _latInFlight++;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:3334/api/rshl/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, n }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (res.status === 429 && attempt === 0) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        if (!res.ok) return null;
        const hits = await res.json();
        const lines = (Array.isArray(hits) ? hits : []).map(h => h.text).filter(Boolean);
        const result = lines.length ? lines.join('\n') : null;
        _latCache.set(key, { result, ts: Date.now() });
        if (_latCache.size > 200) _latCache.delete(_latCache.keys().next().value);
        return result;
      } catch (e) {
        if (String(e?.name).includes('Timeout') || String(e?.message).includes('abort')) {
          _latTimeouts.push(Date.now());
          _latTimeouts = _latTimeouts.filter(t => Date.now() - t < 60_000);
          if (_latTimeouts.length >= 2) {
            _latBreakerUntil = Date.now() + 90_000;
            console.warn('[Codex/Lattice] Engine timing out — pausing fleet lattice queries for 90s to let it breathe.');
          }
        }
        return null;
      }
    }
    return null;
  } finally {
    _latInFlight--;
  }
}

// One-call knowledge context for any bot: Codex (if KAI-related) + lattice.
export async function buildKnowledgeContext(topicText, maxChars = 3000) {
  let out = '';
  if (isKaiTopic(topicText)) {
    const codex = consultCodex(topicText, Math.floor(maxChars * 0.7));
    if (codex) out += `[KAI CODEX — authoritative excerpts]\n${codex}\n`;
  }
  const lattice = await queryLatticeRaw(topicText, 4);
  if (lattice) out += `\n[LATTICE MEMORY]\n${lattice.slice(0, Math.floor(maxChars * 0.4))}\n`;
  return out.slice(0, maxChars) || null;
}

// ── NEW UPGRADES FOR CODEX READER TOOL (v9.2.0) ─────────────────────────────
const WORDS_PER_PAGE = 278;

// CACHE the raw Codex text + the parsed offset-sections by file mtime. These used
// to re-read AND re-parse the full ~656 KB file on EVERY codex_search / page / stats
// call — a burst of which (e.g. "read a part of the codex and find today's updates")
// churned several MB of throwaway strings per second. On the resource-governed
// laptop (PROTECT tier, RAM near cap) that allocation spike could push V8 into a
// fatal OOM abort — which uncaughtException CANNOT catch, so Leo's process died.
// One parsed copy, shared by all callers, invalidated only when the file changes.
let _rawCache = null, _rawMtime = -1, _rawPath = null;
export function getCodexRaw() {
  const CODEX_PATH = CODEX_PATHS.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || CODEX_PATHS[0];
  try {
    const mt = fs.statSync(CODEX_PATH).mtimeMs;
    if (_rawCache !== null && _rawPath === CODEX_PATH && mt === _rawMtime) return _rawCache;
    _rawCache = fs.readFileSync(CODEX_PATH, 'utf8');
    _rawMtime = mt; _rawPath = CODEX_PATH;
    return _rawCache;
  } catch (_) {
    return fs.readFileSync(CODEX_PATH, 'utf8');
  }
}

let _offsetCache = null, _offsetMtime = -1;
export function loadCodexSectionsWithOffsets() {
  const CODEX_PATH = CODEX_PATHS.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || CODEX_PATHS[0];
  let mt = -1; try { mt = fs.statSync(CODEX_PATH).mtimeMs; } catch (_) {}
  if (_offsetCache && mt !== -1 && mt === _offsetMtime) return _offsetCache;
  const raw = getCodexRaw();
  const regex = /\n(?=#{1,4} )/g;
  let match;
  const sections = [];

  const splitIndices = [0];
  while ((match = regex.exec(raw)) !== null) {
    splitIndices.push(match.index + 1);
  }
  splitIndices.push(raw.length);

  for (let i = 0; i < splitIndices.length - 1; i++) {
    const start = splitIndices[i];
    const end = splitIndices[i + 1];
    const text = raw.slice(start, end);
    const title = (text.match(/^#{1,4} \**(.+?)\**\s*$/m) || [])[1] || text.slice(0, 60);
    sections.push({ title, text, start, end });
  }
  _offsetCache = sections; _offsetMtime = mt;
  return sections;
}

function getPageNumberForCharIndex(text, charIdx, wordsPerPage) {
  const textBefore = text.slice(0, charIdx);
  const wordCountBefore = (textBefore.match(/\S+/g) || []).length;
  return Math.ceil((wordCountBefore + 1) / wordsPerPage);
}

function sliceByWordIndex(text, startWordIdx, endWordIdx) {
  const regex = /\S+/g;
  let match;
  let count = 0;
  let startCharIdx = 0;
  let endCharIdx = text.length;
  while ((match = regex.exec(text)) !== null) {
    if (count === startWordIdx) {
      startCharIdx = match.index;
    }
    count++;
    if (count === endWordIdx) {
      endCharIdx = match.index + match[0].length;
      break;
    }
  }
  return text.slice(startCharIdx, endCharIdx);
}

export function codex_stats() {
  try {
    const raw = getCodexRaw();
    const lines = raw.split('\n');
    const words = raw.match(/\S+/g) || [];
    const sections = loadCodexSections();
    return {
      word_count: words.length,
      line_count: lines.length,
      char_count: raw.length,
      section_count: sections.length,
      page_count: Math.ceil(words.length / WORDS_PER_PAGE)
    };
  } catch (e) {
    console.error(`[Codex] Error getting stats: ${e.message}`);
    return { word_count: 0, line_count: 0, char_count: 0, section_count: 0, page_count: 0 };
  }
}

export function codex_get_page(n) {
  try {
    const raw = getCodexRaw();
    const words = raw.match(/\S+/g) || [];
    const totalPages = Math.ceil(words.length / WORDS_PER_PAGE);
    const pageNum = Math.max(1, Math.min(totalPages, Number(n) || 1));
    
    const startWordIdx = (pageNum - 1) * WORDS_PER_PAGE;
    const endWordIdx = pageNum * WORDS_PER_PAGE;
    return sliceByWordIndex(raw, startWordIdx, endWordIdx);
  } catch (e) {
    console.error(`[Codex] Error getting page: ${e.message}`);
    return '';
  }
}

// Robust resolver: understands §-numbers (14.44, 26.1), ranges ("24 through 24.4"),
// chunk index (#N), page numbers, and title keywords. Returns the text tagged with
// its real §-number + page so the bot reports the correct address (no more guessing).
export function codex_get_section(query) {
  try {
    const sections = loadCodexSections();
    const qraw = String(query || '').trim();
    const q = qraw.toLowerCase();
    if (!q) return '';
    const tag = s => `[#${s.index}${s.num ? ' §' + s.num : ''} | p.${s.page} | ${s.title}]\n${s.text}`;

    if (/\bpage\b/.test(q)) {
      const p = parseInt((q.match(/(\d+)/) || [])[1]);
      if (p) return `[Codex page ${p}]\n` + codex_get_page(p);
    }

    const nums = (qraw.match(/\d+(?:\.\d+)*/g) || []);
    const toKey = n => n.split('.').map(x => parseInt(x, 10));
    const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };

    if (nums.length >= 2 && /through|to|-|–|—|thru/.test(q)) {           // range
      let a = toKey(nums[0]), b = toKey(nums[nums.length - 1]);
      const lo = cmp(a, b) <= 0 ? a : b, hi = cmp(a, b) <= 0 ? b : a;
      const hits = sections.filter(s => s.num && cmp(toKey(s.num), lo) >= 0 && cmp(toKey(s.num), hi) <= 0);
      if (hits.length) return hits.slice(0, 8).map(tag).join('\n\n').slice(0, 13000);
    }
    if (nums.length >= 1) {
      const tok = nums[0];
      const exact = sections.filter(s => s.num === tok);
      if (exact.length) return exact.map(tag).join('\n\n').slice(0, 9000);
      const pref = sections.filter(s => s.num && s.num.startsWith(tok + '.'));   // 26 -> 26.1, 26.1.1
      if (pref.length) return pref.slice(0, 8).map(tag).join('\n\n').slice(0, 13000);
      const byIdx = sections.find(s => s.index === parseInt(tok, 10));           // chunk index
      if (byIdx && tok.indexOf('.') === -1) return tag(byIdx);
    }

    let best = null, score = 0;
    for (const s of sections) {
      const tl = s.title.toLowerCase();
      if (tl.includes(q)) { const sc = q.length / tl.length + (tl.startsWith(q) ? 2 : 0); if (sc > score) { score = sc; best = s; } }
    }
    if (best) return tag(best);
    for (const s of sections) if (s.text.toLowerCase().includes(q)) return tag(s);
    return '';
  } catch (e) {
    console.error(`[Codex] Error getting section: ${e.message}`);
    return '';
  }
}

// Live table of contents built from the ACTUAL headings (not the stale embedded
// ToC). Every heading with its chunk #, §-number, and page — so the bot can see
// exactly what exists and never again claim "the Codex only goes to §21".
export function codex_outline() {
  try {
    const secs = loadCodexSections().filter(s => s.title && s.text.length > 50);
    return secs.map(s => `#${s.index}${s.num ? ' §' + s.num : ''} p.${s.page}  ${s.title}`).join('\n');
  } catch (e) { return ''; }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function codex_search(query) {
  try {
    const raw = getCodexRaw();
    const sections = loadCodexSectionsWithOffsets();
    const q = String(query).toLowerCase().trim();
    if (!q || q.length < 3) return [];
    
    const results = [];
    let idx = -1;
    const rawLower = raw.toLowerCase();
    
    while ((idx = rawLower.indexOf(q, idx + 1)) !== -1) {
      if (results.length >= 10) break;
      
      const sec = sections.find(s => idx >= s.start && idx < s.end) || { title: 'Unknown' };
      const pageNum = getPageNumberForCharIndex(raw, idx, WORDS_PER_PAGE);
      
      const contextStart = Math.max(0, idx - 100);
      const contextEnd = Math.min(raw.length, idx + q.length + 100);
      let passage = raw.slice(contextStart, contextEnd);
      
      if (contextStart > 0) passage = '...' + passage;
      if (contextEnd < raw.length) passage = passage + '...';
      
      results.push({
        passage: passage.trim(),
        section: sec.title.trim(),
        page: pageNum
      });
    }
    // BRANCHING INDEX: append the related branch of the matched sections as a
    // final supplementary hit. Additive — verbatim hits keep their exact shape;
    // the related entry carries an extra `isRelated` flag and a `related` list
    // so callers that want to surface linked topics can, while existing
    // formatters (which just read passage/section/page) still render it fine.
    try {
      if (results.length) {
        const size = Number(process.env.CODEX_BRANCH_SIZE) || 4;
        const depth = Number(process.env.CODEX_BRANCH_DEPTH) || 1;
        if (size > 0) {
          const all = loadCodexSections();
          const matchedTitles = new Set(results.map(r => r.section));
          const seeds = all.filter(s => matchedTitles.has((s.title || '').trim())).map(s => s.index);
          const branch = relatedBranch(seeds, depth, size);
          if (branch.length) {
            const list = branch.map(s => ({ num: s.num || null, title: (s.title || '').trim() }));
            results.push({
              isRelated: true,
              section: 'RELATED BRANCH',
              page: null,
              related: list,
              passage: 'Related linked topics (follow with codex_section):\n' +
                list.map(x => `  • ${x.num ? '§' + x.num + ' ' : ''}${x.title}`).join('\n')
            });
          }
        }
      }
    } catch (_) { /* branch is supplementary — never break the verbatim search */ }
    return results;
  } catch (e) {
    console.error(`[Codex] Error searching codex: ${e.message}`);
    return [];
  }
}

export function codex_get_math(sectionQuery) {
  try {
    const secText = codex_get_section(sectionQuery);
    if (!secText) return [];
    
    const mathBlocks = [];
    let match;
    
    const doubleDollarRegex = /\$\$([\s\S]*?)\$\$/g;
    while ((match = doubleDollarRegex.exec(secText)) !== null) {
      mathBlocks.push(match[0]);
    }
    
    const displayBracketRegex = /\\\[([\s\S]*?)\\\]/g;
    while ((match = displayBracketRegex.exec(secText)) !== null) {
      mathBlocks.push(match[0]);
    }
    
    const inlineParenRegex = /\\\(([\s\S]*?)\\\)/g;
    while ((match = inlineParenRegex.exec(secText)) !== null) {
      mathBlocks.push(match[0]);
    }
    
    const singleDollarRegex = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
    while ((match = singleDollarRegex.exec(secText)) !== null) {
      mathBlocks.push(match[0]);
    }
    
    return mathBlocks;
  } catch (e) {
    console.error(`[Codex] Error getting math: ${e.message}`);
    return [];
  }
}

// ── GENERIC DOCUMENT RETRIEVAL (v9.3.0) ─────────────────────────────────────
// Replicates the research-agent method on ANY project doc, not just the indexed
// Codex: grep-style full-text search (line numbers + context), a doc locator/
// lister, and a bounded line-range reader. ADDITIVE — the indexed codex_search /
// consultCodex above are untouched; these complement them for arbitrary .md/.txt.
//
// SAFETY: reads are restricted to text docs (.md/.txt + the known Codex/whitepaper)
// living UNDER an allow-listed set of doc roots. Paths are resolved/normalized and
// anything outside the roots — or any sensitive file (.env, keys, node_modules,
// .git) — is refused. Roots are env-overridable via KAI_DOC_ROOTS (path-sep list).
const DEFAULT_DOC_ROOTS = ['c:/KAI', 'c:/KAI/tools/oracle-discord'];
function docRoots() {
  const env = String(process.env.KAI_DOC_ROOTS || '').trim();
  const roots = env
    ? env.split(/[;,]/).map(s => s.trim()).filter(Boolean)
    : DEFAULT_DOC_ROOTS;
  return roots.map(r => path.resolve(r));
}
const ALLOWED_DOC_EXT = new Set(['.md', '.txt', '.markdown']);
// Directories / files we NEVER read, even if they sit under a doc root.
const DOC_DENY = /(^|[\\/])(node_modules|\.git|\.env|\.venv|secrets?|keys?)([\\/]|$)|\.(env|pem|key)$/i;

// Resolve a user-supplied doc name/path to a real, allowed file path (or null).
// Accepts an absolute path, a path relative to a doc root, or a bare filename
// (which is searched for under the roots).
function resolveDocPath(input) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  // ALIAS: the Codex IS the whitepaper. A request for "whitepaper" / WHITEPAPER.md
  // resolves to the canonical Codex so callers always read the current document,
  // never the stale snapshot. (Only fall through to the snapshot if the Codex file
  // is genuinely missing.)
  if (/^whitepaper$/i.test(raw) || WHITEPAPER_RE.test(raw)) {
    const codex = CODEX_PATHS[0];
    try { if (fs.existsSync(codex)) return path.resolve(codex); } catch (_) {}
  }
  const roots = docRoots();
  const within = (p) => roots.some(r => {
    const rel = path.relative(r, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  const okFile = (p) => {
    try {
      if (DOC_DENY.test(p)) return false;
      if (!within(p)) return false;
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return false;
      // Allow the known Codex/whitepaper even if the ext check is bypassed.
      if (CODEX_PATHS.some(cp => path.resolve(cp) === p)) return true;
      return ALLOWED_DOC_EXT.has(path.extname(p).toLowerCase());
    } catch (_) { return false; }
  };

  // 1) absolute or root-relative path as given
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(path.resolve(raw));
  for (const r of roots) candidates.push(path.resolve(r, raw));
  for (const c of candidates) if (okFile(c)) return c;

  // 2) bare filename → scan the doc tree for a name match (case-insensitive)
  const base = path.basename(raw).toLowerCase();
  for (const d of listDocs()) {
    if (path.basename(d.path).toLowerCase() === base) return d.path;
  }
  return null;
}

// list_docs(): every readable doc under the allowed roots → { name, path, size }.
let _docListCache = null, _docListTs = 0;
export function listDocs() {
  if (_docListCache && Date.now() - _docListTs < 30_000) return _docListCache;
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (DOC_DENY.test(full)) continue;
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (!ALLOWED_DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      // The Codex IS the whitepaper — WHITEPAPER.md is a stale snapshot of the
      // SAME document. Never list it as a separate doc: that would show the Codex
      // twice and let a default search return duplicate hits from both files.
      if (WHITEPAPER_RE.test(full)) continue;
      const rp = path.resolve(full);
      if (seen.has(rp)) continue;
      seen.add(rp);
      let size = 0;
      try { size = fs.statSync(rp).size; } catch (_) {}
      out.push({ name: e.name, path: rp, size });
    }
  };
  for (const r of docRoots()) walk(r, 0);
  out.sort((a, b) => b.size - a.size);
  _docListCache = out; _docListTs = Date.now();
  return out;
}

// search_docs(query, file?): grep-style full-text search. Returns matching lines
// as { file, lineNumber, line, context } (±2 lines). file optional — if omitted,
// scans the main project docs (Codex, WHITEPAPER, SRHT_* papers). Plain substring
// by default; if the query is wrapped in /…/ it's treated as a regex.
// Case-insensitive unless the regex carries no `i`… (we default to insensitive).
export function searchDocs(query, file = null, maxResults = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  // Build matcher: /regex/flags → RegExp; otherwise case-insensitive substring.
  let matcher;
  const reWrap = q.match(/^\/(.*)\/([a-z]*)$/i);
  try {
    if (reWrap) {
      const flags = reWrap[2].includes('i') ? reWrap[2] : reWrap[2] + 'i';
      const re = new RegExp(reWrap[1], flags);
      matcher = (line) => re.test(line);
    } else {
      const lc = q.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lc);
    }
  } catch (_) {
    const lc = q.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(lc);
  }

  // Resolve which files to scan.
  let targets = [];
  if (file) {
    const p = resolveDocPath(file);
    if (!p) return [{ error: `Doc not found or outside allowed roots: ${file}` }];
    targets = [p];
  } else {
    // Default sweep: the canonical Codex (= the whitepaper) + the SRHT papers.
    // WHITEPAPER.md is intentionally NOT searched here — it's a stale copy of the
    // Codex and is already excluded from listDocs(), so a default sweep can never
    // return the same content twice from two files.
    const all = listDocs();
    const primary = all.filter(d =>
      /the kai codex\.md$/i.test(d.path) ||
      /(^|[\\/])srht[^\\/]*\.md$/i.test(d.path)
    );
    targets = (primary.length ? primary : all.slice(0, 8)).map(d => d.path);
  }

  const results = [];
  for (const fp of targets) {
    let lines;
    try { lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/); } catch (_) { continue; }
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue;
      const from = Math.max(0, i - 2);
      const to = Math.min(lines.length - 1, i + 2);
      const context = lines.slice(from, to + 1)
        .map((l, k) => `${from + k + 1}: ${l}`).join('\n');
      results.push({
        file: path.basename(fp),
        path: fp,
        lineNumber: i + 1,
        line: lines[i].trim().slice(0, 300),
        context
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

// read_doc_lines(file, startLine, endLine): 1-based inclusive line range of a doc.
// Range capped (default <= 200 lines) so it never dumps a whole file.
export function readDocLines(file, startLine, endLine, maxLines = 200) {
  const p = resolveDocPath(file);
  if (!p) return { error: `Doc not found or outside allowed roots: ${file}` };
  let lines;
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch (e) {
    return { error: `Could not read ${file}: ${e.message}` };
  }
  let s = Math.max(1, Number(startLine) || 1);
  let e = Math.max(s, Number(endLine) || s);
  if (e - s + 1 > maxLines) e = s + maxLines - 1;
  e = Math.min(e, lines.length);
  if (s > lines.length) return { error: `startLine ${s} is past end of file (${lines.length} lines).`, totalLines: lines.length };
  const slice = lines.slice(s - 1, e).map((l, k) => `${s + k}: ${l}`).join('\n');
  return { file: path.basename(p), path: p, startLine: s, endLine: e, totalLines: lines.length, text: slice };
}

