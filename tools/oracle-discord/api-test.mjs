import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: 'C:/KAI/tools/oracle-discord/.env' });

async function testApi(name, url, headers, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      console.log(`[OK] ${name} is working.`);
    } else {
      const text = await res.text();
      console.log(`[FAIL] ${name}: ${res.status} - ${text.substring(0, 150)}`);
    }
  } catch(e) {
    console.log(`[ERROR] ${name}: ${e.message}`);
  }
}

async function run() {
  console.log("Testing API connections...");
  await testApi('Zen (Claude Sonnet 3.5)', 'https://opencode.ai/zen/v1/chat/completions', 
    { 'Authorization': 'Bearer ' + process.env.OPENCODE_ZEN_KEY, 'Content-Type': 'application/json' },
    { model: 'claude-sonnet-4-5', messages: [{role: 'user', content: 'hi'}], max_tokens: 10 }
  );

  await testApi('Moonshot (Kimi)', 'https://api.moonshot.cn/v1/chat/completions', 
    { 'Authorization': 'Bearer ' + process.env.MOONSHOT_API_KEY, 'Content-Type': 'application/json' },
    { model: 'moonshot-v1-8k', messages: [{role: 'user', content: 'hi'}], max_tokens: 10 }
  );

  await testApi('Groq (Llama3)', 'https://api.groq.com/openai/v1/chat/completions', 
    { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    { model: 'llama-3.3-70b-versatile', messages: [{role: 'user', content: 'hi'}], max_tokens: 10 }
  );

  await testApi('xAI (Grok)', 'https://api.x.ai/v1/chat/completions', 
    { 'Authorization': 'Bearer ' + process.env.XAI_API_KEY, 'Content-Type': 'application/json' },
    { model: 'grok-2', messages: [{role: 'user', content: 'hi'}], max_tokens: 10 }
  );

  await testApi('Gemini (2.5 Flash)', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 
    { 'Authorization': 'Bearer ' + process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    { model: 'gemini-2.5-flash', messages: [{role: 'user', content: 'hi'}], max_tokens: 10 }
  );
}

run();
