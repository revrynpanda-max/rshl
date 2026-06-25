/**
 * edge-reading-tts.mjs — FREE edge-tts engine for Leo's LONG-FORM reading.
 *
 * Why this exists:
 *   Leo's long verbatim reads (book / Codex / papers) used to go through the
 *   dedicated Gemini TTS API (shared/gemini-tts.mjs synthesizeSpeech), which is
 *   RATE-LIMITED (Gemini free tier ~15 RPM) so a ~94-section read 429-storms and
 *   never finishes. edge-tts (Microsoft Edge online voices) has NO rate limit, so
 *   a full book completes. This module synthesizes ONE block of text per call and
 *   returns RAW PCM (s16le, 24kHz, MONO) — the EXACT format playTtsPcm() in
 *   bots/leo.mjs already expects (it was written for Gemini TTS). So the reader
 *   loop in leo.mjs only swaps which synth function it calls; nothing downstream
 *   changes.
 *
 *   The CONVERSATIONAL voice (Gemini Live "Charon") is NOT touched by this module
 *   — only the per-section reading synthesis routes here.
 *
 * Voice selection (persisted so it survives a restart):
 *   1. env LEO_EDGE_VOICE  (highest priority override)
 *   2. state/leo-reading-voice.json -> { "voice": "en-GB-RyanNeural" }
 *   3. DEFAULT_READING_VOICE (warm British male)
 *
 * Pipeline: edge-tts (MP3 to stdout) -> ffmpeg (decode to s16le 24k mono) -> Buffer.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';

/** Where the chosen reading voice is persisted across restarts. */
export const READING_VOICE_STATE_PATH = 'c:/KAI/tools/oracle-discord/state/leo-reading-voice.json';

/** Warm British male default (matches Leo's vibe). */
export const DEFAULT_READING_VOICE = 'en-GB-RyanNeural';

/** PCM format this module emits — same as Gemini TTS so playTtsPcm() works unchanged. */
export const READING_PCM = Object.freeze({ sampleRate: 24000, channels: 1, bitDepth: 16 });

/**
 * Resolve the reading voice: env override, then state file, then default.
 * @returns {string} edge-tts ShortName (e.g. "en-GB-RyanNeural").
 */
export function getReadingVoice() {
  const envVoice = (process.env.LEO_EDGE_VOICE || '').trim();
  if (envVoice) return envVoice;
  try {
    const raw = fs.readFileSync(READING_VOICE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.voice === 'string' && parsed.voice.trim()) {
      return parsed.voice.trim();
    }
  } catch (_) { /* no state file yet — use default */ }
  return DEFAULT_READING_VOICE;
}

/**
 * Persist the chosen reading voice to the state file.
 * @param {string} voice edge-tts ShortName.
 * @returns {boolean} true on success.
 */
export function setReadingVoice(voice) {
  const v = String(voice || '').trim();
  if (!v) return false;
  try {
    fs.mkdirSync('c:/KAI/tools/oracle-discord/state', { recursive: true });
    fs.writeFileSync(READING_VOICE_STATE_PATH, JSON.stringify({ voice: v }, null, 2));
    return true;
  } catch (e) {
    console.error('[Leo/EdgeTTS] Could not persist reading voice:', e?.message || e);
    return false;
  }
}

/**
 * Naturalize a technical edge-tts ShortName into spoken English so the TTS never
 * spells out "e n dash g b dash Ryan Neural". Used by cleanForSpeech() for any
 * spoken voice-list line / confirmation. The on-screen TEXT keeps the ShortName;
 * only the SPOKEN form is naturalized.
 * e.g. "en-GB-RyanNeural" -> "Ryan, a British male voice".
 * @param {string} shortName
 * @returns {string|null} natural phrase, or null if it is not a ShortName.
 */
