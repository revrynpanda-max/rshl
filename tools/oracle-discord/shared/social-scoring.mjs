/**
 * social-scoring.mjs — Dynamic social participation scoring.
 *
 * Distinguishes direct address vs passing mention, detects unanswered gaps
 * ("idk who posted it"), and boosts bots who hold relevant memory so they
 * can fill honest gaps without being named.
 */

import { computeInterest, PARTICIPATION_THRESHOLD, TWO_CENTS_THRESHOLD } from './social-interest.mjs';
import { AI_REGISTRY } from './identities.mjs';

const FLEET_BOTS = Object.keys(AI_REGISTRY);

// --- NAME-ADDRESSING ALIAS MAP (env: SOCIAL_NAME_ROUTING, default ON) ---
// Maps spoken/typed aliases -> canonical fleet name. Includes STT manglings
// the logs showed (Claudia/Jemmy/Grodd) plus the everyday short forms (Gemi).
// All lowercase keys. Used by getPrimaryAddressee so a name spoken by a human
// OR by another bot routes the turn to the right responder — including Leo.
const NAME_ROUTING_ON = String(process.env.SOCIAL_NAME_ROUTING ?? '1') === '1';
const NAME_ALIASES = {
  'claudey': 'Claudey', 'claudia': 'Claudey', 'claude': 'Claudey', 'claudy': 'Claudey', 'cloudy': 'Claudey',
  'gemini': 'Gemini', 'gemi': 'Gemini', 'jemmy': 'Gemini', 'jemi': 'Gemini', 'gemmy': 'Gemini', 'jemini': 'Gemini',
  'groq': 'Groq', 'grodd': 'Groq', 'grok': 'Groq', 'grock': 'Groq', 'grog': 'Groq',
  'leo': 'Leo', 'leon': 'Leo', 'leyo': 'Leo',
  'kai': 'KAI', 'ky': 'KAI', 'kay': 'KAI',
  'oracle': 'Oracle',
  'x': 'X', 'ex': 'X', 'axe': 'X',
  'analyst': 'Analyst', 'researcher': 'Researcher'
};
// Canonical names addressable by name-routing (fleet + Leo). Longest-first so a
// multi-token name can't be shadowed by a shorter alias.
const ADDRESSABLE = Array.from(new Set([...FLEET_BOTS, 'Leo']))
  .sort((a, b) => b.length - a.length);

// Levenshtein <=1 fuzzy match for a single token against an alias key, so minor
// STT slips still resolve. Cheap, bounded — only runs on short address tokens.
function nearAlias(token) {
  const t = (token || '').toLowerCase();
  if (!t) return null;
  if (NAME_ALIASES[t]) return NAME_ALIASES[t];
  for (const key of Object.keys(NAME_ALIASES)) {
    // Only fuzz longer alias keys — short ones (x, kai, leo, ex, ky) must match
    // exactly so common words ('by', 'ax', 'so') can't be misrouted to a bot.
    if (key.length < 5) continue;
    if (Math.abs(key.length - t.length) > 1) continue;
    let i = 0, j = 0, edits = 0;
    while (i < key.length && j < t.length) {
      if (key[i] === t[j]) { i++; j++; continue; }
      if (++edits > 1) break;
      if (key.length > t.length) i++;
      else if (key.length < t.length) j++;
      else { i++; j++; }
    }
    edits += (key.length - i) + (t.length - j);
    if (edits <= 1) return NAME_ALIASES[key];
  }
  return null;
}

// Resolve an addressee from a leading token (alias-tolerant). Returns canonical
// name or null. Honors SOCIAL_NAME_ROUTING.
function resolveAddressee(token) {
  if (!NAME_ROUTING_ON) return null;
  return nearAlias(token);
}

