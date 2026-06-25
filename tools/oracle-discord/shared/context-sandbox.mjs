/**
 * context-sandbox.mjs — the "context sandbox" (Stage 3).
 *
 * Leo's model can only hold so much at once. When there's something BIG to read
 * out — a Codex page, a long document, a large block of recalled memory — we
 * don't cram it all in (that breaks the model). Instead we put it in a SANDBOX:
 *
 *   1. Split the big text into ordered, model-safe chunks (small → larger ramp,
 *      never cutting mid-sentence).
 *   2. Leo reads chunk #1. As he FINISHES a turn, the voice loop looks at the
 *      sandbox, sees what's next, and LADDERS him into it — he continues
 *      speaking the next section. (Chained replies, in order.)
 *   3. The just-spoken chunk is REMOVED, then on to the next, until done.
 *   4. If you INTERRUPT (say "stop"), wherever he was is saved to a DRAFT cache
 *      (temporary) so the thread isn't lost — max 2 drafts, newest kept, each
 *      stamped with the date/time. He can pick it back up later.
 *
 * Sandboxes + drafts are keyed by a sessionId (use the voice user's id) so two
 * people aren't reading the same queue. Live state is in-memory; drafts also
 * persist to a small JSON ring so a "pick it back up" survives a restart.
 */
import fs from 'fs';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const DRAFTS_PATH = `${STATE_DIR}/sandbox_drafts.json`;
// Durable "where Leo left off" pointer. Written as EACH section is sent during a
// Live read so a restart / resume_reading can pick the book back up from the exact
// saved section. Plain JSON, one record per session id. SINGLE-QUOTED — no backticks.
const READING_POSITION_PATH = STATE_DIR + '/leo-reading-position.json';
const MAX_DRAFTS_PER_SESSION = 2;   // user's rule: 2 drafts max, in order
const MAX_SANDBOXES = 50;           // safety cap on live sessions

// ── INTENT / CONFIRM thresholds (env-tunable) ──────────────────────────────────
// classifyReadIntent() looks at the LENGTH of a piece of text a read points at and
// decides how Leo should handle it. The whole point of the sandbox is that Leo's
// CONVERSATIONAL model can only hold so much; anything past these thresholds must be
// chunked (and, when very large, CONFIRMED) rather than crammed into one reply.
//
//   SMALL   (<= SANDBOX_SMALL_CHARS): fits one ~1-min TTS turn — read it DIRECTLY,
//           no sandbox, no chunk seams, no preamble.
//   LARGE   (SMALL < len <= CONFIRM): bounded multi-section read — chunk + read
//           sequentially; a brief "this is ~N min, reading now" is fine.
//   HUGE    (> SANDBOX_CONFIRM_CHARS): past what the conversational model can hold —
//           CONFIRM first: word-for-word (~N min) vs a short summary of key points,
//           UNLESS the user already said "word for word" (then read it in full).
//
// SMALL defaults to one edge/gemini section (MAX_CHUNK ~1700) so "small" === "one turn".
// CONFIRM defaults to ~24000 chars (~25-30 min of speech / well past a comfortable
// single-shot conversational context) so only genuinely big bodies trigger the ask.
const SANDBOX_SMALL_CHARS = Number(process.env.SANDBOX_SMALL_CHARS) > 0
  ? Number(process.env.SANDBOX_SMALL_CHARS) : 0; // 0 -> resolved to MAX_CHUNK below
const SANDBOX_CONFIRM_CHARS = Number(process.env.SANDBOX_CONFIRM_CHARS) > 0
  ? Number(process.env.SANDBOX_CONFIRM_CHARS) : 24000;
// Speaking-rate estimate for "~N min" framing (chars/sec of audio ~ 1/0.06).
const SANDBOX_CHARS_PER_SEC = Number(process.env.SANDBOX_CHARS_PER_SEC) > 0
  ? Number(process.env.SANDBOX_CHARS_PER_SEC) : 16.7;

// ── SPOKEN-SECTION DRAFT CACHE (per-section, for follow-up Q&A) ─────────────────
// SEPARATE from the interrupt drafts above. After Leo SPEAKS a section, we stash that
// section's exact text here, indexed by section number + source doc, so the user can
// ask "what did that part say about X" and we can SEARCH what was just read (and the
// source doc) for the answer. In-memory, per session, and it CLEARS after a few NEW
// large reads (SANDBOX_CACHE_TURNS) so it can never grow unbounded; the durable reading
// POSITION (above) is what persists/resumes — this cache is just recent recall.
const SANDBOX_CACHE_TURNS = Number(process.env.SANDBOX_CACHE_TURNS) > 0
  ? Math.floor(Number(process.env.SANDBOX_CACHE_TURNS)) : 3;
