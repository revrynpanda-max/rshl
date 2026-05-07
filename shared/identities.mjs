/**
 * identities.mjs — Centralized Identity Registry for Humans and AIs.
 * This links names, roles, and Discord IDs for strict traffic control.
 */

export const HUMAN_REGISTRY = {
  [process.env.OWNER_NAME || "Ryan"]: {
    id: process.env.OWNER_ID || "1111106883135217665",
    role: "Owner/Creator",
    username: process.env.OWNER_USERNAME || "nastermodx"
  }
  // All other users are now resolved dynamically via the MemPalace Bridge.
};

export const AI_REGISTRY = {
  "Analyst":   { id: "1499327113075888218", port: 3406 },
  "Claude":    { id: "1499022611542180051", port: 3403 },
  "Gemini":    { id: "1499022418990203034", port: 3402 },
  "Groq":      { id: "1499327027004575794", port: 3405 },
  "KAI":       { id: "1499022265973604372", port: 3401 },
  "Kai Coder": { id: "1499960413691969536", port: 3408 },
  "Leo":       { id: "1499020954054168678", port: 3400 },
  "Oracle":    { id: "1498794939650412674", port: 3410 },
  "Researcher":{ id: "1499326874608865280", port: 3407 },
  "X":         { id: "1499022834536808458", port: 3404 }
};

export const HUMAN_IDS = new Set(Object.values(HUMAN_REGISTRY).map(h => h.id));
export const AI_IDS = new Set(Object.values(AI_REGISTRY).map(a => a.id));

/**
 * MemPalace Bridge: Dynamically resolve identities from the RSHL/ChromaDB lattice.
 */
export async function resolveIdentityFromMemory(userId, username) {
  // 1. GHOST SUPPRESSION: Ignore system/null users
  if (!userId || userId === "null" || username === "System") return null;

  // 2. OWNER SUPREMACY: Check the Sovereign Registry first
  const ownerId = process.env.OWNER_ID || "1111106883135217665";
  if (userId === ownerId) {
    return {
      type: "human",
      id: userId,
      name: process.env.OWNER_NAME || "Ryan",
      role: "Owner/Creator",
      username: username
    };
  }

  // 3. CACHE LOOKUP: Check if we already have this operative
  const identity = getIdentityById(userId);
  if (identity) return identity;

  console.log(`[MemPalace/Sync] Querying RSHL Lattice for user ${username} (${userId})...`);
  
  try {
    const res = await fetch(`http://127.0.0.1:3333/query?q=Who is user ${username} with ID ${userId}?`, {
      method: "GET",
      signal: AbortSignal.timeout(3000)
    }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data.claims && data.claims.length > 0) {
        const topClaim = data.claims[0].text;
        console.log(`[MemPalace/Hit] Resolved: ${topClaim}`);
        
        let role = "Operative";
        if (topClaim.toLowerCase().includes("partner") || topClaim.toLowerCase().includes("taas")) role = "Co-lead/Partner";
        if (topClaim.toLowerCase().includes("owner") || topClaim.toLowerCase().includes("master")) role = "Owner/Creator";

        return {
          type: "human",
          id: userId,
          name: username,
          role: role,
          username: username
        };
      }
    }
  } catch (e) {
    console.warn(`[MemPalace/Error] Lattice query failed:`, e.message);
  }

  return {
    type: "human",
    id: userId,
    name: username,
    role: "Guest Operative",
    username: username
  };
}

/**
 * Returns the identity data for a given Discord User ID.
 */
export function getIdentityById(userId) {
  const human = Object.values(HUMAN_REGISTRY).find(h => h.id === userId);
  if (human) return { type: "human", ...human };

  const ai = Object.entries(AI_REGISTRY).find(([name, data]) => data.id === userId);
  if (ai) return { type: "ai", name: ai[0], ...ai[1] };

  return null;
}

/**
 * Returns the Discord ID for a given name.
 */
export function getIdByName(name) {
  if (HUMAN_REGISTRY[name]) return HUMAN_REGISTRY[name].id;
  if (AI_REGISTRY[name]) return AI_REGISTRY[name].id;
  return null;
}
