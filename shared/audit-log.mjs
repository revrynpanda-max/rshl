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

    let audit = [];
    if (fs.existsSync(AUDIT_FILE)) {
      try {
        const content = fs.readFileSync(AUDIT_FILE, 'utf8');
        audit = JSON.parse(content);
      } catch (e) {
        console.error("[AuditLog] Parse failed, starting fresh:", e.message);
        audit = [];
      }
    }
    
    audit.push(entry);
    
    // LOG PRUNING: Keep only the last 1000 entries to prevent memory exhaustion
    if (audit.length > 1000) {
      audit = audit.slice(-1000);
    }

    fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2));
    
    // Also log to console for immediate visibility
    if (type === 'ERROR' || type === 'NEURAL_FAILURE') {
      console.warn(`[AUDIT] ${type}: ${JSON.stringify(data)}`);
    } else {
      console.log(`[AUDIT] ${type}: ${data.message || ''}`);
    }
  } catch (e) {
    console.error(`[Audit] Failed to write log:`, e.message);
  }
}
