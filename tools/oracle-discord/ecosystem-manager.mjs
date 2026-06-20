import { spawn, fork } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import { WorldClock } from './shared/simulation.mjs';
const clock = new WorldClock();

const LOG_FILE = 'c:/KAI/tools/oracle-discord/logs/ecosystem.log';
const MANAGER_STATE_FILE = 'c:/KAI/tools/oracle-discord/state/ecosystem-manager.json';
try {
  fs.mkdirSync('c:/KAI/tools/oracle-discord/logs', { recursive: true });
  fs.mkdirSync('c:/KAI/tools/oracle-discord/state', { recursive: true });
} catch (_) {}
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
const KNOWN_PROCESSES = ["Dashboard", "Oracle", "KAI", "Leo", ...BOTS];
const processes = new Map(); // name -> child process
const processMeta = new Map(); // name -> startup and exit metadata
const sleepingBots = new Set(); // name -> true (prevents auto-respawn)

function normalizeProcessName(name) {
  if (!name) return null;
  const needle = String(name).trim().toLowerCase().replace(/[_-]+/g, ' ');
  const aliases = {
    "kai coder": "Kai Coder",
    "coder": "Kai Coder",
    "research": "Researcher",
    "researcher": "Researcher",
    "leo": "Leo",
    "kai": "KAI",
    "core": "KAI",
    "oracle": "Oracle",
    "dashboard": "Dashboard"
  };
  if (aliases[needle]) return aliases[needle];
  return KNOWN_PROCESSES.find(n => n.toLowerCase() === needle) || null;
}

function scriptForProcess(name) {
  if (name === "Oracle") return "oracle-gateway.mjs";
  if (name === "Leo") return "bots/leo.mjs"; // Leo still uses his original file or native-bot if preferred
  if (name === "X" || name === "Claudey" || name === "Groq") return "bots/native-bot.mjs";
  if (name === "KAI") return "bots/kai.mjs";
  if (name === "Dashboard") return "dashboard-server.mjs";
  return "bots/start-bot.mjs";
}

function argsForProcess(name) {
  return ["Oracle", "Leo", "KAI", "Dashboard"].includes(name) ? [] : [name];
}

for (const raw of (process.env.ORACLE_START_SLEEP_BOTS || "").split(",")) {
  const name = normalizeProcessName(raw);
  if (name && !["Oracle", "KAI", "Dashboard"].includes(name)) {
    sleepingBots.add(name);
  }
}
if (sleepingBots.size) {
  console.log(`[Ecosystem] Startup sleep list active: ${[...sleepingBots].join(', ')}`);
}

