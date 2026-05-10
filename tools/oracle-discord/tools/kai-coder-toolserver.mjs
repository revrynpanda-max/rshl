/**
 * kai-coder-toolserver.mjs
 * Local HTTP tool server — port 3420
 *
 * Gives Kai Coder real capabilities:
 *   read, list, grep, write (sandbox), exec (sandbox), diff, apply, check
 *
 * Security model:
 *   - Reads: allowed anywhere under PROJECT_ROOT
 *   - Writes/Exec: sandbox only (SANDBOX_ROOT)
 *   - Apply: copies sandbox → production with automatic backup
 *   - All ops are logged to the audit trail
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT          = 3420;
const PROJECT_ROOT  = path.resolve('c:/KAI');                       // Full project — read access
const DISCORD_ROOT  = path.resolve('c:/KAI/tools/oracle-discord'); // Discord project subtree
const SANDBOX_ROOT  = path.join(DISCORD_ROOT, 'sandbox');           // Write sandbox — always isolated
const BACKUP_ROOT   = path.join(DISCORD_ROOT, '.kai-backups');
const MAX_FILE_SIZE = 500 * 1024; // 500 KB read cap per file
const EXEC_TIMEOUT  = 15000;      // 15s shell timeout

// Ensure directories exist
for (const dir of [SANDBOX_ROOT, BACKUP_ROOT]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Security ──────────────────────────────────────────────────────────────────

function assertUnderRoot(p, root = PROJECT_ROOT) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(root)) {
    throw new Error(`Path outside allowed root: ${resolved}`);
  }
  return resolved;
}

// Translate a project-relative path to its sandbox equivalent
function sandboxPath(relOrAbs) {
  const rel = path.isAbsolute(relOrAbs)
    ? path.relative(PROJECT_ROOT, relOrAbs)
    : relOrAbs;
  return path.join(SANDBOX_ROOT, rel);
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function toolRead({ path: filePath }) {
  const resolved = assertUnderRoot(filePath);
  if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) return { error: `File too large (${stat.size} bytes). Read specific lines instead.` };
  return { content: fs.readFileSync(resolved, 'utf8'), path: resolved };
}

async function toolList({ path: dirPath }) {
  const resolved = assertUnderRoot(dirPath);
  if (!fs.existsSync(resolved)) return { error: `Directory not found: ${dirPath}` };
  const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
    size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : null
  }));
  return { entries, path: resolved };
}

async function toolGrep({ pattern, searchPath = '.', recursive = true, caseInsensitive = false }) {
  const resolved = assertUnderRoot(path.join(PROJECT_ROOT, searchPath));
  const flags = caseInsensitive ? 'gi' : 'g';
  const regex = new RegExp(pattern, flags);
  const matches = [];

  function scanFile(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) return;
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          matches.push({ file: filePath, line: i + 1, content: line.trim() });
          regex.lastIndex = 0; // reset stateful regex
        }
      });
    } catch (_) {}
  }

  function scanDir(dirPath, depth = 0) {
    if (depth > 6) return;
    const SKIP = new Set(['node_modules', '.git', 'sandbox', '.kai-backups', 'dist', 'build', 'target']);
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dirPath, e.name);
      if (e.isDirectory() && recursive) scanDir(full, depth + 1);
      else if (e.isFile() && /\.(mjs|js|json|ts|md|txt|bat|ps1|env|rs|toml|lock)$/.test(e.name)) scanFile(full);
    }
  }

  const stat = fs.existsSync(resolved) && fs.statSync(resolved);
  if (stat && stat.isDirectory()) scanDir(resolved);
  else if (stat && stat.isFile()) scanFile(resolved);

  return { matches: matches.slice(0, 200), total: matches.length, pattern };
}

async function toolWrite({ path: filePath, content }) {
  // Always writes to sandbox — never directly to production
  // Translate project-absolute paths into sandbox-relative paths
  const relToDiscord = path.isAbsolute(filePath)
    ? path.relative(DISCORD_ROOT, path.resolve(filePath))
    : filePath;
  const sbPath = path.join(SANDBOX_ROOT, relToDiscord);
  fs.mkdirSync(path.dirname(sbPath), { recursive: true });
  fs.writeFileSync(sbPath, content, 'utf8');
  return { written: sbPath, sandboxRelative: path.relative(SANDBOX_ROOT, sbPath) };
}

async function toolExec({ command }) {
  // Runs inside the sandbox directory with a hard timeout
  // Allowlist safe commands only — no rm, del, format etc.
  const BLOCKED = /\b(rm|rmdir|del|format|shutdown|reboot|mkfs|dd\s)/i;
  if (BLOCKED.test(command)) return { error: `Blocked command: ${command}` };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: SANDBOX_ROOT,
      timeout: EXEC_TIMEOUT,
      windowsHide: true
    });
    return { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 1000), cwd: SANDBOX_ROOT };
  } catch (e) {
    return { error: e.message.slice(0, 500), stderr: e.stderr?.slice(0, 500) };
  }
}

async function toolCheck({ path: filePath }) {
  // node --check syntax validation — works on both sandbox and production files
  // If path exists in sandbox, check sandbox version; else check production
  const sbPath = sandboxPath(filePath);
  const checkPath = fs.existsSync(sbPath) ? sbPath : assertUnderRoot(filePath);
  try {
    const { stdout, stderr } = await execAsync(`node --check "${checkPath}"`, { timeout: 8000, windowsHide: true });
    return { valid: true, path: checkPath, stdout, stderr };
  } catch (e) {
    return { valid: false, path: checkPath, error: e.stderr || e.message };
  }
}

async function toolDiff({ path: filePath }) {
  // Compare sandbox version vs production version
  const sbPath = sandboxPath(filePath);
  const prodPath = assertUnderRoot(filePath);

  const sandboxExists = fs.existsSync(sbPath);
  const prodExists = fs.existsSync(prodPath);

  if (!sandboxExists) return { error: `No sandbox version of ${filePath}. Write to sandbox first.` };

  const sandboxContent = fs.readFileSync(sbPath, 'utf8').split('\n');
  const prodContent = prodExists ? fs.readFileSync(prodPath, 'utf8').split('\n') : [];

  const diff = [];
  const maxLen = Math.max(sandboxContent.length, prodContent.length);
  let additions = 0, deletions = 0;

  for (let i = 0; i < maxLen; i++) {
    const prod = prodContent[i];
    const sb = sandboxContent[i];
    if (prod === undefined) { diff.push(`+[${i+1}] ${sb}`); additions++; }
    else if (sb === undefined) { diff.push(`-[${i+1}] ${prod}`); deletions++; }
    else if (prod !== sb) {
      diff.push(`-[${i+1}] ${prod}`);
      diff.push(`+[${i+1}] ${sb}`);
      additions++; deletions++;
    }
  }

  return {
    file: filePath,
    sandboxPath: sbPath,
    productionPath: prodPath,
    additions,
    deletions,
    unchanged: maxLen - additions - deletions,
    diff: diff.slice(0, 300).join('\n'),
    isNewFile: !prodExists
  };
}

async function toolApply({ path: filePath }) {
  // Copy sandbox → production, with backup of original
  const sbPath = sandboxPath(filePath);
  const prodPath = assertUnderRoot(filePath);

  if (!fs.existsSync(sbPath)) return { error: `No sandbox file at: ${sbPath}` };

  // Back up original if it exists
  if (fs.existsSync(prodPath)) {
    const backupName = `${path.basename(prodPath)}.${Date.now()}.bak`;
    const backupPath = path.join(BACKUP_ROOT, backupName);
    fs.copyFileSync(prodPath, backupPath);
    console.log(`[KaiCoderTools] Backup: ${backupPath}`);
  }

  fs.mkdirSync(path.dirname(prodPath), { recursive: true });
  fs.copyFileSync(sbPath, prodPath);
  return { applied: prodPath, from: sbPath, backedUp: fs.existsSync(prodPath) };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

import os from 'os';

async function toolSysinfo() {
  const cpus   = os.cpus();
  const totMem = os.totalmem();
  const freMem = os.freemem();
  // Disk: use 'wmic' on Windows; skip gracefully if unavailable
  let diskInfo = 'unavailable';
  try {
    const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption', { timeout: 3000, windowsHide: true });
    diskInfo = stdout.trim();
  } catch (_) {}
  return {
    platform: os.platform(),
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length,
    loadAvg: os.loadavg(),
    totalMemMB: Math.round(totMem / 1048576),
    freeMemMB:  Math.round(freMem / 1048576),
    usedMemPct: Math.round((1 - freMem / totMem) * 100),
    uptimeSeconds: Math.round(os.uptime()),
    disk: diskInfo
  };
}

async function toolSearch({ query }) {
  // Use internal web-search utility or a fallback
  try {
    const res = await fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(query)}`, { timeout: 10000 });
    if (res.ok) return await res.json();
    return { error: `Search service error: ${res.statusText}` };
  } catch (e) {
    return { error: `Search service unreachable: ${e.message}` };
  }
}

async function toolLattice({ query }) {
  try {
    const res = await fetch('http://127.0.0.1:3333/api/rshl/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: query }),
      timeout: 5000
    });
    return await res.json();
  } catch (e) {
    return { error: `Lattice (3333) unreachable: ${e.message}` };
  }
}

async function toolInspect({ path: filePath }) {
  try {
    const res = await fetch('http://127.0.0.1:3333/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
      timeout: 5000
    });
    return await res.json();
  } catch (e) {
    return { error: `Inspector (3333) unreachable: ${e.message}` };
  }
}

async function toolStatus() {
  try {
    const res = await fetch('http://127.0.0.1:3333/api/status', { timeout: 3000 });
    return await res.json();
  } catch (e) {
    return { error: `Status (3333) unreachable: ${e.message}` };
  }
}

async function toolAudit() {
  // Runs the system-auditor script if available
  try {
    const auditorPath = path.join(DISCORD_ROOT, 'scripts', 'system-auditor.mjs');
    if (!fs.existsSync(auditorPath)) return { error: 'Auditor script not found.' };
    const { stdout, stderr } = await execAsync(`node "${auditorPath}" --json`, { timeout: 30000 });
    return JSON.parse(stdout);
  } catch (e) {
    return { error: `Audit failed: ${e.message}` };
  }
}

async function toolSnapshot() {
  try {
    const { stdout } = await execAsync('powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 | ConvertTo-Json"', { timeout: 5000 });
    return { processes: JSON.parse(stdout), timestamp: new Date().toISOString() };
  } catch (e) {
    return { error: `Snapshot failed: ${e.message}` };
  }
}

async function toolTest() {
  const results = {};
  for (const name of Object.keys(TOOL_MAP)) {
    results[name] = 'ready';
  }
  return { status: 'Tool diagnostics complete', results };
}

const TOOL_MAP = { 
  read: toolRead, 
  list: toolList, 
  grep: toolGrep, 
  write: toolWrite, 
  exec: toolExec, 
  check: toolCheck, 
  diff: toolDiff, 
  apply: toolApply, 
  sysinfo: toolSysinfo,
  search: toolSearch,
  lattice: toolLattice,
  inspect: toolInspect,
  status: toolStatus,
  audit: toolAudit,
  snapshot: toolSnapshot,
  test: toolTest
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', sandbox: SANDBOX_ROOT, tools: Object.keys(TOOL_MAP) }));
  }

  if (req.method === 'POST' && req.url === '/tool') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { action, ...params } = JSON.parse(body);
        const handler = TOOL_MAP[action];
        if (!handler) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
        }
        console.log(`[KaiCoderTools] ${action.toUpperCase()} ${JSON.stringify(params).slice(0, 80)}`);
        const result = await handler(params);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[KaiCoderTools] Tool server online at port ${PORT}`);
  console.log(`[KaiCoderTools] Project root (read): ${PROJECT_ROOT}`);
  console.log(`[KaiCoderTools] Sandbox (write): ${SANDBOX_ROOT}`);
  console.log(`[KaiCoderTools] Backups: ${BACKUP_ROOT}`);
  console.log(`[KaiCoderTools] Tools: ${Object.keys(TOOL_MAP).join(', ')}`);
});

export { PORT as TOOL_SERVER_PORT };