const MAX_CACHE_SECTIONS = Number(process.env.SANDBOX_CACHE_MAX_SECTIONS) > 0
  ? Math.floor(Number(process.env.SANDBOX_CACHE_MAX_SECTIONS)) : 400; // hard safety cap

// Chunk sizing — tied to the Gemini TTS AUDIO-OUTPUT CAP (the binding limit).
// Google confirmed the dedicated Gemini TTS engine truncates after ~1-2 MINUTES of
// generated audio per single call (the ~16,384 output-token wall; audio burns tokens
// fast). Each section = exactly ONE TTS reply, so a section must be a COMFORTABLE
// amount of words that finishes WELL UNDER that wall, or the audio comes back cut off.
//
//   Target: ~75-90 seconds of speech ≈ ~250-300 words ≈ ~1500-1700 characters.
//   We default the cap to 1700 chars: the LARGEST size that still reliably returns
//   COMPLETE (non-truncated) audio. Going smaller wastes quota and sounds choppy at
//   the seams; going bigger risks the truncation wall. Env-overridable via
//   SANDBOX_MAX_CHUNK, but clamped below HARD_MAX so it can never approach the wall.
//
//   HARD_MAX (~1800) is an absolute ceiling no section may exceed — even a single
//   run-on sentence is force-split before it. 1800 chars ≈ ~95s of speech, still
//   under the ~1-2 min wall with margin.
const HARD_MAX = 1800; // absolute ceiling for the EDGE / gemini-tts engines.
const _maxChunkEnv = Number(process.env.SANDBOX_MAX_CHUNK) > 0
  ? Math.min(Number(process.env.SANDBOX_MAX_CHUNK), HARD_MAX) // honour override but never above the ceiling
  : 1700;
// Ramp easing-in toward the cap, but never above it (clamped to _maxChunkEnv).
const RAMP = [800, 1200, 1500, _maxChunkEnv].map(n => Math.min(n, _maxChunkEnv));
const MAX_CHUNK = _maxChunkEnv;

// LIVE-engine chunk sizing — DELIBERATELY LARGER than the edge/gemini cap above.
// The binding limit for the native-audio LIVE reader is NOT input tokens: it is the
// ~1-2 MINUTES of audio OUTPUT the LIVE model emits per single turn before it stops.
// At ~0.06s/char that wall is ~1800-2400 chars of speech. We default LIVE sections to
// ~2400 chars (fewer, larger sections -> fewer seams; the user asked for fewer than the
// 137 they were seeing) and let LEO_LIVE_MAX_CHUNK tune it BY EAR. Bigger sections risk
// the model truncating mid-section; runLiveRead's truncation-safety re-reads any section
// that comes back short, so over-shooting costs a repeat rather than dropped text.
// HARD ceiling ~3500 chars so a runaway env value can never sit far past the audio wall.
const LIVE_HARD_MAX = 3500; // absolute ceiling for a LIVE section (never exceeded).
const _liveMaxChunkEnv = Number(process.env.LEO_LIVE_MAX_CHUNK) > 0
  ? Math.min(Number(process.env.LEO_LIVE_MAX_CHUNK), LIVE_HARD_MAX) // honour override, clamp to ceiling
  : 2400;
// LIVE ramp eases in then settles at the (larger) live cap; clamped so no step exceeds it.
const LIVE_RAMP = [1000, 1600, 2000, _liveMaxChunkEnv].map(n => Math.min(n, _liveMaxChunkEnv));
const LIVE_MAX_CHUNK = _liveMaxChunkEnv;

// Resolve "small" to one TTS turn if not explicitly set: a SMALL piece is anything
// that fits a single section, so it never needs the sandbox/chunk machinery at all.
const SMALL_CHARS = SANDBOX_SMALL_CHARS > 0 ? SANDBOX_SMALL_CHARS : MAX_CHUNK;

// ── live state (in-memory) ─────────────────────────────────────────────────
/** sessionId -> { chunks:[{text,seq}], idx, total, meta, startedAt } */
const _live = new Map();