function writeManagerState() {
  const children = [];
  for (const [name, child] of processes) {
    const meta = processMeta.get(name) || {};
    children.push({
      name,
      pid: child?.pid || null,
      connected: Boolean(child?.connected),
      killed: Boolean(child?.killed),
      sleeping: sleepingBots.has(name),
      script: meta.script || null,
      args: meta.args || [],
      startedAt: meta.startedAt || null,
      lastExitCode: meta.lastExitCode ?? null,
      lastExitedAt: meta.lastExitedAt || null
    });
  }
  for (const name of sleepingBots) {
    if (processes.has(name)) continue;
    const meta = processMeta.get(name) || {};
    children.push({
      name,
      pid: null,
      connected: false,
      killed: true,
      sleeping: true,
      script: meta.script || scriptForProcess(name),
      args: meta.args || argsForProcess(name),
      startedAt: meta.startedAt || null,
      lastExitCode: meta.lastExitCode ?? null,
      lastExitedAt: meta.lastExitedAt || null
    });
  }
  const payload = {
    managerPid: process.pid,
    updatedAt: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    childCount: children.length,
    children
  };
  try { fs.writeFileSync(MANAGER_STATE_FILE, JSON.stringify(payload, null, 2)); } catch (_) {}
}

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
// FIX: only kill processes LISTENING on these ports (local address match).
// The old `findstr :port` matched OUTBOUND connections too — it killed the
// launcher PowerShell mid-health-check (its poll of :3001 appeared in netstat),
// which is why run-oracle-discord.ps1 died with exit code 1.
if (process.platform === 'win32') {
  try {
    const protectedPids = new Set(["0", String(process.pid), String(process.ppid)]);
    const output = execSync(`netstat -ano -p tcp`).toString();
    const killTargets = new Map(); // pid -> port
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // [proto, localAddr, foreignAddr, state, pid]
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      const localPort = Number(parts[1].split(':').pop());
      const pid = parts[4];
      if (KAI_PORTS.includes(localPort) && !protectedPids.has(pid)) {
        killTargets.set(pid, localPort);
      }
    }
    for (const [pid, port] of killTargets) {
      console.log(`[Ecosystem] Killing ghost listener ${pid} on port ${port}...`);
      try { execSync(`taskkill /F /PID ${pid}`); killedAny = true; } catch(e) {}
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
  if (sleepingBots.has(name)) {
    console.log(`[Ecosystem] ${name} is marked ASLEEP. Skipping startup.`);
    processMeta.set(name, {
      script: script || scriptForProcess(name),
      args: args?.length ? args : argsForProcess(name),
      startedAt: null,
      lastExitCode: null,
      lastExitedAt: null
    });
    writeManagerState();
    return null;
  }

  let delay = 0;
  if (processes.has(name)) {
    const old = processes.get(name);
    if (old) {
      // FIX: detach the old instance's close handler BEFORE killing it.
      old.removeAllListeners('close');
      try { old.kill('SIGKILL'); } catch (_) {}
      processes.delete(name);
      // Wait 2s for OS to clean up sockets before respawning to avoid EADDRINUSE
      delay = 2000;
    }
  }

  const doSpawn = () => {
    if (sleepingBots.has(name)) return; // Re-check in case it was slept during the delay

    console.log(`[Ecosystem] Starting ${name}...`);
    processMeta.set(name, {
      script,
      args,
      startedAt: new Date().toISOString(),
      lastExitCode: null,
      lastExitedAt: null
    });
    
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
            // MUZZLE: Do not report billing, quota, provider-fallback, or known
            // TTS failures to Oracle — they are not codable and were spawning
            // auto-repair tickets that burned the GPU and starved KAI's engine.
            const isQuotaError = /401|429|ElevenLabs|OpenAI|Null-fallback|returned null|skipping turn|Failing over|unavailable|cooldown|timed? out|aborted/i.test(errorMsg);
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
          const properName = normalizeProcessName(target);
          if (properName) {
            console.log(`[Ecosystem] ${name} requested restart of ${properName}. Applying...`);
            sleepingBots.delete(properName);
            startProcess(properName, scriptForProcess(properName), argsForProcess(properName));
          }
        }
        if (msg.type === 'SLEEP_BOT' && name === 'Oracle') {
          const target = msg.botName;
          const properName = normalizeProcessName(target);
          if (properName) {
            if (["Oracle", "KAI", "Dashboard"].includes(properName)) {
              console.log(`[Ecosystem] Refusing sleep request for protected core process ${properName}.`);
              return;
            }
            console.log(`[Ecosystem] Oracle requested SLEEP for ${properName}. Stopping process...`);
            sleepingBots.add(properName);
            const child = processes.get(properName);
            if (child) {
               child.removeAllListeners('close');
               if (child.connected) child.kill('SIGKILL');
               processes.delete(properName);
               console.log(`[Ecosystem] ${properName} is now ASLEEP.`);
               writeManagerState();
            }
            writeManagerState();
          }
        }
        if (msg.type === 'WAKE_BOT' && name === 'Oracle') {
          const target = msg.botName;
          const properName = normalizeProcessName(target);
          if (properName) {
            sleepingBots.delete(properName);
            // FIX: waking an already-running bot must be a no-op, not a
            // kill-and-restart (that caused duplicate processes + port fights).
            const existing = processes.get(properName);
            if (existing && existing.exitCode === null && !existing.killed) {
              console.log(`[Ecosystem] ${properName} is already awake. WAKE ignored.`);
              writeManagerState();
            } else {
              console.log(`[Ecosystem] Oracle requested WAKE for ${properName}...`);
              startProcess(properName, scriptForProcess(properName), argsForProcess(properName));
            }
          }
        }
        if (msg.type === 'PHOENIX_PROTOCOL' && (name === 'KAI' || name === 'Oracle')) {
          // ── PHOENIX: full infrastructure relaunch requested from inside ──
          console.log(`🔥 [Ecosystem] PHOENIX PROTOCOL invoked by ${name}: ${msg.reason || 'no reason given'}. Relaunching the entire system...`);
          try {
            const phoenix = spawn('powershell.exe',
              ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', 'c:/KAI/tools/oracle-discord/run-oracle-discord.ps1'],
              { detached: true, stdio: 'ignore', cwd: 'c:/KAI/tools/oracle-discord' });
            phoenix.unref();
          } catch (e) {
            console.error('[Ecosystem] Phoenix relaunch failed:', e.message);
          }
          return;
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
      const meta = processMeta.get(name) || {};
      processMeta.set(name, {
        ...meta,
        lastExitCode: code,
        lastExitedAt: new Date().toISOString()
      });
      // FIX: if a newer instance already replaced this child in the registry,
      // this close belongs to a stale process — never respawn from it.
      if (processes.get(name) !== child) {
        console.log(`[Ecosystem] Stale ${name} instance closed (code ${code}). Newer instance active — no respawn.`);
        writeManagerState();
        return;
      }
      if (sleepingBots.has(name)) {
        console.log(`[Ecosystem] ${name} process closed, but is ASLEEP. Suppressing auto-respawn.`);
        writeManagerState();
        return;
      }
      console.log(`[Ecosystem] ${name} exited with code ${code}. Re-spawning in 5s...`);
      processes.delete(name);
      writeManagerState();
      if (fs.existsSync('c:/KAI/tools/oracle-discord/state/test_failsafe.flag')) {
        console.log(`[Ecosystem] Failsafe testing flag detected. Suppressing auto-respawn for ${name} to allow collapse simulation.`);
        return;
      }
      setTimeout(() => {
        startProcess(name, scriptForProcess(name), argsForProcess(name));
      }, 5000);
    });

    processes.set(name, child);
    writeManagerState();
  };

  if (delay > 0) {
    console.log(`[Ecosystem] Waiting ${delay}ms for ${name} port cleanup before respawning...`);
    setTimeout(doSpawn, delay);
  } else {
    doSpawn();
  }
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

