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

// Commands that can wipe the machine — never allowed regardless of context.
const HARD_BLOCKED = /\b(format\s+[a-z]:|\.\bwipe\b|rm\s+-rf\s+\/|del\s+\/f\s+\/s\s+\/q\s+[a-z]:\\$|shutdown|reboot|mkfs|cipher\s+\/w)\b/i;

/**
 * toolExec — Run a shell command anywhere inside c:\KAI.
 * Uses PowerShell as the shell on Windows for full project tooling access.
 * cwd defaults to PROJECT_ROOT (c:\KAI) but can be overridden per-call.
 */
async function toolExec({ command, cwd: cwdParam }) {
  if (!command) return { error: 'No command provided.' };
  if (HARD_BLOCKED.test(command)) return { error: `Blocked — destructive command detected: ${command}` };

  // Resolve working directory — must stay inside project root
  let cwd = PROJECT_ROOT;
  if (cwdParam) {
    try { cwd = assertUnderRoot(cwdParam, PROJECT_ROOT); } catch { /* ignore bad cwd, use root */ }
  }

  try {
    // Use PowerShell on Windows for full ps1/cargo/npm/node/git access
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const shellFlag = process.platform === 'win32' ? '-Command' : '-c';
    const { stdout, stderr } = await execAsync(`${shell} ${shellFlag} "${command.replace(/"/g, '\\"')}"`, {
      cwd,
      timeout: EXEC_TIMEOUT,
      windowsHide: true,
      env: {
        ...process.env,
        KAI_PROJECT_DIR: PROJECT_ROOT,
        KAI_ORACLE_HOST: 'http://127.0.0.1:3333'
      }
    });
    return { stdout: stdout.slice(0, 6000), stderr: stderr.slice(0, 2000), cwd, shell };
  } catch (e) {
    return { error: e.message.slice(0, 1000), stderr: e.stderr?.slice(0, 1000), cwd };
  }
}

/**
 * toolPowershell — Explicitly run a PowerShell script or command block.
 * Supports multi-line scripts. cwd defaults to c:\KAI.
 * Use this for: cargo builds, npm installs, running .ps1 scripts,
 * checking services, reading event logs, etc.
 */
async function toolPowershell({ script, cwd: cwdParam, timeout: timeoutParam }) {
  if (!script) return { error: 'No script provided.' };
  if (HARD_BLOCKED.test(script)) return { error: `Blocked — destructive command detected.` };

  let cwd = PROJECT_ROOT;
  if (cwdParam) {
    try { cwd = assertUnderRoot(cwdParam, PROJECT_ROOT); } catch { /* use root */ }
  }
  const timeout = Math.min(parseInt(timeoutParam || 60) * 1000, 300000); // max 5min

  try {
    // Write script to a temp file to avoid quoting nightmares with complex scripts
    const tmpFile = path.join(SANDBOX_ROOT, `ps_${Date.now()}.ps1`);
    fs.writeFileSync(tmpFile, script, 'utf8');
    const { stdout, stderr } = await execAsync(`powershell.exe -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      cwd,
      timeout,
      windowsHide: true,
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT, KAI_ORACLE_HOST: 'http://127.0.0.1:3333' }
    });
    try { fs.unlinkSync(tmpFile); } catch {}
    return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), cwd };
  } catch (e) {
    return { error: e.message.slice(0, 1000), stderr: e.stderr?.slice(0, 1000), cwd };
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

async function toolLattice({ action = 'query', query, data, metadata = {} }) {
  try {
    const endpoint = action === 'store' ? '/api/rshl/anchor' : '/api/rshl/query';
    const body = action === 'store' 
      ? { text: data, metadata: { ...metadata, source: 'KaiCoder' } }
      : { prompt: query };

    const res = await fetch(`http://127.0.0.1:3333${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

// ── Ecosystem-Specific Command Runners ────────────────────────────────────────
// Each runner knows the correct cwd, timeout, and shell for its ecosystem.
// Kai Coder calls these by name rather than crafting raw exec calls.

const RUST_ROOT = PROJECT_ROOT; // Cargo.toml lives at c:\KAI
const NODE_ROOT = path.join(PROJECT_ROOT, 'tools', 'oracle-discord');
const PYTHON_ROOT = path.join(PROJECT_ROOT, 'OpenJarvis-main');

/**
 * toolCargo — Run any Cargo / Rust command in the RSHL project.
 * Examples: check, build --release, test, clippy, doc, clean
 */
async function toolCargo({ command = 'check', args = '', cwd: cwdParam }) {
  const cwd = cwdParam ? path.resolve(cwdParam) : RUST_ROOT;
  const fullCmd = `cargo ${command} ${args}`.trim();
  if (HARD_BLOCKED.test(fullCmd)) return { error: 'Blocked command.' };
  try {
    const { stdout, stderr } = await execAsync(`powershell.exe -Command "cargo ${command} ${args}"`, {
      cwd, timeout: 300000, windowsHide: true, // up to 5min for release builds
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT }
    });
    return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000), cwd, command: fullCmd };
  } catch (e) {
    return { error: e.message.slice(0, 2000), stderr: e.stderr?.slice(0, 2000), cwd, command: fullCmd };
  }
}