// sessionId -> { sections:[{section,text,source,title,ts}], reads } spoken-section
// cache for follow-up Q&A. `reads` counts NEW large reads loaded so we can clear it
// after SANDBOX_CACHE_TURNS of them (lifecycle, below).
const _cache = new Map();

// ── INTENT ROUTING ─────────────────────────────────────────────────────────────
/**
 * Decide how a read request should be handled, from the SIZE of the text it points
 * at and whether the user already asked for it word-for-word. Pure + side-effect-free
 * so leo.mjs / the bridge can call it before touching the sandbox. Returns:
 *   { mode, chars, estSeconds, estMinutes, sections, needsConfirm }
 *   mode: 'empty' | 'small' | 'large' | 'huge'
 *     small  -> read directly in one turn (no sandbox)
 *     large  -> chunk + sequential read (brief "~N min, reading now" is fine)
 *     huge   -> CONFIRM first (word-for-word vs summary) UNLESS wordForWord===true
 *   needsConfirm: true only for 'huge' when the user did NOT already say word-for-word.
 * Thresholds are env-tunable (SANDBOX_SMALL_CHARS / SANDBOX_CONFIRM_CHARS).
 */
export function classifyReadIntent(text, { wordForWord = false, live = false } = {}) {
  const s = String(text || '').trim();
  const chars = s.length;
  const maxChunk = live ? LIVE_MAX_CHUNK : MAX_CHUNK;
  const estSeconds = Math.round(chars / SANDBOX_CHARS_PER_SEC);
  const estMinutes = Math.max(1, Math.round(estSeconds / 60));
  const sections = chars ? Math.max(1, Math.ceil(chars / maxChunk)) : 0;
  if (!chars) return { mode: 'empty', chars, estSeconds, estMinutes: 0, sections: 0, needsConfirm: false };
  if (chars <= SMALL_CHARS) return { mode: 'small', chars, estSeconds, estMinutes, sections: 1, needsConfirm: false };
  if (chars <= SANDBOX_CONFIRM_CHARS) return { mode: 'large', chars, estSeconds, estMinutes, sections, needsConfirm: false };
  return { mode: 'huge', chars, estSeconds, estMinutes, sections, needsConfirm: !wordForWord };
}

/**
 * Build the short spoken CONFIRM prompt for a 'huge' read — single-quoted, no
 * backticks (safe to import into core-safe files). Tells the user roughly how long a
 * full word-for-word read would take and offers a summary instead.
 */
export function confirmPrompt({ estMinutes = 0, title = '' } = {}) {
  const what = title ? ('"' + title + '"') : 'this';
  return 'That is a big one — reading ' + what + ' word for word would take about '
    + (estMinutes || 1) + ' minute' + ((estMinutes === 1) ? '' : 's')
    + '. Do you want the whole thing read out word for word, or just a short summary of the key points?';
}

/**
 * Detect a "word for word / read it all / the whole thing" instruction in the user's
 * own words, so a read they ALREADY asked to hear in full skips the confirm. Also used
 * to interpret the ANSWER to a confirm prompt. Returns 'full' | 'summary' | null.
 */