// ── Ordered ignition (per Ryan's spec): Oracle -> KAI -> INDUSTRIAL helpers -> SOCIAL ais ──
// Industrial/helper AIs come up first so they're ready to assist; the social AIs come last.
// Staggered ~1.2s apart to respect Discord's one-identify-per-5s gateway limit and avoid OS spikes.
// startProcess() still honors the sleep list, so social bots asleep in essentials mode are skipped.
const INDUSTRIAL_ORDER = ["Analyst", "Researcher", "Kai Coder"];
const SOCIAL_ORDER = ["Leo", "Gemini", "Claudey", "X", "Groq"]; // Leo first = voice anchor

let startDelay = 4000;
for (const bot of INDUSTRIAL_ORDER) {
  const currentBot = bot;
  setTimeout(() => {
    console.log(`[Ecosystem] Spawning industrial AI: ${currentBot}...`);
    startProcess(currentBot, "bots/start-bot.mjs", [currentBot]);
  }, startDelay);
  startDelay += 1200;
}
for (const bot of SOCIAL_ORDER) {
  const currentBot = bot;
  const file = currentBot === "Leo" ? "bots/leo.mjs" : "bots/start-bot.mjs";
  const args = currentBot === "Leo" ? [] : [currentBot];
  setTimeout(() => {
    console.log(`[Ecosystem] Spawning social AI: ${currentBot}...`);
    startProcess(currentBot, file, args);
  }, startDelay);
  startDelay += 1200;
}

