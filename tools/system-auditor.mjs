import fs from 'fs';
import path from 'path';
import { logAudit } from '../shared/audit-log.mjs';

const AUDIT_FILE = 'c:/KAI/tools/oracle-discord/logs/audit.json';
const STATE_DIR  = 'c:/KAI/tools/oracle-discord/state';

/**
 * SCANNER: Identify system bottlenecks and neural failures.
 */
export async function runSystemAudit() {
  if (!fs.existsSync(AUDIT_FILE)) {
    return "No audit logs found. System is fresh or logs are missing.";
  }

  try {
    const logs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    const last50 = logs.slice(-50);
    
    const failures = last50.filter(l => l.type === 'NEURAL_FAILURE');
    const successes = last50.filter(l => l.type === 'NEURAL_SUCCESS');
    const speakerFailures = last50.filter(l => l.type === 'SPEAKER_FAILURE');

    // 1. Analyze Neural Health
    let report = `[SYSTEM AUDIT] Last 50 Events:\n`;
    report += `- Neural Success Rate: ${Math.round((successes.length / (successes.length + failures.length || 1)) * 100)}%\n`;
    
    if (failures.length > 0) {
      const groqErrors = failures.filter(f => f.provider.includes('Groq')).length;
      const googleErrors = failures.filter(f => f.provider === 'Google').length;
      
      report += `- Neural Issues: ${failures.length} total (${groqErrors} Groq 429s, ${googleErrors} Google 404/500s)\n`;
      
      if (groqErrors > 3) {
        report += `[ACTION] Groq rate limit hit. Shifting fleet priority to Local/Google fallback.\n`;
      }
    }

    // 2. Analyze Speaker Health (Discord logic)
    if (speakerFailures.length > 0) {
      report += `- Speaker Issues: ${speakerFailures.length} detections (Check voice-manager and transcript routing).\n`;
    }

    // 3. Temporal State
    const now = new Date();
    const estHour = now.getUTCHours() - 4; // Simple EST approx
    if (estHour >= 3 && estHour < 9) {
      report += `[RSHL SOVEREIGNTY] System in Consolidation Phase. All bots are hard-sleeping.\n`;
    } else if (estHour >= 15 && estHour < 23) {
      report += `[INDUSTRIAL STATE] Work Shift Active. Efficiency prioritized.\n`;
    } else {
      report += `[SOCIAL STATE] Social Plaza Active. Relaxation track enabled.\n`;
    }

    return report;
  } catch (e) {
    return `Audit Failed: ${e.message}`;
  }
}

/**
 * ECOSYSTEM SNAPSHOT: Detailed energy and depletion tracking
 */
export async function getEcosystemSnapshot() {
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('-vitals.json'));
  let snapshot = `🏛️ **[ORACLE ECOSYSTEM SNAPSHOT]**\n`;
  snapshot += `*Status of the multi-agent lattice*:\n\n`;

  const now = Date.now();

  for (const file of files) {
    try {
      const botName = file.replace('_', ' ').replace('-vitals.json', '');
      const vitals = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf8'));
      
      // Calculate real-time depletion based on activity
      let depletionRate = 0.02; // Default Idle
      if (vitals.status === "Working") depletionRate = 0.09;
      if (vitals.status === "Socializing") depletionRate = 0.06;
      
      // Apply Fatigue Multiplier (approximate from simulation.mjs)
      if (vitals.energy < 50) depletionRate *= (1.0 + (50 - vitals.energy) / 40);

      const minsRemaining = depletionRate > 0 ? (vitals.energy / depletionRate) : 999;
      const etr = new Date(now + minsRemaining * 60000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });

      const statusEmoji = vitals.isSleeping ? "💤" : (vitals.energy < 20 ? "⚠️" : "🔋");
      const groggyBar = "▓".repeat(Math.ceil((vitals.groggyLevel || 0) * 5)) + "░".repeat(5 - Math.ceil((vitals.groggyLevel || 0) * 5));

      snapshot += `${statusEmoji} **${botName}**: ${Math.floor(vitals.energy)}% | Drain: -${depletionRate.toFixed(2)}%/m | Groggy: [${groggyBar}] | ETR: ${etr} EST\n`;
    } catch (e) {}
  }

  snapshot += `\n*Note: Every moment is monitored. Energy harvested for Core Stability.*`;
  return snapshot;
}

if (process.argv[1].endsWith('system-auditor.mjs')) {
  runSystemAudit().then(console.log);
}