export function classifyConfirmAnswer(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/\b(word for word|word-for-word|whole thing|the whole|all of it|everything|in full|verbatim|full read|read it all|every word|cover to cover)\b/.test(t)) return 'full';
  if (/\b(summary|summari|key points|key bits|gist|tl;?dr|highlights?|just the|overview|brief|short version|main points|recap)\b/.test(t)) return 'summary';
  if (/\b(yes|yeah|yep|go ahead|do it|please do|read it|go on)\b/.test(t)) return 'full';
  if (/\b(no|nah|don'?t|skip)\b/.test(t)) return 'summary';
  return null;
}

// ── chunking ────────────────────────────────────────────────────────────────
/**
 * Split text into an ordered, NON-OVERLAPPING CONTIGUOUS PARTITION of sections.
 *
 * This is a CURSOR-BASED splitter: a single read cursor walks the (whitespace-
 * normalized) source from start to end. Section N+1 begins EXACTLY where section N
 * ended — no character is ever repeated across a boundary, and none is skipped.
 * (The old paragraph/sentence re-join approach could duplicate or drop text at
 * seams, which is what produced the repeated lines the user heard.)
 *
 * Boundary preference within the budget window, so each section ends on a CLEAN,
 * complete-sounding line that bridges into the next:
 *   1. the LATEST sentence terminator (. ! ?) at/before the cap,
 *   2. else the latest newline,
 *   3. else the latest whitespace,
 *   4. else (a single token longer than the cap) a hard cut — NEVER mid-word
 *      unless the word itself exceeds the cap.
 *
 * Sizes RAMP up (short opening, larger later) but every section stays <= HARD_MAX.
 *
 * INVARIANT (self-checked below): concatenating the sections with single spaces
 * reproduces the normalized source with NO duplication and NO loss.
 */
export function chunkText(text, { ramp = RAMP, maxChunk = MAX_CHUNK, hardMax = HARD_MAX } = {}) {
  // Normalize whitespace ONCE up front, then partition THIS exact string. Doing the
  // normalization first (and never re-joining fragments) is what guarantees the
  // round-trip invariant: every output char comes verbatim from `src`, in order.
  const src = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')        // collapse runs of spaces/tabs
    .replace(/ *\n */g, '\n')       // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')     // cap blank-line runs at one
    .trim();
  if (!src) return [];

  const HARD = Math.max(200, Math.min(hardMax, Math.max(maxChunk, ...ramp)));
  const budgetFor = (n) => Math.min(
    (n < ramp.length ? ramp[n] : ramp[ramp.length - 1] || maxChunk),
    maxChunk,
    HARD
  );

  const chunks = [];
  let cursor = 0;
  const len = src.length;

  while (cursor < len) {
    const budget = budgetFor(chunks.length);
    // The remaining tail fits in one section — take it all (clean end-of-text).
    if (len - cursor <= budget) {
      const piece = src.slice(cursor).trim();
      if (piece) chunks.push(piece);
      cursor = len;
      break;
    }

    // Window we may cut within: [cursor, cursor+budget]. Find the best boundary.
    const winEnd = cursor + budget;
    const window = src.slice(cursor, winEnd);

    let cut = -1;
    // 1) latest sentence terminator (. ! ?) optionally followed by quote/bracket.
    const sentRe = /[.!?]["')\]]?(?=\s|$)/g;
    let m;
    while ((m = sentRe.exec(window)) !== null) cut = m.index + m[0].length;
    // 2) else latest newline
    if (cut <= 0) { const nl = window.lastIndexOf('\n'); if (nl > 0) cut = nl + 1; }
    // 3) else latest whitespace
    if (cut <= 0) { const sp = window.lastIndexOf(' '); if (sp > 0) cut = sp + 1; }
    // 4) else a single token longer than the budget — hard cut at the budget so we
    //    never spin forever. Only ever splits mid-"word" when that word alone is
    //    longer than a whole section (pathological — e.g. a giant URL/base64 blob).
    if (cut <= 0) cut = budget;

    const end = cursor + cut;
    const piece = src.slice(cursor, end).trim();
    if (piece) chunks.push(piece);
    // Advance the cursor PAST any whitespace that separated this section from the
    // next so the boundary whitespace is consumed exactly once (no repeat, no gap).
    let next = end;
    while (next < len && /\s/.test(src[next])) next++;
    // Safety: cursor MUST move forward every iteration.
    cursor = next > cursor ? next : cursor + 1;
  }

  // ── SELF-CHECK: verify the partition reproduces the source (no dup / no loss) ──
  // Compare the rejoined sections to the source with ALL whitespace REMOVED. We do
  // NOT model the seam as "always one space": a section can legitimately end on a
  // sentence terminator that is immediately followed in the source by a NON-space
  // char (e.g. markdown emphasis: "room.*italic*"). The cursor splits cleanly there
  // (section A ends "room.", section B starts "*italic*") with NO char dropped or
  // duplicated, but joining with a single space would FABRICATE a space the source
  // never had — that is the off-by-one false alarm we were tripping. Stripping ALL
  // whitespace for the comparison still catches the real bugs (any duplicated or
  // dropped non-whitespace character changes this length), without false-alarming on
  // seam whitespace. (Per-piece .trim() already removed boundary whitespace, so no
  // real char lives only in the seam.) SINGLE-QUOTED — no backticks.
  try {
    const flat = (s) => s.replace(/\s+/g, '');
    const rejoined = flat(chunks.join(''));
    const original = flat(src);
    if (rejoined !== original) {
      const wantLen = original.length, gotLen = rejoined.length;
      console.warn(`[Sandbox] chunkText PARTITION SELF-CHECK FAILED: rejoined length ${gotLen} != source length ${wantLen} (delta ${gotLen - wantLen}). Sections may overlap or drop text.`);
      // Find first divergence to aid debugging.
      let i = 0; while (i < wantLen && i < gotLen && original[i] === rejoined[i]) i++;
      console.warn(`[Sandbox] first divergence at char ${i}: source="…${original.slice(Math.max(0, i - 20), i + 20)}…" rejoined="…${rejoined.slice(Math.max(0, i - 20), i + 20)}…"`);
    }
  } catch (_) { /* self-check must never break a real read */ }

  return chunks.map((text, seq) => ({ text, seq }));
}

// ── load / paging ────────────────────────────────────────────────────────────
/**
 * Fill a sandbox for a session with a big body of text. Returns a summary
 * { total, sessionId } or null if nothing to load.
 */
export function loadSandbox(sessionId, text, { meta = {}, title = '', live = false } = {}) {
  if (!sessionId) return null;
  // LIVE reads use the LARGER live chunk sizing (LEO_LIVE_MAX_CHUNK / LIVE ramp /
  // LIVE_HARD_MAX). Everything else keeps the tighter edge/gemini-tts cap. Same
  // clean-partition / sentence-boundary / no-mid-word splitter either way.
  const chunks = live
    ? chunkText(text, { ramp: LIVE_RAMP, maxChunk: LIVE_MAX_CHUNK, hardMax: LIVE_HARD_MAX })
    : chunkText(text);
  if (!chunks.length) return null;
  if (_live.size >= MAX_SANDBOXES && !_live.has(sessionId)) {
    // At the cap and this is a NEW session — must make room by evicting the oldest.
    // WARN first (never a silent drop), and if the evicted sandbox still has unread
    // sections, AUTO-SAVE them to a draft so a saved/in-progress read is never lost.
    const oldest = [..._live.entries()].sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0))[0];
    if (oldest) {
      const [oldId, oldState] = oldest;
      const unread = oldState && oldState.idx < oldState.chunks.length;
      console.warn(`[Sandbox] At MAX_SANDBOXES (${MAX_SANDBOXES}) — evicting oldest session "${oldId}"${unread ? ' (had unread sections — saving to a draft so it is NOT lost).' : ' (already finished).'}`);
      if (unread) {
        try { saveDraft(oldId, { note: 'auto-saved: evicted at sandbox cap' }); }
        catch (e) { console.error(`[Sandbox] Failed to auto-save evicted draft for "${oldId}": ${e?.message || e}`); _live.delete(oldId); }
      } else {
        _live.delete(oldId);
      }
    }
  }
  _live.set(sessionId, {
    chunks, idx: 0, total: chunks.length,
    meta: { ...meta, title, source: meta.source || title }, startedAt: Date.now()
  });
  // LIFECYCLE: each new big read ticks the Q&A cache counter; after SANDBOX_CACHE_TURNS
  // new reads the spoken-section cache wipes so it never grows unbounded. Multi-section
  // reads only (a tiny one-section direct read doesn't churn recall).
  if (chunks.length > 1) { try { noteNewRead(sessionId); } catch (_) {} }
  return { sessionId, total: chunks.length, title };
}

