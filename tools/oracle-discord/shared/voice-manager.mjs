import fs from 'fs';
import { CHANNEL_IDS, USER_TRANSCRIPT_MAP } from './channel-rules.mjs';

// ── Fixed slot assignments (source of truth) ──────────────────────────────────
// These never change dynamically. If a user is in this map, they always
// get the same transcript channel regardless of join order.
const FIXED_ASSIGNMENTS = {
  "1111106883135217665": 0,  // Ryan  → Slot 0 → "1500527640107417783"
  "1286110163505385523": 1,  // Taz   → Slot 1 → "1500529928184008885"
  "437459146778869770":  2,  // Guest 1 → Slot 2 → "1500529995087610027"
  "1002347589959688303": 3,  // Guest 2 → Slot 3 → "1500530046111318116"
};

const SLOTS_FILE = 'c:/KAI/tools/oracle-discord/data/voice_slots.json';

// Initialize slots file if missing
if (!fs.existsSync(SLOTS_FILE)) {
  fs.writeFileSync(SLOTS_FILE, JSON.stringify({
    assignments: {}, // userId -> slotIndex
    history: {}      // userId -> { lastSeen: timestamp, isRegistered: boolean }
  }, null, 2));
}

export async function getSlotAssignments() {
  try {
    const data = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));

    // FIXED REGISTRY MERGE: Always ensure fixed assignments are present and correct.
    // Dynamic slots (e.g., unknown guests) still use file-based assignment for slots 4+.
    let changed = false;
    for (const [uid, slot] of Object.entries(FIXED_ASSIGNMENTS)) {
      if (data.assignments[uid] !== slot) {
        // Eject anyone who grabbed this fixed slot
        for (const [otherUid, otherSlot] of Object.entries(data.assignments)) {
          if (otherSlot === slot && otherUid !== uid) {
            delete data.assignments[otherUid];
            changed = true;
          }
        }
        data.assignments[uid] = slot;
        changed = true;
      }
    }
    if (changed) saveSlotAssignments(data);
    return data;
  } catch (e) {
    return { assignments: { ...FIXED_ASSIGNMENTS }, history: {} };
  }
}

/**
 * Fast lookup: get the transcript channel ID for a user.
 * Uses fixed registry first, falls back to file-based slot.
 */
export function getTranscriptChannel(userId) {
  return USER_TRANSCRIPT_MAP[userId] || null;
}

export function saveSlotAssignments(data) {
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2));
}

export async function assignSlot(userId) {
  // Check fixed registry first
  if (FIXED_ASSIGNMENTS[userId] !== undefined) {
    return FIXED_ASSIGNMENTS[userId];
  }

  const data = await getSlotAssignments();

  // If user already has a slot, return it
  if (data.assignments[userId] !== undefined) {
    return data.assignments[userId];
  }

  // Find first empty slot (starting from 4 to leave 0-3 for fixed users)
  const occupiedSlots = new Set(Object.values(data.assignments));
  for (let i = 4; i < 6; i++) {
    if (!occupiedSlots.has(i)) {
      data.assignments[userId] = i;
      saveSlotAssignments(data);
      return i;
    }
  }

  return -1; // Full
}

export async function releaseSlot(userId) {
  const data = await getSlotAssignments();
  if (data.assignments[userId] !== undefined) {
    const slotIdx = data.assignments[userId];
    delete data.assignments[userId];
    saveSlotAssignments(data);
    return slotIdx;
  }
  return -1;
}

/**
 * Grant or revoke a user's access to their assigned transcript channel.
 * Uses USER_TRANSCRIPT_MAP for fixed users, falls back to slot index for others.
 */
export async function updatePermissions(client, userId, slotIdx, hasAccess) {
  try {
    // Fixed users always use their dedicated channel
    const channelId = USER_TRANSCRIPT_MAP[userId] || CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`[VoiceManager] Transcript channel ${channelId} not found for user ${userId}`);
      return;
    }

    // Resolve to a User object — permissionOverwrites.edit rejects raw ID strings
    const guild = channel.guild;
    let target = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (!target) target = await client.users.fetch(userId).catch(() => null);
    if (!target) {
      console.warn(`[VoiceManager] Cannot resolve user ${userId} for permission update`);
      return;
    }

    if (hasAccess) {
      await channel.permissionOverwrites.edit(target, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
      console.log(`[VoiceManager] ✓ Granted access: ${userId} → channel ${channelId}`);
    } else {
      // Fixed users keep their channel access permanently (don't revoke on leave)
      if (!USER_TRANSCRIPT_MAP[userId]) {
        await channel.permissionOverwrites.delete(target);
        console.log(`[VoiceManager] Revoked access: ${userId} → channel ${channelId}`);
      }
    }
  } catch (err) {
    console.error(`[VoiceManager] Permission update failed for ${userId}:`, err.message);
  }
}

/**
 * Bootstrap: ensure all registered users have access to their transcript channels.
 * Call this on bot startup to fix any missing permission overrides.
 */
export async function bootstrapPermissions(client) {
  console.log('[VoiceManager] Bootstrapping transcript channel permissions...');

  // Resolve the guild once — needed to fetch members
  const guildId = process.env.ORACLE_GUILD_ID;
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : client.guilds.cache.first();
  if (!guild) {
    console.warn('[VoiceManager] Bootstrap skipped — no guild found.');
    return;
  }

  for (const [userId, channelId] of Object.entries(USER_TRANSCRIPT_MAP)) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) { console.warn(`[VoiceManager] Channel ${channelId} not found`); continue; }

      // permissionOverwrites.edit requires a User/GuildMember object, not a bare ID string.
      // Fetch the member from the guild; fall back to a raw user fetch if not in the guild yet.
      let target = await guild.members.fetch(userId).catch(() => null);
      if (!target) target = await client.users.fetch(userId).catch(() => null);
      if (!target) {
        console.warn(`[VoiceManager] Could not resolve user ${userId} — skipping bootstrap for this slot.`);
        continue;
      }

      await channel.permissionOverwrites.edit(target, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
      console.log(`[VoiceManager] ✓ ${userId} → ${channelId}`);
    } catch (err) {
      console.error(`[VoiceManager] Bootstrap failed for ${userId}:`, err.message);
    }
  }
  console.log('[VoiceManager] Bootstrap complete.');
}

export async function isUserRegistered(userId) {
  const data = await getSlotAssignments();
  return data.history[userId]?.isRegistered || false;
}

export async function registerUser(userId, username) {
  const data = await getSlotAssignments();
  data.history[userId] = { 
    username, 
    lastSeen: Date.now(), 
    isRegistered: true 
  };
  saveSlotAssignments(data);
}
