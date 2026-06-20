// loop-guard.mjs — detect & truncate runaway repetition in generated / bot text.
//
// Ported forward from Kai 2.0's `kai_loop_guard.py`. Current KAI has *echo* detection
// (Leo recognising his own voice through the mic), but nothing that catches a model
// that gets stuck repeating the same sentence or phrase over and over. This is that
// missing guard — it runs on the TEXT a bot is about to send/speak and trims the
// runaway loop, so KAI never spams the same line three times.
//
// Returns { text, truncated }. `guard()` is the convenience form that returns just
// the cleaned string. Pure, dependency-free, unit-checkable.

// Phrases that, repeated, almost always signal a stuck loop (extend per your fleet).
const DEFAULT_SPAM_PHRASES = [
  'acknowledged',
  'system notification',
  'good morning',
  'i am here',
  'how can i help',
];

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Truncate runaway repetition.
 * @param {string} text
 * @param {{phraseHits?:number, sentenceHits?:number, spamPhrases?:string[]}} [opts]
 * @returns {{text:string, truncated:boolean}}
 */
export function truncateRepetitionLoops(text, opts = {}) {
  const { phraseHits = 3, sentenceHits = 3, spamPhrases = DEFAULT_SPAM_PHRASES } = opts;
  const t = String(text || '');
  if (!t.trim()) return { text: t, truncated: false };
  const lowered = t.toLowerCase();

  // 1) A spam phrase repeated >= phraseHits times -> cut at the Nth occurrence.
  for (const phrase of spamPhrases) {
    const p = String(phrase || '').toLowerCase();
    if (!p) continue;
    let count = 0, idx = 0, cutAt = t.length;
    while (count < phraseHits) {
      const pos = lowered.indexOf(p, idx);
      if (pos < 0) break;
      count++;
      if (count === phraseHits) { cutAt = pos; break; }
      idx = pos + p.length;
    }
    if (count >= phraseHits) {
      let cut = t.slice(0, cutAt).trimEnd();
      cut = cut ? cut + ' ...' : t.slice(0, 200).trimEnd() + ' ...';
      return { text: cut, truncated: true };
    }
  }

  // 2) The same sentence (normalized, >= 12 chars) repeated >= sentenceHits times.
  const sents = splitSentences(t);
  const seen = new Map();
  sents.forEach((s, i) => {
    const n = s.toLowerCase().slice(0, 500);
    if (n.length < 12) return;
    if (!seen.has(n)) seen.set(n, []);
    seen.get(n).push(i);
  });
  for (const [, idxs] of seen) {
    if (idxs.length >= sentenceHits) {
      const third = idxs[sentenceHits - 1];
      if (third === 0) return { text: sents[0] + ' ...', truncated: true };
      return { text: sents.slice(0, third).join(' ').trim() + ' ...', truncated: true };
    }
  }

  return { text: t, truncated: false };
}

/** Convenience: returns just the cleaned string (no-op if nothing looped). */
export function guard(text, opts) {
  return truncateRepetitionLoops(text, opts).text;
}
