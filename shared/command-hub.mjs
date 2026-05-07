import fs from 'fs';
import path from 'path';

const COMMAND_QUEUE_PATH = 'c:/KAI/tools/oracle-discord/state/command_queue.json';

export function pushCommand(botName, directive, rawContent) {
  try {
    if (!fs.existsSync(path.dirname(COMMAND_QUEUE_PATH))) {
      fs.mkdirSync(path.dirname(COMMAND_QUEUE_PATH), { recursive: true });
    }

    let queue = [];
    if (fs.existsSync(COMMAND_QUEUE_PATH)) {
      queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    }

    const newCommand = {
      id: `cmd_${Date.now()}`,
      bot: botName,
      directive: directive,
      raw: rawContent,
      status: "PENDING",
      phase: "PLANNING",
      contributions: {},
      notified: [], // Bots that have announced this completion
      timestamp: new Date().toISOString()
    };

    queue.push(newCommand);
    fs.writeFileSync(COMMAND_QUEUE_PATH, JSON.stringify(queue, null, 2));
    return newCommand.id;
  } catch (e) {
    console.error("[CommandHub] Push failed:", e.message);
    return null;
  }
}

export function addContribution(cmdId, botName, content) {
  try {
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    const cmd = queue.find(c => c.id === cmdId);
    if (cmd) {
      cmd.contributions[botName] = content;
      fs.writeFileSync(COMMAND_QUEUE_PATH, JSON.stringify(queue, null, 2));
    }
  } catch {}
}

export function getCommandsByPhase(phase) {
  try {
    if (!fs.existsSync(COMMAND_QUEUE_PATH)) return [];
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    return queue.filter(c => c.phase === phase);
  } catch { return []; }
}

export function getPendingCommands(botName) {
  try {
    if (!fs.existsSync(COMMAND_QUEUE_PATH)) return [];
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    return queue.filter(c => 
      (c.phase === "PLANNING" && !c.contributions[botName]) ||
      (c.phase === "EXECUTION" && c.bot === botName && c.status === "APPROVED")
    );
  } catch { return []; }
}

/**
 * Returns commands that are COMPLETED but haven't notified a specific bot yet.
 */
export function getCompletedForNotification(botName) {
  try {
    if (!fs.existsSync(COMMAND_QUEUE_PATH)) return [];
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    return queue.filter(c => c.status === "COMPLETED" && !c.notified?.includes(botName));
  } catch { return []; }
}

export function markAsNotified(cmdId, botName) {
  try {
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    const cmd = queue.find(c => c.id === cmdId);
    if (cmd) {
      if (!cmd.notified) cmd.notified = [];
      if (!cmd.notified.includes(botName)) cmd.notified.push(botName);
      fs.writeFileSync(COMMAND_QUEUE_PATH, JSON.stringify(queue, null, 2));
    }
  } catch {}
}

export function updateCommandStatus(cmdId, status, result = null, phase = null) {
  try {
    const queue = JSON.parse(fs.readFileSync(COMMAND_QUEUE_PATH, 'utf8'));
    const cmd = queue.find(c => c.id === cmdId);
    if (cmd) {
      if (status) cmd.status = status;
      if (phase) cmd.phase = phase;
      if (result) cmd.result = result;
      fs.writeFileSync(COMMAND_QUEUE_PATH, JSON.stringify(queue, null, 2));
    }
  } catch {}
}
