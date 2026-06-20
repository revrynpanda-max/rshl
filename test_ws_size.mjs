import { WebSocket } from 'ws';
import fs from 'fs';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("No API key");
  process.exit(1);
}

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

function testSize(size) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      const payload = {
        setup: {
          model: "models/gemini-2.0-flash-exp",
          system_instruction: {
            parts: [{ text: "A".repeat(size) }]
          }
        }
      };
      ws.send(JSON.stringify(payload));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.setupComplete) {
        console.log(`Size ${size}: SUCCESS`);
        ws.close();
        resolve(true);
      }
    });

    ws.on('close', (code) => {
      if (code !== 1000 && code !== 1005) {
        console.log(`Size ${size}: FAILED with code ${code}`);
      }
      resolve(false);
    });
  });
}

async function run() {
  await testSize(10000); // 10KB
  await testSize(32000); // 32KB
  await testSize(64000); // 64KB
  await testSize(128000); // 128KB
  await testSize(500000); // 500KB
}

run();
