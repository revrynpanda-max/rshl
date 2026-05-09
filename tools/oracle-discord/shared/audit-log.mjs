import fs from 'fs';
import path from 'path';

const AUDIT_FILE = 'c:/KAI/tools/oracle-discord/logs/audit.json';
const LOG_DIR = 'c:/KAI/tools/oracle-discord/logs';

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Log a system event for the Analyst/Oracle to ingest.
 */
export function logAudit(type, data) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data
    };

    // HIGH-PERFORMANCE APPEND: JSON Lines (JSONL) format
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    
    // Also log to console for immediate visibility
    if (type === 'ERROR' || type === 'NEURAL_FAILURE') {
      console.warn(`[AUDIT] ${type}: ${JSON.stringify(data)}`);
    } else {
      console.log(`[AUDIT] ${type}: ${data.botName || ''} via ${data.provider || ''}`);
    }
  } catch (e) {
    console.error(`[Audit] Failed to write log:`, e.message);
  }
}

// Global anchor for fleet-wide reliability
global.logAudit = logAudit;
