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
import { consultCodex, getCodexSection, codexSectionCount } from './codex.mjs';
export { consultCodex };

// v1beta supports the latest 2026 live models
const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;

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
- Questions about KAI's CURRENT condition (how is he, scores, training, vitals): call kai_status EVERY single time — the data is live and changes constantly; yesterday's numbers are wrong by definition.
- Questions about the world: search_lattice, then search_web. State facts from the results, not from vibes.
- If you didn't look it up and don't know it cold, don't assert it.

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
    name: "consult_codex",
    description: "Look up the KAI Codex — the complete 250-page RSHL whitepaper — for authoritative answers about KAI's architecture, math, design doctrine, or roadmap. Use this BEFORE making specific claims about KAI/RSHL internals.",
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
    name: "kai_status",
    description: "Get KAI's LIVE condition: lattice size, synapses, phi, hippocampus consolidation state, plus his learning-pipeline report card (curriculum level, tests taken/passed, recent quiz scores, weak areas). Use whenever someone asks how KAI is doing, how training is going, or about his scores.",
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
    name: "read_channel_feed",
    description: "Read the latest live messages from one of the ecosystem's Discord feeds. Feeds: 'training' (KAI's tutoring/quiz updates and grades), 'dreams' (KAI's dream/vitals stream), 'frequencies' (RF spectrum sensor posts), 'chat' (general chat), 'self_optimize' (system optimization/diagnostics), 'work' (industrial work channel + task threads), 'overall' (the main public chat). Use whenever asked what's happening in a channel, how training/dreams/sensors are going right now, or what the system has been posting.",
    parameters: {
      type: "OBJECT",
      properties: {
        feed: { type: "STRING", description: "One of: training, dreams, frequencies, chat, self_optimize, work, overall" }
      },
      required: ["feed"]
    }
  }
];

export class GeminiLiveBridge {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.isReady = false;
    this.isActive  = false;
    this.audioChunks = []; // Buffer incoming audio deltas