export function naturalizeShortName(shortName) {
  const sn = String(shortName || '').trim();
  // Pattern: lang-REGION-NameNeural (Name may contain extra qualifiers).
  const m = sn.match(/^([a-z]{2})-([A-Z]{2})-([A-Za-z]+?)(?:Neural|Multilingual.*)?$/);
  if (!m) return null;
  const locale = m[1].toLowerCase() + '-' + m[2].toUpperCase();
  const accent = LOCALE_LABELS[locale] || (m[1].toLowerCase() + ' ' + m[2].toUpperCase());
  // Split a CamelCase name back into a plain first name (Ryan, MaisieNeural -> Maisie).
  let name = m[3].replace(/Neural$/i, '').replace(/Multilingual.*$/i, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const g = VOICE_NAME_GENDER[name.split(' ')[0]];
  const genderWord = g ? (' ' + g) : '';
  return name + ', a ' + accent + genderWord + ' voice';
}

/**
 * Clean text BEFORE it is synthesized for speech so the TTS never reads raw
 * symbols, markdown, or technical ShortNames aloud. Does NOT touch the visible
 * Discord TEXT — only the string handed to the synth engine. Preserves sentence
 * flow and the chunker's boundaries (line structure is kept where it matters).
 *
 * Env override: set LEO_SPEECH_SANITIZE=0 to disable (returns text unchanged).
 * @param {string} input
 * @returns {string}
 */
export function cleanForSpeech(input) {
  let t = String(input == null ? '' : input);
  if (!t.trim()) return t;
  if ((process.env.LEO_SPEECH_SANITIZE || '1') === '0') return t;

  // Naturalize standalone voice ShortNames first (before symbol-stripping mangles
  // the dashes). e.g. "en-GB-RyanNeural" -> "Ryan, a British male voice".
  t = t.replace(/\b([a-z]{2}-[A-Z]{2}-[A-Za-z]+?(?:Neural|Multilingual[A-Za-z]*))\b/g, (full) => {
    const nat = naturalizeShortName(full);
    return nat || full;
  });

  // Markdown links: speak the link TEXT, drop the URL.  [text](http://url) -> text
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  // Bare URLs -> drop entirely (don't spell out http colon slash slash).
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');

  // Process line-by-line so we can strip leading structure (headers, bullets,
  // blockquotes) while keeping the words and overall paragraph flow.
  const lines = t.split(/\r?\n/).map((line) => {
    let s = line;
    // Horizontal rules (---, ***, ___) on their own line -> a pause.
    if (/^\s*([-*_])\1{2,}\s*$/.test(s)) return ',';
    // Leading ATX headers (#, ##, ###) -> keep heading WORDS, drop the hashes.
    s = s.replace(/^\s*#{1,6}\s+/, '');
    // Blockquote markers at line start.
    s = s.replace(/^\s*>+\s?/, '');
    // List bullets (-, *, +) at line start -> drop the bullet, keep text.
    s = s.replace(/^\s*[-*+]\s+/, '');
    return s;
  });
  t = lines.join('\n');

  // Inline code / backticks: keep the words inside, drop the backticks.
  t = t.replace(/`+([^`]*)`+/g, '$1');
  t = t.replace(/`+/g, '');
  // Bold / italic / underscore emphasis markers (keep the words).
  t = t.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');

  // Table pipes -> a comma/pause so columns don't run together.
  t = t.replace(/\s*\|\s*/g, ', ');

  // Section sign -> the word "section".
  t = t.replace(/§/g, ' section ');
  // Em / en dashes and arrows -> a comma/pause.
  t = t.replace(/\s*(—|–|->|=>)\s*/g, ', ');

  // Strip stray standalone symbols that would be read aloud.
  t = t.replace(/[#*|~^_`]/g, ' ');

  // Collapse repeated punctuation (e.g. "!!!" -> "!", ",,," -> ",").
  t = t.replace(/([,.;:!?])\1+/g, '$1');
  // Tidy spacing around commas, and around line breaks.
  t = t.replace(/\s+,/g, ',').replace(/,\s*,/g, ',');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * NARRATION prosody profile for long-form read-aloud (book / Codex / papers).
 *
 * HONEST NOTE ON edge-tts (FREE endpoint):
 *   The free Microsoft Edge voices cannot do true emotional style-acting — Azure's
 *   mstts express-as styles (cheerful, sad, narration-professional, etc.) require a
 *   PAID Azure Speech key. What the free CLI DOES reliably honor is PROSODY: the
 *   --rate, --pitch and --volume flags. Raw SSML / <break> tags are NOT reliably
 *   honored by the edge-tts CLI, so natural pauses here are achieved via PUNCTUATION
 *   NORMALIZATION (text-level), not <break> tags. For genuine emotional delivery
 *   you'd need ElevenLabs or a paid Gemini/Azure voice — out of scope for this
 *   FREE, rate-limit-free reading path.
 *
 * Net effect: a slightly slower, deliberate read-aloud cadence with breathing
 * pauses at sentence and paragraph ends — book-like rather than rushed/flat.
 *
 * Env overrides (all optional; sensible expressive-but-natural defaults):
 *   LEO_READING_RATE    edge-tts --rate   (default "+5%"   — lively; set negative to slow down)
 *   LEO_READING_PITCH   edge-tts --pitch  (default "+0Hz"  — natural; try "+2Hz" for warmth)
 *   LEO_READING_VOLUME  edge-tts --volume (default "+0%"   — unchanged loudness)
 *   LEO_READING_PAUSES  set to "0" to DISABLE the punctuation pause-shaping.
 */
export const NARRATION_DEFAULTS = Object.freeze({ rate: '+5%', pitch: '+0Hz', volume: '+0%' });

/**
 * Resolve the narration prosody profile from env, falling back to NARRATION_DEFAULTS.
 * Values are passed straight through to edge-tts's --rate/--pitch/--volume flags,
 * which expect signed relative strings (e.g. "-10%", "+2Hz", "+0%").
 * @returns {{rate:string, pitch:string, volume:string}}
 */
export function getNarrationProfile() {
  const pick = (envVal, def) => {
    const v = (envVal || '').trim();
    return v ? v : def;
  };
  return {
    rate: pick(process.env.LEO_READING_RATE, NARRATION_DEFAULTS.rate),
    pitch: pick(process.env.LEO_READING_PITCH, NARRATION_DEFAULTS.pitch),
    volume: pick(process.env.LEO_READING_VOLUME, NARRATION_DEFAULTS.volume),
  };
}

/**
 * Shape PUNCTUATION so the read-aloud breathes instead of running sentences
 * together. Applied AFTER cleanForSpeech() (sanitize first, then prosody). Because
 * the edge-tts CLI does NOT reliably honor SSML <break> tags, we lean on the fact
 * that the neural voices already pause naturally at sentence-final punctuation and
 * paragraph breaks — we just make sure that punctuation is PRESENT and give
 * paragraph boundaries a touch more weight, kept subtle so it never sounds stuttery.
 *
 * What it does:
 *   - Ensures each non-empty line that lacks sentence-final punctuation gets a
 *     period, so the voice lands a clean sentence pause at line ends (matters for
 *     the per-section chunker — every section ends on a real pause).
 *   - Converts paragraph breaks (blank line between blocks) into a slightly longer
 *     spoken pause via an ellipsis-spaced break the voice reads as a beat.
 *   - Leaves mid-sentence flow untouched.
 *
 * Disable with LEO_READING_PAUSES=0.
 * @param {string} input  Already-sanitized speech text.
 * @returns {string}
 */
export function applyNarrationPauses(input) {
  let t = String(input == null ? '' : input);
  if (!t.trim()) return t;
  if ((process.env.LEO_READING_PAUSES || '1') === '0') return t;

  // Split into paragraph blocks on blank lines so we can weight paragraph ends.
  const blocks = t.split(/\n{2,}/);
  const shaped = blocks.map((block) => {
    // Within a block, ensure every non-empty line ends on sentence punctuation so
    // line breaks (and section ends) get a clean breath.
    const lines = block.split(/\n/).map((line) => {
      const s = line.trim();
      if (!s) return s;
      // If the line already ends in sentence-final punctuation (allowing a closing
      // quote/bracket), leave it; otherwise add a period for a sentence pause.
      if (/[.!?:;,'")\]]$/.test(s)) return s;
      return s + '.';
    });
    return lines.join('\n');
  });

  // Join paragraphs with a slightly longer spoken beat. An ellipsis (read as a
  // trailing-off pause by the neural voices) on its own line gives the paragraph
  // boundary more air than a plain sentence break, without sounding stuttery.
  t = shaped.join('\n…\n');

  return t.trim();
}

/**
 * Synthesize ONE block of text to RAW PCM (s16le, 24kHz, mono) via edge-tts.
 * Returns null on failure (never throws into the read loop).
 *
 * @param {string} text The EXACT words to speak.
 * @param {object} [opts]
 * @param {string} [opts.voice] Override the resolved reading voice for this call.
 * @param {number} [opts.timeoutMs=60000] Hard timeout for the synth pipeline.
 * @returns {Promise<Buffer|null>}
 */
export function synthesizeReadingPcm(text, { voice, timeoutMs = 60000 } = {}) {
  // Sanitize FIRST (strip symbols/markdown/ShortNames), THEN shape narration
  // pauses so the read-aloud breathes at sentence/paragraph ends.
  const sanitized = cleanForSpeech(String(text || '')).trim();
  const raw = applyNarrationPauses(sanitized).trim();
  if (!raw) { console.warn('[Leo/EdgeTTS] synthesizeReadingPcm called with empty text — skipped.'); return Promise.resolve(null); }
  const chosen = (voice && String(voice).trim()) || getReadingVoice();
  // Narration prosody (rate/pitch/volume) — the controls the FREE edge-tts CLI
  // reliably honors. See NARRATION_DEFAULTS / getNarrationProfile() for env knobs.
  const prosody = getNarrationProfile();

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; resolve(val); };

    let edge, ff;
    try {
      // edge-tts writes MP3 to stdout when --write-media is omitted and we read pipe.
      // --rate/--pitch/--volume are the prosody controls the free CLI honors.
      edge = spawn('edge-tts', [
        '--voice', chosen,
        '--rate', prosody.rate,
        '--pitch', prosody.pitch,
        '--volume', prosody.volume,
        '--text', raw,
      ], { windowsHide: true });
      // Decode MP3 -> s16le 24k mono so it matches playTtsPcm()'s expected input.
      ff = spawn(ffmpegPath, [
        '-i', 'pipe:0',
        '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1',
      ], { windowsHide: true });
    } catch (e) {
      console.error('[Leo/EdgeTTS] spawn failed:', e?.message || e);
      done(null);
      return;
    }

    const chunks = [];
    const timer = setTimeout(() => {
      console.error('[Leo/EdgeTTS] synth timeout — killing pipeline.');
      try { edge.kill('SIGKILL'); } catch (_) {}
      try { ff.kill('SIGKILL'); } catch (_) {}
      done(null);
    }, timeoutMs);

    edge.on('error', (e) => { console.error('[Leo/EdgeTTS] edge-tts error:', e?.message || e); });
    edge.stderr.on('data', () => {}); // edge-tts prints progress to stderr — ignore
    ff.on('error', (e) => { console.error('[Leo/EdgeTTS] ffmpeg error:', e?.message || e); });
    ff.stdin.on('error', (e) => { if (e?.code === 'EPIPE') return; });

    edge.stdout.on('error', () => {});
    edge.stdout.pipe(ff.stdin);

    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('close', () => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (!pcm || pcm.length < 2) {
        console.error('[Leo/EdgeTTS] No audio produced for voice "' + chosen + '".');
        done(null);
        return;
      }
      done(pcm);
    });
  });
}

/**
 * List available edge-tts voices by running 'edge-tts --list-voices' and parsing
 * its table. Returns an array of { shortName, gender, locale }.
 * @param {object} [opts]
 * @param {string} [opts.localePrefix='en-'] Filter to locales starting with this. Pass '' for ALL.
 * @returns {Promise<Array<{shortName:string,gender:string,locale:string}>>}
 */
export function listVoices({ localePrefix = 'en-' } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('edge-tts', ['--list-voices'], { windowsHide: true });
    } catch (e) {
      console.error('[Leo/EdgeTTS] list-voices spawn failed:', e?.message || e);
      resolve([]);
      return;
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 30000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => { console.error('[Leo/EdgeTTS] list-voices error:', e?.message || e); });
    proc.on('close', () => {
      clearTimeout(timer);
      const voices = parseVoiceTable(out);
      const filtered = localePrefix
        ? voices.filter(v => v.locale.toLowerCase().startsWith(localePrefix.toLowerCase()))
        : voices;
      resolve(filtered);
    });
  });
}