const UNANSWERED_GAP_RE =
  /\b(idk|i don'?t know|not sure|no idea|who knows|can'?t remember|unsure|don'?t recall|don'?t remember|wasn'?t me|wasn'?t mine|pretty sure .+ but|might'?ve been|was it|who posted|who said|who dropped|who shared|nobody knows|no clue)\b/i;

const ACTION_RE = /\b(posted|shared|dropped|said|wrote|sent|uploaded|linked|published|mentioned)\b/i;

function tokens(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'about', 'what', 'when', 'where', 'which', 'your', 'their', 'they', 'them', 'then', 'than', 'just', 'like', 'would', 'could', 'should', 'there', 'here', 'been', 'being', 'into', 'over', 'under', 'after', 'before']);
  return (text || '').toLowerCase().match(/[a-z][a-z']{2,}/g)?.filter(w => !stop.has(w)) || [];
}

/**
 * Who is being spoken TO at the start of a line (not merely mentioned).
 */
export function getPrimaryAddressee(content) {
  const c = (content || '').trim();
  if (!c) return null;

  const heyMatch = c.match(/^(?:hey|yo|hi|ok|okay|wait|so|alright|listen|oi|ay|aye)\s+([a-z][\w-]*)/i);
  if (heyMatch) {
    const fragment = heyMatch[1].toLowerCase();
    for (const b of ADDRESSABLE) {
      if (fragment === b.toLowerCase() || fragment.startsWith(b.toLowerCase())) return b;
    }
    const aliasHit = resolveAddressee(fragment);
    if (aliasHit) return aliasHit;
  }

  for (const b of ADDRESSABLE) {
    if (new RegExp('^' + b + '\\b[,!?:]', 'i').test(c)) return b;
    if (new RegExp('^' + b + '\\s+you\\b', 'i').test(c)) return b;
  }

  // Alias-tolerant leading-name address: 'gemi, ...' / 'grodd you ...' / '@claudia'.
  // Pull the first word-token (stripping a leading @) and resolve via the alias map
  // so STT manglings still route to the right bot. Only treats it as an address
  // when followed by address punctuation or 'you' (not a mid-sentence mention).
  const lead = c.match(/^@?([a-z][\w'-]{0,14})\b([,!?:]|\s+you\b)?/i);
  if (lead) {
    const aliasHit = resolveAddressee(lead[1]);
    if (aliasHit && lead[2]) return aliasHit;
  }

  return null;
}

// Alias-tolerant: does this message name the given bot anywhere (canonical name
// or any known alias / STT mangling)? Used so a BOT naming another BOT still
// counts as addressing them.
export function mentionsBot(content, botName) {
  const lower = (content || '').toLowerCase();
  if (!lower) return false;
  if (lower.includes(botName.toLowerCase())) return true;
  if (!NAME_ROUTING_ON) return false;
  for (const [alias, canon] of Object.entries(NAME_ALIASES)) {
    if (canon !== botName) continue;
    if (new RegExp('\\b' + alias + '\\b', 'i').test(lower)) return true;
  }
  return false;
}

export function isDirectAddress(content, botName) {
  const lower = (content || '').toLowerCase();
  const b = botName.toLowerCase();
  const primary = getPrimaryAddressee(content);
  if (primary && primary.toLowerCase() === b) return true;
  if (new RegExp(`\\b(what do you think,?\\s+${b}|@${b}|\\b${b}\\s*[,!?]\\s*you\\b)`, 'i').test(lower)) return true;
  return false;
}

export function isPassingMention(content, botName) {
  const lower = (content || '').toLowerCase();
  const b = botName.toLowerCase();
  if (!lower.includes(b)) return false;
  const primary = getPrimaryAddressee(content);
  if (primary && primary.toLowerCase() !== b) return true;
  // "I think groq was the one" — groq mentioned but Claudey is primary
  if (/\b(i think|maybe|probably|might be|could be|was it)\s+\w*\s*groq\b/i.test(lower) && b === 'groq' && primary) return true;
  if (/\b(i think|maybe|probably)\b/.test(lower) && lower.includes(b) && primary && primary.toLowerCase() !== b) return true;
  return false;
}

export function detectsUnansweredGap(content) {
  return UNANSWERED_GAP_RE.test(content || '');
}

/**
 * Did this bot recently say/do something about this topic in channel history?
 */
export function findSelfInRecentHistory(botName, recentMessages = [], topicWords = []) {
  const bLower = botName.toLowerCase();
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i];
    const author = (m.author?.username || m.author?.displayName || '').toLowerCase();
    if (author !== bLower && !author.includes(bLower)) continue;
    const body = (m.content || '').toLowerCase();
    if (!ACTION_RE.test(body)) continue;
    if (topicWords.length === 0 || topicWords.some(w => body.includes(w))) {
      return m.content;
    }
  }
  return null;
}

/**
 * Check lattice + transcript for evidence this bot holds the answer.
 */
export async function checkKnowledgeHolder(botName, messageContent, recentMessages = []) {
  const topicWords = tokens(messageContent).slice(0, 8);
  if (!topicWords.length) return { holds: false, score: 0, evidence: '', reason: '' };

  const selfLine = findSelfInRecentHistory(botName, recentMessages, topicWords);
  if (selfLine) {
    return {
      holds: true,
      score: 2.35,
      evidence: selfLine,
      reason: 'recent-channel-self-action',
    };
  }

  try {
    const { queryLattice } = await import('./lattice-bridge.mjs');
    const query = `${botName} ${topicWords.join(' ')}`;
    const hits = await queryLattice(query, 6);
    const bLower = botName.toLowerCase();
    for (const h of hits || []) {
      const text = (h.text || '');
      const tl = text.toLowerCase();
      if (tl.includes(bLower) && ACTION_RE.test(tl)) {
        return {
          holds: true,
          score: 2.25,
          evidence: text.slice(0, 280),
          reason: 'lattice-self-action',
        };
      }
    }
  } catch (_) {}

  try {
    const { recallProfileMemories } = await import('./transcript-memory.mjs');
    const { AI_REGISTRY } = await import('./identities.mjs');
    const entry = Object.entries(AI_REGISTRY).find(([n]) => n.toLowerCase() === botName.toLowerCase());
    const botId = entry?.[1]?.id;
    if (botId) {
      const memories = recallProfileMemories(botId, { query: topicWords.join(' '), limit: 3 });
      for (const mem of memories || []) {
        const body = (mem.content || '').toLowerCase();
        if (ACTION_RE.test(body)) {
          return {
            holds: true,
            score: 2.2,
            evidence: mem.content.slice(0, 280),
            reason: 'transcript-self-action',
          };
        }
      }
    }
  } catch (_) {}

  return { holds: false, score: 0, evidence: '', reason: '' };
}

/**
 * Full participation score for a reactive social message.
 */
export async function computeSocialScore(botName, messageContent, options = {}) {
  const { recentMessages = [], fromHuman = false, wasTalkingToMe = false } = options;

  let score = computeInterest(botName, messageContent);
  const gap = detectsUnansweredGap(messageContent);
  const knowledge = await checkKnowledgeHolder(botName, messageContent, recentMessages);

  // Priority boost applied to the named/addressed bot. Env-tunable so the
  // first-claim-on-the-floor strength can be raised without code edits.
  const NAME_PRIORITY_BOOST = (() => {
    const v = Number(process.env.SOCIAL_NAME_PRIORITY_BOOST);
    return Number.isFinite(v) && v > 0 ? v : 2.5;
  })();

  if (isDirectAddress(messageContent, botName)) {
    score = Math.max(score, NAME_PRIORITY_BOOST);
  } else if (isPassingMention(messageContent, botName)) {
    score = Math.max(score, 0.85);
  } else if (mentionsBot(messageContent, botName)) {
    score = Math.max(score, 1.15);
  }

  if (gap && knowledge.holds) {
    score = Math.max(score, knowledge.score);
  }

  if (wasTalkingToMe) score += 0.45;
  if (fromHuman) score += 0.25;

  return {
    score,
    gap,
    knowledge,
    isDirect: isDirectAddress(messageContent, botName),
    isPassing: isPassingMention(messageContent, botName),
    primaryAddressee: getPrimaryAddressee(messageContent),
  };
}

export { PARTICIPATION_THRESHOLD, TWO_CENTS_THRESHOLD };