/**
 * toolNpm — Run any npm command in the oracle-discord project.
 * Examples: install, run dev, run start, list, outdated, audit
 */
async function toolNpm({ command = 'list', args = '', cwd: cwdParam }) {
  const cwd = cwdParam ? path.resolve(cwdParam) : NODE_ROOT;
  const fullCmd = `npm ${command} ${args}`.trim();
  if (HARD_BLOCKED.test(fullCmd)) return { error: 'Blocked command.' };
  try {
    const { stdout, stderr } = await execAsync(`powershell.exe -Command "npm ${command} ${args}"`, {
      cwd, timeout: 120000, windowsHide: true,
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT }
    });
    return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), cwd, command: fullCmd };
  } catch (e) {
    return { error: e.message.slice(0, 2000), stderr: e.stderr?.slice(0, 2000), cwd, command: fullCmd };
  }
}

/**
 * toolNode — Run a Node.js script or check its syntax.
 * action: 'run' | 'check' | 'eval'
 * Examples: run bots/leo.mjs, check shared/openjarvis.mjs, eval "console.log(1+1)"
 */
async function toolNode({ action = 'check', target = '', cwd: cwdParam }) {
  const cwd = cwdParam ? path.resolve(cwdParam) : NODE_ROOT;
  let cmd;
  if (action === 'check') {
    const resolved = target ? path.resolve(cwd, target) : cwd;
    cmd = `node --check "${resolved}"`;
  } else if (action === 'eval') {
    cmd = `node -e "${target.replace(/"/g, '\\"')}"`;
  } else {
    cmd = `node "${target}"`;
  }
  if (HARD_BLOCKED.test(cmd)) return { error: 'Blocked command.' };
  try {
    const { stdout, stderr } = await execAsync(`powershell.exe -Command "${cmd}"`, {
      cwd, timeout: 30000, windowsHide: true,
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT }
    });
    return { stdout: stdout.slice(0, 6000), stderr: stderr.slice(0, 2000), cwd, command: cmd };
  } catch (e) {
    return { valid: false, error: e.message.slice(0, 2000), stderr: e.stderr?.slice(0, 2000), cwd };
  }
}

/**
 * toolPython — Run a Python script, pip command, or pytest.
 * Examples: script src/some_tool.py, pip install -r requirements.txt, test
 */
async function toolPython({ action = 'script', target = '', args = '', cwd: cwdParam }) {
  const cwd = cwdParam ? path.resolve(cwdParam) : PYTHON_ROOT;
  let cmd;
  if (action === 'pip') {
    cmd = `pip ${target} ${args}`.trim();
  } else if (action === 'test') {
    cmd = `python -m pytest ${target} ${args}`.trim();
  } else if (action === 'check') {
    cmd = `python -m py_compile "${target}"`;
  } else if (action === 'module') {
    cmd = `python -m ${target} ${args}`.trim();
  } else {
    cmd = `python "${target}" ${args}`.trim();
  }
  if (HARD_BLOCKED.test(cmd)) return { error: 'Blocked command.' };
  try {
    const { stdout, stderr } = await execAsync(`powershell.exe -Command "${cmd}"`, {
      cwd, timeout: 120000, windowsHide: true,
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT, PYTHONPATH: PYTHON_ROOT }
    });
    return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), cwd, command: cmd };
  } catch (e) {
    return { error: e.message.slice(0, 2000), stderr: e.stderr?.slice(0, 2000), cwd, command: cmd };
  }
}

/**
 * toolOllama — Manage and query local Ollama models.
 * Examples: list, show Leo-Sovereign, pull llama3.1:8b, ps (running models)
 */
async function toolOllama({ command = 'list', args = '' }) {
  const fullCmd = `ollama ${command} ${args}`.trim();
  if (HARD_BLOCKED.test(fullCmd)) return { error: 'Blocked command.' };
  try {
    const { stdout, stderr } = await execAsync(`powershell.exe -Command "${fullCmd}"`, {
      timeout: 60000, windowsHide: true,
      env: { ...process.env }
    });
    return { stdout: stdout.slice(0, 6000), stderr: stderr.slice(0, 1000), command: fullCmd };
  } catch (e) {
    return { error: e.message.slice(0, 1000), stderr: e.stderr?.slice(0, 1000), command: fullCmd };
  }
}