/** Is there an active, non-exhausted sandbox for this session? */
export function hasMore(sessionId) {
  const s = _live.get(sessionId);
  return !!(s && s.idx < s.chunks.length);
}

/** Look at the NEXT chunk without consuming it. */
export function peekNext(sessionId) {
  const s = _live.get(sessionId);
  if (!s || s.idx >= s.chunks.length) return null;
  const c = s.chunks[s.idx];
  return { text: c.text, seq: c.seq, index: s.idx + 1, total: s.total, isLast: s.idx === s.chunks.length - 1, title: s.meta?.title || '' };
}

/**
 * Look at the section AFTER the current front (idx+1) WITHOUT consuming anything.
 * Used by the TTS audiobook reader to pre-synthesize the next section while the
 * current one is still playing (double-buffer, gap-free seams). Returns a
 * peekNext()-shaped object for idx+1, or null if there is no section after the front.
 */
export function peekAfter(sessionId) {
  const s = _live.get(sessionId);
  if (!s) return null;
  const j = s.idx + 1;
  if (j >= s.chunks.length) return null;
  const c = s.chunks[j];
  return { text: c.text, seq: c.seq, index: j + 1, total: s.total, isLast: j === s.chunks.length - 1, title: s.meta?.title || '' };
}

/**
 * Consume the current chunk (Leo just spoke it): REMOVE it and move on.
 * Returns the now-front chunk (peekNext) or null when the queue is empty.
 */
