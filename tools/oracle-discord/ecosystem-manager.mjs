import { spawn, fork } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import { WorldClock } from './shared/simulation.mjs';

const clock = new WorldClock();

// Manual .env loader for child process consistency
const envPath = './.env';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const [_, key, value] = match;
      process.env[key] = value.trim().replace(/^['"](.*)['"]$/, '$1');
    }
  });
}
const BOTS = ["Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Kai Coder"];
const processes = new Map(); // name -> child process

function startProcess(name, script, args = []) {
  if (processes.has(name)) {
    console.log(`[Ecosystem] Killing existing ${name}...`);
    processes.get(name).kill();
  }

  console.log(`[Ecosystem] Starting ${name}...`);
  const child = fork(script, args, { 
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'] 
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(`[${name}] ${data}`);
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(`[${name}] ERROR: ${data}`);
  });

  child.on('close', (code) => {
    console.log(`[Ecosystem] ${name} exited with code ${code}. Re-spawning in 5s...`);
    if (processes.get(name) === child) {
      processes.delete(name);
      setTimeout(() => {
        if (name === "Oracle") startProcess("Oracle", "oracle-gateway.mjs");
        else if (name === "Leo") startProcess("Leo", "bots/leo.mjs");
        else if (name === "KAI") startProcess("KAI", "bots/kai.mjs");
        else startProcess(name, "bots/start-bot.mjs", [name]);
      }, 5000);
    }
  });

  processes.set(name, child);
}

function broadcast(msg) {
  for (const [name, child] of processes) {
    if (child.connected) {
      child.send(msg);
    }
  }
}

// Start everything
startProcess("Oracle", "oracle-gateway.mjs");
startProcess("Leo", "bots/leo.mjs");
startProcess("KAI", "bots/kai.mjs");

for (const bot of BOTS) {
  startProcess(bot, "bots/start-bot.mjs", [bot]);
}

// Setup IPC Listeners for Vitals
for (const [name, child] of processes) {
  child.on('message', (msg) => {
    if (msg.type === 'VITALS_UPDATE') {
      // Forward to KAI for observation
      const kai = processes.get("KAI");
      if (kai && kai.connected) {
        kai.send({ type: 'OBSERVE_VITALS', vitals: msg.vitals });
      }
    }
    if (msg.type === 'SOCIAL_STIMULUS') {
      // One bot spoke, wake up the others!
      broadcast({ type: 'INTEREST_BOOST', multiplier: 2.0, duration: 30000 });
    }
    if (msg.type === 'COMMAND_REQUEST') {
      executeCommand(msg.command);
    }
    if (msg.type === 'UPDATE_ENV') {
      updateEnvFile(msg.target);
    }
    if (msg.type === 'LATTICE_FEED') {
      const kai = processes.get("KAI");
      if (kai && kai.connected) {
        kai.send({ type: 'INJECT_CLAIM', payload: msg.payload });
      }
    }
  });
}

function updateEnvFile(keyValue) {
  console.log(`[Ecosystem] Updating .env with: ${keyValue}`);
  const envPath = './.env';
  let content = fs.readFileSync(envPath, 'utf8');
  const [key, val] = keyValue.split('=');
  
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${val}`);
  } else {
    content += `\n${key}=${val}`;
  }
  
  fs.writeFileSync(envPath, content);
  console.log(`[Ecosystem] .env updated. Key ${key} is now set.`);
}

// --- AI Command Watcher ---
const COMMAND_FILE = './remote_commands.json';
if (!fs.existsSync(COMMAND_FILE)) fs.writeFileSync(COMMAND_FILE, '{}');

fs.watch(COMMAND_FILE, (eventType) => {
  if (eventType === 'change') {
    try {
      const data = JSON.parse(fs.readFileSync(COMMAND_FILE, 'utf8'));
      if (data.action) {
        console.log(`[Ecosystem/AI] Received Remote Action: ${data.action} (${data.target || 'no target'})`);
        if (data.action === 'restart') executeCommand(`restart ${data.target}`);
        if (data.action === 'hotfix') executeCommand('hotfix');
        if (data.action === 'env_update') updateEnvFile(data.target);
        if (data.action === 'status_check') executeCommand('status');
        
        // Clear command after processing
        fs.writeFileSync(COMMAND_FILE, '{}');
      }
    } catch (e) {
      // Ignore read errors during writes
    }
  }
});

function executeCommand(input) {
  const line = input.trim();
  if (line === 'hotfix') {
    runHotfix();
    return;
  }
  if (line.startsWith('restart ')) {
    const target = line.replace('restart ', '').trim();
    const lcTarget = target.toLowerCase();
    
    if (lcTarget === 'oracle') startProcess("Oracle", "oracle-gateway.mjs");
    else if (lcTarget === 'leo') startProcess("Leo", "bots/leo.mjs");
    else if (lcTarget === 'kai') startProcess("KAI", "bots/kai.mjs");
    else {
      const exactMatch = BOTS.find(b => b.toLowerCase() === lcTarget);
      if (exactMatch) startProcess(exactMatch, "bots/start-bot.mjs", [exactMatch]);
      else console.log(`[Ecosystem] Unknown bot: ${target}`);
    }
  } else if (line === 'status') {
    console.log("[Ecosystem] Status Requested...");
    // Future: send vitals report back to DM
  } else if (line === 'reboot') {
    console.log("[Ecosystem] Full Reboot Sequence Initiated...");
    process.exit(0); 
  }
}

async function runHotfix() {
  console.log("[Ecosystem] HOTFIX INITIATED: Pulling latest changes...");
  
  const run = (cmd, args, cwd) => new Promise((resolve) => {
    console.log(`[Hotfix] Running: ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true });
    p.on('close', resolve);
  });

  await run("git", ["pull"], "../../");
  console.log("[Hotfix] Core Update Complete. Rebuilding...");
  await run("cargo", ["build", "--release"], "../../");
  console.log("[Hotfix] Rebuild Complete. Restarting Ecosystem...");
  process.exit(0);
}


// --- The Heartbeat (World Clock) ---
let tickCount = 0;
let _isWorkHours = false;

setInterval(async () => {
  tickCount++;
  
  // Sync with Oracle Server to check for "Break Mode" (Pending Proposal)
  if (tickCount % 5 === 0) {
    try {
      const res = await fetch("http://127.0.0.1:3333/api/live-roundtable-tick").catch(() => null);
      if (res && res.ok) {
        const payload = await res.json().catch(() => ({}));
        _isWorkHours = payload.queued && !payload.pending_proposal;
      }
    } catch (e) {}
  }

  clock.tick();
  const state = clock.getState();
  state.isWorkHours = _isWorkHours;
  
  // Broadcast the "Moment" to all living entities
  for (const [name, child] of processes) {
    if (child.connected) {
      child.send({ type: 'WORLD_TICK', worldState: state });
    }
  }
}, 1000); 


console.log("\n=======================================================");
console.log(" Oracle Ecosystem Manager Online (Living Universe Mode)");
console.log(" Type 'restart <bot>' to restart a specific bot.");
console.log("=======================================================\n");

// Interactive command prompt
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', (input) => {
  executeCommand(input);
});


