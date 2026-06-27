/**
 * Pure overnight roster policy — essentials mode must not sleep Leo/Groq/work bots.
 */

const ROSTER_EXCLUDE = new Set(['oracle', 'kai']);
const ESSENTIALS_ALWAYS_ON = new Set(['leo', 'groq', 'analyst', 'researcher', 'kai coder']);

export function essentialsLimitedMode() {
  return process.env.KAI_FORCE_LIMITED === '1';
}

export function parseOvernightRoster(raw) {
  const src = raw || 'Leo,Gemini,Claudey,X,Groq,Researcher,Analyst,Kai Coder';
  return String(src)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => !ROSTER_EXCLUDE.has(b.toLowerCase()));
}

export function effectiveOvernightRoster(overnightRoster, opts = {}) {
  const limited = opts.forceLimited ?? essentialsLimitedMode();
  if (!limited) return overnightRoster;
  return overnightRoster.filter((b) => !ESSENTIALS_ALWAYS_ON.has(b.toLowerCase()));
}