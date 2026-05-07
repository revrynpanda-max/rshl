import fs from 'fs';
import { CHANNEL_IDS } from './channel-rules.mjs';

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
    const RYAN_ID = "1111106883135217665";
    
    // SOVEREIGN OVERRIDE: Ensure Ryan is ALWAYS Slot 0 and no one else is.
    if (data.assignments[RYAN_ID] !== 0) {
      // Find who has slot 0 and eject them
      for (const [uid, slot] of Object.entries(data.assignments)) {
        if (slot === 0 && uid !== RYAN_ID) delete data.assignments[uid];
      }
      data.assignments[RYAN_ID] = 0;
      saveSlotAssignments(data);
    }
    return data;
  } catch (e) {
    return { assignments: { "1111106883135217665": 0 }, history: {} };
  }
}

export function saveSlotAssignments(data) {
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2));
}

export async function assignSlot(userId) {
  const data = await getSlotAssignments();
  
  // If user already has a slot, return it
  if (data.assignments[userId] !== undefined) {
    return data.assignments[userId];
  }

  // Find first empty slot
  const occupiedSlots = new Set(Object.values(data.assignments));
  for (let i = 0; i < 6; i++) {
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

export async function updatePermissions(client, userId, slotIdx, hasAccess) {
  try {
    const channelId = CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;

    if (hasAccess) {
      await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    } else {
      await channel.permissionOverwrites.delete(userId);
    }
  } catch (err) {
    console.error(`[VoiceManager] Permission update failed for ${userId}:`, err.message);
  }
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