// Global World Clock Heartbeat — 30s keeps every agent aligned to real time (second precision)
const WORLD_TICK_MS = parseInt(process.env.KAI_WORLD_TICK_MS || '30000', 10);
setInterval(() => {
  clock.tick();
  const worldState = clock.getCurrentState();
  broadcast({ type: 'WORLD_TICK', worldState });
}, WORLD_TICK_MS);
// Immediate tick on boot so agents get time before first interval
clock.tick();
broadcast({ type: 'WORLD_TICK', worldState: clock.getCurrentState() });

setInterval(writeManagerState, 15000);
writeManagerState();

// ── FILE-QUEUED RESTART REQUESTS ────────────────────────────────────────────
// Processes without an IPC channel to us (e.g. Oracle's standalone ToolServer)
// queue restart requests in this file. Poll it every 5s and act on them —
// closes the "patch applied but bot never restarted" gap.
const RESTART_QUEUE_FILE = 'c:/KAI/tools/oracle-discord/state/restart_requests.json';
setInterval(() => {
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(RESTART_QUEUE_FILE, 'utf8')); } catch (_) { return; }
  if (!Array.isArray(queue) || queue.length === 0) return;
  try { fs.unlinkSync(RESTART_QUEUE_FILE); } catch (_) {}
  for (const req of queue) {
    // Stale guard: ignore requests older than 10 minutes
    if (!req?.botName || (Date.now() - (req.ts || 0)) > 600_000) continue;
    const properName = normalizeProcessName(req.botName);
    if (!properName) continue;
    console.log(`[Ecosystem] File-queued restart: ${properName} (${req.reason || 'no reason'})`);
    sleepingBots.delete(properName);
    startProcess(properName, scriptForProcess(properName), argsForProcess(properName));
  }
}, 5000);

