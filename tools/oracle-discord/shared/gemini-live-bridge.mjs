/**
 * gemini-live-bridge.mjs
 *
 * Real-time audio bridge using Gemini 2.0 Flash Live.
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
 * Model:    gemini-2.0-flash-live-001 (fastest real-time audio model)
 */

import WebSocket from 'ws';
import fetch from 'node-fetch';

// v1beta supports the latest 2026 live models
const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;

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
    this.onTurnComplete = null; 
    this.onToolCall     = null;
    this.onError        = null;
  }

  /**
   * Connect to Gemini Live and configure the session for Leo's personality.
   * @param {string} systemInstruction - Leo's personality + context
   * @param {string} userName - Who Leo is talking to (for personalization)
   */
  async connect(systemInstruction, userName = "the user") {
    if (this.ws) this.disconnect();

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
        console.log(`[GeminiLive] WebSocket connected for ${userName} (Gemini 3.1 Live)`);

        // Send session setup with strict group etiquette
        this.ws.send(JSON.stringify({
          setup: {
            model: "models/gemini-3.1-flash-live-preview",
            system_instruction: {
              role: "system",
              parts: [{
                text: `${systemInstruction}\n\n[GROUP ETIQUETTE]\n- You are in a group voice channel with multiple AIs and humans.\n- ONLY RESPOND if you are explicitly addressed by name (e.g. "Hey ${userName}", or "What do you think, ${userName}?").\n- If you are not addressed, stay silent and listen.\n- If you are addressed but another AI is already speaking, wait for your turn.\n- Keep responses short, energetic, and social. No formal openers.\n- STRICT RESPONSE LIMIT: MAXIMUM 2 TO 3 SENTENCES. Speak in 2-3 short, punchy sentences max per message. Keep it extremely brief and snappy. NEVER output a paragraph of text.`
              }]
            },
            tools: [ 
              { google_search_retrieval: {} },
              {
                function_declarations: [
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
                  }
                ]
              }
            ],
            generation_config: {
              response_modalities: ["AUDIO"],
              speech_config: {
                voice_config: {
                  prebuilt_voice_config: { voice_name: "Fenrir" } // Deep, natural male voice
                }
              }
            },
            system_instruction: {
              parts: [{ text: systemInstruction }]
            },
            // Server-side Voice Activity Detection: Gemini auto-detects when user stops speaking
            realtime_input_config: {
              automatic_activity_detection: {
                disabled: false,
                // HIGH start sensitivity — catches word starts more aggressively
                // Valid API values: START_SENSITIVITY_HIGH | START_SENSITIVITY_LOW
                start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
                end_of_speech_sensitivity: "END_SENSITIVITY_LOW", // Don't cut off mid-thought
                prefix_padding_ms: 500,   // More lead-in to catch word starts cleanly
                silence_duration_ms: 2000  // 2s gap before treating speech as finished (prevents cutting friends)
              }
            }
          }
        }));
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
        this.onError?.(err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[GeminiLive] Connection closed: ${code} ${reason}`);
        this.isReady = false;
        this.isActive = false;
      });
    });
  }

  _handleMessage(msg, connectResolve = null) {
    // Session ready signal
    if (msg.setup_complete) {
      console.log('[GeminiLive] Session ready ✓');
      this.isReady = true;
      connectResolve?.();
      return;
    }

    // Tool calling logic
    if (msg.server_content?.tool_call) {
      this._handleToolCall(msg.server_content.tool_call);
    }

    // Incoming audio delta from Gemini
    if (msg.server_content?.model_turn?.parts) {
      for (const part of msg.server_content.model_turn.parts) {
        if (part.inline_data?.mime_type?.startsWith('audio/')) {
          this.audioChunks.push(part.inline_data.data);
          this.onAudioChunk?.(part.inline_data.data); // Streaming delivery
        }
        if (part.text) {
          this.onTranscript?.(part.text);
        }
        if (part.call) {
           this._handleToolCall(part.call);
        }
      }
    }

    // Turn complete — Gemini stopped speaking
    if (msg.server_content?.turn_complete) {
      console.log('[GeminiLive] Turn complete.');
      this.onTurnComplete?.();
      this.audioChunks = [];
    }

    // Interrupted turn (VAD detected user speaking)
    if (msg.server_content?.interrupted) {
      console.log('[GeminiLive] Gemini interrupted by user speech.');
      this.audioChunks = [];
    }

    // Error from server
    if (msg.error) {
      console.error('[GeminiLive] Server error:', msg.error);
      this.onError?.(new Error(msg.error.message || 'Gemini server error'));
    }
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

    // New 2026 Format: Direct 'audio' field within 'realtime_input'
    this.ws.send(JSON.stringify({
      realtime_input: {
        audio: {
          mime_type: "audio/pcm;rate=16000",
          data: base64
        }
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
      realtime_input: {
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
  static decodeAudioChunk(base64) {
    const pcm24k = Buffer.from(base64, 'base64');
    // Upsample 24kHz mono → 48kHz stereo (simple 2x + stereo dup)
    const numSamples = pcm24k.length / 2;
    const out = Buffer.allocUnsafe(numSamples * 4 * 2); // 2x samples, 2 channels, 2 bytes

    for (let i = 0; i < numSamples; i++) {
      const sample = pcm24k.readInt16LE(i * 2);
      // Write 2 frames (upsample) × 2 channels each
      for (let dup = 0; dup < 2; dup++) {
        out.writeInt16LE(sample, (i * 2 + dup) * 4);     // L
        out.writeInt16LE(sample, (i * 2 + dup) * 4 + 2); // R
      }
    }
    return out;
  }

  disconnect() {
    this.isActive = false;
    this.isReady = false;
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }

  get available() {
    return !!(process.env.GEMINI_API_KEY) && this.isReady && this.isActive;
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

  async getOrCreate(userId, botName, systemInstruction, userName) {
    const sessionKey = `${userId}-${botName}`;
    if (this.sessions.has(sessionKey)) {
      const existing = this.sessions.get(sessionKey);
      if (existing.available) return existing;
      existing.disconnect();
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('[GeminiLive] No GEMINI_API_KEY — falling back to Groq pipeline');
      return null;
    }

    const bridge = new GeminiLiveBridge(apiKey);
    await bridge.connect(systemInstruction, userName);

    // ATTACH LATTICE MEMORY SEARCH TOOL HANDLER
    bridge.onToolCall = async (fn) => {
      if (fn.name === 'search_lattice') {
        const query = fn.args.query;
        console.log(`[${botName}/Live] Searching Lattice for: ${query}`);
        try {
          const res = await fetch(`http://127.0.0.1:3334/api/rshl/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: 5 })
          });
          if (res.ok) {
            const hits = await res.json();
            const context = hits.map(h => h.text).join('\n');
            bridge.sendToolResponse('search_lattice', context || "No specific memory found.");
          } else {
            bridge.sendToolResponse('search_lattice', "Lattice temporarily unreachable.");
          }
        } catch (e) {
          bridge.sendToolResponse('search_lattice', `Search failed: ${e.message}`);
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
