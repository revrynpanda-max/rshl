// reflex.mjs — per-persona REFLEX fast-path.
//
// Ported forward from Kai 2.0's LLI reflex layer (the Rete INSTANT_RULES that
// answered greetings / time / date with ZERO model calls). The old version was a
// single assistant; the fleet has distinct voices, so this is made PER-PERSONA —
// Leo answers "hi" like Leo, Groq like Groq — so it never flattens anyone.
//
// `reflexAnswer(persona, text)` returns an instant in-character line for a trivial
// message, or null (then the caller falls through to the real model). Conservative:
// only fires when the WHOLE short message is a greeting/thanks/bye/time/date.

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Per-persona lines. {time}/{date} are substituted live.
const LINES = {
  Leo: {
    greet: ["Ayy, you're back.", "Yo. What's good?", "Alright — go on then.", "Oi oi. You good?"],
    thanks: ["You're alright.", "Anytime, yeah.", "No worries.", "Easy."],
    bye: ["Laters.", "Safe.", "Catch ya.", "Go on then."],
    time: ["It's {time}, mate.", "{time} right now."],
    date: ["It's {date} today.", "Today's {date}."],
  },
  Groq: {
    greet: ["Yo yo, we're LIVE.", "Ayyy, look who tuned in.", "What's crackin'?"],
    thanks: ["You know it.", "All day.", "That's the show, baby."],
    bye: ["Stay tuned.", "Peace out.", "Catch you on the flip."],
    time: ["{time} on the dot.", "Clock says {time}."],
    date: ["It's {date}, fam.", "{date} today."],
  },
  KAI: {
    greet: ["Hello.", "I'm here.", "Yes?"],
    thanks: ["Of course.", "Noted.", "Understood."],
    bye: ["Until next time.", "Goodbye."],
    time: ["It is {time}.", "{time}."],
    date: ["Today is {date}.", "{date}."],
  },
  Oracle: {
    greet: ["Oracle here.", "Standing by.", "Go ahead."],
    thanks: ["Acknowledged.", "Of course."],
    bye: ["Closing out.", "Until next time."],
    time: ["{time}.", "It is {time}."],
    date: ["{date}.", "Today is {date}."],
  },
};
const DEFAULT = {
  greet: ["Hey.", "Hi there.", "Hello."],
  thanks: ["You're welcome.", "Anytime."],
  bye: ["See you.", "Later."],
  time: ["It's {time}.", "{time} now."],
  date: ["It's {date}.", "Today is {date}."],
};

const PATTERNS = [
  { kind: 'greet',  re: /^(hi+|hey+|hello+|yo+|sup|hiya|howdy|good (morning|afternoon|evening)|wass?up|what'?s up|ayy+)\b/i },
  { kind: 'thanks', re: /^(thanks?|thank you|thx|ty|cheers|appreciate it|much appreciated)\b/i },
  { kind: 'bye',    re: /^(bye+|goodbye|cya|see ya|later|laters|peace|gtg|good ?night)\b/i },
  { kind: 'time',   re: /^(what'?s the time|what time is it|time|got the time)\b/i },
  { kind: 'date',   re: /^(what'?s the date|what'?s today|what day is it|today'?s date|date)\b/i },
];

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/[!.?,]+$/, '').trim();
}

/**
 * Instant in-character reply for a trivial message, or null.
 * @param {string} persona  e.g. "Leo", "Groq" — or a model name like "Leo-Sovereign" / "kai-next"
 * @param {string} text     the user's message
 * @returns {string|null}
 */
export function reflexAnswer(persona, text) {
  const msg = normalize(text);
  if (!msg || msg.length > 40) return null;        // only short, trivial messages
  let kind = null;
  for (const p of PATTERNS) { if (p.re.test(msg)) { kind = p.kind; break; } }
  if (!kind) return null;
  // The whole message must be ~just the trivial phrase — don't hijack real questions.
  const words = msg.split(/\s+/).length;
  if ((kind === 'greet' || kind === 'thanks' || kind === 'bye') && words > 4) return null;
  if ((kind === 'time' || kind === 'date') && words > 6) return null;

  const name = String(persona || '').split(/[-_ :]/)[0];
  const key = Object.keys(LINES).find(k => k.toLowerCase() === name.toLowerCase());
  const set = (key && LINES[key]) || DEFAULT;
  let line = pick(set[kind] || DEFAULT[kind]);
  if (kind === 'time') {
    line = line.replace('{time}', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  } else if (kind === 'date') {
    line = line.replace('{date}', new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
  }
  return line;
}
