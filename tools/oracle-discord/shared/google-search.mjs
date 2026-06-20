/**
 * google-search.mjs — askGoogle(): a real "ask Google's AI" capability.
 *
 * Google's AI box in the search bar (AI Overviews / AI Mode) has NO public API,
 * and scraping it is fragile + against ToS. The proper, clean equivalent is the
 * Gemini API with the `google_search` GROUNDING tool: Gemini runs a live Google
 * search and returns an AI-summarized answer WITH its sources. Same outcome —
 * ask a question in plain language, get a current, grounded answer — no scraping.
 *
 * Uses GEMINI_API_KEY (same key the live voice uses). Model via GEMINI_SEARCH_MODEL.
 */
const MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';

export async function askGoogle(query, { timeoutMs = 15000 } = {}) {
  // KEY RESOLUTION — prefer a search-specific key, then the SAME key Leo's live
  // voice uses (GEMINI_API_KEY_LEO). This fixes the "voice works but every search
  // fails" case: if the plain GEMINI_API_KEY was rotated / rate-limited while the
  // _LEO key is still good, search now rides the working key instead of dying.
  const key = process.env.GEMINI_SEARCH_KEY
    || process.env.GEMINI_API_KEY_LEO
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, text: 'Google search is not configured (no GEMINI_API_KEY set).' };
  const q = String(query || '').trim();
  if (!q) return { ok: false, text: 'Nothing to search for.' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: q }] }],
    tools: [{ google_search: {} }], // live Google Search grounding (Gemini 2.x)
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.warn(`[askGoogle] request failed (${MODEL}): ${e.message}`);
    return { ok: false, text: `Google search request failed: ${e.message}` };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // Make the REAL reason visible in the logs — a 403/401 = bad/rotated key,
    // 404 = wrong model name, 400 = grounding tool rejected. Leo only says
    // "nothing online", so without this the actual cause was invisible.
    console.warn(`[askGoogle] HTTP ${res.status} (model=${MODEL}, key=...${String(key).slice(-6)}): ${t.slice(0, 300)}`);
    return { ok: false, text: `Google search error ${res.status}: ${t.slice(0, 200)}` };
  }

  const data = await res.json().catch(() => null);
  const cand = data && data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .map(p => p.text).filter(Boolean).join('').trim();

  // Grounding sources (titles/URLs Gemini actually used)
  const gm = cand && cand.groundingMetadata;
  const chunks = (gm && gm.groundingChunks) || [];
  const sources = chunks.map(c => (c.web && (c.web.title || c.web.uri))).filter(Boolean).slice(0, 5);

  if (!text) return { ok: false, text: `No answer came back for "${q}".` };
  return {
    ok: true,
    query: q,
    text,
    sources,
    summary: text + (sources.length ? `\n\n(Sources: ${sources.join(' · ')})` : ''),
  };
}
