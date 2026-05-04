import http from 'http';

/**
 * Very simple IPC server for bots to receive signals from Oracle
 */
export function startBotServer(port, name, onTrigger) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/trigger' || req.url === '/signal')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          onTrigger(payload);
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[${name}] IPC server listening on ${port}`);
  });
  
  return server;
}

/**
 * Send a signal from Oracle to a specific bot
 */
export async function sendBotSignal(port, payload) {
  try {
    await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn(`[IPC] Failed to signal bot on port ${port}:`, e.message);
  }
}