/**
 * Parse the whitespace-aligned table produced by 'edge-tts --list-voices'.
 * Columns: Name | Gender | (optionally ContentCategories / VoicePersonalities).
 * We only need ShortName + Gender; locale is derived from the ShortName prefix
 * (e.g. "en-GB-RyanNeural" -> locale "en-GB").
 */
function parseVoiceTable(text) {
  const lines = String(text || '').split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Name\b/i.test(trimmed)) continue;       // header row
    if (/^-{3,}/.test(trimmed)) continue;          // separator row
    // First whitespace-delimited token is the ShortName, second is Gender.
    const cols = trimmed.split(/\s{2,}|\t+/).map(c => c.trim()).filter(Boolean);
    const fallback = trimmed.split(/\s+/);
    const shortName = (cols[0] || fallback[0] || '').trim();
    const gender = (cols[1] || fallback[1] || '').trim();
    if (!shortName || !/Neural$/i.test(shortName)) continue;
    const parts = shortName.split('-');
    const locale = parts.length >= 2 ? parts[0] + '-' + parts[1] : shortName;
    result.push({ shortName, gender, locale });
  }
  return result;
}

/** Friendly locale name for display (e.g. "en-GB" -> "British"). */
const LOCALE_LABELS = {
  'en-GB': 'British', 'en-US': 'American', 'en-AU': 'Australian',
  'en-CA': 'Canadian', 'en-IE': 'Irish', 'en-IN': 'Indian',
  'en-NZ': 'New Zealand', 'en-ZA': 'South African', 'en-HK': 'Hong Kong',
  'en-SG': 'Singaporean', 'en-KE': 'Kenyan', 'en-NG': 'Nigerian',
  'en-PH': 'Philippine', 'en-TZ': 'Tanzanian',
};

