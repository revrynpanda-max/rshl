import fs from 'fs';
import path from 'path';

const PREFERENCES_FILE = 'c:/KAI/tools/oracle-discord/state/user_preferences.json';

/**
 * Record user feedback on model performance or system behavior.
 * @param {string} type - 'YES', 'NO', 'MAYBE'
 * @param {string} feedback - The raw text explanation from the user.
 * @param {object} context - Metadata about what was being fixed/done.
 */
export function recordUserFeedback(type, feedback, context = {}) {
  let prefs = {
    directives: [],
    history: []
  };

  if (fs.existsSync(PREFERENCES_FILE)) {
    try {
      prefs = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8'));
    } catch (e) {
      console.error("[Feedback] Parse failed:", e.message);
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    type,
    feedback,
    context
  };

  prefs.history.push(entry);

  // LOGIC: If it's a "NO" or "DIRECTIVE", elevate it to the active directives
  if (type === 'NO' || feedback.toLowerCase().includes("make sure") || feedback.toLowerCase().includes("always")) {
    prefs.directives.push({
      id: Date.now(),
      instruction: feedback,
      active: true
    });
  }

  // Keep history manageable
  if (prefs.history.length > 100) prefs.history = prefs.history.slice(-100);
  if (prefs.directives.length > 20) prefs.directives = prefs.directives.slice(-20);

  fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
  console.log(`[Feedback] Recorded ${type} directive from User.`);
}

/**
 * Returns a summary of active directives for prompt injection.
 */
export function getActiveDirectives() {
  if (!fs.existsSync(PREFERENCES_FILE)) return "";
  try {
    const prefs = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8'));
    return prefs.directives
      .filter(d => d.active)
      .map(d => `- ${d.instruction}`)
      .join("\n");
  } catch {
    return "";
  }
}
