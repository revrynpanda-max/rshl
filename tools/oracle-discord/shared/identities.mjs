/**
 * identities.mjs — Centralized Identity Registry for Humans and AIs.
 * This links names, roles, and Discord IDs for strict traffic control.
 */

export const HUMAN_REGISTRY = {
  "Ryan": {
    id: "1111106883135217665",
    role: "Owner/Creator",
    username: "nastermodx"
  },
  "Taz": {
    id: "1286110163505385523",
    role: "Co-lead/Partner",
    username: "TaasThaevil1"
  },
  "Grimshaggy": {
    id: "437459146778869770",
    role: "Operative",
    username: "grimshaggy420"
  }
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
