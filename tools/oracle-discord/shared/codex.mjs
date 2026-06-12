// ── THE KAI CODEX — shared lookup for the WHOLE fleet ───────────────────────
// Every bot (not just Leo) can query the 250-page whitepaper. Sections are
// split on headings, scored by term hits (title hits weighted), top matches
// returned at full depth. "random" queries return random sections.
import fs from 'fs';

// Canonical document is "The KAI Codex.md"; WHITEPAPER.md kept as fallback.
const CODEX_PATHS = ['c:/KAI/The KAI Codex.md', 'c:/KAI/WHITEPAPER.md'];
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
    const parts = raw.split(/\n(?=#{1,3} )/);
    _codexSections = parts.map(s => {
      const title = (s.match(/^#{1,3} \**(.+?)\**\s*$/m) || [])[1] || s.slice(0, 60);
      return { title, text: s };
    });
  } catch (e) {
    console.warn(`[Codex] Could not load KAI Codex at ${CODEX_PATH}: ${e.message}`);
    _codexSections = [];
  }
  return _codexSections;
}

export function consultCodex(query, maxChars = 8000) {
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

  const terms = String(query).toLowerCase().split(/[^a-z0-9.=]+/).filter(t => t.length > 2);
  if (!terms.length) return null;
  const scored = sections
    .map(sec => {
      const hay = sec.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (sec.title.toLowerCase().includes(t)) score += 5;
        let idx = -1, n = 0;
        while ((idx = hay.indexOf(t, idx + 1)) !== -1 && n < 20) n++;
        score += n;
      }
      return { sec, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  let out = '';
  for (const { sec } of scored.slice(0, 2)) {
    out += `\n--- ${sec.title} ---\n${sec.text.slice(0, Math.floor(maxChars / 2))}\n`;
    if (out.length >= maxChars) break;
  }
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
