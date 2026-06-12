/**
 * resilience-status.mjs — Phoenix, bone-heal, and recovery telemetry for Oracle briefs.
 */
import fs from 'fs';

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (_) {
    return null;
  }
}

function tailJsonl(path, n = 1) {
  try {
    const lines = fs.readFileSync(path, 'utf8').split('\n').filter(l => l.trim());
    return lines.slice(-n).map(l => {
      try { return JSON.parse(l); } catch (_) { return { raw: l }; }
    });
  } catch (_) {
    return [];
  }
}

/** Lines for Oracle liveSystemBrief / conversational grounding. */
export function getResilienceBrief() {
  const parts = [];

  const bone = readJson('c:/KAI/data/bone_heal_status.json');
  if (bone) {
    parts.push(
      `BoneHeal: quarantined=${bone.quarantined ?? '?'} reinforced=${bone.reinforced ?? '?'} weakened=${bone.weakened ?? '?'} inert=${bone.already_inert ?? bone.inert ?? '?'} @ ${bone.updated_at || bone.updatedAt || 'unknown'}`
    );
  } else {
    parts.push('BoneHeal: no status file yet (runs on KAI engine startup)');
  }

  const phoenixMarker = 'c:/KAI/scratch/phoenix-last-fire.txt';
  if (fs.existsSync(phoenixMarker)) {
    try {
      const fired = fs.readFileSync(phoenixMarker, 'utf8').trim();
      parts.push(`Phoenix last fire: ${fired}`);
    } catch (_) {}
  }

  const recovery = tailJsonl('c:/KAI/logs/system_recovery_events.jsonl', 1)[0];
  if (recovery) {
    parts.push(`Last recovery: ${recovery.type || 'event'} @ ${recovery.ts || '?'} (${recovery.action || recovery.reason || ''})`.trim());
  }

  const authStop = readJson('c:/KAI/state/authorized_stop.json');
  if (authStop?.authorized) {
    parts.push(`Authorized stop marker: ${authStop.timestamp || authStop.ts || 'set'}`);
  }

  return parts.join('\n');
}
