// profile-memory.mjs — per-person history with intent + emotional state.
// Records each human's statements (filtered) to the SENSITIVE channel and the
// transcript memory, so the fleet can recall who said/did what — and catch
// contradictions ("you said the opposite before") with the right context.

import {
  ingestMessage, recallProfileMemories,
  captureEntityFacts, getEntityProfile, setEntityFact, recallFromEngine
} from './transcript-memory.mjs';

// Re-export the structured-memory + engine-recall API so callers can pull
// "who this person is" (categorized facts) and deep/bulk lattice recall through
// the profile layer they already import.
export { getEntityProfile, setEntityFact, recallFromEngine };

export const SENSITIVE_CHANNEL = '1500053533515448480';

// Lightweight emotional-state read (text). Voice uses Gemini 3.1 acoustic sensing;
// this is the text fallback so every record carries a "last emotional state".
export function inferEmotion(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(furious|pissed|angry|hate|wtf|fuck you|shut up|stupid|idiot)\b/.test(t)) return 'angry';
  if (/\b(sad|depress|hopeless|cry|tired of|give up|alone|hurt)\b/.test(t)) return 'sad';
  if (/\b(scared|anxious|worried|nervous|afraid|stress)\b/.test(t)) return 'anxious';
  if (/\b(love|awesome|amazing|great|yes+|let's go|excited|hyped|lmao|haha|🔥)\b/.test(t)) return 'positive';
  if (/\?\s*$/.test(t) || /\b(how|why|what|when|where|can you)\b/.test(t)) return 'curious';
  return 'neutral';
}

export function inferIntent(text) {
  const t = String(text || '').toLowerCase();
  if (t.trim().endsWith('?')) return 'question';
  if (/\b(build|code|repo|fix|make|implement)\b/.test(t)) return 'development';
  if (/\b(love|like|prefer|favorite|hate|don'?t like)\b/.test(t)) return 'preference';
  if (/\b(remember|recall|earlier|before|last time|you said)\b/.test(t)) return 'recall';
  return 'statement';
}

/**
 * Record a person's statement: store in transcript memory (intent/tags) AND post a
 * filtered profile entry (person | intent | emotion | time | snippet) to the
 * sensitive channel, where the fleet keeps per-person history. Humans only.
 */
export async function recordProfile(client, person, userId, content, channelId) {
  const text = String(content || '').trim();
  if (!text || !person) return;
  const emotion = inferEmotion(text);
  const intent = inferIntent(text);
  // Stamp the channel as the thread_id fallback (a flat-channel message's
  // "thread" is the channel itself). A true Discord thread id is captured at the
  // bot listener layer which has the message object; here we only have channelId.
  try { ingestMessage(person, userId, text, channelId, { threadId: channelId }); } catch (_) {}
  // CHEAP structured-fact capture (regex only, no LLM/network) — builds the small
  // categorized "who is this person" store as a side-effect of recording. Humans
  // and AIs alike; misses are fine, only clear self-statements are captured.
  try { captureEntityFacts(userId, person, text); } catch (_) {}
  try {
    const ch = client?.channels?.cache?.get(SENSITIVE_CHANNEL) || await client?.channels?.fetch?.(SENSITIVE_CHANNEL).catch(() => null);
    if (ch) {
      const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      await ch.send(`**[PROFILE] ${person}** · ${when} · intent: \`${intent}\` · emotion: \`${emotion}\`\n> ${text.slice(0, 400)}`).catch(() => {});
    }
  } catch (_) {}
  return { intent, emotion };
}

/**
 * Past statements by this person, formatted for prompt injection so the bot can
 * spot contradictions against what they're saying now.
 */
export function contradictionContext(userId, n = 6) {
  try {
    const past = recallProfileMemories(userId, { limit: n }) || [];
    if (!past.length) return '';
    const lines = past.map(p => {
      const when = new Date(Number(p.timestamp) || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `  - (${when}) ${String(p.content || '').replace(/\s+/g, ' ').slice(0, 100)}`;
    });
    return `[WHAT THIS PERSON HAS SAID BEFORE — check it; if they now contradict this without a reason, call it out gently]:\n${lines.join('\n')}`;
  } catch (_) { return ''; }
}

/**
 * Compact "who this person is" block for prompt injection — the STRUCTURED
 * categorized facts (likes/dislikes/patterns/…), NOT the raw transcript. Loads
 * on demand so Leo/Oracle can know a person without replaying their history.
 * Returns '' when nothing is known yet.
 */
export function entityProfileContext(entityId) {
  try {
    const prof = getEntityProfile(entityId);
    if (!prof || !prof.summary) return '';
    return `[WHO THIS PERSON IS — structured memory, load on demand]:\n  ${prof.summary}`;
  } catch (_) { return ''; }
}