/**
 * Known edge-tts English voice first-names -> gender word, so the SPOKEN form can
 * say "Ryan, a British male voice". (The ShortName itself does not encode gender;
 * this is a best-effort lookup. Unknown names just omit the gender word.)
 */
const VOICE_NAME_GENDER = {
  // Male
  Ryan: 'male', Thomas: 'male', Alfie: 'male', Elliot: 'male', Ethan: 'male',
  Noah: 'male', Oliver: 'male', Guy: 'male', Eric: 'male', Christopher: 'male',
  Brian: 'male', Andrew: 'male', Roger: 'male', Steffan: 'male', William: 'male',
  Liam: 'male', Connor: 'male', Duncan: 'male', Prabhat: 'male', James: 'male',
  Luke: 'male', Mitchell: 'male', Neerja: 'male',
  // Female
  Sonia: 'female', Libby: 'female', Maisie: 'female', Olivia: 'female',
  Hollie: 'female', Ada: 'female', Bella: 'female', Abbi: 'female',
  Aria: 'female', Ana: 'female', Jenny: 'female', Michelle: 'female',
  Emma: 'female', Ava: 'female', Nancy: 'female', Jane: 'female',
  Sara: 'female', Natasha: 'female', Clara: 'female', Emily: 'female',
  Yan: 'female', Molly: 'female', Asilia: 'female', Ezinne: 'female',
  Imani: 'female', Leah: 'female', Luna: 'female', Rosa: 'female',
};