export function advance(sessionId) {
  const s = _live.get(sessionId);
  if (!s) return null;
  s.idx += 1;
  if (s.idx >= s.chunks.length) { _live.delete(sessionId); return null; }
  return peekNext(sessionId);
}

/**
 * Go BACK n sections so the user can re-hear a part, then continue forward from
 * there. advance() only moves the read cursor (idx); it never deletes spoken
 * chunks from the array, so every earlier section is still here to replay. Clamps
 * at the start. Returns the now-front chunk (peekNext) to read next.
 */
export function rewind(sessionId, n = 1) {
  const s = _live.get(sessionId);
  if (!s) return null;
  const back = Math.max(1, Math.floor(Number(n) || 1));
  s.idx = Math.max(0, s.idx - back);
  return peekNext(sessionId);
}

/** Jump to a specific 1-based section number (clamped). Returns peekNext. */
export function jumpTo(sessionId, index1) {
  const s = _live.get(sessionId);
  if (!s) return null;
  const i = Math.max(1, Math.min(s.total, Math.floor(Number(index1) || 1)));
  s.idx = i - 1;
  return peekNext(sessionId);
}

/** Progress, e.g. "section 2 of 7". */
export function progress(sessionId) {
  const s = _live.get(sessionId);
  if (!s) return null;
  return { index: Math.min(s.idx + 1, s.total), total: s.total, title: s.meta?.title || '' };
}

/** Drop a sandbox entirely (finished, or user said "never mind"). */
export function clearSandbox(sessionId) { _live.delete(sessionId); }

// ── SPOKEN-SECTION CACHE + Q&A SEARCH ───────────────────────────────────────────
/**
 * Record a section that was just SPOKEN, so follow-up questions can search it.
 * Call from the read loop AFTER a section's audio has played (or as it is sent).
 * Indexed per section (section number, text, source doc/title, ts). De-duped by
 * (source+section) so a re-read/resume doesn't pile up duplicates. Capped at
 * MAX_CACHE_SECTIONS (oldest dropped) as an absolute safety bound.
 */
export function cacheSpokenSection(sessionId, { section = 0, text = '', source = '', title = '' } = {}) {
  if (!sessionId || !String(text || '').trim()) return;
  let entry = _cache.get(sessionId);
  if (!entry) { entry = { sections: [], reads: 0 }; _cache.set(sessionId, entry); }
  const src = source || title || '';
  const existing = entry.sections.find(s => s.source === src && s.section === section);
  if (existing) { existing.text = text; existing.ts = Date.now(); return; }
  entry.sections.push({ section, text: String(text), source: src, title, ts: Date.now() });
  while (entry.sections.length > MAX_CACHE_SECTIONS) entry.sections.shift();
}

/**
 * Mark that a NEW large read has begun. After SANDBOX_CACHE_TURNS such reads the
 * spoken-section cache is wiped (lifecycle: recall stays useful for the last few
 * reads, never grows unbounded). The durable reading POSITION is untouched — it
 * persists/resumes independently. Call once per new loadSandbox of a big body.
 */
export function noteNewRead(sessionId) {
  if (!sessionId) return;
  let entry = _cache.get(sessionId);
  if (!entry) { entry = { sections: [], reads: 0 }; _cache.set(sessionId, entry); }
  entry.reads += 1;
  if (entry.reads > SANDBOX_CACHE_TURNS) {
    // Aged out: clear the spoken sections, reset the counter to count THIS read as #1.
    entry.sections = [];
    entry.reads = 1;
  }
}

/** Drop the spoken-section cache for a session entirely. */
export function clearCache(sessionId) { _cache.delete(sessionId); }

/** Inspect the cache (for diagnostics / "what have we read"). */
export function getCache(sessionId) {
  const e = _cache.get(sessionId);
  return e ? { reads: e.reads, sections: e.sections.slice() } : { reads: 0, sections: [] };
}

