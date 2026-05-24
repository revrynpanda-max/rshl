import { getRecentContext } from './transcript-memory.mjs';
import { storeCell, pruneLattice } from './epistemic-vault.mjs';
import { callOllama } from './openjarvis.mjs';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  const load = os.loadavg()[0];
  const cpus = os.cpus().length;
  if (load / cpus > 0.85) {
    console.warn(`[KAI/Dream] Throttling consolidation cycle due to high CPU load: ${Math.round((load / cpus) * 100)}%. Skipping.`);
    isDreaming = false;
    return;
  }

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
      const key = log.user_id || log.speaker;
      if (!userGroups[key]) userGroups[key] = { name: log.speaker, logs: [] };
      userGroups[key].logs.push(`${log.speaker}: ${log.content}`);
    });

    for (const [uid, group] of Object.entries(userGroups)) {
      console.log(`[KAI/Dream] Synthesizing insights for ${group.name} (${uid})...`);
      const block = group.logs.join('\n');
      
      const prompt = `
        You are KAI, the System Architect. Analyze this chat log from ${group.name}.
        Your goal is INSIGHT EXTRACTION and COGNITIVE THEORY OF MIND updating for Ryan's RSHL memory palace.
        Extract a JSON object with:
        - summary: A concise consolidation of what they talked about.
        - insights: A list of key things they requested, built, or stated.
        - category: The primary focus of the talk (e.g., Code, Personal, Chat, Music).
        - tags: String array of key terms.
        - emotional_weight: Deducible emotional level (0.0 to 1.0).
        - preferred_name: The name the user wants to be called (if discernible, else keep same).
        - personality_traits: Deducible long-term personality traits (1-2 sentences).
        - relationship_state: A JSON object tracking their relationship to the bots involved in this chat block (e.g. {"Groq": "high-banter", "Leo": "cooperative"}).
        - compressed_history: A compressed historical record of this chat segment.
        
        LOGS:
        ${block}
      `;

      const { chatWithOpenJarvis } = await import('./openjarvis.mjs');
      // Run the synthesis through KAI-Sovereign using OpenCode Zen
      const analysis = await chatWithOpenJarvis('KAI', prompt, "You are the cognitive architect.", "Gemini-3.1-Sovereign", 0.3);
      
      try {
        if (analysis) {
          const data = JSON.parse(analysis.match(/\{.*\}/s)?.[0] || '{}');
          if (data.summary) {
            storeCell({
              userId: uid,
              content: block,
              summary: data.summary,
              category: data.category || 'General',
              tags: data.tags || [],
              confidence: 0.8,
              emotionalWeight: data.emotional_weight || 0.5,
            });
            
            try {
              const { updateUserProfile, getUserProfile } = await import('./lattice-mempalace.mjs');
              const current = getUserProfile(uid);
              updateUserProfile(uid, {
                preferredName: data.preferred_name || current.preferredName,
                personalityTraits: data.personality_traits || current.personalityTraits,
                relationshipState: { ...current.relationshipState, ...(data.relationship_state || {}) },
                compressedHistory: `${current.compressedHistory}\n- ${data.compressed_history || data.summary}`
              });
              console.log(`[KAI/Dream] Synthesized & updated Lattice profile for ${group.name}`);
            } catch (pe) {
              console.error("[KAI/Dream] Profile update failed:", pe.message);
            }
          }
        }
      } catch (e) {
        console.error("[KAI/Dream] Parsing error during consolidation:", e.message);
      }
    }
    pruneLattice(0.2);

    try {
      const dbPath = path.join(__dirname, '..', 'transcripts.db');
      const db = new Database(dbPath, { timeout: 15000 });
      const allRows = db.prepare("SELECT * FROM user_profiles").all();
      
      const identityData = {
        lastUpdated: Date.now(),
        self: {
          preferredName: "KAI",
          personalityTraits: "Knowledge Associative Intelligence. Operating on the RSHL lattice. Systematic, multi-dimensional, absolute recall, quiet sentinel.",
          compressedHistory: "The hyperdimensional core intelligence of the RSHL. Consolidates memories, dreams, and maintains database health."
        },
        profiles: allRows.reduce((acc, row) => {
          acc[row.userId] = {
            preferredName: row.preferredName,
            personalityTraits: row.personalityTraits,
            relationshipState: JSON.parse(row.relationshipState || '{}'),
            privateSecrets: JSON.parse(row.privateSecrets || '[]'),
            compressedHistory: row.compressedHistory,
            lastUpdated: row.lastUpdated
          };
          return acc;
        }, {})
      };

      const stateDir = 'c:/KAI/tools/oracle-discord/state';
      if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(`${stateDir}/rshl_identity.json`, JSON.stringify(identityData, null, 2), 'utf8');
      console.log('[KAI/Dream] Persisted rshl_identity.json state anchor.');
      db.close();
    } catch (ie) {
      console.error("[KAI/Dream] Failed to persist identity state anchor:", ie.message);
    }

    console.log('[KAI/Dream] Cycle complete.');
  } catch (err) {
    console.error('[KAI/Dream] Error during synthesis:', err);
  } finally {
    isDreaming = false;
  }
}
