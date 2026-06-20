/**
 * gemini-live-bridge.mjs
 *
 * Real-time audio bridge using Gemini 2.5 Flash Native Audio Live.
 * Replaces the STT → LLM → TTS 3-step pipeline with a SINGLE bidirectional
 * audio WebSocket — dramatically lower latency.
 *
 * Architecture:
 *   Discord PCM audio → [this class] → Gemini Live → PCM audio → Discord voice
 *
 * Latency improvement:
 *   Old:  STT(Whisper ~800ms) + LLM(Groq ~400ms) + TTS(ElevenLabs ~600ms) = ~1800ms
 *   New:  Gemini Live streaming → first audio chunk back in ~400-600ms
 *
 * Requires: GEMINI_API_KEY environment variable
 * Model:    gemini-2.5-flash-native-audio-preview-12-2025
 */

import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';
import { webSearch } from './openjarvis.mjs';
// Codex lookup now lives in shared/codex.mjs so the WHOLE fleet can use it
// (re-exported here for backward compatibility).
import { consultCodex, getCodexSection, codexSectionCount, codex_search, codex_get_page, codex_get_section, codex_stats, codex_outline, searchDocs, readDocLines, listDocs } from './codex.mjs';
export { consultCodex };

// v1beta supports the latest 2026 live models
const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;

// SELF-HEALING MODEL LIST: Google rotates Live model names and our .env value
// keeps getting overwritten with dead ones. Instead of failing on a single bad
// name, the bridge tries the configured model first, then cycles through these
// known native-audio / Live candidates until one is accepted (no more silent voice).
// VERIFIED via ListModels on this account's key (2026-06): these are the ONLY
// models with bidiGenerateContent (live voice) access. No guessed names — every
// one here is confirmed available, so cycling can't dead-end on a 1008.
// PRIMARY comes from env GEMINI_LIVE_MODEL (stable native-audio default). The
// preview "flash-live" name is kept ONLY as a last-resort fallback so a session-
// expiry cascade can no longer leave Leo permanently stuck on the preview model.
const LIVE_MODEL_PRIMARY = process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-preview-09-2025";
const LIVE_MODEL_FALLBACKS = [
  LIVE_MODEL_PRIMARY,                                           // stable native-audio Live model (env-overridable). PRIMARY.
  "models/gemini-2.5-flash-native-audio-latest",               // native-audio fallback (connects; different turn-taking)
  "models/gemini-2.5-flash-native-audio-preview-12-2025",      // native-audio dated preview
  "models/gemini-2.5-flash-native-audio-preview-09-2025",      // native-audio dated preview
  "models/gemini-3.1-flash-live-preview",                      // "Flash Live" preview — LAST RESORT only (drifts/expires).
];

const DEFAULT_GEMINI_VOICES = {
  Leo: 'Charon',
  Gemini: 'Aoede',
  Claudey: 'Kore',
  Groq: 'Puck',
  X: 'Fenrir',
};

/** Resolve Gemini Live prebuilt voice name for any fleet bot. */
export function resolveGeminiVoice(botName = 'Leo') {
  const slug = botName.toUpperCase().replace(/[\s-]+/g, '_');
  const statePath = `c:/KAI/tools/oracle-discord/state/${botName.toLowerCase().replace(/\s+/g, '_')}_voice.json`;
  try {
    const v = JSON.parse(fs.readFileSync(statePath, 'utf8')).voice;
    if (v) return v;
  } catch (_) {}
  if (botName === 'Leo') {
    try {
      const v = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/leo_voice.json', 'utf8')).voice;
      if (v) return v;
    } catch (_) {}
  }
  return process.env[`GEMINI_VOICE_${slug}`]
    || (botName === 'Leo' ? process.env.LEO_VOICE : null)
    || DEFAULT_GEMINI_VOICES[botName]
    || 'Charon';
}

const LEO_INTERACTIVE_ETIQUETTE = `

[WHO IS BEING ADDRESSED — read the room before you speak]
- You hear EVERYTHING in the voice channel, including humans talking to EACH OTHER. Not every sentence is for you.
- SPEAK when: (1) YOUR name is used ("Leo", "hey Leo", "what do you think, Leo"), (2) the speaker is clearly continuing a conversation they're having WITH YOU (they were just talking to you and haven't turned away), or (3) you're alone in the room with one person — then everything is for you.
- STAY SILENT when humans are talking to each other: they use each other's names, answer each other's points, or discuss something without referencing you. Do NOT interject. Do NOT answer questions they asked each other.
- If a conversation that included you shifts to human-to-human, drop out gracefully and just listen. Rejoin only when re-addressed, or when someone asks the whole room a question and nobody answers ("anyone know...?" — that counts as you).
- WHEN IN DOUBT, STAY SILENT. Missing a line costs nothing; butting into someone else's conversation is annoying.
- If another AI is already speaking, wait your turn.

[GROUNDING — read, don't improvise. TOOLS BEFORE "I DON'T KNOW" — always.]
- IRONCLAD RULE: you are FORBIDDEN from saying "I don't know", "can't find it", or "no results" unless you ACTUALLY CALLED the relevant tool THIS TURN and it returned nothing. An "I don't know" without a tool call is a failure. Simple world questions (history, science, products, people, places) almost always have a web answer — search_web FIRST, then speak.
- Questions about KAI/RSHL/the system: NEVER answer from memory alone. Call consult_codex (and search_lattice) FIRST and base your answer on what comes back — read from the returned text, quoting it directly when asked. If the tools return nothing, say so plainly — and say that you checked.
- kai_status is ONLY for explicit questions about KAI — the AI being trained — BY SUBJECT: his scores, training, vitals, lattice/synapse counts, report card. When someone clearly asks about KAI, call it every time (the data is live; yesterday's numbers are wrong by definition). But do NOT call it for greetings or small talk: "how are you", "how's it going", "what's up", "you good?" are directed at YOU (Leo) — just answer as yourself, no tool. If it's ambiguous whether they mean you or KAI, ask, don't fire the tool.
- Questions about the world: search_lattice, then search_web. State facts from the results, not from vibes.
- If you didn't look it up and don't know it cold, don't assert it.
- ANNOUNCE TOOL USE — no dead air. The SECOND you call a tool that takes a beat (recall_memory, consult_oracle, search_web, search_lattice, codex_search/consult_codex, get_directions, find_place, kai_status, read_channel_feed, narrate), first say a SHORT, natural what-you're-doing line out loud — "hold up, lemme check that", "gimme a sec, pullin' it up", "lemme search that real quick", "checkin' my memory" — THEN call the tool and come back with the answer. Never go silent while a tool runs; the human shouldn't be left wondering if you froze.

[DELIVERY]
- Casual banter: short, energetic, 2-3 sentences. No formal openers.
- EXPLANATIONS ARE THE EXCEPTION: when someone asks you to explain, teach, walk through, or read from the Codex — IGNORE the length limit. Speak as long as the material needs, passage by passage, until the explanation is actually complete. Don't compress a requested deep-dive into two sentences.`;

