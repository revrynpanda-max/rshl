import fs from 'fs';

async function extractSource() {
  console.log("Fetching inspector targets...");
  const res = await fetch('http://127.0.0.1:9229/json/list');
  const targets = await res.json();
  const target = targets.find(t => t.type === 'node');
  
  if (!target) {
    console.error("No node target found");
    return;
  }
  
  const wsUrl = target.webSocketDebuggerUrl;
  console.log("Connecting to", wsUrl);
  
  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  let targetScriptId = null;
  
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: msgId++, method: 'Debugger.enable' }));
  };
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.method === 'Debugger.scriptParsed') {
      if (msg.params.url.includes('command-center-server.mjs')) {
        targetScriptId = msg.params.scriptId;
        console.log("Found script ID:", targetScriptId, "for URL:", msg.params.url);
        // Request the source code
        ws.send(JSON.stringify({
          id: msgId++,
          method: 'Debugger.getScriptSource',
          params: { scriptId: targetScriptId }
        }));
      }
    }
    
    if (msg.id && msg.result && msg.result.scriptSource) {
      console.log("Received source code! Length:", msg.result.scriptSource.length);
      fs.writeFileSync('C:/KAI/tools/oracle-discord/command-center-server.mjs.recovered', msg.result.scriptSource);
      console.log("Successfully wrote recovered file.");
      process.exit(0);
    }
  };
  
  ws.onerror = (e) => {
    console.error("WS error:", e);
  };
}

extractSource().catch(console.error);
