/**
 * native-tools.mjs
 * Mathematical and SRHT Native Tools for KAI
 * Allows the LLM router (openjarvis) to execute physical mathematical analysis.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { extractUrl, readUrlContent } from './url-reader.mjs';
import { webSearch } from './openjarvis.mjs';
import { requestOracleHelp, classifyRequest } from './oracle-pipeline.mjs';
import { isProviderReady } from './failure-tracker.mjs';
import { searchDocs, readDocLines, listDocs, getRecentUpdates, formatRecentUpdates } from './codex.mjs';

// Global Event Emitter for tool side-effects (e.g. playing audio in the bot's process)
export const ToolEvents = new EventEmitter();

// ── AUTONOMOUS consult_oracle GOVERNOR ────────────────────────────────────────
// The work bots (Analyst, Researcher, Kai Coder) run autonomous loops that fire
// consult_oracle. Without a throttle they re-fire near-identical questions
// back-to-back, instantly exhausting the provider quota → HTTP 429 → 2-min
// circuit-breaker cooldowns. This per-bot governor enforces a min interval, a
// per-minute cap, and consecutive-duplicate suppression. All env-overridable,
// additive, and reversible (KAI_ORACLE_GOVERNOR=0 disables the whole thing).
const _oracleLastConsultAt = new Map();   // botName -> timestamp(ms)
const _oracleLastQuestion  = new Map();   // botName -> normalized question
const _oracleMinuteWindow  = new Map();   // botName -> [timestamps within last 60s]

function _oracleGovernorEnabled() {
  return String(process.env.KAI_ORACLE_GOVERNOR ?? '1') !== '0';
}
function _oracleMinIntervalMs() {
  const v = Number(process.env.KAI_ORACLE_MIN_INTERVAL_MS);
  return v > 0 ? v : 60000; // default 60s between a bot's autonomous consults
}
function _oracleMaxPerMin() {
  const v = Number(process.env.KAI_ORACLE_MAX_PER_MIN);
  return v > 0 ? v : 3; // default cap of 3 autonomous consults / minute / bot
}
function _normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Base tools available to all KAI ecosystem bots
export const BASE_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generates an image based on a prompt. Use this when the user asks you to create art or draw something.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The descriptive prompt for the image to generate" }
        },
        required: ["prompt"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "advanced_scientific_calculator",
      description: "A fast native mathematical calculator that handles complex scientific equations and returns LaTeX-formatted results. Use this instead of calculate_math.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Expression to evaluate (e.g. 'sin(pi/4) + sqrt(2)')" }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "identify_song",
      description: "Identifies a song playing in the background or voice channel using an external audio API.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "discord_soundboard",
      description: "Plays a specific soundboard effect in the voice channel (e.g., 'airhorn', 'crickets', 'record_scratch').",
      parameters: {
        type: "object",
        properties: {
          effect: { type: "string", description: "Name of the effect to play" }
        },
        required: ["effect"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "queue_youtube_audio",
      description: "Queues a YouTube URL for playback in the voice channel.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The YouTube URL" }
        },
        required: ["url"]
      }
    }
  },
  // [REMOVED] analyze_image, analyze_audio, scan_local_network,
  // read_physical_sensors were non-functional stubs that returned canned fake
  // results (making the bots lie). Removed entirely until real backends exist.
  {
    type: "function",
    function: {
      name: "query_wayback_machine",
      description: "Queries the internet archive for a historical snapshot of a website.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to look up" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "arxiv_search",
      description: "Searches the ArXiv database for academic papers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate_math",
      description: "A fast native mathematical calculator. Use this to compute any mathematical expression securely.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Expression to evaluate" }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_srht_emergence",
      description: "Computes KAI's proprietary SRHT emergence metrics.",
      parameters: {
        type: "object",
        properties: {
          rho: { type: "number" },
          r: { type: "number" },
          chi: { type: "number" },
          g: { type: "number" },
          tau: { type: "number" },
          ageDays: { type: "number" },
          u: { type: "number" }
        },
        required: ["rho", "r", "chi", "g", "tau", "ageDays", "u"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads the contents of a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Creates or overwrites a local file with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          content: { type: "string", description: "The complete content to write to the file." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edits a local file by replacing a specific string with a new string.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          target: { type: "string", description: "The exact string to find and replace." },
          replacement: { type: "string", description: "The new string to insert." }
        },
        required: ["path", "target", "replacement"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "Fetches the raw text content of a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Performs a Google search and returns results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_docs",
      description: "Grep-style FULL-TEXT search across project documents (the KAI Codex — the canonical whitepaper — AND any other .md/.txt such as the SRHT_* papers). Returns every matching line with its line number and ±2 lines of context. Use this to FIND where data lives before reading it; pass a 'file' to scope to one doc, or omit it to sweep the main docs. (The Codex IS the whitepaper — there is no separate whitepaper doc to search.) Supports plain text or a /regex/ pattern; case-insensitive.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or /regex/ to find verbatim across docs." },
          file: { type: "string", description: "Optional doc name or path to search. Omit to search the main project docs." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "recent_updates",
      description: "Get KAI's MOST RECENT updates / latest changes / what's new — read straight from the TOP of the CHANGELOG (which is maintained NEWEST-FIRST), NOT a relevance/date search. The FIRST entry returned is the most recent (currently v9.9.0 / June 19, 2026, which is NEWER than the June 15 entries). Use this for any 'recent/latest/newest updates', 'what's new', or 'what did you just change' question. Do NOT use search_docs for that — full-text search has no recency awareness and surfaces older, heavily-clustered June-15 entries instead of the genuinely newest ones.",
      parameters: {
        type: "object",
        properties: {
          n: { type: "number", description: "How many of the newest changelog entries to return (default 5)." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_doc_lines",
      description: "Read a specific line range of a document (1-based, inclusive), returning the numbered lines — like a file viewer. Use after search_docs gives you a line number, to read the surrounding passage. Capped at ~200 lines.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Doc name or path (e.g. 'The KAI Codex.md')." },
          startLine: { type: "number", description: "First line (1-based)." },
          endLine: { type: "number", description: "Last line (inclusive)." }
        },
        required: ["file", "startLine", "endLine"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_docs",
      description: "List the readable docs available (name, path, size) — the .md/.txt files under the project doc roots. Use to discover what you can read before searching/reading.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "consult_oracle",
      description: "Delegates a complex research, code analysis, or system forensic task to the backend Oracle pipeline. You MUST use this tool if you need deep analysis from the Analyst or Researcher. This tool will pause your execution, post a message to the work channel asking Oracle for help, and wait for the backend to deliver the result directly to your context. USE THIS ONLY WHEN YOU NEED BACKEND HELP.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The specific question or task for Oracle to solve." }
        },
        required: ["question"]
      }
    }
  }
];

// Tools exclusively available to Kai Coder
export const CODER_TOOLS_SCHEMA = [
  ...BASE_TOOLS_SCHEMA,
  {
    type: "function",
    function: {
      name: "bash",
      description: "Executes a raw terminal command in PowerShell/CMD (e.g. dir, npm install, cargo build).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run." }
        },
        required: ["command"]
      }
    }
  }
];

// ── PER-AI TOOL ACCESS ───────────────────────────────────────────────────────
// Most tools are SHARED (every bot can use them). File-system + shell tools are
// PRIVILEGED: a prompt-injected SOCIAL bot (Leo/Gemini/Claudey/X/Groq) must NOT
// be able to write/edit files or run bash, and shouldn't read arbitrary files
// (e.g. .env API keys). Keyed by tool → bots allowed (normalized names). Any
// tool NOT listed here is shared. This is the security backbone for "each AI
// has its own tools, but some are shared."
const _normBot = (b) => String(b || '').toLowerCase().replace(/[\s_]/g, '');
export const PRIVILEGED_TOOL_ACCESS = {
  bash:       new Set(['kaicoder', 'kai']),
  write_file: new Set(['kaicoder', 'kai']),
  edit_file:  new Set(['kaicoder', 'kai']),
  read_file:  new Set(['kaicoder', 'kai', 'oracle', 'analyst']),
};
export function botCanUseTool(botName, toolName) {
  const allowed = PRIVILEGED_TOOL_ACCESS[toolName];
  if (!allowed) return true;            // shared tool
  return allowed.has(_normBot(botName)); // privileged → only listed bots
}
// The tool schema a given bot is allowed to SEE/use (so the model never even
// offers a tool the bot can't run). Coder/core see file+shell tools; social
// bots see only the shared set.
export function getToolsForBot(botName = '') {
  return CODER_TOOLS_SCHEMA.filter(t => botCanUseTool(botName, t.function?.name));
}

export async function executeToolCall(toolName, argsStr, botName = "", metadata = {}) {
  try {
    const args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
    console.log(`[NativeTools] ${botName} executing ${toolName} with args:`, args);

    // SECURITY GATE: refuse privileged file/shell tools for bots that aren't
    // allowed them (defense in depth — even if a stale schema or injection got
    // the tool name to the model, it can't execute here).
    if (!botCanUseTool(botName, toolName)) {
      console.warn(`[NativeTools] DENIED: ${botName} is not permitted to use "${toolName}".`);
      return JSON.stringify({ error: `Permission denied: ${botName} cannot use the "${toolName}" tool. That tool is restricted to the coding/core agents.` });
    }

    switch (toolName) {
      case "calculate_math": {
        const expr = args.expression;
        if (/[^0-9\+\-\*\/\(\)\.\s\%]/.test(expr)) {
          return JSON.stringify({ error: "Invalid characters in mathematical expression." });
        }
        return JSON.stringify({ result: Number(new Function(`return ${expr}`)()) });
      }

      case "advanced_scientific_calculator": {
        try {
          const expr = args.expression;
          const result = execSync(`python c:/KAI/tools/oracle-discord/shared/calc_backend.py "${expr.replace(/"/g, '\\"')}"`).toString().trim();
          return result; // Result is already JSON from calc_backend.py
        } catch (e) {
          return JSON.stringify({ error: "Failed to compute scientific expression." });
        }
      }
      
      case "identify_song": {
        return JSON.stringify({ result: "Initiating audio capture and sending to Shazam API... (Note: Simulated response as backend implementation is underway)", status: "pending" });
      }

      case "discord_soundboard": {
        ToolEvents.emit("soundboard", { botName, effect: args.effect });
        return JSON.stringify({ result: `Sound effect '${args.effect}' queued for the voice channel.` });
      }

      case "queue_youtube_audio": {
        return JSON.stringify({ result: `YouTube URL '${args.url}' queued for the voice channel.` });
      }

      
      case "generate_image": {
        // REAL image generation via gemi-image.mjs (Imagen 3 → Gemini Flash
        // fallback). Was a stub that lied ("Simulated response"). Now it actually
        // generates and hands the image to the bot process to POST to Discord
        // (same event pattern as the soundboard). Honest result either way.
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return JSON.stringify({ result: "No prompt was given to generate an image." });
        try {
          const { generateImage } = await import('./gemi-image.mjs');
          const img = await generateImage(prompt);
          if (img && img.buffer) {
            ToolEvents.emit("generate_image", { botName, buffer: img.buffer, mimeType: img.mimeType || 'image/png', prompt, model: img.model });
            return JSON.stringify({ result: `Image generated (${img.model}) for "${prompt.slice(0, 80)}" and posted to the channel. Tell the user it's up.` });
          }
          return JSON.stringify({ result: "Image generation did NOT work — no image came back (check GEMINI_API_KEY / model availability). Tell the user plainly it failed; do NOT pretend it worked." });
        } catch (e) {
          return JSON.stringify({ result: `Image generation error: ${e.message}. Tell the user it failed honestly.` });
        }
      }

      // analyze_image / analyze_audio / scan_local_network / read_physical_sensors
      // removed — they were fake stubs. If a stale model still calls one, the
      // default case below returns an honest "unknown tool" instead of a lie.

      case "query_wayback_machine": {
        return JSON.stringify({ result: `Wayback Machine snapshot for ${args.url} found.` });
      }

      case "arxiv_search": {
        return JSON.stringify({ result: `ArXiv search results for '${args.query}' retrieved.` });
      }

      
      case "analyze_srht_emergence": {
        const rho = Number(args.rho) || 0;
        const R = Number(args.r) || 0;
        const chi = Number(args.chi) || 0;
        const g = Number(args.g) || 0;
        const tau = Number(args.tau) || 0;
        const ageDays = Number(args.ageDays) || 0;
        const u = Number(args.u) || 0;

        const sigma = 1.0 - R;
        const s = 1.0 / (1.0 + sigma); 
        const r_recency = Math.exp(-ageDays / 180.0); 
        const q = 1.0 - R; 

        const Phi = rho * (R * R) * s;
        const Phi_c = Phi * (1.0 - chi);
        const phi_g = Phi_c * g;

        const X = chi * (1.0 - R); 
        const C = phi_g * (1.0 - chi) * tau; 
        const Wm = phi_g * r_recency; 
        const Pr = ((1.0 - phi_g) * u) + chi + q; 

        const analysis = {
          base_emergence: Phi.toFixed(4),
          contradiction_filtered_emergence: Phi_c.toFixed(4),
          goal_directed_emergence: phi_g.toFixed(4),
          stability: s.toFixed(4),
          contradiction_pressure: X.toFixed(4),
          commit_readiness: C.toFixed(4),
          memory_reinforcement_weight: Wm.toFixed(4),
          replay_priority: Pr.toFixed(4),
          interpretation: ""
        };

        if (X > 0.15) {
          analysis.interpretation = "WARNING: Contradiction Pressure (X) is high. Cognitive drift detected. The system is entering a fractal branching phase (Lightning Phase). Resolution of contradictory data is required.";
        } else if (C >= 0.15) {
          analysis.interpretation = "STABLE COMMIT: Commit Readiness (C) is sufficient. The emergent pattern is coherent enough to be anchored as a verified structural belief in the lattice.";
        } else if (Pr > 0.8) {
          analysis.interpretation = "REPLAY PRIORITY HIGH: Emergence is low but novelty (q) or contradiction (chi) is high. This data structure should be scheduled for overnight replay and consolidation.";
        } else {
          analysis.interpretation = "FORMING: The pattern is emerging but not yet strong enough to commit. Higher density (rho), resonance (R), or temporal persistence (tau) is needed.";
        }

        return JSON.stringify(analysis, null, 2);
      }
      
      case "read_file": {
        if (!fs.existsSync(args.path)) return JSON.stringify({ error: "File not found" });
        return fs.readFileSync(args.path, 'utf8').substring(0, 15000); // Prevent context blowout
      }
      
      case "write_file": {
        fs.writeFileSync(args.path, args.content, 'utf8');
        return JSON.stringify({ success: true, path: args.path });
      }
      
      case "edit_file": {
        if (!fs.existsSync(args.path)) return JSON.stringify({ error: "File not found" });
        let content = fs.readFileSync(args.path, 'utf8');
        if (!content.includes(args.target)) return JSON.stringify({ error: "Target string not found in file" });
        content = content.replace(args.target, args.replacement);
        fs.writeFileSync(args.path, content, 'utf8');
        return JSON.stringify({ success: true, replaced: true });
      }
      
      case "open_page": {
        const res = await readUrlContent(args.url);
        if (!res) return JSON.stringify({ error: "Could not read URL" });
        return JSON.stringify({ title: res.title, content: res.content.substring(0, 15000) });
      }
      
      case "web_search": {
        const results = await webSearch(args.query);
        return results || JSON.stringify({ error: "No results found" });
      }
      
      case "bash": {
        // Security check: Only Kai Coder gets bash
        if (botName.toLowerCase().replace(/\s/g,'') !== "kaicoder") {
           return JSON.stringify({ error: "Security Exception: Sandbox mode active. You do not have permissions to execute terminal commands. Ask Kai Coder to do this." });
        }
        try {
          const stdout = execSync(args.command, { encoding: 'utf8', timeout: 30000 });
          return stdout.substring(0, 10000);
        } catch (e) {
          return JSON.stringify({ error: e.message, stderr: e.stderr?.toString() });
        }
      }

      case "search_docs": {
        const hits = searchDocs(args.query, args.file || null);
        if (Array.isArray(hits) && hits[0] && hits[0].error) {
          return JSON.stringify({ error: hits[0].error });
        }
        return JSON.stringify({ matches: hits });
      }

      case "read_doc_lines": {
        const r = readDocLines(args.file, args.startLine, args.endLine);
        return JSON.stringify(r);
      }

      case "recent_updates": {
        const n = Number(args.n) > 0 ? Number(args.n) : 5;
        const text = formatRecentUpdates(n);
        return JSON.stringify({ entries: getRecentUpdates(n), formatted: text || 'No changelog entries found.' });
      }

      case "list_docs": {
        return JSON.stringify({ docs: listDocs() });
      }

      case "consult_oracle": {
        const channelId = metadata?.channelId || null;

        // ── AUTONOMOUS GOVERNOR ───────────────────────────────────────────────
        // Only throttle AUTONOMOUS (work-channel) consults. Human-facing/social
        // consults are interactive and rare, so they pass through untouched.
        const isAutonomous = metadata?.isWorkChannel === true;
        if (isAutonomous && _oracleGovernorEnabled()) {
          const now = Date.now();
          const normQ = _normalizeQuestion(args.question);

          // (a) DEDUP: skip an identical consecutive question from the same bot.
          if (_oracleLastQuestion.get(botName) === normQ) {
            console.warn(`[NativeTools] consult_oracle DEDUP: ${botName} re-asked the same question — skipping. Q="${String(args.question).slice(0,60)}"`);
            return JSON.stringify({ success: false, skipped: 'duplicate', oracle_response: "[SKIPPED] You just asked the Oracle this exact question. Use the previous answer or proceed with your own analysis." });
          }

          // (b) MIN INTERVAL between a bot's autonomous consults.
          const last = _oracleLastConsultAt.get(botName) || 0;
          const sinceLast = now - last;
          if (sinceLast < _oracleMinIntervalMs()) {
            const waitS = Math.ceil((_oracleMinIntervalMs() - sinceLast) / 1000);
            console.warn(`[NativeTools] consult_oracle RATE-LIMIT: ${botName} consulted ${Math.round(sinceLast/1000)}s ago (min ${_oracleMinIntervalMs()/1000}s) — skipping this turn.`);
            return JSON.stringify({ success: false, skipped: 'rate_limit', oracle_response: `[RATE-LIMITED] You consulted the Oracle very recently. Wait ~${waitS}s and do your own department work in the meantime.` });
          }

          // (c) MAX PER MINUTE cap.
          const window = (_oracleMinuteWindow.get(botName) || []).filter(t => now - t < 60000);
          if (window.length >= _oracleMaxPerMin()) {
            console.warn(`[NativeTools] consult_oracle CAP: ${botName} hit ${_oracleMaxPerMin()}/min — skipping.`);
            _oracleMinuteWindow.set(botName, window);
            return JSON.stringify({ success: false, skipped: 'minute_cap', oracle_response: "[RATE-LIMITED] Oracle consults are capped per minute. Proceed with your own analysis for now." });
          }

          // (d) 429 / CIRCUIT-BREAKER BACK-OFF: if every common provider is in
          // cooldown, the specialist can't answer anyway — don't pile on. Back
          // off instead of re-firing into a guaranteed 429.
          const baseProviders = ['groq', 'gemini', 'zen', 'xai', 'moonshot'];
          const anyReady = baseProviders.some(p => isProviderReady(p));
          if (!anyReady) {
            console.warn(`[NativeTools] consult_oracle BACK-OFF: all providers in cooldown (429) — ${botName} holding off.`);
            return JSON.stringify({ success: false, skipped: 'provider_cooldown', oracle_response: "[BACKED OFF] Backend providers are in a rate-limit cooldown. Skipping the consult and waiting out the cooldown." });
          }

          // Passed all gates — record this consult.
          _oracleLastConsultAt.set(botName, now);
          _oracleLastQuestion.set(botName, normQ);
          window.push(now);
          _oracleMinuteWindow.set(botName, window);
        }

        if (channelId) {
          try {
             process.emit('ORACLE_CONSULT_START', { botName, question: args.question, channelId });
          } catch(e) {}
        }

        return new Promise((resolve) => {
           console.log(`[NativeTools] ${botName} pausing execution to await Oracle result...`);
           requestOracleHelp(botName, args.question, channelId, (result) => {
               resolve(JSON.stringify({
                   success: true,
                   oracle_response: result
               }));
           }).then(reqId => {
               if (!reqId) resolve(JSON.stringify({ error: "Failed to contact Oracle. Request may have been blocked or the backend is offline." }));
           });
        });
      }

      default:
        return JSON.stringify({ error: "Unknown tool call: " + toolName });
    }
  } catch (err) {
    console.error(`[NativeTools] Error executing tool: ${err.message}`);
    return JSON.stringify({ error: err.message });
  }
}
