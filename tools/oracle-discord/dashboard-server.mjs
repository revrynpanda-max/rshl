import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3001;
const DASHBOARD_FILE = 'c:\\KAI\\oracle.html';

const server = http.createServer((req, res) => {
  // Proxy /api requests to the Rust CNS on 3334
  if (req.url.startsWith('/api')) {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 3334,
      path: req.url,
      method: req.method,
      headers: req.headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('CNS Offline');
    });
    req.pipe(proxyReq);
    return;
  }

  // Health probe: confirms the dashboard process is up, and reports whether
  // the Rust CNS on 3334 answers. Returns 200 so uptime checks pass.
  if (req.url === '/health') {
    const cnsReq = http.request(
      { hostname: '127.0.0.1', port: 3334, path: '/api/session', method: 'GET', timeout: 1500 },
      (cnsRes) => {
        cnsRes.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          dashboard: 'up',
          cns: cnsRes.statusCode === 200 ? 'up' : 'degraded',
          ts: new Date().toISOString()
        }));
      }
    );
    cnsReq.on('timeout', () => cnsReq.destroy());
    cnsReq.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', dashboard: 'up', cns: 'down', ts: new Date().toISOString() }));
    });
    cnsReq.end();
    return;
  }

  if (req.url === '/' || req.url === '/dashboard') {
    fs.readFile(DASHBOARD_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading dashboard');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Dashboard] CRITICAL: Port 3001 is already in use by another process.`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n🌌 [Sovereign Dashboard] LIVE at http://localhost:${PORT}`);
  console.log(`🚀 Access this URL in your browser to bypass CORS restrictions.\n`);
});
