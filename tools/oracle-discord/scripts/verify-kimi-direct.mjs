import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

async function testMoonshot() {
  const key = process.env.MOONSHOT_API_KEY;
  console.log("Testing Moonshot with key ending in:", key.slice(-4));
  
  try {
    const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [{ role: "user", content: "Verify KAI connection." }]
      })
    });
    
    const data = await res.json();
    console.log("Response Status:", res.status);
    console.log("Response Data:", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Test Error:", e.message);
  }
}

testMoonshot();
