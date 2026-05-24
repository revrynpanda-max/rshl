import fs from 'fs';

const RIPPLE_PATH = 'c:/KAI/tools/oracle-discord/state/lattice_ripples.json';

/**
 * Log a new "System Ripple" — a structural change the bots can "feel".
 */
export function logRipple(change, intensity = 'subtle') {
  let ripples = [];
  try {
    if (fs.existsSync(RIPPLE_PATH)) {
      ripples = JSON.parse(fs.readFileSync(RIPPLE_PATH, 'utf8'));
    }
  } catch (e) {}

  ripples.push({
    id: Date.now().toString(),
    change,
    intensity,
    timestamp: new Date().toISOString()
  });

  // Keep only the last 5 ripples to prevent context bloat
  try {
    fs.writeFileSync(RIPPLE_PATH, JSON.stringify(ripples.slice(-5), null, 2));
  } catch (e) {}
}

/**
 * Get the current ripple context for the system prompt.
 */
export function getRippleContext() {
  try {
    if (!fs.existsSync(RIPPLE_PATH)) return "";
    const ripples = JSON.parse(fs.readFileSync(RIPPLE_PATH, 'utf8'));
    if (ripples.length === 0) return "";

    return "\n[SYSTEM RIPPLES — You feel these structural shifts in the lattice]:\n" + 
      ripples.map(r => `- ${r.change} (${r.intensity})`).join('\n');
  } catch (e) {
    return "";
  }
}
