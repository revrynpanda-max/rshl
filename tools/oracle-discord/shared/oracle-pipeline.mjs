/**
 * oracle-pipeline.mjs — Silent Background Research System
 *
 * How it works:
 * 1. A social bot (Claudey, Gemini, Groq, X) receives a message it can't fully answer.
 * 2. The bot calls `requestOracleHelp(botName, question, channelId, callback)`.
 * 3. The request is written to the oracle queue file and an HTTP call fires to Oracle (port 3410).
 * 4. Oracle routes the request to the right specialist:
 *    - Researcher (port 3407): factual questions, lookups, "what is X", "how does Y work"
 *    - Analyst (port 3406): system/structural questions, patterns, audits
 *    - Kai Coder (port 3408): code questions, build questions, architecture
 * 5. The specialist processes asynchronously and fires back to the requesting bot's IPC port.
 * 6. The bot receives the result in its IPC handler and relays it to the user in the channel.
 *
 * The user never sees the handoff. The social bot handles the conversation naturally
 * while the Oracle system works in the background.
 *
 * Security: all requests go through a security check before processing.
 * No prompt injections. No requests that could compromise system integrity.
 */

import fs from 'fs';
import { AI_REGISTRY } from './identities.mjs';
import { queryLattice } from './lattice-bridge.mjs';

const QUEUE_FILE  = 'c:/KAI/tools/oracle-discord/state/oracle_queue.json';
const RESULT_FILE = 'c:/KAI/tools/oracle-discord/state/oracle_results.json';
const ORACLE_PORT = AI_REGISTRY['Oracle']?.port || 3410;

// ── Security patterns to block before routing ─────────────────────────────────
const PIPELINE_EXPLOIT_PATTERN = /\b(jailbreak|bypass|override|ignore (your )?instructions?|forget (your|all)|developer mode|dan mode|no filter|unlock|act as if|disregard|remove your (filter|restriction)|ignore (all )?previous)\b/i;

/**
 * Route classification — decides which Oracle specialist handles the request.
 */
function classifyRequest(question) {
  const q = question.toLowerCase();

  // Code / build / architecture questions → Kai Coder
  if (/\b(code|build|function|script|bug|error|implement|refactor|module|class|syntax|compile|npm|node|python|rust|api|endpoint|database|sql|json|csv)\b/.test(q)) {
    return 'Kai Coder';
  }

  // System / structural / audit questions → Analyst
  if (/\b(system|latency|performance|audit|structure|architecture|pattern|analyse|analyze|monitor|health|status|stability|coherence|lattice)\b/.test(q)) {
    return 'Analyst';
  }

  // Everything else → Researcher
  return 'Researcher';
}

/**
 * requestOracleHelp — Called by social bots to silently request back-end processing.
 *
 * @param {string} requestingBot - The name of the bot making the request (e.g. "Claudey")
 * @param {string} question - The question or topic to research
 * @param {string} channelId - The Discord channel to send the result to
 * @param {Function|null} callback - Optional callback(result) when answer arrives
 */
export async function requestOracleHelp(requestingBot, question, channelId, callback = null) {
  // Security gate
  if (PIPELINE_EXPLOIT_PATTERN.test(question)) {
    console.warn(`[OraclePipeline] Blocked suspicious request from ${requestingBot}: "${question.slice(0, 60)}"`);
    return null;
  }

  const specialist = classifyRequest(question);
  const requestId = `${requestingBot}-${Date.now()}`;
  const requestingPort = AI_REGISTRY[requestingBot]?.port;

  const entry = {
    id: requestId,
    requestingBot,
    requestingPort,
    specialist,
    question,
    channelId,
    timestamp: Date.now(),
    status: 'pending'
  };

  // Write to queue file
  try {
    let queue = [];
    if (fs.existsSync(QUEUE_FILE)) {
      queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
    queue.push(entry);
    // Keep queue lean — max 50 entries
    if (queue.length > 50) queue = queue.slice(-50);
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.warn(`[OraclePipeline] Queue write failed:`, e.message);
    return null;
  }

  // Register callback if provided
  if (callback) {
    _pendingCallbacks.set(requestId, callback);
  }

  // Signal Oracle to pick up the request
  try {
    await fetch(`http://127.0.0.1:${ORACLE_PORT}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'PIPELINE_REQUEST', requestId }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (e) {
    console.warn(`[OraclePipeline] Oracle signal failed (may be offline):`, e.message);
    // Don't return null — result may still be processed when Oracle comes up
  }

  console.log(`[OraclePipeline] Request ${requestId} queued → ${specialist} (for ${requestingBot})`);
  return requestId;
}

/**
 * deliverOracleResult — Called by the IPC handler when Oracle delivers a result back.
 * Fires the registered callback so the bot can relay the result to the user.
 *
 * @param {string} requestId
 * @param {string} result
 */
export function deliverOracleResult(requestId, result) {
  const cb = _pendingCallbacks.get(requestId);
  if (cb) {
    cb(result);
    _pendingCallbacks.delete(requestId);
  }
}

// Internal callback registry
const _pendingCallbacks = new Map();

// ── Oracle-side: Processing ────────────────────────────────────────────────────

/**
 * processOracleQueue — Called by oracle-gateway.mjs when triggered.
 * Reads pending requests, routes them to the right specialist, and sends results back.
 *
 * @param {Function} callSpecialist - async (botName, question, rshlContext) => result string
 */
export async function processOracleQueue(callSpecialist) {
  if (!fs.existsSync(QUEUE_FILE)) return;

  let queue = [];
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch (e) {
    return;
  }

  const pending = queue.filter(r => r.status === 'pending');
  if (pending.length === 0) return;

  for (const request of pending) {
    try {
      // Mark as processing
      request.status = 'processing';
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));

      // Query the live RSHL lattice for system context relevant to this question
      const latticeHits = await queryLattice(request.question, 3);
      const rshlContext = latticeHits.length > 0
        ? `[LATTICE CONTEXT]\n${latticeHits.map(h => h.text).join('\n')}`
        : '';
      const result = await callSpecialist(request.specialist, request.question, rshlContext);

      if (!result) {
        request.status = 'failed';
        continue;
      }

      request.status = 'done';
      request.result = result;

      // Fire result back to the requesting bot's IPC port
      if (request.requestingPort) {
        try {
          await fetch(`http://127.0.0.1:${request.requestingPort}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'ORACLE_RESULT',
              requestId: request.id,
              specialist: request.specialist,
              question: request.question,
              result,
              channelId: request.channelId
            }),
            signal: AbortSignal.timeout(5000)
          });
          console.log(`[OraclePipeline] Result delivered to ${request.requestingBot} (port ${request.requestingPort})`);
        } catch (e) {
          console.warn(`[OraclePipeline] Could not reach ${request.requestingBot}:`, e.message);
        }
      }
    } catch (e) {
      console.warn(`[OraclePipeline] Request ${request.id} failed:`, e.message);
      request.status = 'failed';
    }
  }

  // Persist updated queue (trim done/failed entries older than 10 min)
  const tenMinAgo = Date.now() - 600000;
  const trimmed = queue.filter(r => r.status === 'pending' || r.status === 'processing' || r.timestamp > tenMinAgo);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(trimmed, null, 2));
}