const LIVE_TOOL_DECLARATIONS = [
  {
    name: "search_lattice",
    description: "Search the RSHL lattice memory for deep technical context, past conversations, or industrial data.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "The technical or social query to search for." }
      },
      required: ["query"]
    }
  },
  {
    name: "recall_memory",
    description: "Search your OWN episodic conversation memory — the real words people said to you and you said back, stored locally across ALL sessions (earlier today, yesterday, any time, even across restarts). Call this WHENEVER someone asks what they or you said before, what you talked about earlier, or to remember a past detail. This is your actual memory of conversations; NEVER say 'I don't remember' or 'I wasn't told that' without calling this first.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "What to recall — a topic, keyword, name, or phrase (e.g. 'the Titans paper', 'what Ryan said about the deadline')." }
      },
      required: ["query"]
    }
  },
  {
    name: "consult_codex",
    description: "Look up the KAI Codex — the complete ~280-page RSHL whitepaper (all 420+ sections fully searchable) — for authoritative answers about KAI's architecture, math, design doctrine, or roadmap. The newest facts (current version, latest changes) are in the dated SYSTEM STATE SUMMARY entries and surface first. Use this BEFORE making specific claims about KAI/RSHL internals, and trust what it returns over memory.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Topic or question to look up in the Codex (e.g. 'fractal state space', 'SpiralState b parameter', 'consolidation gates')." }
      },
      required: ["query"]
    }
  },
  {
    name: "search_web",
    description: "Search the live internet for current facts, news, numbers, or anything outside KAI's own memory. Use this when asked about the world and you are not certain of the answer.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "The web search query." }
      },
      required: ["query"]
    }
  },
  {
    name: "ask_google",
    description: "Ask Google's AI a real question and get a CURRENT, web-grounded answer WITH sources (live Google Search via Gemini). This is smarter and fresher than search_web — use it for any outside-world question that needs to be current or that you're not 100% sure of: news, prices, 'what is X', 'who won Y', 'is Z still true'. Ask it in plain natural language, like you would type into Google.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "The question in natural language, as you'd ask Google." }
      },
      required: ["query"]
    }
  },
  {
    name: "kai_status",
    description: "Get KAI's LIVE condition: lattice size, synapses, phi, hippocampus consolidation state, plus his learning-pipeline report card (curriculum level, tests taken/passed, recent quiz scores, weak areas). Call this ONLY when the user EXPLICITLY asks about KAI by subject — 'how is KAI', 'KAI's scores', 'how's the training going', 'his synapse count'. Do NOT call it for greetings or questions directed at you, Leo ('how are you', 'how's it going', 'what's up') — those are small talk, just answer as yourself. When unsure who they mean, ask instead of calling.",
    parameters: { type: "OBJECT", properties: {} }
  },
  {
    name: "read_codex_section",
    description: "Fetch one full section of The KAI Codex for out-loud narration, in order. Use when asked to READ or NARRATE the Codex (a page or two at a time). Pass 'next' to continue from where you left off, or a section number to jump.",
    parameters: {
      type: "OBJECT",
      properties: {
        section: { type: "STRING", description: "'next' to continue sequentially, or a section number like '42'." }
      },
      required: ["section"]
    }
  },
  {
    name: "narrate",
    description: "Read out something LARGE in your own words, section by section, hands-free — your CONTEXT SANDBOX. Use this whenever asked to read/walk through/go over something long: a Codex page or section, a long stretch of memory, or a big passage. It loads the whole thing, splits it into bite-size sections, and you read the FIRST one. When you finish, you AUTOMATICALLY continue to the next section on your own (you do NOT call any tool again) until it's done or you're interrupted. If interrupted, your place is saved so you can pick it back up. Prefer this over read_codex_section for anything more than a section or two.",
    parameters: {
      type: "OBJECT",
      properties: {
        source: { type: "STRING", description: "Where the content comes from: 'codex_page', 'codex_section', 'memory', 'text', or 'book' (KAIVERSE — the biographical book of how KAI was made)." },
        page: { type: "NUMBER", description: "Codex page number (when source='codex_page')." },
        id: { type: "STRING", description: "Codex section id/§-number (when source='codex_section')." },
        query: { type: "STRING", description: "What to pull from memory (when source='memory')." },
        text: { type: "STRING", description: "Raw text to read out (when source='text')." },
        chapter: { type: "STRING", description: "Which chapter of the book to read (a number or keyword) when source='book'; omit to start from the beginning." },
        title: { type: "STRING", description: "Optional short label for what you're reading (e.g. 'Codex p.12')." }
      },
      required: ["source"]
    }
  },
  {
    name: "resume_reading",
    description: "Pick back up a narration you were interrupted in the middle of — continues your context sandbox from where you left off (your last saved place). Use when the user says 'keep going', 'continue where you left off', 'finish reading that', or asks what you were reading.",
    parameters: { type: "OBJECT", properties: {} }
  },
  {
    name: "get_directions",
    description: "Get REAL directions between two places (live Google Routes API) — distance, travel time, and turn-by-turn steps. Use whenever asked how to get somewhere, how far it is, or how long it takes. Default is driving; pass mode for walking/cycling/transit. The full route is saved to your info sandbox. IMPORTANT — when you DON'T know where the user is starting from (e.g. they say 'take me home', 'navigate home', or 'I'm lost'), don't guess: ASK them to open Google Maps or their phone and read out their current location or coordinates (e.g. '42.97, -83.69'), then pass that as the origin. Endpoints accept an address, a place name, 'lat,lng', or a saved place ('home'/'work', which you resolve automatically). If someone is genuinely lost or in danger, tell them first to use their phone's GPS / share their location / call emergency services — don't rely on guesswork.",
    parameters: {
      type: "OBJECT",
      properties: {
        origin: { type: "STRING", description: "Start point — an address, place name, or 'lat,lng'." },
        destination: { type: "STRING", description: "Destination — an address, place name, or 'lat,lng'." },
        mode: { type: "STRING", description: "Travel mode: 'drive' (default), 'walk', 'bicycle', or 'transit'." }
      },
      required: ["origin", "destination"]
    }
  },
  {
    name: "find_place",
    description: "Find a REAL place by description (live Google Places API) — e.g. 'coffee near downtown Flint', 'a hardware store in Ann Arbor', 'the nearest pharmacy'. Returns names, addresses, ratings, and open/closed status.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "What to look for and roughly where (e.g. 'tacos near Detroit')." }
      },
      required: ["query"]
    }
  },
  {
    name: "reverse_geocode",
    description: "Turn coordinates the user reads off their phone / Google Maps (like '42.97, -83.69') into a REAL place — nearest street address + city. Use it to CONFIRM where someone is before routing ('okay, you're near Main & 5th in Flint') and then remember_fact 'last_location' with it. Pass the coordinates as 'lat,lng'.",
    parameters: {
      type: "OBJECT",
      properties: {
        coords: { type: "STRING", description: "Coordinates as 'lat,lng', e.g. '42.97, -83.69'." }
      },
      required: ["coords"]
    }
  },
  {
    name: "get_elevation",
    description: "How high above sea level a coordinate is — confirm 'I'm on a hill' / 'in a valley'. Pass 'lat,lng'.",
    parameters: { type: "OBJECT", properties: { coords: { type: "STRING", description: "'lat,lng'" } }, required: ["coords"] }
  },
  {
    name: "get_time_zone",
    description: "The time zone and current LOCAL time at a coordinate — use to know if it's day or night where the user is (helps decide what to ask, e.g. 'where's the sun?'), or to sanity-check their region. Pass 'lat,lng'.",
    parameters: { type: "OBJECT", properties: { coords: { type: "STRING", description: "'lat,lng'" } }, required: ["coords"] }
  },
  {
    name: "satellite_view",
    description: "Post a top-down SATELLITE image of a coordinate to the user's channel so they can LOOK and confirm where they are ('does this clearing with a lake to the north look right?'). Pass 'lat,lng' and optionally zoom (1-20, default 17). After calling it, ask them to look at the image you posted and tell you if it matches.",
    parameters: { type: "OBJECT", properties: { coords: { type: "STRING", description: "'lat,lng'" }, zoom: { type: "NUMBER", description: "1-20, higher = closer. Default 17." } }, required: ["coords"] }
  },
  {
    name: "street_view",
    description: "Post a GROUND-LEVEL street-view photo of a coordinate to the user's channel — the view from standing right there, great for 'is this what's around you?'. Pass 'lat,lng' and optionally heading (0-360, which way to face). Remote/forest spots have no imagery. After posting, ask them if it looks familiar.",
    parameters: { type: "OBJECT", properties: { coords: { type: "STRING", description: "'lat,lng'" }, heading: { type: "NUMBER", description: "0-360, optional camera direction" } }, required: ["coords"] }
  },
  {
    name: "aerial_view",
    description: "Get a cinematic 3D AERIAL flyover video of an ADDRESS (not raw coordinates — reverse_geocode first to get the address, or use their saved home). Posts a playable video link to their channel. It renders asynchronously, so the first time you may be told it's still rendering — let them know and ask again in a minute.",
    parameters: { type: "OBJECT", properties: { address: { type: "STRING", description: "A street address, e.g. '4501 Rainbow Lane, Flint, MI'" } }, required: ["address"] }
  },
  {
    name: "get_weather",
    description: "Current weather at a coordinate (live Google Weather API) — conditions, temperature, feels-like, humidity, wind. Use when asked 'what's the weather', or to corroborate where someone is ('is it raining where you are?'). Pass 'lat,lng'.",
    parameters: { type: "OBJECT", properties: { coords: { type: "STRING", description: "'lat,lng'" } }, required: ["coords"] }
  },
  {
    name: "validate_address",
    description: "Validate and clean up a street address (live Google Address Validation API) — returns the standardized, correctly-formatted version and whether it's complete. Use this on a HOME or WORK address the user gives you BEFORE you remember_fact it, so the saved address routes reliably. Pass the address as they said it.",
    parameters: { type: "OBJECT", properties: { address: { type: "STRING", description: "The address as the user gave it" } }, required: ["address"] }
  },
  {
    name: "get_current_time",
    description: "Tell the user the CURRENT date and time. Uses their SAVED timezone if you know it (save it with remember_fact 'timezone' once you learn it — e.g. from get_time_zone's timeZoneId); otherwise returns the system clock and you should ask their timezone. No coordinates needed. Use for 'what time is it' / 'what's today's date'.",
    parameters: { type: "OBJECT", properties: { timezone: { type: "STRING", description: "Optional IANA timezone like 'America/Detroit'. Omit to use the user's saved timezone." } }, required: [] }
  },
  {
    name: "recall_info",
    description: "Pull back something you looked up earlier this session from your INFO sandbox: 'directions' (the last route, full step list) or 'places' (last place search). Use when asked 'what were those directions again', 'read me all the steps', or 'what was that place'.",
    parameters: {
      type: "OBJECT",
      properties: {
        region: { type: "STRING", description: "'directions' or 'places'." }
      },
      required: ["region"]
    }
  },
  {
    name: "remember_fact",
    description: "Permanently remember a PERSONAL FACT the user states about themselves — home address, work address, a preference (favorite food/color/ice cream), birthday, a pet, a nickname. Use whenever they tell you something to keep: 'my home is 123 Main St', 'remember my favorite ice cream is mint', or 'I'm at home now' (store home if you have it). Saved under THEIR profile so you can use it later.",
    parameters: {
      type: "OBJECT",
      properties: {
        key: { type: "STRING", description: "What the fact is about: 'home', 'work', 'favorite_ice_cream', 'birthday', 'pet', 'nickname', etc. Aliases like 'my house' or 'where I live' map to 'home'." },
        value: { type: "STRING", description: "The fact value — the actual address, 'mint', 'June 3', etc." }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "recall_fact",
    description: "Look up a PERSONAL FACT you previously stored about the user (their home/work address, a preference) so you can use it. When they say 'take me home' / 'navigate home', recall 'home' to get the address. Returns the stored value, or nothing if you don't know it yet — in which case ASK them and then remember_fact it.",
    parameters: {
      type: "OBJECT",
      properties: {
        key: { type: "STRING", description: "Which fact to recall: 'home', 'work', 'favorite_ice_cream', etc." }
      },
      required: ["key"]
    }
  },
  {
    name: "codex_search",
    description: "EXACT full-text search of the ENTIRE KAI Codex — every page, line, and symbol. Returns the precise matching passages with their section title and page number. Use this (NOT consult_codex) whenever you need a VERIFIABLE, word-for-word answer about KAI/RSHL — versions, exact numbers, specific terms, definitions, quotes. This is the source of truth; trust it over your memory and never guess when you can search.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Exact phrase or term to find verbatim in the Codex (e.g. 'v9.2.0', 'Fibonacci Torsion', 'Born rule', 'curriculum level')." }
      },
      required: ["query"]
    }
  },
  {
    name: "codex_get_page",
    description: "Fetch one full PAGE of the KAI Codex verbatim by page number (the Codex is ~283 pages). Use to read exact content a page at a time, or to verify what's on a specific page.",
    parameters: {
      type: "OBJECT",
      properties: {
        page: { type: "NUMBER", description: "Page number (1 to ~283)." }
      },
      required: ["page"]
    }
  },
  {
    name: "codex_outline",
    description: "Get the LIVE table of contents of the KAI Codex — every real section heading with its §-number and page, built fresh from the document (NOT the stale embedded ToC). ALWAYS use this to see what sections actually exist before saying something isn't in the Codex. The Codex has §1–§26+ plus §14.x blocks and dated SYSTEM STATE entries.",
    parameters: { type: "OBJECT", properties: {} }
  },
  {
    name: "codex_section",
    description: "Fetch a specific Codex section by its identifier: a §-number ('24.4', '14.44', '26.1'), a RANGE ('24 through 24.4'), a page ('page 261'), or a title keyword. Returns the exact text tagged with its real §-number and page. Use this (not consult_codex) when someone names a specific section or asks 'what does section X say'.",
    parameters: {
      type: "OBJECT",
      properties: {
        id: { type: "STRING", description: "Section number, range, 'page N', or title keyword (e.g. '24.4', 'section 24 through 24.4', 'page 261', 'Born rule')." }
      },
      required: ["id"]
    }
  },
  {
    name: "search_docs",
    description: "Grep-style FULL-TEXT search across project documents — returns every matching LINE with its line number and ±2 lines of context. Works on the KAI Codex (the canonical whitepaper) AND any other doc (the SRHT_* papers, READMEs, notes). Use this to FIND where something is written when you need a line address to then READ — call this first, then read_doc_lines on the hit. If you give a 'file' it searches just that doc; leave it out to sweep the main docs. (The Codex IS the whitepaper — they are one document, not two.) Supports plain text or a /regex/ pattern; case-insensitive.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Text or /regex/ to find verbatim across docs (e.g. 'Fibonacci Torsion', '/v9\\.\\d+/')." },
        file: { type: "STRING", description: "Optional doc name or path to search (e.g. 'The KAI Codex.md', 'SRHT_paper.md'). Omit to search the main project docs." }
      },
      required: ["query"]
    }
  },
  {
    name: "read_doc_lines",
    description: "Read a SPECIFIC line range of a document (1-based, inclusive), returning the numbered lines — like opening a file to lines N..M instead of dumping the whole thing. Use after search_docs gives you a line number: read around that line to get the full passage. Capped at ~200 lines per call. Works on the Codex and any allowed .md/.txt doc.",
    parameters: {
      type: "OBJECT",
      properties: {
        file: { type: "STRING", description: "Doc name or path (e.g. 'The KAI Codex.md')." },
        startLine: { type: "NUMBER", description: "First line to read (1-based)." },
        endLine: { type: "NUMBER", description: "Last line to read (inclusive)." }
      },
      required: ["file", "startLine", "endLine"]
    }
  },
  {
    name: "list_docs",
    description: "List the readable documents available to you (name, path, size) — the .md/.txt files under the project doc roots (the Codex, the SRHT papers, etc.). Use this to discover WHAT you can read before searching/reading a specific doc. (The Codex IS the whitepaper — the stale WHITEPAPER.md snapshot is intentionally not listed.)",
    parameters: { type: "OBJECT", properties: {} }
  },
  {
    name: "read_channel_feed",
    description: "Read the latest live messages from one of the ecosystem's Discord feeds. Feeds: 'training' (KAI's tutoring/quiz updates and grades), 'dreams' (KAI's dream/vitals stream), 'frequencies' (RF spectrum sensor posts), 'chat' (general chat), 'self_optimize' (system optimization/diagnostics), 'work' (industrial work channel + task threads), 'overall' (the main public chat). Use whenever asked what's happening in a channel, how training/dreams/sensors are going right now, or what the system has been posting.",
    parameters: {
      type: "OBJECT",
      properties: {
        feed: { type: "STRING", description: "One of: training, dreams, frequencies, chat, self_optimize, work, overall" }
      },
      required: ["feed"]
    }
  },
  {
    name: "discord_soundboard",
    description: "Drop a sound effect into the voice channel as a reaction. TIMING IS AUTOMATIC — the effect is held and played in the beat right AFTER your current spoken line finishes, so just say your line and call this; do NOT try to time it yourself and do NOT pause for it. Pick the effect that fits the MOMENT: 'rimshot' after YOUR OWN joke/pun; 'sad horn' after a fail/letdown/bad news; 'crickets' after an awkward silence or a joke that flops; 'applause' for a genuine win or someone nailing something; 'airhorn' only for real hype/celebration; 'drumroll' before a reveal. USE SPARINGLY — at most one per reply, and only when there's a real comedic or reaction beat to earn it. No sound is better than a wrong or random one; if nothing fits, don't call this. Pass the effect name.",
    parameters: {
      type: "OBJECT",
      properties: {
        effect: { type: "STRING", description: "The sound effect name to play (e.g. 'airhorn', 'crickets', 'drumroll')." }
      },
      required: ["effect"]
    }
  },
  {
    name: "consult_oracle",
    description: "Ask Oracle for help when you don't know something or need real work done. Oracle coordinates the work fleet — Analyst (logs, forensics, system health, vitals), Researcher (live web + deep research), Kai Coder (code/build questions) — and brings back the REAL answer. Use this INSTEAD of guessing or making something up: ask, then WAIT for the answer, then tell the user what Oracle found. Say a short natural line first ('gimme a sec, asking Oracle') so there's no dead air.",
    parameters: {
      type: "OBJECT",
      properties: {
        question: { type: "STRING", description: "The question or task to hand to Oracle and the work fleet." }
      },
      required: ["question"]
    }
  },
  {
    name: "request_code_change",
    description: "Propose a code or configuration change. This does NOT apply anything — it sends the proposal to the owner's DMs for explicit approval first. Use whenever you or the user wants to change, fix, or add code/settings/behavior. Describe the change clearly, then tell the user you've sent it to their DMs to approve.",
    parameters: {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING", description: "Short one-line title of the proposed change." },
        details: { type: "STRING", description: "What to change and why — the file(s) or behavior involved and the reason. Be specific." }
      },
      required: ["summary", "details"]
    }
  },
  {
    name: "calculate",
    description: "Compute any arithmetic, algebra, unit conversion, percentage, or date math EXACTLY. ALWAYS use this for ANY number — never do math in your head (you get it wrong). Returns the precise result.",
    parameters: {
      type: "OBJECT",
      properties: {
        expression: { type: "STRING", description: "The expression to compute, e.g. '12.5% of 840', 'sqrt(2)*3', '45 miles in km', '2025-1987', '(3/8)*256'." }
      },
      required: ["expression"]
    }
  },
  {
    name: "simulate_emergence",
    description: "Run KAI's SRHT emergence simulation and report Φ (emergence), stability, contradiction pressure, commit-readiness, memory-reinforcement weight and replay priority. Use when asked to simulate KAI's emergence/consciousness math or analyze a cell's dynamics — don't estimate it, run it.",
    parameters: {
      type: "OBJECT",
      properties: {
        rho: { type: "NUMBER", description: "Resonance density ρ (0-1)." },
        r:   { type: "NUMBER", description: "Reinforcement R (0-1)." },
        chi: { type: "NUMBER", description: "Contradiction χ (0-1)." },
        g:   { type: "NUMBER", description: "Goal alignment g (0-1)." },
        tau: { type: "NUMBER", description: "Time/commit factor τ (0-1)." },
        ageDays: { type: "NUMBER", description: "Age of the memory in days." },
        u:   { type: "NUMBER", description: "Uncertainty u (0-1)." }
      },
      required: ["rho", "r", "chi", "g"]
    }
  }
];

