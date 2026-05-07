import { spawn, fork } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import { WorldClock } from './shared/simulation.mjs';

const clock = new WorldClock();

import 'dotenv/config';

const BOTS = ["Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Kai Coder"];
const processes = new Map(); // name -> child process

function broadcast(msg) {
  for (const [name, child] of processes) {
    if (child && child.connected) {
      child.send(msg);
    }
  }
}

function startProcess(name, script, args = []) {
  if (processes.has(name)) {
    const old = processes.get(name);
    if (old && old.connected) old.kill();
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

  // ATTACH IPC LISTENERS IMMEDIATELY
  child.on('message', (msg) => {
    if (msg.type === 'VITALS_UPDATE') {
      const kai = processes.get("KAI");
      if (kai && kai.connected) {
        kai.send({ type: 'OBSERVE_VITALS', vitals: msg.vitals });
      }
    }
    if (msg.type === 'SOCIAL_STIMULUS') {
      // One bot spoke, wake up the others!
      broadcast({ type: 'INTEREST_BOOST', multiplier: 2.0, duration: 30000 });
    }
    if (msg.type === 'LATTICE_FEED') {
      const kai = processes.get("KAI");
      if (kai && kai.connected) {
        kai.send({ type: 'INJECT_CLAIM', payload: msg.payload });
      }
    }
  });

  child.on('close', (code) => {
    console.log(`[Ecosystem] ${name} exited with code ${code}. Re-spawning in 5s...`);
    processes.delete(name);
    setTimeout(() => {
      if (name === "Oracle") startProcess("Oracle", "oracle-gateway.mjs");
      else if (name === "Leo") startProcess("Leo", "bots/leo.mjs");
      else if (name === "KAI") startProcess("KAI", "bots/kai.mjs");
      else startProcess(name, "bots/start-bot.mjs", [name]);
    }, 5000);
  });

  processes.set(name, child);
}

// Start everything
startProcess("Oracle", "oracle-gateway.mjs");
startProcess("Leo", "bots/leo.mjs");
startProcess("KAI", "bots/kai.mjs");

for (const bot of BOTS) {
  startProcess(bot, "bots/start-bot.mjs", [bot]);
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
