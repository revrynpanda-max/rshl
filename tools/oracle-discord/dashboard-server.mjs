import http from 'http';
import fs from 'fs';
import path from 'path';
import { buildProofSummary, renderProofMarkdown, proofPaths } from './shared/proof-metrics.mjs';

const PORT = 3001;
const DASHBOARD_FILE = 'c:\\KAI\\oracle.html';

const server = http.createServer((req, res) => {
  if (req.url === '/api/proof/summary') {
    const summary = buildProofSummary();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary, null, 2));
    return;
  }

  if (req.url === '/proof') {
    const summary = buildProofSummary();
    const markdown = fs.existsSync(proofPaths.latestMarkdown)
      ? fs.readFileSync(proofPaths.latestMarkdown, 'utf8')
      : renderProofMarkdown(summary);
    const escaped = markdown.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>KAI Proof Report</title><style>body{font-family:system-ui,Segoe UI,sans-serif;margin:32px;max-width:1100px;line-height:1.45}pre{white-space:pre-wrap;background:#0d1117;color:#e6edf3;padding:20px;border-radius:8px}a{color:#0969da}</style></head><body><p><a href="/dashboard">Dashboard</a> | <a href="/api/proof/summary">Proof JSON</a></p><pre>${escaped}</pre></body></html>`);
    return;
  }

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