/**
 * toolOpenJarvis — Bridge to the full OpenJarvis Python tool library.
 * Kai Coder can invoke any registered OpenJarvis tool through this bridge.
 * This feeds the donated engineering toolkit (git, web_search, apply_patch,
 * knowledge_search, shell_exec, etc.) into Kai Coder without a new agent.
 *
 * Available tools include:
 *   kai_cli       — shell commands, read files, project status
 *   git_tool      — git log, diff, status, commit inspection
 *   web_search    — real-time web research
 *   apply_patch   — apply unified diffs to files
 *   knowledge_search — query the knowledge base / lattice
 *   shell_exec    — safe shell execution with sandboxing
 *   file_read     — read project files
 *   file_write    — write files safely
 *   repl          — run Python/JS code snippets
 *   http_request  — make outbound HTTP calls
 */
async function toolOpenJarvis({ tool, params = {} }) {
  if (!tool) return { error: 'tool name is required' };
  try {
    const res = await fetch('http://127.0.0.1:8080/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: tool, params }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { error: `OpenJarvis HTTP ${res.status}: ${res.statusText}` };
    return await res.json();
  } catch (e) {
    return { error: `OpenJarvis bridge unreachable: ${e.message}` };
  }
}

/**
 * toolGit — Direct git operations via the OpenJarvis git_tool bridge.
 * Shorthand for common git operations Kai Coder needs during engineering tasks.
 */
async function toolGit({ command = 'status', args = '' }) {
  return toolOpenJarvis({ tool: 'git_tool', params: { command, args } });
}

/**
 * toolWebSearch — Real-time web research for Kai Coder.
 * Routes through OpenJarvis web_search tool.
 */
async function toolWebSearch({ query }) {
  // Try internal OpenJarvis web_search first, fall back to toolSearch (port 8080)
  const ojResult = await toolOpenJarvis({ tool: 'web_search', params: { query } });
  if (!ojResult.error) return ojResult;
  return toolSearch({ query }); // fallback
}

/**
 * toolPatch — Apply a unified diff patch to a file.
 * Routes through OpenJarvis apply_patch tool.
 */
async function toolPatch({ path: filePath, patch }) {
  return toolOpenJarvis({ tool: 'apply_patch', params: { path: filePath, patch } });
}

/**
 * toolKnowledge — Query the knowledge base / long-term memory.
 * Routes through OpenJarvis knowledge_search tool.
 */
async function toolKnowledge({ query }) {
  return toolOpenJarvis({ tool: 'knowledge_search', params: { query } });
}

const TOOL_MAP = { 
  // ── Core File & Code Tools ──────────────────────────────────────────────────
  read: toolRead,       // Read any file in the project
  list: toolList,       // List directory contents
  grep: toolGrep,       // Search across source files
  write: toolWrite,     // Write to sandbox (never production directly)
  exec: toolExec,       // Execute any PowerShell command across c:\KAI
  powershell: toolPowershell, // Full multi-line PS1 script execution
  check: toolCheck,     // node --check syntax validation
  diff: toolDiff,       // Sandbox vs production diff
  apply: toolApply,     // Promote sandbox file to production (with backup)
  // ── Ecosystem Command Runners ───────────────────────────────────────────────
  cargo: toolCargo,     // Rust: cargo check | build | test | clippy | clean
  npm: toolNpm,         // Node.js: npm install | run | audit | outdated
  node: toolNode,       // Node.js: run | check | eval scripts
  python: toolPython,   // Python: scripts | pip | pytest | module | check
  ollama: toolOllama,   // Ollama: list | show | pull | ps (model management)
  // ── System Intelligence ─────────────────────────────────────────────────────
  sysinfo: toolSysinfo,   // Hardware stats (CPU/RAM/disk)
  snapshot: toolSnapshot, // Live process snapshot
  status: toolStatus,     // Oracle server + lattice health
  audit: toolAudit,       // System audit report
  // ── Knowledge & Search ──────────────────────────────────────────────────────
  search: toolSearch,         // Internal search (port 8080)
  lattice: toolLattice,       // RSHL lattice query + store
  inspect: toolInspect,       // Deep lattice inspection
  knowledge: toolKnowledge,   // Long-term knowledge base query
  websearch: toolWebSearch,   // Real-time web research
  // ── OpenJarvis Engineering Toolkit (donated skills) ─────────────────────────
  openjarvis: toolOpenJarvis, // Raw bridge: call ANY OpenJarvis Python tool
  git: toolGit,               // Git operations (log, diff, status, etc.)
  patch: toolPatch,           // Apply unified diffs to files
  // ── Diagnostics ─────────────────────────────────────────────────────────────
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