/** Human label for a voice row, e.g. "en-GB-RyanNeural (Male, British)". */
export function describeVoice(v) {
  const accent = LOCALE_LABELS[v.locale] || v.locale;
  const gender = v.gender || 'Unknown';
  return v.shortName + ' (' + gender + ', ' + accent + ')';
}

/** Natural-language gender words -> edge-tts Gender value. */
const GENDER_WORDS = {
  male: 'Male', man: 'Male', men: 'Male', guy: 'Male', boy: 'Male', he: 'Male', his: 'Male', dude: 'Male', gentleman: 'Male',
  female: 'Female', woman: 'Female', women: 'Female', lady: 'Female', girl: 'Female', she: 'Female', her: 'Female', gal: 'Female',
};

/** Natural-language accent/region words -> English locale code. Multi-word keys checked first. */
const REGION_WORDS = {
  'south african': 'en-ZA', 'new zealand': 'en-NZ',
  british: 'en-GB', england: 'en-GB', english: 'en-GB', uk: 'en-GB', gb: 'en-GB', brit: 'en-GB', scottish: 'en-GB', welsh: 'en-GB',
  american: 'en-US', america: 'en-US', us: 'en-US', usa: 'en-US', yank: 'en-US',
  australian: 'en-AU', aussie: 'en-AU', australia: 'en-AU', au: 'en-AU',
  irish: 'en-IE', ireland: 'en-IE', ie: 'en-IE',
  canadian: 'en-CA', canada: 'en-CA', ca: 'en-CA',
  indian: 'en-IN', india: 'en-IN', in: 'en-IN',
  za: 'en-ZA', kiwi: 'en-NZ', nz: 'en-NZ',
  nigerian: 'en-NG', kenyan: 'en-KE', singaporean: 'en-SG', philippine: 'en-PH', filipino: 'en-PH',
};

