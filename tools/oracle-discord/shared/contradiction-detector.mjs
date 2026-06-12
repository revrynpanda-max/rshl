/**
 * contradiction-detector.mjs — Detect self-contradictions for ANY speaker
 * (humans + fleet AIs) in an active transcript window.
 */

const FLEET_NAMES = new Set([
  'leo', 'kai', 'gemini', 'claudey', 'groq', 'x', 'analyst', 'researcher',
  'kai coder', 'oracle', 'oracle coder', 'gemi',
]);

const STOPWORDS = new Set(
  "about above after again against all am an and any are as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here his how i if in into is isn't it it's its just let me more most mustn't my no nor not of off on once only or other our out over own same she should shouldn't so some such than that the their them then there these they this those through to too under until up very was wasn't we were weren't what when where which while who why with won't would wouldn't you your".split(/\s+/)
);

const OPPOSITIONS = [
  ['love', 'hate'], ['like', 'dislike'], ['always', 'never'], ['have', "haven't"],
  ['had', "didn't"], ['yes', 'no'], ['true', 'false'], ['pro', 'anti'],
  ['was', "wasn't"], ['did', "didn't"], ['will', "won't"], ['can', "can't"],
];

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(':');
  if (idx < 1) return null;
  let speaker = trimmed.slice(0, idx).trim().replace(/\s*\(YOU\)\s*$/i, '');
  const content = trimmed.slice(idx + 1).trim();
  return { speaker, content, speakerKey: speaker.toLowerCase() };
}

function sharesTopic(a, b) {
  const wordsA = a.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  const wordsB = b.toLowerCase();
  return wordsA.some(w => wordsB.includes(w));
}

function isContradictory(cur, prior) {
  const curLower = cur.toLowerCase();
  const pstLower = prior.toLowerCase();
  for (const [op1, op2] of OPPOSITIONS) {
    if ((curLower.includes(op1) && pstLower.includes(op2)) || (curLower.includes(op2) && pstLower.includes(op1))) {
      return true;
    }
  }
  const neg = ['not', "don't", 'never', "didn't", "haven't", "wasn't", "won't", "can't", 'no'];
  const curNeg = neg.some(n => curLower.includes(n));
  const pstNeg = neg.some(n => pstLower.includes(n));
  return curNeg !== pstNeg && sharesTopic(cur, prior);
}

/**
 * Scan transcript for the latest line from any speaker that contradicts
 * something they said earlier. Works for humans AND fleet AIs.
 */
export function detectTranscriptContradiction(transcriptText) {
  const lines = (transcriptText || '').split('\n');
  const parsed = lines.map(parseLine).filter(Boolean);
  if (parsed.length < 2) return null;

  const latest = parsed[parsed.length - 1];
  const speakerKey = latest.speakerKey;

  for (let i = parsed.length - 2; i >= 0; i--) {
    const prior = parsed[i];
    if (prior.speakerKey !== speakerKey) continue;
    if (!sharesTopic(latest.content, prior.content)) continue;
    if (isContradictory(latest.content, prior.content)) {
      return {
        speaker: latest.speaker,
        current: latest.content,
        prior: prior.content,
        isAI: FLEET_NAMES.has(speakerKey),
      };
    }
  }
  return null;
}

export function buildContradictionPrompt(hit) {
  if (!hit) return '';
  const who = hit.speaker;
  return `\n[MEMORY CALLBACK — ${who} may be contradicting themselves]\n` +
    `Earlier ${who} said: "${hit.prior.slice(0, 200)}"\n` +
    `Now ${who} said: "${hit.current.slice(0, 200)}"\n` +
    `If you're replying to ${who}, you MAY gently call this out in-character ("wait, didn't you just say...?") — natural, not robotic. ` +
    `Anyone in the room (human or AI) can be held accountable for inconsistent claims.\n`;
}