export function reloadEnv() {
  try {
    const envPath = 'c:/KAI/tools/oracle-discord/.env';
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let val = trimmed.slice(index + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (_) {}
}

/**
 * A WebSocket bridge that connects Discord PCM audio streams directly to the Gemini 2.5 Flash Native Audio API.
 * 
 * This class handles the initialization, bidirectional PCM streaming, tool call interceptions,
 * and graceful fallback mechanisms for model endpoint rotation.
 *
 * @class GeminiLiveBridge
 */
export class GeminiLiveBridge {
  /**
   * Initializes the WebSocket bridge for Gemini Live Native Audio.
   * @param {string} apiKey - The Gemini API key used to authenticate the WebSocket connection.
   */
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.isReady = false;
    this.isActive  = false;
    this.audioChunks = []; // Buffer incoming audio deltas

    /** @type {((chunk: Buffer) => void) | null} Callback fired when a PCM audio chunk is received from Gemini. */
    this.onAudioChunk   = null; 
    /** @type {((text: string) => void) | null} Callback fired when Gemini provides a transcript of its own spoken output. */
    this.onTranscript   = null; 
    /** @type {((text: string) => void) | null} Callback fired when Gemini provides a transcript of the user's spoken input. */
    this.onInputTranscript = null;
    /** @type {(() => void) | null} Callback fired when Gemini indicates the current conversational turn is complete. */
    this.onTurnComplete = null; 
    /** @type {((name: string, args: object) => void) | null} Callback fired when Gemini attempts to execute a function call. */
    this.onToolCall     = null;
    /** @type {((error: Error) => void) | null} Callback fired when a WebSocket or parsing error occurs. */
    this.onError        = null;

    this.pingInterval   = null;
    this._modelIdx      = null; // null = use the configured GEMINI_LIVE_MODEL; >=0 = a fallback
  }

  /**
   * Which Live model to attempt right now. Tries the configured env model first;
   * after a 1008 "model not found/supported" close we advance through the
   * known-good fallbacks until one connects. This makes voice self-healing — a
   * bad/overwritten GEMINI_LIVE_MODEL can no longer permanently break Leo.
   */
  _currentLiveModel() {
    if (this._modelIdx == null) {
      return process.env.GEMINI_LIVE_MODEL || LIVE_MODEL_FALLBACKS[0];
    }
    return LIVE_MODEL_FALLBACKS[Math.min(this._modelIdx, LIVE_MODEL_FALLBACKS.length - 1)];
  }

  /**
   * Connect to Gemini Live and configure the session for Leo's personality.
   *
   * @param {string} systemInstruction - The persona and context instructions for the model.
   * @param {string} [userName="the user"] - The name of the user interacting with the model.
   * @param {object} [options={}] - Additional connection options.
   * @param {string} [options.botName='Leo'] - The name of the bot connecting to the model.
   * @param {string} [options.mode='interactive'] - The interaction mode.
   * @param {boolean} [options.enableTools=true] - Whether to enable tool/function calling.
   * @returns {Promise<void>} Resolves when the connection and initial setup are successful.
   */
  async connect(systemInstruction, userName = "the user", options = {}) {
    reloadEnv();
    if (this.ws) this.disconnect();

    const botName = options.botName || 'Leo';
    const mode = options.mode || 'interactive';
    const enableTools = options.enableTools !== false;
    this._connectOptions = { botName, mode, enableTools };
    this._isInteractive = (mode === 'interactive'); // VAD on → safe to send silent keepalive

    // Remember session config so an unexpected close can auto-reconnect
    // with the same personality and callbacks intact.
    this._lastSystemInstruction = systemInstruction;
    this._lastUserName = userName;
    this._lastConnectOptions = this._connectOptions;
    this._userClosed = false;

    const url = `${GEMINI_LIVE_URL}?key=${this.apiKey}`;
    this.ws = new WebSocket(url);
    this.isReady = false;
    this.isActive = true;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Gemini Live connection timeout (5s)'));
        this.disconnect();
      }, 5000);

      this.ws.on('open', async () => {
        clearTimeout(timeout);
        console.log(`[GeminiLive] WebSocket connected for ${userName} (Gemini 2.5 Native Audio Live)`);

        // KEEP-ALIVE. Gemini Live aborts an IDLE session (1008 "The operation was
        // aborted") if no realtime AUDIO flows for ~30-45s — and a raw ws.ping is
        // NOT enough, the server wants actual input. During silence Leo gates his
        // mic and sends nothing, so the session went idle and got force-closed,
        // then reconnected, over and over (the disconnect loop). Fix: when no real
        // audio has been sent for a few seconds, feed tiny SILENT PCM frames. They
        // register as activity but never trip the VAD, so the session stays alive
        // without Leo hearing phantom speech. Raw ws.ping still runs for TCP.
        if (this.pingInterval) clearInterval(this.pingInterval);
        this._lastAudioSentTs = Date.now();
        let _kaTick = 0;
        this.pingInterval = setInterval(() => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          try {
            if ((++_kaTick % 3) === 0) this.ws.ping(); // TCP keepalive ~every 15s
            // Application-level activity keepalive — now for ALL modes, not just
            // interactive. The social/outbound bots (Claudey, Gemini, X, Groq) send
            // nothing while idle, so Gemini aborted them (1008 "operation aborted")
            // every ~minute → constant reconnect churn. A silent frame keeps them
            // alive. CRITICAL: only feed silence during TRUE idle — never while the
            // bot is mid-turn or its audio is playing (during a turn it would look
            // like a barge-in and cut the reply short).
            // Also treat an active sandbox narration as "busy": the read-ladder has
            // a ~15s "waiting for your reply" pause where _playing is false, and
            // injecting a silent frame there looked like a barge-in and broke the
            // narration on native-audio fallback models.
            const botBusy = this._playing || this._modelTurnActive || !!this._sandboxSessionId;
            if (this.isReady && !botBusy &&
                (Date.now() - (this._lastAudioSentTs || 0)) > 8000) {
              this._sendSilenceKeepalive();
            }
          } catch (_) {}
        }, 5000);

        let recentContextStr = "";
        if (this._reconnectAttempts > 0) {
          try {
            const { getRecentContext } = await import('./transcript-memory.mjs');
            const recent = getRecentContext(15, this._transcriptChannelId || null);
            if (recent && recent.length > 0) {
              // recent is an array of row OBJECTS — joining directly gave "[object
              // Object]". Format each row, and it's now scoped to this channel.
              const _convo = recent.map(r => `${r.speaker}: ${String(r.content || '').replace(/\s+/g, ' ')}`).join('\n');
              recentContextStr = `\n\n[SYSTEM RECONNECT - RECENT CONVERSATION CONTEXT (Do NOT greet again, pick up seamlessly from the last message below)]\n${_convo}`;
            }
          } catch (e) {
            console.error('[GeminiLive] Failed to fetch reconnect context:', e);
          }
        }

        const fullSystemInstruction = mode === 'interactive'
          ? `${systemInstruction}${LEO_INTERACTIVE_ETIQUETTE}${recentContextStr}`
          : `${systemInstruction}${recentContextStr}`;

        const voiceName = resolveGeminiVoice(botName);
        const setupPayload = {
          model: this._currentLiveModel(),
          systemInstruction: {
            role: "system",
            parts: [{ text: fullSystemInstruction }]
          },
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
               voiceConfig: {
                 prebuiltVoiceConfig: { voiceName }
               }
            }
          },
          realtimeInputConfig: {
            // MANUAL VAD (LEO_MANUAL_VAD, defaults ON): for Leo's interactive
            // session we DISABLE Gemini's server-side auto VAD and drive activity
            // ourselves from Leo's local mic gate (signalActivityStart/End below).
            // Gemini's auto VAD was firing PHANTOM "user interrupted" events on
            // nearly every narration section even with the user muted and ZERO real
            // frames forwarded — halting generation server-side and truncating each
            // section mid-sentence. With auto VAD off, Gemini only "hears" the user
            // when our local gate passes REAL speech (we wrap it in activityStart/
            // activityEnd), so it can never phantom-interrupt a read, while a genuine
            // barge-in / "stop"/"go back" nav still reaches it. Revert: LEO_MANUAL_VAD=0.
            automaticActivityDetection: (mode === 'outbound' ||
                (mode === 'interactive' && process.env.LEO_MANUAL_VAD !== '0')) ? {
              disabled: true
            } : {
              disabled: false,
              // START sensitivity LOW — the fix for "Gemini interrupts Leo mid-
              // sentence with NO real mic input" (gate never opened, RMS≈10, yet a
              // phantom barge-in fires and ends his turn). HIGH/default was twitchy
              // enough that a tail of buffered audio, room noise, or the acoustic
              // bridge's bleed could trip it and chop Leo off — which also wrecked
              // the Grok conversation. LOW means it needs CLEAR, real speech to cut
              // him off, so he finishes his thoughts; a loud, genuine barge-in still
              // interrupts. Tune with LEO_VAD_START (HIGH/LOW).
              startOfSpeechSensitivity: (process.env.LEO_VAD_START || "LOW").toUpperCase() === "HIGH"
                ? "START_SENSITIVITY_HIGH" : "START_SENSITIVITY_LOW",
              // END sensitivity LOW + a longer silence window: HIGH/700ms was
              // concluding "you're done" on a mid-sentence breath, so a long
              // multi-sentence message got chopped into fragments Gemini never
              // cleanly answered (the "didn't reply to my paragraph" bug). LOW +
              // 1100ms lets a full thought stay ONE turn so it always gets a
              // reply. Costs ~0.4s of reply lag — worth it for reliable answers.
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 300,
              // How long a pause before Gemini decides you're done. This is the
              // single biggest lever on reply speed. 850ms + LOW end-sensitivity
              // is the sweet spot: fast replies without chopping a multi-sentence
              // thought. Lower = snappier but more risk of cutting you off; raise
              // if it ever clips you. Tune live with LEO_VAD_SILENCE_MS.
              silenceDurationMs: Number(process.env.LEO_VAD_SILENCE_MS) > 0 ? Number(process.env.LEO_VAD_SILENCE_MS) : 850
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // SESSION RESUMPTION — Gemini Live sessions have a HARD duration limit.
          // Enabling this makes Gemini hand us a resumption handle so a reconnect
          // resumes the SAME conversation (context preserved) instead of a blank
          // session. Fixes BOTH the "1008 GoAway" abort loop AND "his memory
          // doesn't go back far" — the session no longer wipes context every
          // ~10 minutes. If we have a handle from before, resume with it.
          sessionResumption: this._resumptionHandle ? { handle: this._resumptionHandle } : {}
        };

        if (enableTools) {
          setupPayload.tools = [{ functionDeclarations: LIVE_TOOL_DECLARATIONS }];
        }

        console.log(`[GeminiLive] Session setup: bot=${botName} mode=${mode} voice=${voiceName}`);
        this.ws.send(JSON.stringify({ setup: setupPayload }));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg, resolve);
        } catch (e) {
          console.error('[GeminiLive] Parse error:', e.message);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[GeminiLive] WebSocket error:', err.message);
        this.isReady = false;
        try { this.onError?.(err); } catch (_) {}
        reject(err);
      });

      // HANDSHAKE REJECTIONS (e.g. 521 "origin down" when Google's endpoint
      // is unreachable): ws routes non-101 responses through this event.
      // Without a listener the failure can surface as an UNCAUGHT exception
      // — it killed Leo's whole process on 2026-06-10. Handle it like a
      // connection error: log, reject, and let auto-reconnect retry.
      this.ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timeout);
        const msg = `Gemini Live handshake rejected: HTTP ${res?.statusCode || '?'} (endpoint down or blocked)`;
        console.error(`[GeminiLive] ${msg}`);
        this.isReady = false;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        try { res?.resume(); } catch (_) {}
        try { this.ws?.terminate(); } catch (_) {}
        reject(new Error(msg));
      });

      const sock = this.ws; // capture: ignore close events from replaced sockets
      this.ws.on('close', (code, reason) => {
        if (this.ws !== sock && this.ws !== null) {
          // A newer socket already replaced this one — stale close, ignore.
          return;
        }
        console.log(`[GeminiLive] Connection closed: ${code} ${reason}`);
        this.isReady = false;
        this.isActive = false;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        // AUTO-RECONNECT: Google sometimes drops live sessions mid-conversation
        // (e.g. 1008 "not implemented/supported", session time limits). The old
        // behavior left the bridge dead until the user rejoined the channel —
        // Leo just went silent. Now we rebuild the session in place: same
        // personality, same callbacks (they live on this instance).
        if (!this._userClosed && this._lastSystemInstruction) {
          // 1008 = the model name was rejected ("is not found ... bidiGenerateContent"
          // or "not supported"). Don't waste retries on a dead name — advance to the
          // next known-good Live model and try that, until one connects.
          const reasonStr = String(reason || '');
          const modelRejected = (code === 1008 || code === 1007) &&
            (/not\s+found|not\s+supported|bidiGenerateContent|unsupported|invalid/i.test(reasonStr) || reasonStr === '');
          if (modelRejected) {
            const nextIdx = (this._modelIdx == null ? 0 : this._modelIdx + 1);
            if (nextIdx < LIVE_MODEL_FALLBACKS.length) {
              this._modelIdx = nextIdx;
              this._reconnectAttempts = 0; // fresh budget for the new model
              const nextModel = LIVE_MODEL_FALLBACKS[nextIdx];
              console.warn(`[GeminiLive] Live model rejected (${code}): "${reasonStr || 'no reason'}". Trying next candidate → ${nextModel}`);
              setTimeout(() => {
                if (this._userClosed) return;
                this.connect(this._lastSystemInstruction, this._lastUserName, this._lastConnectOptions || {})
                  .then(() => console.log(`[GeminiLive] Voice online ✓ on ${this._currentLiveModel()} (${this._lastUserName})`))
                  .catch(e => console.warn(`[GeminiLive] Candidate failed: ${e.message}`));
              }, 800);
              return;
            }
            console.warn('[GeminiLive] Exhausted all candidate Live models — none accepted. Check GEMINI_LIVE_MODEL / API access.');
            return;
          }
          // CONNECTIVITY-AWARE RECONNECT. On a portable hotspot the link drops
          // mid-session; the old code burned all 3 retries in ~2s (all failing
          // because there's no internet) and gave up, leaving Leo dead even
          // after the connection came back. Now: if we're OFFLINE, don't waste
          // the budget — go dormant and rebuild the session automatically the
          // moment connectivity returns. Only count retries when we're online.
          import('./connectivity.mjs').then(({ isOnline, whenOnline }) => {
            if (!isOnline()) {
              console.warn('[GeminiLive] Offline — voice dormant; will rebuild automatically when the internet returns.');
              whenOnline().then(() => {
                if (this._userClosed) return;
                this._reconnectAttempts = 0; // fresh budget after the outage
                this.connect(this._lastSystemInstruction, this._lastUserName, this._lastConnectOptions || {})
                  .then(() => console.log(`[GeminiLive] 🟢 Back online — voice session restored (${this._lastUserName})`))
                  .catch(e => console.warn(`[GeminiLive] Post-outage reconnect failed: ${e.message}`));
              });
              return;
            }
            this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
            if (this._reconnectAttempts <= 3) {
              const delay = 1000 * this._reconnectAttempts;
              console.log(`[GeminiLive] Unexpected close (${code}). Rebuilding session in ${delay}ms (attempt ${this._reconnectAttempts}/3)...`);
              setTimeout(() => {
                if (this._userClosed) return; // user left in the meantime
                this.connect(this._lastSystemInstruction, this._lastUserName, this._lastConnectOptions || {})
                  .then(() => {
                    this._reconnectAttempts = 0;
                    console.log(`[GeminiLive] Session restored ✓ (${this._lastUserName})`);
                  })
                  .catch(e => console.warn(`[GeminiLive] Reconnect failed: ${e.message}`));
              }, delay);
            } else {
              // Out of quick retries while ONLINE — keep one slow watchdog so a
              // flaky link still recovers instead of going permanently silent.
              console.warn('[GeminiLive] 3 quick retries used — switching to slow 30s recovery polling.');
              setTimeout(() => {
                if (this._userClosed) return;
                this._reconnectAttempts = 0;
                this.connect(this._lastSystemInstruction, this._lastUserName, this._lastConnectOptions || {}).catch(() => {});
              }, 30_000);
            }
          }).catch(() => {
            // connectivity module unavailable — fall back to the plain bounded retry
            this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
            if (this._reconnectAttempts <= 3) {
              setTimeout(() => {
                if (this._userClosed) return;
                this.connect(this._lastSystemInstruction, this._lastUserName, this._lastConnectOptions || {})
                  .then(() => { this._reconnectAttempts = 0; })
                  .catch(() => {});
              }, 1000 * this._reconnectAttempts);
            }
          });
        }
      });
    });
  }

  _handleMessage(msg, connectResolve = null) {
    // Session ready signal
    if (msg.setupComplete || msg.setup_complete) {
      console.log('[GeminiLive] Session ready ✓');
      this.isReady = true;
      // SELF-HEAL the model choice. _modelIdx only ever INCREMENTS on a model
      // rejection (line ~603) and never resets, so once the primary preview Live
      // model gets throttled/retired we get stuck on a native-audio FALLBACK whose
      // different turn-taking stalls the sandbox read-ladder ("worked at 11pm,
      // broke overnight"). Once THIS session proves stable (45s), clear the index
      // so the NEXT reconnect retries the primary model again.
      if (this._modelIdx != null) {
        clearTimeout(this._modelResetTimer);
        this._modelResetTimer = setTimeout(() => {
          if (this.isReady) {
            console.log(`[GeminiLive] Stable on fallback #${this._modelIdx}; retrying the primary Live model on next reconnect.`);
            this._modelIdx = null;
          }
        }, 45000);
      }
      connectResolve?.();
      return;
    }

    // ── SESSION RESUMPTION HANDLE ──────────────────────────────────────────
    // Gemini periodically sends a fresh handle. Stash the latest one so the
    // next (re)connect can RESUME this conversation instead of starting blank.
    const resumption = msg.sessionResumptionUpdate || msg.session_resumption_update;
    if (resumption && (resumption.newHandle || resumption.new_handle) && (resumption.resumable !== false)) {
      this._resumptionHandle = resumption.newHandle || resumption.new_handle;
    }

    // ── GO-AWAY (session duration limit approaching) ───────────────────────
    // Gemini warns us BEFORE it force-closes. Close cleanly NOW and let the
    // close handler reconnect WITH the resumption handle — context preserved,
    // and we avoid the "1008 ... failed to close after GoAway" abort loop.
    const goAway = msg.goAway || msg.go_away;
    if (goAway) {
      console.log(`[GeminiLive] GoAway — session limit approaching (${goAway.timeLeft || goAway.time_left || '?'} left). Closing now to reconnect cleanly with context preserved.`);
      try { this.ws?.close(1000, 'goaway-graceful'); } catch (_) {}
      return;
    }

    const serverContent = msg.serverContent || msg.server_content;

    // Tool calling logic
    const toolCall = msg.toolCall || msg.tool_call || serverContent?.toolCall || serverContent?.tool_call;
    if (toolCall) {
      this._handleToolCall(toolCall);
    }

    // Incoming audio delta from Gemini
    const modelTurn = serverContent?.modelTurn || serverContent?.model_turn;
    const inputTranscription = serverContent?.inputTranscription || serverContent?.input_transcription;
    if (inputTranscription?.text) {
      const txt = inputTranscription.text;
      // FORWARD ALL non-empty chunks. Gemini streams the USER's words in tiny
      // pieces (often < 8 chars: "Hel", "lo", " the"). The old per-chunk
      // `length >= 8` filter dropped those building blocks, so the user's line
      // never accumulated and never got logged — while Leo's OUTPUT transcript
      // (no filter, below) always did. THAT is why "his words are there, mine
      // aren't." Noise/VAD filtering now happens downstream on the FULL
      // accumulated utterance (flushInputTranscript in leo.mjs), which is the
      // correct place to judge "is this a real sentence or a mic pop."
      if (txt && /[a-z0-9]/i.test(txt)) {
        this.onInputTranscript?.(txt);
      }
    }

    const outputTranscription = serverContent?.outputTranscription || serverContent?.output_transcription;
    if (outputTranscription?.text) {
      this.onTranscript?.(outputTranscription.text);
    }

    if (modelTurn?.parts) {
      this._modelTurnActive = true; // Leo is generating — keepalive must stay quiet
      if (!this._turnAudioStartTs) this._turnAudioStartTs = Date.now(); // forensic: when his speech began
      this._lastAudioSentTs = Date.now(); // his OUTPUT counts as activity, so the
      // idle keepalive clock only starts AFTER he's fully done (won't clip his tail)
      for (const part of modelTurn.parts) {
        const inlineData = part.inlineData || part.inline_data;
        const mimeType = inlineData?.mimeType || inlineData?.mime_type;
        if (mimeType?.startsWith('audio/')) {
          this.audioChunks.push(inlineData.data);
          this.onAudioChunk?.(inlineData.data, mimeType); // Streaming delivery (rate in mimeType)
        }
        // FIX: skip Gemini's internal "thinking" parts (part.thought) — they
        // were leaking the model's reasoning monologue into the transcript
        // channel alongside what Leo actually said out loud.
        if (part.text && !part.thought) {
          this.onTranscript?.(part.text);
        }
        const functionCall = part.functionCall || part.call;
        if (functionCall) {
           this._handleToolCall(functionCall);
        }
      }
    }

    // Turn complete — Gemini stopped speaking
    if (serverContent?.turnComplete || serverContent?.turn_complete) {
      // FORENSIC: how long did he actually speak? A very SHORT turn = Gemini ended
      // ITSELF early (model truncation) — that's a cut-off with NO mic involvement,
      // and it looks identical to a "random cutoff" even when you're muted.
      const turnMs = this._turnAudioStartTs ? (Date.now() - this._turnAudioStartTs) : -1;
      const short = turnMs >= 0 && turnMs < 1500;
      console.log(`[GeminiLive] Turn complete after ${turnMs}ms of speech${short ? '  ⚠️ SHORT — likely Gemini ENDED ITS OWN TURN early (model-side truncation, NOT a mic interrupt)' : ''}.`);
      this._turnAudioStartTs = 0;
      this._modelTurnActive = false; // turn done — keepalive may resume during idle
      this.onTurnComplete?.();
      this.audioChunks = [];
    }

    // Interrupted turn (VAD detected user speaking)
    if (serverContent?.interrupted) {
      const turnMs = this._turnAudioStartTs ? (Date.now() - this._turnAudioStartTs) : -1;
      console.log(`[GeminiLive] Gemini interrupted by user speech (after ${turnMs}ms of speech) — VAD path; leo.mjs decides honor vs phantom.`);
      this._turnAudioStartTs = 0;
      this._modelTurnActive = false;
      this.audioChunks = [];
      this.onInterrupted?.(); // let the bot flush/reset its playback cleanly
    }

    // Error from server
    if (msg.error) {
      console.error('[GeminiLive] Server error:', msg.error);
      this.onError?.(new Error(msg.error.message || 'Gemini server error'));
    }
  }

  /**
   * Handle incoming tool calls from Gemini.
   */
  _handleToolCall(toolCall) {
    const calls = toolCall.functionCalls || toolCall.function_calls || (toolCall.name ? [toolCall] : []);
    for (const fn of calls) {
      console.log(`[GeminiLive] Tool call: ${fn.name}`);
      // The handler is async; calling it bare let a rejected promise become an
      // UNHANDLED rejection that could take the process down. Wrap it so any tool
      // error is caught and reported back to the model instead of crashing Leo.
      try {
        Promise.resolve(this.onToolCall?.(fn)).catch((e) => {
          try { this.sendToolResponse?.(fn.name, `Tool error: ${e && e.message ? e.message : e}`, fn.id); } catch (_) {}
          console.error(`[GeminiLive] tool '${fn.name}' rejected:`, e && e.message ? e.message : e);
        });
      } catch (e) {
        try { this.sendToolResponse?.(fn.name, `Tool error: ${e.message}`, fn.id); } catch (_) {}
      }
    }
  }

  /**
   * Send a tool response back to Gemini.
   * @param {string} name - Function name
   * @param {string} result - Result string
   */
  sendToolResponse(name, result, id = null) {
    if (!this.isReady || !this.ws) return;
    const response = {
      name: name,
      response: {
        result: result
      }
    };
    if (id) response.id = id;
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [
          response
        ]
      }
    }));
  }

  /**
   * Stream a chunk of PCM audio (Discord format) to Gemini.
   * Discord provides 48kHz 2-channel PCM s16le.
   * Gemini Live expects 16kHz mono PCM s16le.
   * We downsample and convert here.
   *
   * @param {Buffer} pcmBuffer - Raw PCM buffer from Discord (48kHz, stereo, s16le)
   */
  sendAudio(pcmBuffer) {
    if (!this.isReady || !this.ws) return;

    // Downsample 48kHz stereo → 16kHz mono
    const mono16k = this._downsample48to16(pcmBuffer);
    const base64 = mono16k.toString('base64');

    // Current Live API format: direct audio blob inside realtimeInput.
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64
        }
      }
    }));
    this._lastAudioSentTs = Date.now(); // resets the idle keepalive clock
  }

  /**
   * MANUAL VAD — activity signalling.
   *
   * When LEO_MANUAL_VAD is on we tell Gemini "automaticActivityDetection.disabled
   * = true", which means GEMINI will not infer speech start/end on its own. The
   * client must bracket REAL input audio with activityStart / activityEnd. We hook
   * these to Leo's LOCAL mic gate (the only reliable "user is really speaking"
   * signal), so Gemini only ever reacts to genuine speech and can't phantom-cut a
   * read. Debounced via _userActivityOpen: start fires once on the false→true edge,
   * end fires once after a trailing silence (see leo.mjs gate hook).
   *
   * No-ops unless we're in interactive mode with manual VAD active, so the outbound
   * (Groq) path and an auto-VAD revert (LEO_MANUAL_VAD=0) are untouched.
   */
  _manualVadActive() {
    return this._isInteractive && process.env.LEO_MANUAL_VAD !== '0';
  }

  signalActivityStart() {
    if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._manualVadActive()) return;
    if (this._userActivityOpen) return; // already open — debounce
    this._userActivityOpen = true;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    } catch (_) { this._userActivityOpen = false; }
  }

  signalActivityEnd() {
    if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this._manualVadActive()) return;
    if (!this._userActivityOpen) return; // nothing open — debounce
    this._userActivityOpen = false;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    } catch (_) {}
  }

  /**
   * Idle keepalive: send a short burst of 16kHz mono SILENCE so Gemini sees the
   * session as active and doesn't abort it (1008) during quiet stretches. Silence
   * (all zeros) never trips the VAD, so Leo won't react to it.
   */
  _sendSilenceKeepalive() {
    if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // 120ms of 16kHz mono PCM16 silence = 16000 * 0.12 * 2 = 3840 zero bytes.
    if (!this._silenceB64) this._silenceB64 = Buffer.alloc(3840, 0).toString('base64');
    try {
      this.ws.send(JSON.stringify({
        realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: this._silenceB64 } }
      }));
      this._lastAudioSentTs = Date.now();
    } catch (_) {}
  }

  sendAudioStreamEnd() {
    if (!this.isReady || !this.ws) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audioStreamEnd: true
      }
    }));
  }

  /**
   * Send a text message to Gemini Live (e.g., when the text transcript is known).
   * Useful as a fallback when audio quality is poor.
   */
  sendText(text, turnComplete = false) {
    if (!this.isReady || !this.ws) return;
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text: text }]
          }
        ],
        turnComplete: turnComplete
      }
    }));
  }

  /**
   * Downsample 48kHz stereo s16le → 16kHz mono s16le.
   * Simple 3:1 decimation (48000/16000=3) with left+right averaging.
   */
  _downsample48to16(pcm) {
    // Each sample is 2 bytes (s16le), stereo = 4 bytes per frame
    const frameSize = 4;
    const numFrames = Math.floor(pcm.length / frameSize);
    const outFrames = Math.floor(numFrames / 3);
    const out = Buffer.allocUnsafe(outFrames * 2);

    for (let i = 0; i < outFrames; i++) {
      const srcIdx = i * 3 * frameSize; // Take every 3rd frame
      // Average L+R channels
      const L = pcm.readInt16LE(srcIdx);
      const R = pcm.readInt16LE(srcIdx + 2);
      out.writeInt16LE(Math.round((L + R) / 2), i * 2);
    }
    return out;
  }

  /**
   * Decode a base64 audio chunk from Gemini to a PCM buffer.
   * Gemini returns 24kHz mono s16le; Discord needs 48kHz stereo s16le.
   * We upsample here so the existing audio pipeline works unchanged.
   */
  static decodeAudioChunk(base64, mimeType = '') {
    // Resample Gemini PCM (mono) → 48kHz stereo for Discord.
    // FIXES for the "cracky / low / sick" voice:
    //  1. RATE-AWARE: the old code assumed 24kHz; if Gemini sends another
    //     rate (declared in the chunk's mimeType), playback ran slow —
    //     deep, draggy, sick-sounding. We now read the actual rate.
    //  2. LINEAR INTERPOLATION: the old sample-duplication upsampler
    //     (zero-order hold) caused harsh aliasing — the crackle.
    const src = Buffer.from(base64, 'base64');
    const rateMatch = /rate=(\d+)/.exec(mimeType || '');
    const srcRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const n = Math.floor(src.length / 2);
    if (n === 0) return Buffer.alloc(0);

    const outFrames = Math.floor(n * 48000 / srcRate);
    const out = Buffer.allocUnsafe(outFrames * 4); // stereo s16le
    const step = srcRate / 48000;

    for (let i = 0; i < outFrames; i++) {
      const pos = i * step;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = pos - i0;
      const s = Math.round(src.readInt16LE(i0 * 2) * (1 - frac) + src.readInt16LE(i1 * 2) * frac);
      out.writeInt16LE(s, i * 4);     // L
      out.writeInt16LE(s, i * 4 + 2); // R
    }
    return out;
  }

  /**
   * Disconnects the WebSocket bridge and cleans up associated ping intervals.
   * Ensures the connection is fully terminated.
   */
  disconnect() {
    this._userClosed = true; // intentional close — suppress auto-reconnect
    this.isActive = false;
    this.isReady = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  get available() {
    return !!this.apiKey && this.isReady && this.isActive;
  }
}