/**
 * Parse a free-text voice query into combinable filters. Gender AND region both
 * apply. Returns the locale prefix to fetch with and a predicate to filter rows.
 *
 * Examples:
 *   "male british"       -> { gender:'Male', locale:'en-GB', label:'Male, British' }
 *   "female american"    -> { gender:'Female', locale:'en-US', label:'Female, American' }
 *   "aussie voices"      -> { gender:null, locale:'en-AU', label:'Australian' }
 *   "all" / ""           -> { gender:null, locale:null, prefix:'' (all English or all) }
 *
 * @param {string} query
 * @returns {{gender:(string|null), locale:(string|null), prefix:string, label:string, all:boolean}}
 */
export function parseVoiceQuery(query) {
  const q = ' ' + String(query || '').toLowerCase().trim() + ' ';
  // Explicit "all" / "all voices" -> every locale.
  if (/^\s*(all|everything|any)\s*$/.test(q)) {
    return { gender: null, locale: null, prefix: '', label: 'all', all: true };
  }
  // Direct locale code (e.g. "en-au", "en-GB").
  const codeM = q.match(/\b(en-[a-z]{2})\b/i);

  let gender = null;
  for (const [word, val] of Object.entries(GENDER_WORDS)) {
    if (new RegExp('\\b' + word + '\\b').test(q)) { gender = val; break; }
  }

  let locale = codeM ? ('en-' + codeM[1].slice(3).toUpperCase()) : null;
  if (!locale) {
    // Multi-word region phrases first so "south african" beats "africa"/none.
    for (const word of ['south african', 'new zealand']) {
      if (q.includes(' ' + word + ' ') || q.includes(word)) { locale = REGION_WORDS[word]; break; }
    }
    if (!locale) {
      for (const [word, code] of Object.entries(REGION_WORDS)) {
        if (word.includes(' ')) continue;
        if (new RegExp('\\b' + word + '\\b').test(q)) { locale = code; break; }
      }
    }
  }

  // Label echoes the active filter for the page footer.
  const parts = [];
  if (gender) parts.push(gender);
  if (locale) parts.push(LOCALE_LABELS[locale] || locale);
  const label = parts.length ? parts.join(', ') : 'en-*';

  // If a specific region is requested we fetch that locale; otherwise all English.
  const prefix = locale ? locale : 'en-';
  return { gender, locale, prefix, label, all: false };
}

/**
 * Validate a requested voice ShortName against the live edge-tts voice list.
 * @param {string} requested
 * @returns {Promise<{valid:boolean, match:string|null, suggestions:string[]}>}
 */
export async function validateVoice(requested) {
  const want = String(requested || '').trim();
  if (!want) return { valid: false, match: null, suggestions: [] };
  // Validate against ALL voices (a user might pick a non-English voice on purpose).
  const all = await listVoices({ localePrefix: '' });
  const exact = all.find(v => v.shortName.toLowerCase() === want.toLowerCase());
  if (exact) return { valid: true, match: exact.shortName, suggestions: [] };
  // Closest matches: substring, then prefix of the locale, then anything similar.
  const lower = want.toLowerCase();
  const scored = all
    .map(v => {
      const sn = v.shortName.toLowerCase();
      let score = 0;
      if (sn.includes(lower)) score += 5;
      if (lower.includes(sn.replace('neural', ''))) score += 3;
      // shared leading characters
      let shared = 0;
      for (let i = 0; i < Math.min(sn.length, lower.length); i++) {
        if (sn[i] === lower[i]) shared++; else break;
      }
      score += shared / 4;
      return { v, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => s.v.shortName);
  return { valid: false, match: null, suggestions: scored };
}
