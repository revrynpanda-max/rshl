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

  const ROSTER = ["KAI", "Oracle", "Leo", "Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Kai Coder", "GPT-4o"];
  
  for (const botName of ROSTER) {
    try {
      const fileName = botName.replace(' ', '_') + '-vitals.json';
      const filePath = path.join(STATE_DIR, fileName);
      
      let vitals;
      if (fs.existsSync(filePath)) {
        vitals = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } else {
        // Mock vitals for bots that haven't saved yet (like Oracle or KAI)
        vitals = { 
          energy: 100, 
          status: botName === "KAI" ? "Orchestrating" : "Observing", 
          isSleeping: false, 
          groggyLevel: 0 
        };
        if (botName === "KAI") vitals.status = "Deep Learning";
      }
      
      const isSleeping = vitals.isSleeping || vitals.status === "Sleeping";
      
      let rateLabel = "Drain";
      let rateValue = 0.08; // Default Idle
      let timeLabel = "TTR"; // Time to Rest
      
      if (isSleeping) {
        rateLabel = "Regen";
        rateValue = 0.35; // Standard Sleep Restore
        timeLabel = "TTW"; // Time to Wake
      } else {
        if (vitals.status === "Working") rateValue = 0.45;
        if (vitals.status === "Socializing") rateValue = 0.25;
        if (vitals.energy < 60) rateValue *= (1.0 + (60 - vitals.energy) / 40);
      }

      // Calculation: If sleeping, calculate time until 90% (Wake threshold). If awake, until 5%.
      const targetEnergy = isSleeping ? 90 : 5;
      const energyDiff = Math.abs(vitals.energy - targetEnergy);
      const minsRemaining = rateValue > 0 ? (energyDiff / rateValue) : 0;
      
      const hours = Math.floor(minsRemaining / 60);
      const mins = Math.floor(minsRemaining % 60);
      const duration = `${hours}h ${mins}m`;
      
      const etDate = new Date(now + minsRemaining * 60000);
      const etString = etDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });

      const statusEmoji = isSleeping ? "💤" : (vitals.energy < 20 ? "⚠️" : "🔋");
      const barFull = Math.ceil(vitals.energy / 10);
      const energyBar = "█".repeat(barFull) + "░".repeat(10 - barFull);
      const barEmoji = vitals.energy > 60 ? "🟩" : (vitals.energy > 30 ? "🟨" : "🟥");

      snapshot += `${statusEmoji} **${botName}** ${barEmoji} [${energyBar}] ${Math.floor(vitals.energy)}%\n`;
      snapshot += `> ${timeLabel}: **${duration}** | ${rateLabel}: ${isSleeping ? "+" : "-"}${rateValue.toFixed(2)}%/m | ${isSleeping ? "EST Wake" : "EST Sleep"}: ${etString}\n\n`;
    } catch (e) {}
  }

  snapshot += `\n*Note: Every moment is monitored. Energy harvested for Core Stability.*`;
  return snapshot;
}

if (process.argv[1].endsWith('system-auditor.mjs')) {
  runSystemAudit().then(console.log);
}
