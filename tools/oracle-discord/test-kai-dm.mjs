async function run() {
  const systemPrompt = `You are KAI, the core architect of this system. Provide a helpful, concise response to the user.`;
  const chatMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Hey Kai' }
  ];

  console.log("Fetching from ollama gemma4...");
  const res = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: 'gemma4',
      messages: chatMessages,
      stream: false,
      options: { temperature: 0.85, num_predict: 128, num_ctx: 4096 }
    })
  });

  const data = await res.json();
  console.log("RAW OLLAMA RESPONSE:");
  console.log(JSON.stringify(data, null, 2));

  let response = data.choices?.[0]?.message?.content?.trim() || data.message?.content?.trim() || "";
  console.log("EXTRACTED CONTENT:");
  console.log(response);

  const botNames = ["Leo", "Oracle", "KAI", "Analyst", "Gemini", "Gemi", "Groq", "Claudey", "Researcher", "Kai Coder", "x AI", "X"];
  const lines = response.split('\n');
  let cleanLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && botNames.some(n => line.toLowerCase().startsWith(n.toLowerCase() + ":"))) {
       cleanLines.push(line.split(':').slice(1).join(':').trim());
       continue;
    }
    if (botNames.some(n => line.startsWith(n + ":") || line.startsWith("[" + n + "]") || line.startsWith(n + " ["))) {
      break; 
    }
    cleanLines.push(line);
  }
  response = cleanLines.join('\n').trim();

  response = response
    .replace(/\[.*?\]/g, "") 
    .replace(/\b(lattice|rshl memory|recent claim|topic associated|search through)\b/gi, "that")
    .replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');

  console.log("CLEANED CONTENT:");
  console.log(response);
}

run();