/**
 * SCORE how well a chunk of text answers a query. Cheap term-overlap scorer (no deps):
 * counts how many distinct query terms appear, weighted by frequency, normalized by
 * length so a short on-topic line beats a long off-topic one. Good enough to rank
 * "what did that part say about X" across a handful of recently-read sections.
 */
function _scoreText(text, terms) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return 0;
  let score = 0, hits = 0;
  for (const term of terms) {
    if (!term) continue;
    let from = 0, count = 0, at;
    while ((at = hay.indexOf(term, from)) !== -1) { count++; from = at + term.length; }
    if (count > 0) { hits++; score += 1 + Math.log(1 + count); }
  }
  if (!hits) return 0;
  // Reward covering MORE distinct terms; gently penalize very long blocks.
  return (score * (1 + hits / Math.max(1, terms.length))) / (1 + Math.log(1 + hay.length / 400));
}

function _queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}
const STOPWORDS = new Set(['the','and','that','this','with','from','what','did','was','were','say','said','part','about','have','has','for','you','your','they','them','tell','more','some','any','can','does','was','just','like','into','out','how','who','when','where','which','there','here','then','than','also','been','being','only','very','much']);

/**
 * Search the SPOKEN-SECTION cache for the sections that best answer a follow-up
 * question ("what did that part say about X"). Returns up to `limit` matches, best
 * first: [{ section, source, title, text, score, snippet }]. Empty array if nothing
 * relevant (caller can then fall back to searching the source doc).
 */
