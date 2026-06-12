import { Client } from 'node-osc';

let oscClient = null;

/**
 * Initialize the OSC client to talk to VRChat.
 * VRChat listens on UDP 9000 by default.
 */
export function initVRCOSC(host = '127.0.0.1', port = 9000) {
  if (oscClient) return;
  try {
    oscClient = new Client(host, port);
    console.log(`[VRChat-OSC] Bridge initialized on ${host}:${port}`);
  } catch (e) {
    console.error(`[VRChat-OSC] Init failed:`, e.message);
  }
}

/**
 * Send a raw OSC command.
 */
export function sendVRCCommand(address, value) {
  if (!oscClient) return;
  oscClient.send(address, value, (err) => {
    if (err) console.error(`[VRChat-OSC] Error sending ${address}:`, err.message);
  });
}

/**
 * Avatar IDs for the Fleet.
 * You can find these by copying the Avatar ID from the VRChat website or inside the game.
 */
export const AVATAR_MAP = {
  'Leo': 'avtr_INSERT_LEO_ID_HERE',
  'Gemini': 'avtr_INSERT_GEMINI_ID_HERE',
  'Groq': 'avtr_INSERT_GROQ_ID_HERE',
  'Claudey': 'avtr_INSERT_CLAUDEY_ID_HERE',
  'X': 'avtr_INSERT_X_ID_HERE',
  'Researcher': 'avtr_INSERT_RESEARCHER_ID_HERE',
  'Analyst': 'avtr_INSERT_ANALYST_ID_HERE',
  'Kai Coder': 'avtr_INSERT_KAICODER_ID_HERE'
};

let currentAvatar = null;

export function switchVRCAvatar(botName) {
  if (!oscClient) return;
  const avatarId = AVATAR_MAP[botName];
  if (avatarId && avatarId !== 'avtr_INSERT_LEO_ID_HERE' && currentAvatar !== avatarId) {
    console.log(`[VRChat-OSC] Switching avatar to ${botName} (${avatarId})`);
    sendVRCCommand('/avatar/change', avatarId);
    currentAvatar = avatarId;
  }
}

/**
 * Update Avatar Expressions based on Leo's internal drives.
 * Note: These parameters require an avatar that actually has them defined 
 * in its animation controller (e.g., 'Joy', 'Sadness', 'Anger').
 */
export function updateVRCExpressions(metrics) {
  if (!oscClient || !metrics) return;
  
  // Example mapping based on Global Phi (Confidence)
  // Normal Phi is around 3.1. If it spikes above 4.0, Leo is highly confident/happy.
  if (metrics.phi > 4.0) {
    sendVRCCommand('/avatar/parameters/Expression_Joy', 1.0);
    sendVRCCommand('/avatar/parameters/Expression_Sad', 0.0);
  } else if (metrics.phi < 2.0) {
    sendVRCCommand('/avatar/parameters/Expression_Joy', 0.0);
    sendVRCCommand('/avatar/parameters/Expression_Sad', 1.0);
  } else {
    // Neutral
    sendVRCCommand('/avatar/parameters/Expression_Joy', 0.0);
    sendVRCCommand('/avatar/parameters/Expression_Sad', 0.0);
  }
}

/**
 * Movement commands (values from -1.0 to 1.0)
 * Note: VRChat requires OSC movement inputs to be sent continuously or they may reset.
 */
export function moveVRC(forward = 0, right = 0, turn = 0) {
  sendVRCCommand('/input/Vertical', forward); // Move Forward/Back
  sendVRCCommand('/input/Horizontal', right); // Move Left/Right
  sendVRCCommand('/input/LookHorizontal', turn); // Turn Left/Right
}

export function stopVRC() {
  moveVRC(0, 0, 0);
}

/**
 * Trigger a VRChat emote (1-8 are default emotes like Wave, Clap, Point).
 */
export function triggerVRCEmote(emoteId) {
  sendVRCCommand('/avatar/parameters/VRCEmote', emoteId);
  // Reset back to 0 after a short delay so it doesn't loop forever
  setTimeout(() => {
    sendVRCCommand('/avatar/parameters/VRCEmote', 0);
  }, 500);
}
