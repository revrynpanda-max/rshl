import { getRecentContext } from './transcript-memory.mjs';
import { storeCell, pruneLattice } from './epistemic-vault.mjs';
import { callOllama } from './openjarvis.mjs';
import fs from 'fs';

const DREAM_INTERVAL_MS = 45 * 60 * 1000; // 45 Minutes
let isDreaming = false;

/**
 * KAI's Dream Cycle: Background synthesis of raw transcripts into Epistemic Knowledge.
 */
export async function startDreamCycle() {
  console.log('[KAI/Dream] Initializing synaptic maintenance loop (45m cycle)...');
  setInterval(async () => {
    if (isDreaming) return;
    await performDreamCycle();
  }, DREAM_INTERVAL_MS);
}

// ALIAS for legacy code (oracle-gateway.mjs)
export async function runKaiConsolidation() {
  return performDreamCycle();
}

/**
 * Check if the daily briefing has already been generated.
 */
export function hasTodaysBriefing() {
  const date = new Date().toISOString().split('T')[0];
  const flagFile = `c:/KAI/tools/oracle-discord/state/briefing_${date}.json`;
  return fs.existsSync(flagFile);
}

export async function performDreamCycle() {
  isDreaming = true;
  console.log('[KAI/Dream] Starting consolidation cycle...');

  try {
    const rawLogs = getRecentContext(50);
    if (rawLogs.length < 5) {
      console.log('[KAI/Dream] Insufficient new data for synthesis. Skipping.');
      isDreaming = false;
      return;
    }

    const userGroups = {};
    rawLogs.forEach(log => {
      if (log.speaker === 'System' || log.speaker.includes('Bot')) return;
      if (!userGroups[log.speaker]) userGroups[log.speaker] = [];
      userGroups[log.speaker].push(`${log.speaker}: ${log.content}`);
    });

    for (const [username, logs] of Object.entries(userGroups)) {
      console.log(`[KAI/Dream] Synthesizing insights for ${username}...`);
      const block = logs.join('\n');
      
      const prompt = `
        You are KAI, the System Architect. Analyze this chat log from ${username}.
        Your goal is INSIGHT EXTRACTION, not just summarization.
        Extract a JSON object with: summary, insights (list), meta_memories (list), emotional_weight (0-1), category, tags.
        LOGS: ${block}
      `;

      const analysis = await callOllama('KAI-Sovereign', prompt);
      
      try {
        const data = JSON.parse(analysis.match(/\{.*\}/s)?.[0] || '{}');
        if (data.summary) {
          storeCell({
            userId: username,
            content: block,
            summary: data.summary,
            category: data.category || 'General',
            tags: data.tags || [],
            confidence: 0.8,
            emotionalWeight: data.emotional_weight || 0.5,
          });
          console.log(`[KAI/Dream] Synthesized ${username}: ${data.summary}`);
        }
      } catch (e) {}
    }
    pruneLattice(0.2);
    console.log('[KAI/Dream] Cycle complete.');
  } catch (err) {
    console.error('[KAI/Dream] Error during synthesis:', err);
  } finally {
    isDreaming = false;
  }
}