// CLI Interface
if (process.stdin.isTTY) {
  // FIX: when the launching console closes, reads from the dead TTY emit
  // EPIPE. Without these handlers the 'error' event was unhandled and
  // crashed the whole ecosystem manager (orphaning every bot).
  process.stdin.on('error', () => {});

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Ecosystem> '
  });

  rl.on('error', () => {
    console.log('[Ecosystem] Console detached. CLI disabled; manager continues headless.');
    try { rl.close(); } catch (_) {}
  });

  rl.prompt();

  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd.startsWith('restart ')) {
      const name = line.split(' ')[1];
      if (name) {
        const properName = normalizeProcessName(name);
        if (properName) {
          sleepingBots.delete(properName);
          startProcess(properName, scriptForProcess(properName), argsForProcess(properName));
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
} else {
  console.log('[Ecosystem] Non-interactive mode detected. CLI disabled; manager state is written to state/ecosystem-manager.json.');
}

// ── DYNAMIC ENV WATCHER & HOT-RELOADER ──────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    const envPath = 'c:/KAI/tools/oracle-discord/.env';
    if (!fs.existsSync(envPath)) return env;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let val = trimmed.slice(index + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch (_) {}
  return env;
}

let currentEnv = loadEnv();

function handleEnvChange() {
  console.log(`[Ecosystem] .env file change detected. Reloading configuration...`);
  const nextEnv = loadEnv();
  
  const changedKeys = [];
  const addedKeys = [];
  const removedKeys = [];
  
  for (const key of Object.keys(nextEnv)) {
    if (!(key in currentEnv)) {
      addedKeys.push(key);
    } else if (nextEnv[key] !== currentEnv[key]) {
      changedKeys.push(key);
    }
  }
  for (const key of Object.keys(currentEnv)) {
    if (!(key in nextEnv)) {
      removedKeys.push(key);
    }
  }

  // Update process.env for new child processes to inherit
  for (const key of addedKeys.concat(changedKeys)) {
    process.env[key] = nextEnv[key];
  }
  for (const key of removedKeys) {
    delete process.env[key];
  }

  const allChanges = [...addedKeys, ...changedKeys, ...removedKeys];
  if (allChanges.length === 0) {
    console.log(`[Ecosystem] No configuration changes detected in .env.`);
    return;
  }

  console.log(`[Ecosystem] Reloaded .env. Changed keys: ${allChanges.join(', ')}`);
  currentEnv = nextEnv;

  // 1. Handle sleep/wake changes via ORACLE_START_SLEEP_BOTS
  if (allChanges.includes('ORACLE_START_SLEEP_BOTS')) {
    const newSleepList = new Set();
    for (const raw of (process.env.ORACLE_START_SLEEP_BOTS || "").split(",")) {
      const name = normalizeProcessName(raw);
      if (name && !["Oracle", "KAI", "Dashboard"].includes(name)) {
        newSleepList.add(name);
      }
    }

    // Put newly slept bots to sleep
    for (const bot of newSleepList) {
      if (!sleepingBots.has(bot)) {
        console.log(`[Ecosystem] Config change: Putting ${bot} to sleep...`);
        sleepingBots.add(bot);
        const child = processes.get(bot);
        if (child) {
          child.removeAllListeners('close');
          if (child.connected) child.kill('SIGKILL');
          processes.delete(bot);
          console.log(`[Ecosystem] ${bot} is now ASLEEP.`);
        }
      }
    }

    // Wake newly awake bots
    const currentSleeping = [...sleepingBots];
    for (const bot of currentSleeping) {
      if (!newSleepList.has(bot)) {
        console.log(`[Ecosystem] Config change: Waking up ${bot}...`);
        sleepingBots.delete(bot);
        const existing = processes.get(bot);
        if (!existing || existing.exitCode !== null || existing.killed) {
          startProcess(bot, scriptForProcess(bot), argsForProcess(bot));
        }
      }
    }
    writeManagerState();
  }

  // 2. Restart processes affected by specific key changes
  const restartTargets = new Set();

  for (const key of allChanges) {
    if (key === 'ORACLE_START_SLEEP_BOTS') continue;

    // Check if it belongs to a specific bot
    let matchedBot = null;
    for (const bot of KNOWN_PROCESSES) {
      // Handle special naming mapping for Kai Coder -> Oracle Coder token
      const botUpper = bot.toUpperCase().replace(/\s+/g, '_');
      if (key.endsWith(`_${botUpper}`) || key.includes(`_${botUpper}_`) || key.endsWith(`_${botUpper.replace('KAI_CODER', 'ORACLE_CODER')}`)) {
        matchedBot = bot;
        break;
      }
    }

    if (matchedBot) {
      restartTargets.add(matchedBot);
    } else {
      // It's a global config change (e.g. GEMINI_LIVE_MODEL, GEMINI_API_KEY, SOVEREIGN_API_KEY, OWNER_ID)
      // We should restart all active processes to pick up the new configuration
      for (const [name, child] of processes) {
        if (child && child.exitCode === null && !child.killed) {
          restartTargets.add(name);
        }
      }
    }
  }

  // Restart targets with staggered delay
  if (restartTargets.size > 0) {
    console.log(`[Ecosystem] Config changes require restarting: ${[...restartTargets].join(', ')}`);
    let delay = 0;
    for (const bot of restartTargets) {
      if (sleepingBots.has(bot)) {
        console.log(`[Ecosystem] ${bot} is asleep, skipping restart.`);
        continue;
      }
      setTimeout(() => {
        console.log(`[Ecosystem] Live-reloading ${bot}...`);
        startProcess(bot, scriptForProcess(bot), argsForProcess(bot));
      }, delay);
      delay += 1500; // 1.5s stagger is perfectly safe
    }
  }
}

let envWatchTimeout = null;
const envFilePath = 'c:/KAI/tools/oracle-discord/.env';
if (fs.existsSync(envFilePath)) {
  fs.watch(envFilePath, (eventType) => {
    if (eventType === 'change') {
      if (envWatchTimeout) clearTimeout(envWatchTimeout);
      envWatchTimeout = setTimeout(() => {
        try {
          handleEnvChange();
        } catch (err) {
          console.error(`[Ecosystem] Error handling .env file change:`, err);
        }
      }, 500);
    }
  });
  console.log(`[Ecosystem] Live-watching .env file for configuration changes...`);
}