    // Callbacks
    this.onAudioChunk   = null; 
    this.onTranscript   = null; 
    this.onInputTranscript = null;
    this.onTurnComplete = null; 
    this.onToolCall     = null;
    this.onError        = null;
  }

  /**
   * Connect to Gemini Live and configure the session for Leo's personality.
   * @param {string} systemInstruction - Leo's personality + context
   * @param {string} userName - Who Leo is talking to (for personalization)
   */
  async connect(systemInstruction, userName = "the user", options = {}) {
    if (this.ws) this.disconnect();

    const botName = options.botName || 'Leo';
    const mode = options.mode || 'interactive';
    const enableTools = options.enableTools !== false;
    this._connectOptions = { botName, mode, enableTools };

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

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log(`[GeminiLive] WebSocket connected for ${userName} (Gemini 2.5 Native Audio Live)`);

        const fullSystemInstruction = mode === 'interactive'
          ? `${systemInstruction}${LEO_INTERACTIVE_ETIQUETTE}`
          : systemInstruction;

        const voiceName = resolveGeminiVoice(botName);
        const setupPayload = {
          model: process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-preview-12-2025",
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
            automaticActivityDetection: mode === 'outbound' ? {
              disabled: true
            } : {
              disabled: false,
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 400,
              silenceDurationMs: 1800
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
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

        // AUTO-RECONNECT: Google sometimes drops live sessions mid-conversation
        // (e.g. 1008 "not implemented/supported", session time limits). The old
        // behavior left the bridge dead until the user rejoined the channel —
        // Leo just went silent. Now we rebuild the session in place: same
        // personality, same callbacks (they live on this instance).
        if (!this._userClosed && this._lastSystemInstruction) {
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
            console.warn('[GeminiLive] Gave up after 3 reconnect attempts — falling back to local voice until the user rejoins.');
          }
        }
      });
    });
  }

  _handleMessage(msg, connectResolve = null) {
    // Session ready signal
    if (msg.setupComplete || msg.setup_complete) {
      console.log('[GeminiLive] Session ready ✓');
      this.isReady = true;
      connectResolve?.();
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
      const txt = inputTranscription.text.trim();
      // Ignore very short / noisy input transcripts (VAD glitches, "um", single syllables, mic pops).
      // These were causing repeated "interrupted" -> short "transcript ready (3-36 chars)" loops,
      // Gemini treating noise as turns, and spurious tool calls (e.g. kai_status on garbage input).
      if (txt.length >= 8 && /[a-z0-9]/i.test(txt)) {
        this.onInputTranscript?.(txt);
      } else {
        // still log for debugging but don't forward as user speech
        if (txt.length > 0) console.log(`[GeminiLive] Ignoring short/noisy input transcript (${txt.length} chars): "${txt}"`);
      }
    }

    const outputTranscription = serverContent?.outputTranscription || serverContent?.output_transcription;
    if (outputTranscription?.text) {
      this.onTranscript?.(outputTranscription.text);
    }

    if (modelTurn?.parts) {
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
      console.log('[GeminiLive] Turn complete.');
      this.onTurnComplete?.();
      this.audioChunks = [];
    }

    // Interrupted turn (VAD detected user speaking)
    if (serverContent?.interrupted) {
      console.log('[GeminiLive] Gemini interrupted by user speech.');
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
      this.onToolCall?.(fn);
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
  sendText(text) {
    if (!this.isReady || !this.ws) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        text: text
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

  disconnect() {
    this._userClosed = true; // intentional close — suppress auto-reconnect
    this.isActive = false;
    this.isReady = false;
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
      } else if (fn.name === 'search_web') {
        console.log(`[${botName}/Live] Web search: ${query}`);
        try {
          const result = await webSearch(query);
          const text = result ? String(typeof result === 'object' ? JSON.stringify(result) : result).slice(0, 2000) : "No results found.";
          bridge.sendToolResponse('search_web', text, fn.id);
        } catch (e) {
          bridge.sendToolResponse('search_web', `Web search failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'kai_status') {
        console.log(`[${botName}/Live] Fetching KAI's live status + report card...`);
        try {
          const parts = [];
          try {
            const r = await fetch('http://127.0.0.1:3334/api/status', { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
              const s = await r.json();
              parts.push(`ENGINE: ${Number(s.total_cells).toLocaleString()} neurons, ${Number(s.synapses).toLocaleString()} synapses, phi=${Number(s.phi_g).toFixed(2)}. Host CPU ${s.cpu}, RAM ${s.ram}.`);
            }
          } catch (_) { parts.push('ENGINE: unreachable right now.'); }
          try {
            const h = JSON.parse(fs.readFileSync('c:/KAI/data/hippocampus_status.json', 'utf8'));
            parts.push(`MEMORY: ${h.patterns} short-term patterns, ${h.pending_consolidations} queued for sleep replay, ${h.promoted_total} promoted to long-term Universe.`);
          } catch (_) {}
          try {
            const c = JSON.parse(fs.readFileSync('c:/KAI/data/pipeline_curriculum.json', 'utf8'));
            const recent = (c.recent_scores || []).slice(-5).map(x => Math.round(x)).join(', ');
            parts.push(`SCHOOL REPORT: curriculum level ${c.level}, ${c.total_passed}/${c.total_tests} sections passed. Recent quiz averages: ${recent || 'none yet'}. Weak areas: ${(c.weak_areas || []).join(', ') || 'none flagged'}. Retention queue: ${(c.retention_queue || []).length} facts awaiting re-study.`);
          } catch (_) { parts.push('SCHOOL REPORT: no training data found.'); }
          bridge.sendToolResponse('kai_status', parts.join('\n') || 'No status available.', fn.id);
        } catch (e) {
          bridge.sendToolResponse('kai_status', `Status fetch failed: ${e.message}`, fn.id);
        }
      } else if (fn.name === 'read_codex_section') {
        const want = String(args.section || 'next').trim().toLowerCase();
        if (want === 'next') {
          bridge._codexBookmark = (bridge._codexBookmark || 0) + 1;
        } else {
          bridge._codexBookmark = parseInt(want, 10) || 1;
        }
        console.log(`[${botName}/Live] Narrating Codex section ${bridge._codexBookmark}...`);
        try {
          const sec = getCodexSection(bridge._codexBookmark);
          if (!sec) {
            bridge.sendToolResponse('read_codex_section', 'The Codex could not be loaded.', fn.id);
          } else {
            bridge._codexBookmark = sec.number; // clamp bookmark to valid range
            bridge.sendToolResponse('read_codex_section',
              `[Section ${sec.number} of ${sec.total}: ${sec.title}]\n${sec.text}\n\n(Read this aloud naturally. When finished, ask if they want section ${sec.number + 1}.)`,
              fn.id);
          }
        } catch (e) {
          bridge.sendToolResponse('read_codex_section', `Codex read failed: ${e.message}`, fn.id);
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