export function searchCache(sessionId, query, { limit = 3 } = {}) {
  const entry = _cache.get(sessionId);
  if (!entry || !entry.sections.length) return [];
  const terms = _queryTerms(query);
  if (!terms.length) {
    // No usable terms — just return the most recently read sections.
    return entry.sections.slice(-limit).reverse().map(s => ({ ...s, score: 0, snippet: _snippet(s.text, '') }));
  }
  const scored = entry.sections
    .map(s => ({ ...s, score: _scoreText(s.text, terms) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({ ...s, snippet: _snippet(s.text, terms[0]) }));
  return scored;
}

/**
 * Search an arbitrary SOURCE document for the passages that best answer a query —
 * used when the cache doesn't have it (e.g. asking about a part not yet read, or a
 * whole-doc question). Chunks the doc on paragraph boundaries, scores each, returns
 * the best [{ text, score, snippet }]. Pure helper so the bridge can pass any doc.
 */
export function searchSource(sourceText, query, { limit = 3 } = {}) {
  const src = String(sourceText || '').trim();
  if (!src) return [];
  const terms = _queryTerms(query);
  if (!terms.length) return [];
  // Split into paragraph-ish passages (blank-line or single-newline blocks), keep
  // ones of reasonable length so a passage carries enough context to be an answer.
  const paras = src.split(/\n{2,}/).flatMap(p => p.length > 1200 ? p.split(/\n/) : [p])
    .map(p => p.trim()).filter(p => p.length > 0);
  const scored = paras
    .map((text, i) => ({ text, index: i, score: _scoreText(text, terms) }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(p => ({ ...p, snippet: _snippet(p.text, terms[0]) }));
  return scored;
}

/** A short context snippet around the first hit of `term` (for compact answers). */
function _snippet(text, term, radius = 220) {
  const s = String(text || '');
  if (!term) return s.slice(0, radius * 2).trim();
  const at = s.toLowerCase().indexOf(String(term).toLowerCase());
  if (at < 0) return s.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(s.length, at + radius);
  return (start > 0 ? '…' : '') + s.slice(start, end).trim() + (end < s.length ? '…' : '');
}

/**
 * ONE-STOP follow-up answer helper: search the spoken cache FIRST, then (if the cache
 * has nothing relevant and a source doc is supplied) the source doc. Returns
 * { from:'cache'|'source'|'none', matches:[...] } so the caller can frame the reply.
 */
export function answerFollowUp(sessionId, query, { sourceText = '', limit = 3 } = {}) {
  const cacheHits = searchCache(sessionId, query, { limit });
  if (cacheHits.length && cacheHits[0].score > 0) return { from: 'cache', matches: cacheHits };
  if (sourceText) {
    const srcHits = searchSource(sourceText, query, { limit });
    if (srcHits.length) return { from: 'source', matches: srcHits };
  }
  // Fall back to most-recent cache sections even if term-scoring found nothing.
  if (cacheHits.length) return { from: 'cache', matches: cacheHits };
  return { from: 'none', matches: [] };
}

// ── drafts (interrupt cache) ──────────────────────────────────────────────────
function _loadDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8')); } catch { return {}; }
}
function _saveDrafts(obj) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(DRAFTS_PATH, JSON.stringify(obj, null, 2)); } catch (_) {}
}

/**
 * Interrupt save: stash where Leo was (remaining chunks) so the thread survives.
 * Keeps at most MAX_DRAFTS_PER_SESSION, newest last, each with date/time meta.
 * Returns the saved draft entry.
 */
export function saveDraft(sessionId, { note = '' } = {}) {
  const s = _live.get(sessionId);
  if (!s) return null;
  const remaining = s.chunks.slice(s.idx);
  if (!remaining.length) { _live.delete(sessionId); return null; }
  const all = _loadDrafts();
  const list = Array.isArray(all[sessionId]) ? all[sessionId] : [];
  const entry = {
    id: `${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    ts: new Date().toISOString(),
    title: s.meta?.title || '',
    note,
    atIndex: s.idx + 1,
    total: s.total,
    remaining
  };
  list.push(entry);
  // user's rule: 2 drafts max, in order — drop the oldest beyond the cap.
  while (list.length > MAX_DRAFTS_PER_SESSION) list.shift();
  all[sessionId] = list;
  _saveDrafts(all);
  _live.delete(sessionId); // paused; lives in drafts now
  return entry;
}

/** List a session's drafts (oldest → newest), for "where was I?" */
export function getDrafts(sessionId) {
  const all = _loadDrafts();
  return Array.isArray(all[sessionId]) ? all[sessionId] : [];
}

/**
 * Resume: pop a draft (default newest) back into the live sandbox so Leo can
 * pick the thread back up from where he left off.
 */
export function resumeDraft(sessionId, draftId = null) {
  const all = _loadDrafts();
  const list = Array.isArray(all[sessionId]) ? all[sessionId] : [];
  if (!list.length) return null;
  const idxInList = draftId ? list.findIndex(d => d.id === draftId) : list.length - 1;
  if (idxInList < 0) return null;
  const draft = list.splice(idxInList, 1)[0];
  all[sessionId] = list;
  _saveDrafts(all);
  _live.set(sessionId, {
    chunks: draft.remaining.map((c, i) => ({ text: c.text, seq: i })),
    idx: 0, total: draft.remaining.length,
    meta: { title: draft.title, resumedFrom: draft.id }, startedAt: Date.now()
  });
  return { sessionId, total: draft.remaining.length, title: draft.title, resumedAt: draft.atIndex };
}

// ── durable reading position (survives restarts) ───────────────────────────────
// A tiny pointer to where Leo last was in a book, written as each section is SENT.
// This is separate from drafts: drafts cache the REMAINING text for a paused read;
// this is just the cursor + title so resume_reading / a restart can say (and resume)
// exactly where he stopped, even when the live sandbox was rebuilt from the source.
export const READING_POSITION_FILE = READING_POSITION_PATH;

function _loadPositions() {
  try { return JSON.parse(fs.readFileSync(READING_POSITION_PATH, 'utf8')); } catch { return {}; }
}

/**
 * Persist where the read currently is. Call as each section is SENT. index and
 * total are 1-based section numbers. Never throws (a write failure must not stop
 * a read). SINGLE-QUOTED — no backticks.
 */
export function saveReadingPosition(sessionId, { title = '', index = 0, total = 0 } = {}) {
  if (!sessionId) return null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const all = _loadPositions();
    const entry = { title, index, total, ts: new Date().toISOString() };
    all[sessionId] = entry;
    fs.writeFileSync(READING_POSITION_PATH, JSON.stringify(all, null, 2));
    return entry;
  } catch (_) { return null; }
}

/** Read the saved reading position for a session (or null). */
export function getReadingPosition(sessionId) {
  if (!sessionId) return null;
  const all = _loadPositions();
  return all[sessionId] || null;
}

/** Clear the saved position (read finished or abandoned). Never throws. */
export function clearReadingPosition(sessionId) {
  if (!sessionId) return;
  try {
    const all = _loadPositions();
    if (all[sessionId]) { delete all[sessionId]; fs.writeFileSync(READING_POSITION_PATH, JSON.stringify(all, null, 2)); }
  } catch (_) {}
}