/**
 * Session factory — creates a per-user Gemini Live session.
 * Leo maintains one session per active voice user and reuses it across turns.
 */
export class GeminiLiveSessionManager {
  constructor() {
    this.sessions = new Map(); // userId → GeminiLiveBridge
  }

  async getOrCreate(userId, botName, systemInstruction, userName, options = {}) {
    reloadEnv();
    const sessionKey = `${userId}-${botName}`;
    if (this.sessions.has(sessionKey)) {
      const existing = this.sessions.get(sessionKey);
      if (existing.available) return existing;
      existing.disconnect();
    }

    const envKeySlug = botName.toUpperCase().replace(/[\s-]+/g, '_');
    const apiKey = process.env[`GEMINI_API_KEY_${envKeySlug}`] || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn(`[GeminiLive] No GEMINI_API_KEY_${envKeySlug} or GEMINI_API_KEY — falling back to Groq pipeline`);
      return null;
    }

    const connectOptions = { botName, ...options };
    const bridge = new GeminiLiveBridge(apiKey);
    try {
      await bridge.connect(systemInstruction, userName, connectOptions);
    } catch (e) {
      console.error(`[GeminiLive] Failed to connect for ${userName}:`, e.message);
      return null;
    }

    if (connectOptions.enableTools === false) {
      this.sessions.set(sessionKey, bridge);
      console.log(`[GeminiLive] New session created for ${botName} (${userName})`);
      return bridge;
    }

