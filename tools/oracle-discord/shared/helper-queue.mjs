/**
 * helper-queue.mjs — Dispatcher for Inter-Agent Neural Routing.
 * Scans messages for @mentions and bridges requests between departments.
 */

import { AI_REGISTRY } from './identities.mjs';

const BRIDGE_URL = "http://127.0.0.1:3410/api/bot/signal"; // Oracle IPC Bridge

/**
 * Scans a message for mentions of other AI agents.
 */
export function scanForHelpers(content, currentBotName) {
  const mentions = [];
  for (const [name, data] of Object.entries(AI_REGISTRY)) {
    if (name === currentBotName) continue;
    
    // Check for raw mention <@ID> or Name mention
    const idMention = `<@${data.id}>`;
    const nameMention = `@${name}`;
    
    if (content.includes(idMention) || content.toLowerCase().includes(nameMention.toLowerCase())) {
      mentions.push({ name, ...data });
    }
  }
  return mentions;
}

/**
 * Routes a request to a targeted helper bot.
 */
export async function requestHelp(targetBot, requesterName, requesterChannelId, context) {
  console.log(`[HelperQueue] Routing request from ${requesterName} to ${targetBot.name}...`);
  
  const payload = {
    targetBot: targetBot.name,
    port: targetBot.port,
    type: "HELPER_REQUEST",
    requester: requesterName,
    channelId: requesterChannelId,
    content: context
  };

  try {
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    
    if (res.ok) {
      console.log(`[HelperQueue] Signal delivered to ${targetBot.name} on port ${targetBot.port}.`);
      return true;
    }
    console.error(`[HelperQueue] Bridge failed to route to ${targetBot.name}: ${res.status}`);
  } catch (err) {
    console.error(`[HelperQueue] Network error routing to ${targetBot.name}:`, err.message);
  }
  return false;
}
