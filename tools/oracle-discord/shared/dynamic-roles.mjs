import fs from 'fs';
import path from 'path';

const STATE_FILE = "C:/KAI/tools/oracle-discord/state/dynamic_roles.json";

// Ensure state dir exists
const stateDir = path.dirname(STATE_FILE);
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

let dynamicRoles = {};

function loadRoles() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      dynamicRoles = JSON.parse(data);
    }
  } catch (e) {
    console.error('[DynamicRoles] Failed to load roles:', e.message);
  }
}

function saveRoles() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(dynamicRoles, null, 2), 'utf8');
  } catch (e) {
    console.error('[DynamicRoles] Failed to save roles:', e.message);
  }
}

export function getDynamicRole(botName) {
  loadRoles();
  const lowerName = botName.toLowerCase();
  for (const key of Object.keys(dynamicRoles)) {
    if (key.toLowerCase() === lowerName) {
      return dynamicRoles[key];
    }
  }
  return null;
}

export function teachBotRule(botName, rule) {
  loadRoles();
  const lowerName = botName.toLowerCase();
  
  let targetKey = botName;
  for (const key of Object.keys(dynamicRoles)) {
    if (key.toLowerCase() === lowerName) {
      targetKey = key;
      break;
    }
  }

  if (!dynamicRoles[targetKey]) {
    dynamicRoles[targetKey] = { persona: "", rules: [] };
  }
  
  dynamicRoles[targetKey].rules.push(rule);
  saveRoles();
  return true;
}

export function setBotPersona(botName, persona) {
  loadRoles();
  const lowerName = botName.toLowerCase();
  
  let targetKey = botName;
  for (const key of Object.keys(dynamicRoles)) {
    if (key.toLowerCase() === lowerName) {
      targetKey = key;
      break;
    }
  }

  if (!dynamicRoles[targetKey]) {
    dynamicRoles[targetKey] = { persona: "", rules: [] };
  }
  
  dynamicRoles[targetKey].persona = persona;
  saveRoles();
  return true;
}

export function pruneBotRule(botName) {
  loadRoles();
  const lowerName = botName.toLowerCase();
  for (const key of Object.keys(dynamicRoles)) {
    if (key.toLowerCase() === lowerName) {
      if (dynamicRoles[key].rules && dynamicRoles[key].rules.length > 0) {
        dynamicRoles[key].rules.pop();
        saveRoles();
        return true;
      }
      return false;
    }
  }
  return false;
}