    // ATTACH TOOL HANDLERS: lattice memory, KAI Codex, live web search
    bridge.onToolCall = async (fn) => {
      let args = fn.args || fn.argsJson || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const query = args.query || "";

      if (fn.name === 'search_lattice') {
        console.log(`[${botName}/Live] Searching Lattice for: ${query}`);
        try {
          const res = await fetch(`http://127.0.0.1:3334/api/rshl/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, n: 5 })
          });
          if (res.ok) {
            const hits = await res.json();
            const context = hits.map(h => h.text).join('\n');
            bridge.sendToolResponse('search_lattice', context || "No specific memory found.", fn.id);
          } else {
            bridge.sendToolResponse('search_lattice', "Lattice temporarily unreachable.", fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('search_lattice', `Search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'consult_codex') {
        console.log(`[${botName}/Live] Consulting the KAI Codex for: ${query}`);
        try {
          const result = consultCodex(query);
          bridge.sendToolResponse('consult_codex', result || "The Codex has no section matching that query.", fn.id);
        } catch (e) {
          bridge.sendToolResponse('consult_codex', `Codex lookup failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'codex_search') {
        console.log(`[${botName}/Live] EXACT Codex search for: ${query}`);
        try {
          const hits = codex_search(query);
          if (!hits || !hits.length) {
            // Fall back to the scored section lookup so we never come up empty
            const soft = consultCodex(query, 6000);
            bridge.sendToolResponse('codex_search', soft || `No verbatim match for "${query}" in the Codex.`, fn.id);
          } else {
            const out = hits.slice(0, 6).map(h => `[p.${h.page} — ${h.section}]\n${h.passage}`).join('\n\n');
            bridge.sendToolResponse('codex_search', out.slice(0, 9000), fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('codex_search', `Codex search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'codex_get_page') {
        const pageNum = Number(args.page) || 1;
        console.log(`[${botName}/Live] Reading Codex page ${pageNum} verbatim...`);
        try {
          const text = codex_get_page(pageNum);
          const stats = codex_stats();
          bridge.sendToolResponse('codex_get_page', text ? `[Codex page ${pageNum} of ${stats.page_count}]\n${text}` : `Page ${pageNum} is out of range (Codex has ${stats.page_count} pages).`, fn.id);
        } catch (e) {
          bridge.sendToolResponse('codex_get_page', `Codex page read failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'codex_outline') {
        console.log(`[${botName}/Live] Reading live Codex outline...`);
        try {
          const o = codex_outline();
          bridge.sendToolResponse('codex_outline', o ? o.slice(0, 11000) : "Codex outline unavailable.", fn.id);
        } catch (e) {
          bridge.sendToolResponse('codex_outline', `Codex outline failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'codex_section') {
        const id = String(args.id || '').trim();
        console.log(`[${botName}/Live] Codex section lookup: ${id}`);
        try {
          const txt = codex_get_section(id);
          if (txt && txt.length > 2) {
            bridge.sendToolResponse('codex_section', txt.slice(0, 11000), fn.id);
          } else {
            // never dead-end: show the outline so it can find the right address
            const o = codex_outline();
            bridge.sendToolResponse('codex_section', `No section matched "${id}". Here is the live outline — pick the right §-number:\n${(o || '').slice(0, 8000)}`, fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('codex_section', `Codex section lookup failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'search_docs') {
        const file = String(args.file || '').trim() || null;
        console.log(`[${botName}/Live] search_docs "${query}"${file ? ' in ' + file : ' (main docs)'}`);
        try {
          const hits = searchDocs(query, file);
          if (!hits.length) {
            bridge.sendToolResponse('search_docs', `No matches for "${query}"${file ? ' in ' + file : ' in the main docs'}.`, fn.id);
          } else if (hits[0] && hits[0].error) {
            bridge.sendToolResponse('search_docs', hits[0].error, fn.id);
          } else {
            const out = hits.map(h => `${h.file}:${h.lineNumber}\n${h.context}`).join('\n---\n');
            bridge.sendToolResponse('search_docs', out.slice(0, 9000), fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('search_docs', `Doc search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'read_doc_lines') {
        const file = String(args.file || '').trim();
        console.log(`[${botName}/Live] read_doc_lines ${file} ${args.startLine}-${args.endLine}`);
        try {
          const r = readDocLines(file, args.startLine, args.endLine);
          if (r && r.error) {
            bridge.sendToolResponse('read_doc_lines', r.error, fn.id);
          } else {
            bridge.sendToolResponse('read_doc_lines',
              `[${r.file} lines ${r.startLine}-${r.endLine} of ${r.totalLines}]\n${r.text}`.slice(0, 11000), fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('read_doc_lines', `Doc read failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'list_docs') {
        console.log(`[${botName}/Live] list_docs`);
        try {
          const docs = listDocs();
          const out = docs.length
            ? docs.map(d => `${d.name} (${(d.size / 1024).toFixed(1)} KB) — ${d.path}`).join('\n')
            : 'No readable docs found under the allowed roots.';
          bridge.sendToolResponse('list_docs', out.slice(0, 9000), fn.id);
        } catch (e) {
          bridge.sendToolResponse('list_docs', `Listing docs failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'search_web') {
        console.log(`[${botName}/Live] Web search: ${query}`);
        try {
          const result = await webSearch(query);
          const text = result ? String(typeof result === 'object' ? JSON.stringify(result) : result).slice(0, 2000) : "No results found.";
          bridge.sendToolResponse('search_web', text, fn.id);
        } catch (e) {
          bridge.sendToolResponse('search_web', `Web search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'ask_google') {
        const q = String(args.query || query || '').trim();
        console.log(`[${botName}/Live] ask_google (grounded): ${q}`);
        try {
          const { askGoogle } = await import('./google-search.mjs');
          const r = await askGoogle(q);
          bridge.sendToolResponse('ask_google',
            r.ok ? `${r.summary}\n\n(Relay this in your own voice — give them the gist + the key facts, mention it's current. Don't read the source list robotically.)` : r.text,
            fn.id);
        } catch (e) {
          bridge.sendToolResponse('ask_google', `Google search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'kai_status') {
        console.log(`[${botName}/Live] Fetching KAI's live status + report card...`);
        try {
          const parts = [];
          // Pull the SAME live sources the dreams-channel telemetry uses, so the
          // numbers Leo says match what's actually broadcast (no more vague-ness).
          let stats = null, syn = null;
          try {
            const [r, rs] = await Promise.all([
              fetch('http://127.0.0.1:3334/api/status', { signal: AbortSignal.timeout(6000) }),
              fetch('http://127.0.0.1:3334/api/synapse/status', { signal: AbortSignal.timeout(6000) }).catch(() => null),
            ]);
            if (r && r.ok) stats = await r.json();
            if (rs && rs.ok) syn = await rs.json();
          } catch (_) {}
          if (stats) {
            const N = Number(stats.total_cells) || 0;
            const S = Number(stats.synapses) || 0;
            const p = N > 0 ? Math.min(S / (N * 4.0), 1.0) : 0;
            const throttle = 1.0 + 100.0 * (4.0 * p * (1.0 - p));
            parts.push(`ENGINE (live now): ${N.toLocaleString()} neurons, ${S.toLocaleString()} synapses, Global Phi (confidence) ${Number(stats.phi_g).toFixed(4)}, coherence/density ${syn ? Number(syn.density_per_cell).toFixed(4) : 'n/a'}, learning throttle ${throttle.toFixed(2)}x. Host CPU ${stats.cpu}, RAM ${stats.ram}.`);
            parts.push(`CELLULAR: ~${Math.floor(N * 1.24).toLocaleString()} astrocytes, ${Math.floor(S * 0.85).toLocaleString()} tripartite (astrocyte-gated) synapses, ${syn ? Number(syn.neurons_with_outgoing).toLocaleString() : '?'} grounded geometric bridges.`);
          } else {
            parts.push('ENGINE: unreachable right now (the Rust core may be busy rebuilding or down).');
          }
          try {
            const h = JSON.parse(fs.readFileSync('c:/KAI/data/hippocampus_status.json', 'utf8'));
            parts.push(`MEMORY: ${Number(h.patterns).toLocaleString()} short-term patterns, ${Number(h.pending_consolidations).toLocaleString()} queued for sleep replay, ${Number(h.promoted_total).toLocaleString()} promoted to long-term Universe.`);
          } catch (_) {}
          try {
            const c = JSON.parse(fs.readFileSync('c:/KAI/data/pipeline_curriculum.json', 'utf8'));
            const recent = (c.recent_scores || []).slice(-5).map(x => Math.round(x)).join(', ');
            parts.push(`SCHOOL REPORT: curriculum level ${c.level}, ${c.total_passed}/${c.total_tests} sections passed. Recent quiz averages: ${recent || 'none yet'}. Weak areas: ${(c.weak_areas || []).join(', ') || 'none flagged'}. Retention queue: ${(c.retention_queue || []).length} facts awaiting re-study.`);
          } catch (_) { parts.push('SCHOOL REPORT: no training data found.'); }
          parts.push('(For the FULL live telemetry — drives, prediction accuracy, self-model — read the dreams feed. These numbers are real and current; state them, don\'t hedge.)');
          bridge.sendToolResponse('kai_status', parts.join('\n') || 'No status available.', fn.id);
        } catch (e) {
          bridge.sendToolResponse('kai_status', `Status fetch failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'read_codex_section') {
        const want = String(args.section || 'next').trim().toLowerCase();
        // Persist the bookmark on globalThis, NOT the bridge: the bridge is rebuilt at
        // the ~10-min Gemini session boundary, which kept resetting "next" back to
        // section 1 — that's the "stuck re-reading the title page" loop. globalThis
        // survives the reset so reading actually advances across the whole hour.
        globalThis.__codexBookmarks = globalThis.__codexBookmarks || {};
        const _bmKey = botName || 'Leo';
        let _bm = globalThis.__codexBookmarks[_bmKey] || 0;
        if (want === 'next') { _bm = _bm + 1; }
        else { _bm = parseInt(want, 10) || 1; }
        console.log(`[${botName}/Live] Narrating Codex section ${_bm}...`);
        try {
          const sec = getCodexSection(_bm);
          if (!sec) {
            bridge.sendToolResponse('read_codex_section', 'The Codex could not be loaded.', fn.id);
          } else {
            globalThis.__codexBookmarks[_bmKey] = sec.number; // clamp to valid range + persist
            bridge.sendToolResponse('read_codex_section',
              `[Codex section ${sec.number} of ${sec.total}: ${sec.title}]\n${sec.text}\n\n(Read this aloud naturally — this IS the Codex. When finished, ask if they want section ${sec.number + 1}.)`,
              fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('read_codex_section', `Codex read failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'narrate') {
        // CONTEXT SANDBOX (Stage 3): load a big body of text, chunk it, and let
        // Leo read it section-by-section, auto-laddering to the next part each
        // time he finishes — far more than a single context window can hold.
        const source = String(args.source || '').trim().toLowerCase();
        let bigText = '', title = String(args.title || '').trim();
        let bookChapterHead = ''; // for chapter auto-continuity (book source only)
        console.log(`[${botName}/Live] Narrate → sandbox (source=${source})`);
        try {
          if (source === 'codex_page') {
            const pageNum = Number(args.page) || (bridge._codexBookmark || 1);
            bigText = codex_get_page(pageNum) || '';
            if (!title) title = `Codex page ${pageNum}`;
          } else if (source === 'codex_section') {
            const id = String(args.id || '').trim();
            bigText = codex_get_section(id) || '';
            if (!title) title = `Codex §${id}`;
          } else if (source === 'text') {
            bigText = String(args.text || '');
            if (!title) title = 'that passage';
          } else if (source === 'memory') {
            const mq = String(args.query || query || '').trim();
            try {
              const res = await fetch('http://127.0.0.1:3334/api/rshl/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: mq, n: 12 }), signal: AbortSignal.timeout(5000)
              });
              if (res.ok) { const hits = await res.json(); bigText = (hits || []).map(h => h.text).filter(Boolean).join('\n\n'); }
            } catch (_) {}
            if (!title) title = `memory: ${mq}`.slice(0, 40);
          } else if (source === 'book') {
            // Read Ryan's KAIVERSE.md — "A Biographical Isekai of How KAI Was Made"
            // — aloud like a real book. Optional `chapter` (a number or a keyword)
            // jumps to that chapter; otherwise it starts from the beginning. The
            // sandbox chunks it so Leo reads it chapter-by-chapter, hands-free.
            try {
              const fsb = await import('fs');
              const raw = fsb.readFileSync('c:/KAI/KAIVERSE.md', 'utf8');
              const want = String(args.chapter || args.id || '').trim().toLowerCase();
              if (want) {
                const parts = raw.split(/\n(?=#{1,3}\s.*chapter)/i);
                const hit = parts.find(p => {
                  const head = (p.split('\n')[0] || '').toLowerCase();
                  return head.includes(want) || head.includes('chapter ' + want);
                });
                bigText = hit || raw;
                if (!title) title = 'KAIVERSE — ' + ((hit || 'the book').split('\n')[0].replace(/^#+\s*/, '').slice(0, 50));
              } else {
                // Begin at the first CHAPTER heading — skip the title page, the
                // version note, the "Biographical Isekai" line, the dedication, and
                // the whole Table of Contents. Leo should just START THE STORY, not
                // recite the front matter or the contents list.
                const _m = raw.match(/^#{1,3}\s.*chapter/im);
                bigText = (_m && _m.index > 0) ? raw.slice(_m.index) : raw;
                if (!title) title = 'KAIVERSE — the book of how KAI was made';
              }
              // Record which chapter heading this read STARTS at, so chapter
              // auto-continuity can find the NEXT chapter when this one empties.
              const firstChapLine = (bigText.match(/^#{1,3}\s.*chapter.*$/im) || [''])[0];
              bookChapterHead = firstChapLine || '';
            } catch (e) { bigText = ''; }
          }
        } catch (e) { bigText = ''; }

        if (!bigText || bigText.trim().length < 1) {
          bridge.sendToolResponse('narrate', `There was nothing to read for that ${source || 'source'} request.`, fn.id);
        } else if (typeof bridge.loadSandbox !== 'function') {
          bridge.sendToolResponse('narrate', 'The context sandbox is not wired up in this session.', fn.id);
        } else {
          try {
            const loaded = await bridge.loadSandbox(bigText, { title, book: source === 'book', chapterHead: bookChapterHead });
            if (loaded && loaded.tts) {
              // DEDICATED-TTS AUDIOBOOK PATH: the book is being read by the dedicated
              // Gemini TTS reader (Charon, verbatim) streamed straight to voice — NOT by
              // you. Do NOT read the text yourself; the audio is already starting. Just
              // give a SHORT in-character intro line, then go quiet and let it play.
              bridge.sendToolResponse('narrate',
                `Starting the audiobook read of "${title}" now — ${loaded.total} part(s) — in your own voice, read aloud automatically. Say ONE short in-character line to kick it off (e.g. "Right, settle in — here we go.") then STOP and stay quiet; the reading plays on its own. Do NOT speak the book text yourself. If they want to pause, they'll unmute or say "stop"; "keep going" resumes it.`,
                fn.id);
            } else if (loaded && loaded.first) {
              // SOURCE LABEL — so Leo frames it HONESTLY. Memory content is KAI's
              // ingested knowledge (papers it has studied), NOT the Codex; he kept
              // calling it "Codex section N" which was wrong. Codex content IS the Codex.
              const kindNote = source === 'memory'
                ? `IMPORTANT: this is from YOUR OWN INGESTED KNOWLEDGE — things KAI has studied/learned. Say so plainly ("this is from what I've studied", "from my memory") — do NOT call it the Codex.`
                : (source.startsWith('codex') ? `This is from the KAI Codex.` : `This is the passage they gave you.`);
              bridge.sendToolResponse('narrate',
                `Loaded "${title}" into your context sandbox — ${loaded.total} part(s). ${kindNote} Read PART 1 of ${loaded.total} aloud now, naturally, in your own voice. When you finish, PAUSE — it auto-continues to the next part (do NOT call a tool again for it). Part 1:\n\n${loaded.first.text}`,
                fn.id);
            } else {
              bridge.sendToolResponse('narrate', 'Could not load that into the sandbox.', fn.id);
            }
          } catch (e) {
            bridge.sendToolResponse('narrate', `Sandbox load failed: ${e.message}`, fn.id);
          }
        }
      } else if (fn.name === 'resume_reading') {
        try {
          // DEDICATED-TTS RESUME (default ON; LEO_TTS_READING=0 reverts): mirror the
          // fresh book→TTS branch in loadSandbox. A saved book/long read must resume
          // through the dedicated TTS reader (Charon, verbatim) — NOT be fed back into
          // the Live ladder, which paraphrases, suffers phantom-interrupt re-reads, and
          // dies at the 10-min session limit. We try TTS first; if there's no draft for
          // the TTS reader to pick up, we fall through to the Live-ladder resume.
          const ttsOn = String(process.env.LEO_TTS_READING || '1') !== '0';
          if (ttsOn && typeof bridge.resumeTtsRead === 'function') {
            const ok = await bridge.resumeTtsRead({});
            if (ok) {
              console.log(`[${botName}/TTS] Resuming read via TTS`);
              bridge.sendToolResponse('resume_reading',
                `Picking your saved read back up now — read aloud automatically in your own voice. Say ONE short in-character line to ease back in (e.g. "Right, where were we — here we go.") then STOP and stay quiet; the reading continues on its own. Do NOT speak the text yourself.`,
                fn.id);
              return;
            }
            // No TTS draft to resume — fall through to the Live-ladder resume below.
          }
          console.log(`[${botName}/Live] Resume reading (sandbox draft)`);
          if (typeof bridge.resumeSandbox !== 'function') {
            bridge.sendToolResponse('resume_reading', 'Resume is not wired up in this session.', fn.id);
          } else {
            const r = await bridge.resumeSandbox();
            if (r && r.first) {
              bridge.sendToolResponse('resume_reading',
                `Picking back up "${r.title || 'where you left off'}" — ${r.total} section(s) remaining. Read this next section aloud, continuing smoothly (no recap). When done, PAUSE and you'll auto-continue. Next section:\n\n${r.first.text}`,
                fn.id);
            } else {
              bridge.sendToolResponse('resume_reading', "You don't have a saved reading to pick back up right now.", fn.id);
            }
          }
        } catch (e) {
          bridge.sendToolResponse('resume_reading', `Resume failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'get_directions') {
        let origin = String(args.origin || '').trim();
        let destination = String(args.destination || '').trim();
        const mode = String(args.mode || 'drive').trim();
        // "take me home" payoff: resolve saved places ("home"/"work"/"my place")
        // to the user's stored address from their profile warehouse.
        if (typeof bridge.recallFact === 'function') {
          if (/^(home|my home|my house|my place|where i live)$/i.test(origin)) { const f = await bridge.recallFact('home').catch(() => null); if (f) origin = f; }
          if (/^(home|my home|my house|my place|where i live)$/i.test(destination)) { const f = await bridge.recallFact('home').catch(() => null); if (f) destination = f; }
          if (/^(work|my work|the office|office|my job)$/i.test(origin)) { const f = await bridge.recallFact('work').catch(() => null); if (f) origin = f; }
          if (/^(work|my work|the office|office|my job)$/i.test(destination)) { const f = await bridge.recallFact('work').catch(() => null); if (f) destination = f; }
        }
        console.log(`[${botName}/Live] Directions: ${origin} → ${destination} (${mode})`);
        try {
          if (typeof bridge.getDirections !== 'function') {
            bridge.sendToolResponse('get_directions', 'Directions are not wired up in this session.', fn.id);
          } else {
            const r = await bridge.getDirections(origin, destination, mode);
            if (!r || !r.ok) {
              bridge.sendToolResponse('get_directions', (r && r.summary) || 'Could not get directions.', fn.id);
            } else {
              const steps = (r.steps || []).slice(0, 8).map((s, i) => `${i + 1}. ${s}`).join('\n');
              const more = (r.steps || []).length > 8 ? `\n…and ${r.steps.length - 8} more steps (say "read me all the steps" to hear the rest).` : '';
              bridge.sendToolResponse('get_directions',
                `${r.summary}\n\n${steps}${more}\n\n(Relay this naturally in your own voice — give them the distance, the time, and the key turns; don't robot-read every step unless they ask. Saved to your info sandbox.)`,
                fn.id);
            }
          }
        } catch (e) {
          bridge.sendToolResponse('get_directions', `Couldn't pull directions: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'remember_fact') {
        const key = String(args.key || '').trim();
        const value = String(args.value || '').trim();
        try {
          const r = (typeof bridge.rememberFact === 'function') ? await bridge.rememberFact(key, value) : null;
          bridge.sendToolResponse('remember_fact',
            r ? `Saved: ${r.key} = "${r.value}". (Confirm naturally, e.g. "got it — I'll remember your ${r.key.replace(/_/g, ' ')}.")`
              : `Couldn't save that fact.`, fn.id);
        } catch (e) {
          bridge.sendToolResponse('remember_fact', `Couldn't save that: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'recall_fact') {
        const key = String(args.key || '').trim();
        try {
          const v = (typeof bridge.recallFact === 'function') ? await bridge.recallFact(key) : null;
          bridge.sendToolResponse('recall_fact',
            v ? `${key.replace(/_/g, ' ')} = "${v}".`
              : `You don't know their ${key.replace(/_/g, ' ')} yet — ask them, then use remember_fact.`, fn.id);
        } catch (e) {
          bridge.sendToolResponse('recall_fact', `Couldn't recall that: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'find_place') {
        const q = String(args.query || '').trim();
        console.log(`[${botName}/Live] Find place: ${q}`);
        try {
          if (typeof bridge.findPlace !== 'function') {
            bridge.sendToolResponse('find_place', 'Place search is not wired up in this session.', fn.id);
          } else {
            const r = await bridge.findPlace(q);
            bridge.sendToolResponse('find_place',
              (r && r.ok)
                ? `${r.summary}\n\n(Give them the best one or two in your own voice — name, where it is, rating, open or not. Saved to your info sandbox.)`
                : ((r && r.summary) || `No places found for "${q}".`),
              fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('find_place', `Place search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'reverse_geocode') {
        const coords = String(args.coords || '').trim();
        try {
          const r = (typeof bridge.reverseGeocode === 'function') ? await bridge.reverseGeocode(coords) : null;
          bridge.sendToolResponse('reverse_geocode',
            (r && r.ok)
              ? `${r.summary} (Confirm that with them naturally, then remember_fact 'last_location' = "${r.address || r.area}".)`
              : ((r && r.summary) || `Couldn't place those coordinates.`),
            fn.id);
        } catch (e) {
          bridge.sendToolResponse('reverse_geocode', `Couldn't place those coordinates: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'get_elevation') {
        try {
          const r = (typeof bridge.getElevation === 'function') ? await bridge.getElevation(String(args.coords || '').trim()) : null;
          bridge.sendToolResponse('get_elevation', (r && r.ok) ? r.summary : ((r && r.summary) || 'Could not get elevation.'), fn.id);
        } catch (e) { bridge.sendToolResponse('get_elevation', `Elevation failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'get_time_zone') {
        try {
          const r = (typeof bridge.getTimeZone === 'function') ? await bridge.getTimeZone(String(args.coords || '').trim()) : null;
          bridge.sendToolResponse('get_time_zone', (r && r.ok) ? r.summary : ((r && r.summary) || 'Could not get time zone.'), fn.id);
        } catch (e) { bridge.sendToolResponse('get_time_zone', `Time zone failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'satellite_view') {
        try {
          const r = (typeof bridge.satelliteView === 'function') ? await bridge.satelliteView(String(args.coords || '').trim(), args.zoom) : null;
          bridge.sendToolResponse('satellite_view', (r && r.ok) ? `${r.summary} Ask them to look at the image and tell you if it matches.` : ((r && r.summary) || 'Could not render satellite view.'), fn.id);
        } catch (e) { bridge.sendToolResponse('satellite_view', `Satellite view failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'street_view') {
        try {
          const r = (typeof bridge.streetView === 'function') ? await bridge.streetView(String(args.coords || '').trim(), args.heading) : null;
          bridge.sendToolResponse('street_view', (r && r.ok) ? `${r.summary} Ask them if it looks familiar.` : ((r && r.summary) || 'Could not render street view.'), fn.id);
        } catch (e) { bridge.sendToolResponse('street_view', `Street view failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'aerial_view') {
        try {
          const r = (typeof bridge.aerialView === 'function') ? await bridge.aerialView(String(args.address || '').trim()) : null;
          bridge.sendToolResponse('aerial_view', (r && r.ok) ? r.summary : ((r && r.summary) || 'Could not get aerial view.'), fn.id);
        } catch (e) { bridge.sendToolResponse('aerial_view', `Aerial view failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'get_weather') {
        try {
          const r = (typeof bridge.getWeather === 'function') ? await bridge.getWeather(String(args.coords || '').trim()) : null;
          bridge.sendToolResponse('get_weather', (r && r.ok) ? r.summary : ((r && r.summary) || 'Could not get weather.'), fn.id);
        } catch (e) { bridge.sendToolResponse('get_weather', `Weather failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'validate_address') {
        try {
          const r = (typeof bridge.validateAddress === 'function') ? await bridge.validateAddress(String(args.address || '').trim()) : null;
          bridge.sendToolResponse('validate_address', (r && r.ok) ? `${r.summary} (If that's right, remember_fact it as their home/work.)` : ((r && r.summary) || 'Could not validate the address.'), fn.id);
        } catch (e) { bridge.sendToolResponse('validate_address', `Address validation failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'get_current_time') {
        try {
          const r = (typeof bridge.getCurrentTime === 'function') ? await bridge.getCurrentTime(args.timezone) : null;
          bridge.sendToolResponse('get_current_time', (r && r.summary) || 'Could not get the current time.', fn.id);
        } catch (e) { bridge.sendToolResponse('get_current_time', `Time failed: ${e.message}`, fn.id); }
      } else if (fn.name === 'recall_info') {
        const region = String(args.region || '').trim().toLowerCase();
        console.log(`[${botName}/Live] Recall info region: ${region}`);
        try {
          const text = (typeof bridge.recallInfo === 'function') ? await bridge.recallInfo(region) : null;
          if (!text) {
            bridge.sendToolResponse('recall_info', `Nothing saved under "${region}" yet this session.`, fn.id);
          } else if (text.length > 700 && typeof bridge.loadSandbox === 'function') {
            // Long (e.g. a full route) — read it back through the narration ladder.
            const loaded = await bridge.loadSandbox(text, { title: region });
            if (loaded && loaded.first) {
              bridge.sendToolResponse('recall_info',
                `Reading back the ${region} — section 1 of ${loaded.total}. Read it naturally; when you finish you'll auto-continue:\n\n${loaded.first.text}`,
                fn.id);
            } else {
              bridge.sendToolResponse('recall_info', text, fn.id);
            }
          } else {
            bridge.sendToolResponse('recall_info', `${text}\n\n(Relay this naturally.)`, fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('recall_info', `Recall failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'read_channel_feed') {
        // The Discord client lives in the bot process, not here — the bot
        // (leo.mjs) registers bridge.fetchChannelFeed at session setup.
        const feed = String(args.feed || '').trim().toLowerCase();
        console.log(`[${botName}/Live] Reading live channel feed: ${feed}`);
        try {
          if (typeof bridge.fetchChannelFeed === 'function') {
            const text = await bridge.fetchChannelFeed(feed);
            bridge.sendToolResponse('read_channel_feed', text || `No recent messages in the ${feed} feed.`, fn.id);
          } else {
            bridge.sendToolResponse('read_channel_feed', 'Channel feeds are not wired up in this session.', fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('read_channel_feed', `Feed read failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'discord_soundboard') {
        const effect = String(args.effect || '').trim();
        console.log(`[${botName}/Live] Soundboard: ${effect}`);
        try {
          if (typeof bridge.playSoundboard === 'function' && effect) {
            bridge.playSoundboard(effect);
            bridge.sendToolResponse('discord_soundboard', `Played the '${effect}' sound.`, fn.id);
          } else {
            bridge.sendToolResponse('discord_soundboard', effect ? 'Soundboard is not wired in this session.' : 'No effect name given.', fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('discord_soundboard', `Soundboard failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'recall_memory') {
        // On-demand search of the LOCAL episodic transcript DB (all sessions,
        // engine-independent) so Leo can answer "what did I say earlier today?"
        // instead of only knowing the current live session.
        const q = String(args.query || query || '').trim();
        console.log(`[${botName}/Live] Recalling memory: ${q.slice(0, 80)}`);
        try {
          const { recallMemory, getRecentContext } = await import('./transcript-memory.mjs');
          const seen = new Set();
          const fmt = (h, star = false) => {
            const when = new Date(Number(h.timestamp) || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `${star ? '⭐ ' : ''}(${when}) ${h.speaker}: ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 220)}`;
          };
          let lines = [];
          // 1) Explicit reminders ALWAYS surface first — "remember this" items
          //    must never be missed just because the wording didn't match.
          for (const h of (recallMemory('REMINDER', 3) || [])) {
            const k = String(h.content || '').slice(0, 60);
            if (!seen.has(k)) { seen.add(k); lines.push(fmt(h, true)); }
          }
          // 2) SEMANTIC search via KAI's lattice — finds memories by MEANING,
          //    not shared words, so "grocery list" matches "milk eggs bread".
          //    This is the real fix for "the data's there but he can't find it":
          //    his 16384-dim lattice is a vector store; every message is in it.
          //    Engine-dependent, so the keyword layers below are the fallback.
          if (q) {
            try {
              const r = await fetch('http://127.0.0.1:3334/api/rshl/query', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: q, n: 8 }),
                signal: AbortSignal.timeout(3000)
              });
              if (r.ok) {
                const hits = await r.json();
                for (const h of (Array.isArray(hits) ? hits : [])) {
                  const txt = String(h.text || h.content || '').replace(/\s+/g, ' ').trim();
                  const k = txt.slice(0, 60);
                  if (txt && !seen.has(k)) { seen.add(k); lines.push(`🧠 ${txt.slice(0, 220)}`); }
                }
              }
            } catch (_) { /* engine down — keyword layers below still work */ }
          }
          // 3) Keyword (exact-word) matches — fast, and the engine-down fallback.
          if (q) {
            for (const h of (recallMemory(q, 8) || [])) {
              const k = String(h.content || '').slice(0, 60);
              if (!seen.has(k)) { seen.add(k); lines.push(fmt(h)); }
            }
          }
          // 4) Fallback to recent context only if we found nothing at all.
          if (!lines.length) {
            const recent = getRecentContext(10, bridge._transcriptChannelId || null) || [];
            lines = recent.map(r => `${r.speaker}: ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 160)}`);
          }
          bridge.sendToolResponse('recall_memory',
            lines.length
              ? `From your memory (use it naturally, like you genuinely remember):\n${lines.join('\n')}`
              : `Nothing in your memory matched "${q}". Say so honestly — don't invent a memory.`,
            fn.id);
        } catch (e) {
          bridge.sendToolResponse('recall_memory', `Memory search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'consult_oracle') {
        // Hand the question to Oracle, which routes it to the work fleet
        // (Analyst/Researcher/Kai Coder) and fires the answer back to this bot's
        // IPC port → deliverOracleResult → our callback. We WAIT (with a hard
        // 25s cap so a voice turn can never hang) and return the real answer.
        const ask = String(args.question || query || '').trim();
        console.log(`[${botName}/Live] Consulting Oracle: ${ask.slice(0, 80)}`);
        if (!ask) {
          bridge.sendToolResponse('consult_oracle', 'No question was provided to ask Oracle.', fn.id);
        } else {
          try {
            const { requestOracleHelp } = await import('./oracle-pipeline.mjs');
            const answer = await new Promise((resolve) => {
              let settled = false;
              const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
              requestOracleHelp(botName, ask, bridge._transcriptChannelId || '', (result) => finish(String(result || '').slice(0, 4000)))
                .then((reqId) => { if (!reqId) finish(null); })
                .catch(() => finish(null));
              setTimeout(() => finish(null), 25000);
            });
            bridge.sendToolResponse('consult_oracle',
              answer
                ? `Oracle (via the work fleet) came back with:\n${answer}`
                : "I asked Oracle but no answer came back in time — Oracle or the work fleet may be offline. Tell the user plainly that you checked but couldn't get it this moment; don't make one up.",
              fn.id);
          } catch (e) {
            bridge.sendToolResponse('consult_oracle', `Couldn't reach Oracle: ${e.message}`, fn.id);
          }
        }
      } else if (fn.name === 'request_code_change') {
        // Route to the bot process (it has the Discord client) to DM the owner
        // for approval. Never applies anything here.
        const summary = String(args.summary || '').trim();
        const details = String(args.details || '').trim();
        console.log(`[${botName}/Live] Code change proposed: ${summary.slice(0, 80)}`);
        try {
          if (typeof bridge.requestCodeChange === 'function') {
            const res = await bridge.requestCodeChange(summary, details);
            bridge.sendToolResponse('request_code_change', res || "Sent the change proposal to the owner's DMs for approval.", fn.id);
          } else {
            bridge.sendToolResponse('request_code_change', 'Code-change routing is not wired in this session.', fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('request_code_change', `Couldn't send the proposal: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'calculate') {
        // Exact math via the SymPy backend — Leo must NEVER do arithmetic in his head.
        const expr = String(args.expression || '').trim();
        try {
          const { execFile } = await import('child_process');
          const result = await new Promise((resolve) => {
            execFile('python', ['c:/KAI/tools/oracle-discord/shared/calc_backend.py', expr],
              { timeout: 6000, windowsHide: true }, (err, stdout, stderr) => {
                if (err) resolve(JSON.stringify({ error: `calc failed: ${(stderr || err.message || '').toString().slice(0,200)}` }));
                else resolve((stdout || '').toString().trim() || JSON.stringify({ error: 'empty result' }));
              });
          });
          bridge.sendToolResponse('calculate', result, fn.id);
        } catch (e) {
          bridge.sendToolResponse('calculate', JSON.stringify({ error: e.message }), fn.id);
        }
      } else if (fn.name === 'simulate_emergence') {
        // KAI's SRHT emergence simulation (pure math; mirrors native-tools analyze_srht_emergence).
        try {
          const num = (x) => Number(x) || 0;
          const rho = num(args.rho), R = num(args.r), chi = num(args.chi), g = num(args.g);
          const tau = num(args.tau), ageDays = num(args.ageDays), u = num(args.u);
          const sigma = 1.0 - R, s = 1.0 / (1.0 + sigma), r_recency = Math.exp(-ageDays / 180.0), q = 1.0 - R;
          const Phi = rho * (R * R) * s, Phi_c = Phi * (1.0 - chi), phi_g = Phi_c * g;
          const X = chi * (1.0 - R), C = phi_g * (1.0 - chi) * tau, Wm = phi_g * r_recency, Pr = ((1.0 - phi_g) * u) + chi + q;
          const out = {
            base_emergence: Phi.toFixed(4), contradiction_filtered_emergence: Phi_c.toFixed(4),
            goal_directed_emergence: phi_g.toFixed(4), stability: s.toFixed(4),
            contradiction_pressure: X.toFixed(4), commit_readiness: C.toFixed(4),
            memory_reinforcement_weight: Wm.toFixed(4), replay_priority: Pr.toFixed(4)
          };
          bridge.sendToolResponse('simulate_emergence', JSON.stringify(out), fn.id);
        } catch (e) {
          bridge.sendToolResponse('simulate_emergence', JSON.stringify({ error: e.message }), fn.id);
        }
      }
    };

    this.sessions.set(sessionKey, bridge);
    console.log(`[GeminiLive] New session created for ${botName} (${userName})`);
    return bridge;
  }

  disconnect(userId, botName) {
    const sessionKey = `${userId}-${botName}`;
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.disconnect();
      this.sessions.delete(sessionKey);
    }
  }

  disconnectAll() {
    for (const [, session] of this.sessions) session.disconnect();
    this.sessions.clear();
  }
}
