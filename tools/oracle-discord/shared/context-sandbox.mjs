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
const MAX_DRAFTS_PER_SESSION = 2;   // user's rule: 2 drafts max, in order
const MAX_SANDBOXES = 50;           // safety cap on live sessions

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
const HARD_MAX = 1800; // absolute ceiling: a section is NEVER longer than this.
const _maxChunkEnv = Number(process.env.SANDBOX_MAX_CHUNK) > 0
  ? Math.min(Number(process.env.SANDBOX_MAX_CHUNK), HARD_MAX) // honour override but never above the ceiling
  : 1700;
// Ramp easing-in toward the cap, but never above it (clamped to _maxChunkEnv).
const RAMP = [800, 1200, 1500, _maxChunkEnv].map(n => Math.min(n, _maxChunkEnv));
const MAX_CHUNK = _maxChunkEnv;

// ── live state (in-memory) ─────────────────────────────────────────────────
/** sessionId -> { chunks:[{text,seq}], idx, total, meta, startedAt } */
const _live = new Map();

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
export function chunkText(text, { ramp = RAMP, maxChunk = MAX_CHUNK } = {}) {
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

  const HARD = Math.max(200, Math.min(HARD_MAX, Math.max(maxChunk, ...ramp)));
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
  // Re-join sections the way they are spoken (single space between) and compare to
  // the source with whitespace flattened. A mismatch means a boundary bug slipped
  // in — log LOUDLY rather than silently shipping overlapping/missing audio.
  try {
    const flat = (s) => s.replace(/\s+/g, ' ').trim();
    const rejoined = flat(chunks.join(' '));
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
export function loadSandbox(sessionId, text, { meta = {}, title = '' } = {}) {
  if (!sessionId) return null;
  const chunks = chunkText(text);
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
    meta: { ...meta, title }, startedAt: Date.now()
  });
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
