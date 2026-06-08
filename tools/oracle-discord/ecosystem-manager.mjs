import { spawn, fork } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import { WorldClock } from './shared/simulation.mjs';
const clock = new WorldClock();

const LOG_FILE = 'c:/KAI/tools/oracle-discord/logs/ecosystem.log';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function writeLog(type, args) {
  const msg = `[Ecosystem/${type}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, msg);
  } catch (e) {}
}

console.log = (...args) => {
  originalLog(...args);
  writeLog('INFO', args);
};
console.warn = (...args) => {
  originalWarn(...args);
  writeLog('WARN', args);
};
console.error = (...args) => {
  originalError(...args);
  writeLog('ERROR', args);
};

import 'dotenv/config';

const BOTS = ["Gemini", "Claudey", "X", "Groq", "Analyst", "Researcher", "Kai Coder"];
const processes = new Map(); // name -> child process
const sleepingBots = new Set(); // name -> true (prevents auto-respawn)

function broadcast(msg) {
  for (const [name, child] of processes) {
    if (child && child.connected) {
      child.send(msg);
    }
  }
}

import { execSync } from 'child_process';

// --- SYSTEM OPTIMIZATION: Port-Assassination ---
// Hard-kill any ghost processes holding KAI infrastructure ports
const KAI_PORTS = [3001, 3333, 3400, 3401, 3402, 3403, 3404, 3405, 3406, 3407, 3408, 3410, 3420];
console.log(`[Ecosystem] Running pre-boot Port-Assassination...`);
let killedAny = false;
for (const port of KAI_PORTS) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const pids = [...new Set(output.split('\n').filter(l=>l.trim()).map(l=>l.trim().split(/\s+/).pop()))];
      for (const pid of pids) {
        if (pid && pid !== "0" && pid !== process.pid.toString()) {
          console.log(`[Ecosystem] Killing ghost process ${pid} on port ${port}...`);
          try { execSync(`taskkill /F /PID ${pid}`); killedAny = true; } catch(e) {}
        }
      }
    }
  } catch (e) {}
}

// If we killed anything, wait for OS to release sockets
if (killedAny) {
  console.log(`[Ecosystem] Waiting 1s for port release...`);
  execSync(`powershell -Command "Start-Sleep -s 1"`);
}

import os from 'os';

function startProcess(name, script, args = []) {
  if (processes.has(name)) {
    const old = processes.get(name);
    if (old && old.connected) old.kill();
  }

  console.log(`[Ecosystem] Starting ${name}...`);
  
  // OPTIMIZATION: Removed memory caps to prevent startup JIT / garbage collection thrashing in Node 22
  const nodeArgs = []; 

  const child = fork(script, args, { 
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: nodeArgs,
    cwd: 'c:/KAI/tools/oracle-discord',
    env: { ...process.env }
  });

  // OPTIMIZATION: Elevate Leo and Oracle priority to ensure audio/intelligence stability
  if (name === "Leo") {
     try { os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch(e) {}
  }
  if (name === "Oracle") {
     try { os.setPriority(child.pid, os.constants.priority.PRIORITY_HIGH); } catch(e) {}
  }

  if (child.stdout) {
    child.stdout.on('data', (data) => {
      const msg = `[${name}] ${data}`;
      process.stdout.write(msg);
      try {
        fs.appendFileSync('c:/KAI/tools/oracle-discord/logs/ecosystem.log', msg);
      } catch (e) {}
    });
  }

  const botErrorCooldowns = new Map();

  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      const msg = `[${name}] ERROR: ${errorMsg}`;
      process.stderr.write(msg);
      try {
        fs.appendFileSync('c:/KAI/tools/oracle-discord/logs/ecosystem.log', msg);
      } catch (e) {}
      
      // Report critical errors to Oracle for autonomous repair (Throttled at source)
      try {
        const now = Date.now();
        const lastErr = botErrorCooldowns.get(name) || 0;
        if (now - lastErr < 10000) return; // 10s local throttle to prevent chunk-spam
        botErrorCooldowns.set(name, now);

        const oracle = processes.get("Oracle");
        if (oracle && oracle.connected && name !== "Oracle") {
          // MUZZLE: Do not report billing, quota, or known TTS failures to Oracle
          const isQuotaError = errorMsg.includes('401') || errorMsg.includes('429') || errorMsg.includes('ElevenLabs') || errorMsg.includes('OpenAI');
          if (!isQuotaError) {
            oracle.send({ type: 'SYSTEM_ERROR', bot: name, error: errorMsg });
          }
        }
      } catch (e) {
        console.warn(`[Ecosystem] Failed to report error to Oracle:`, e.message);
      }
    });
  }

  // ATTACH IPC LISTENERS IMMEDIATELY
  child.on('message', (msg) => {
    try {
      if (msg.type === 'VITALS_UPDATE') {
        const kai = processes.get("KAI");
        if (kai && kai.connected) kai.send({ type: 'OBSERVE_VITALS', vitals: msg.vitals });
        
        const oracle = processes.get("Oracle");
        if (oracle && oracle.connected) {
          oracle.send({ type: 'OBSERVE_VITALS', bot: msg.botName, vitals: msg.vitals, api: msg.api });
        }
      }
      if (msg.type === 'SOCIAL_STIMULUS') {
        broadcast({ type: 'INTEREST_BOOST', multiplier: 2.0, duration: 30000 });
      }
      if (msg.type === 'INTERRUPT_TTS') {
        // Broadcast STOP_TTS to everyone (they will filter it by their own name)
        broadcast({ type: 'STOP_TTS', interrupter: msg.botName });
      }
      if (msg.type === 'LATTICE_FEED') {
        const kai = processes.get("KAI");
        if (kai && kai.connected) kai.send({ type: 'INJECT_CLAIM', payload: msg.payload });
      }
      if (msg.type === 'PROXY_TTS') {
        const kai = processes.get("KAI");
        if (kai && kai.connected) kai.send({ type: 'PROXY_TTS', text: msg.text });
      }
      if (msg.type === 'RESTART_BOT' && (name === 'Oracle' || name === 'KAI' || name === 'Kai Coder')) {
        const target = msg.botName;
        const properName = [...processes.keys()].find(k => k.toLowerCase() === target.toLowerCase()) || 
                           [...BOTS, "Leo", "KAI", "Oracle", "Dashboard"].find(k => k.toLowerCase() === target.toLowerCase());
        if (properName) {
          console.log(`[Ecosystem] ${name} requested restart of ${properName}. Applying...`);
          startProcess(properName, properName === "Oracle" ? "oracle-gateway.mjs" : (properName === "Leo" ? "bots/leo.mjs" : (properName === "KAI" ? "bots/kai.mjs" : "bots/start-bot.mjs")), [properName]);
        }
      }
      if (msg.type === 'SLEEP_BOT' && name === 'Oracle') {
        const target = msg.botName;
        const properName = [...processes.keys()].find(k => k.toLowerCase() === target.toLowerCase());
        if (properName) {
          console.log(`[Ecosystem] Oracle requested SLEEP for ${properName}. Stopping process...`);
          sleepingBots.add(properName);
          const child = processes.get(properName);
          if (child) {
             child.removeAllListeners('close');
             if (child.connected) child.kill('SIGKILL');
             processes.delete(properName);
             console.log(`[Ecosystem] ${properName} is now ASLEEP.`);
          }
        }
      }
      if (msg.type === 'WAKE_BOT' && name === 'Oracle') {
        const target = msg.botName;
        const allKnown = [...BOTS, "Leo", "KAI", "Oracle", "Dashboard"];
        const properName = allKnown.find(k => k.toLowerCase() === target.toLowerCase());
        if (properName) {
          console.log(`[Ecosystem] Oracle requested WAKE for ${properName}...`);
          sleepingBots.delete(properName);
          startProcess(properName, properName === "Oracle" ? "oracle-gateway.mjs" : (properName === "Leo" ? "bots/leo.mjs" : (properName === "KAI" ? "bots/kai.mjs" : "bots/start-bot.mjs")), [properName]);
        }
      }
      if (msg.type === 'RESTART_ALL' && name === 'KAI') {
        console.log(`🌌 [Ecosystem] KAI triggered QUANTUM RESET! Wiping locks and hard-rebooting fleet...`);
        const lockPath = "c:/KAI/tools/oracle-discord/state/neural_lock.json";
        if (fs.existsSync(lockPath)) {
          try { fs.unlinkSync(lockPath); } catch (_) {}
        }
        const LOCK_DIR = "c:/KAI/tools/oracle-discord/state/social_locks";
        try {
          if (fs.existsSync(LOCK_DIR)) {
            const files = fs.readdirSync(LOCK_DIR);
            for (const f of files) fs.unlinkSync(`${LOCK_DIR}/${f}`);
          }
        } catch (_) {}
        for (const [pname, child] of processes) {
          if (pname !== 'KAI' && child) {
            child.removeAllListeners('close');
            if (child.connected) child.kill('SIGKILL');
          }
        }
        setTimeout(() => {
          console.log(`🌌 [Ecosystem] Quantum Reignition Phase 1: Spawning Dashboard & Oracle...`);
          startProcess("Dashboard", "dashboard-server.mjs");
          startProcess("Oracle", "oracle-gateway.mjs");
        }, 2000);

        setTimeout(() => {
          console.log(`🌌 [Ecosystem] Quantum Reignition Phase 2: Spawning Leo...`);
          startProcess("Leo", "bots/leo.mjs");
        }, 3000);

        let restartDelay = 4000;
        for (const bot of BOTS) {
          if (bot !== "KAI") {
            const currentBot = bot;
            setTimeout(() => {
              console.log(`🌌 [Ecosystem] Quantum Reignition Phase 3: Spawning ${currentBot}...`);
              startProcess(currentBot, "bots/start-bot.mjs", [currentBot]);
            }, restartDelay);
            restartDelay += 1000; // 1s gap is perfectly safe for OS and token separation
          }
        }
      }
    } catch (e) {
      console.warn(`[Ecosystem] IPC Handler error for ${name}:`, e.message);
    }
  });

  child.on('close', (code) => {
    if (sleepingBots.has(name)) {
      console.log(`[Ecosystem] ${name} process closed, but is ASLEEP. Suppressing auto-respawn.`);
      return;
    }
    console.log(`[Ecosystem] ${name} exited with code ${code}. Re-spawning in 5s...`);
    processes.delete(name);
    if (fs.existsSync('c:/KAI/tools/oracle-discord/state/test_failsafe.flag')) {
      console.log(`[Ecosystem] Failsafe testing flag detected. Suppressing auto-respawn for ${name} to allow collapse simulation.`);
      return;
    }
    setTimeout(() => {
      if (name === "Oracle") startProcess("Oracle", "oracle-gateway.mjs");
      else if (name === "Leo") startProcess("Leo", "bots/leo.mjs");
      else if (name === "KAI") startProcess("KAI", "bots/kai.mjs");
      else if (name === "Dashboard") startProcess("Dashboard", "dashboard-server.mjs");
      else startProcess(name, "bots/start-bot.mjs", [name]);
    }, 5000);
  });

  processes.set(name, child);
}

// Core Ignition: Start mission-critical bots with a safe Discord Gateway stagger (5.5s)
console.log(`[Ecosystem] Initializing core ignition. Starting KAI, Oracle, and Dashboard.`);

startProcess("Dashboard", "dashboard-server.mjs");
startProcess("Oracle", "oracle-gateway.mjs");

setTimeout(() => {
  // KAI is the Master Proxy; he handles the TTS relay for other bots
  process.env.IS_MASTER = "true";
  startProcess("KAI", "bots/kai.mjs");
}, 2000);

// Start secondary bots on a staggered delay to prevent OS spike
setTimeout(() => {
  console.log(`[Ecosystem] Spawning Leo...`);
  startProcess("Leo", "bots/leo.mjs");
}, 4000);

let startDelay = 5000;
for (const bot of BOTS) {
  if (bot !== "KAI") {
    const currentBot = bot;
    setTimeout(() => {
      console.log(`[Ecosystem] Spawning ${currentBot}...`);
      startProcess(currentBot, "bots/start-bot.mjs", [currentBot]);
    }, startDelay);
    startDelay += 1000;
  }
}

// Global World Clock Heartbeat
setInterval(() => {
  const worldState = clock.getCurrentState();
  broadcast({ type: 'WORLD_TICK', worldState });
}, 60000);

// CLI Interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'Ecosystem> '
});

rl.prompt();

rl.on('line', (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd.startsWith('restart ')) {
    const name = line.split(' ')[1];
    if (name) {
      const properName = [...processes.keys()].find(k => k.toLowerCase() === name.toLowerCase());
      if (properName) {
        startProcess(properName, properName === "Oracle" ? "oracle-gateway.mjs" : (properName === "Leo" ? "bots/leo.mjs" : (properName === "KAI" ? "bots/kai.mjs" : "bots/start-bot.mjs")), [properName]);
      } else {
        console.log(`[Ecosystem] Unknown bot: ${name}`);
      }
    }
  } else if (cmd === 'list') {
    console.log("[Ecosystem] Active processes:");
    for (const [name, child] of processes) {
      console.log(` - ${name} (PID: ${child.pid}, Connected: ${child.connected})`);
    }
  } else if (cmd === 'help') {
    console.log("[Ecosystem] Commands: list, restart <bot>, help");
  }
  rl.prompt();
});
