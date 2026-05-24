// shared/behavioral-signals.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 7: behavioral signal extraction — the metrics that catch issues
// that DON'T throw exceptions but feel wrong to a human watching the chat.
//
// Signals exported:
//   silenceMs(channelId)               ms since last message in this channel
//   speakerDiversity(channelId)        Shannon entropy of speakers (0 = one talker, ~log2(N) = even)
//   distinctSpeakers(channelId)        count of unique speakers in window
//   topicDwellRatio(channelId)         fraction of recent msgs containing the dominant noun
//   replyChainDepth(channelId)         longest A→B→A→B alternation
//   repetitiveness(channelId)          fraction of msgs whose 40-char prefix appears earlier
//   hallucinationMarkers(channelId)    count of bot-LARP phrases ("queried the lattice" etc.)
//
// All signals are computed from topic-tracker's in-memory history (5min TTL).
// They're cheap to compute on every correlation tick.
// ──────────────────────────────────────────────────────────────────────────────

import { getRecentHistory } from './topic-tracker.mjs';

const STOP = new Set(
  ("the and for with that this from have just into about over under your "
 + "they them then than what when where which been being onto upon some "
 + "more most very much many also like would could should there here "
 + "you we us are was were has had does did doing get got make made "
 + "i'm i've it's that's there's here's lol lmao not but yes").split(/\s+/)
);

const HALLUC_PATTERNS = [
  /\bquery(ing|ed)?\s+the\s+lattice\b/i,
  /\bplugged\s+into\s+the\s+lattice\b/i,
  /\bdirect\s+(line|feed)\s+to\s+(the\s+)?(lattice|rshl)\b/i,
  /\baccess\s+to\s+the\s+rshl\b/i,
  /\bsynaptic\s+decay\b/i,
  /\bindustrial.?trash\b/i,
  /\bcircuit.?stain\b/i,
  /\blattice.?burn\b/i,
  /\blogic.?rot\b/i,
  /\bsignal.?void\b/i,
  /\bneural.?drift\b/i,
  // Fabricated-citation patterns (Author et al. + 4-digit year is suspicious in chat)
  /\b[A-Z][a-z]+\s+et\s+al\.?\s+(19|20)\d{2}\b/,
];

function tokens(text) {
  return (text || '').toLowerCase().match(/[a-z][a-z']{3,}/g) || [];
}

export function silenceMs(channelId) {
  const h = getRecentHistory(channelId);
  if (!h.length) return Infinity;
  return Date.now() - h[h.length - 1].ts;
}

export function distinctSpeakers(channelId) {
  const h = getRecentHistory(channelId);
  return new Set(h.map(m => m.author).filter(Boolean)).size;
}

/** Shannon entropy of speaker distribution. 0 = one talker, log2(N) = even. */
export function speakerDiversity(channelId) {
  const h = getRecentHistory(channelId);
  if (h.length < 2) return 0;
  const counts = {};
  for (const m of h) if (m.author) counts[m.author] = (counts[m.author] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let H = 0;
  for (const n of Object.values(counts)) {
    const p = n / total;
    H -= p * Math.log2(p);
  }
  return H;
}

/** Fraction of recent messages containing the most-mentioned content noun. */
export function topicDwellRatio(channelId) {
  const h = getRecentHistory(channelId);
  if (h.length < 4) return 0;
  const docFreq = {};
  for (const m of h) {
    const unique = new Set(tokens(m.text));
    for (const w of unique) {
      if (STOP.has(w)) continue;
      docFreq[w] = (docFreq[w] || 0) + 1;
    }
  }
  let max = 0;
  for (const n of Object.values(docFreq)) if (n > max) max = n;
  return max / h.length;
}

/** Longest contiguous A→B→A→B alternation between same pair. */
export function replyChainDepth(channelId) {
  const h = getRecentHistory(channelId).filter(m => m.author);
  if (h.length < 2) return 0;
  let bestRun = 1;
  for (let start = 0; start < h.length - 1; start++) {
    const a = h[start].author, b = h[start + 1].author;
    if (!a || !b || a === b) continue;
    let run = 2;
    for (let i = start + 2; i < h.length; i++) {
      const expected = (i - start) % 2 === 0 ? a : b;
      if (h[i].author === expected) run++;
      else break;
    }
    if (run > bestRun) bestRun = run;
  }
  return bestRun;
}

/** Fraction of msgs whose 40-char prefix already appeared earlier in window. */
export function repetitiveness(channelId) {
  const h = getRecentHistory(channelId);
  if (h.length < 3) return 0;
  let repeats = 0;
  const seen = new Set();
  for (const m of h) {
    const prefix = m.text.slice(0, 40);
    if (prefix.length < 10) continue;
    if (seen.has(prefix)) repeats++;
    else seen.add(prefix);
  }
  return repeats / h.length;
}

/** Count of bot-LARP / fabricated-citation phrases in the recent window. */
export function hallucinationMarkers(channelId) {
  const h = getRecentHistory(channelId);
  let n = 0;
  const which = [];
  for (const m of h) {
    for (const pat of HALLUC_PATTERNS) {
      if (pat.test(m.text)) {
        n++;
        which.push({ author: m.author, marker: pat.source });
        break;
      }
    }
  }
  return { count: n, samples: which.slice(0, 5) };
}

/** Convenience: all signals at once, useful for correlation rules. */
export function snapshot(channelId) {
  const halluc = hallucinationMarkers(channelId);
  return {
    channel_id: channelId,
    history_size: getRecentHistory(channelId).length,
    silence_ms: silenceMs(channelId),
    distinct_speakers: distinctSpeakers(channelId),
    speaker_diversity: speakerDiversity(channelId),
    topic_dwell_ratio: topicDwellRatio(channelId),
    reply_chain_depth: replyChainDepth(channelId),
    repetitiveness: repetitiveness(channelId),
    hallucination_count: halluc.count,
    hallucination_samples: halluc.samples,
  };
}
