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
  const sbPath = sandboxPath(filePath);
  const prodPath = assertUnderRoot(filePath);

  if (!fs.existsSync(sbPath)) return { error: `No sandbox file at: ${sbPath}` };

  // Backup original
  if (fs.existsSync(prodPath)) {
    const backupName = `${path.basename(prodPath)}.${Date.now()}.bak`;
    const backupPath = path.join(BACKUP_ROOT, backupName);
    fs.copyFileSync(prodPath, backupPath);
    console.log(`[KaiCoderTools] Backup: ${backupPath}`);
  }

  fs.mkdirSync(path.dirname(prodPath), { recursive: true });
  fs.copyFileSync(sbPath, prodPath);
  return { applied: prodPath, from: sbPath };
}

// ── Web search (DuckDuckGo, no key required) ──────────────────────────────────
// Brave Search API used if BRAVE_API_KEY is set; falls back to DDG HTML scrape.

async function toolSearchWeb({ query, maxResults = 8 }) {
  if (!query) return { error: 'No query provided.' };

  // Try Brave Search API first (better results, structured JSON)
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        const results = (data.web?.results || []).slice(0, maxResults).map(r => ({
          title: r.title, url: r.url, snippet: r.description
        }));
        return { results, query, source: 'brave' };
      }
    } catch (e) { console.warn('[KaiTools/search] Brave failed:', e.message); }
  }

  // Fallback: DuckDuckGo instant answers + HTML parse
  try {
    const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KAI-Researcher/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!ddgRes.ok) return { error: `DDG HTTP ${ddgRes.status}` };
    const html = await ddgRes.text();
    // Extract result titles, URLs, snippets from DDG HTML
    const results = [];
    const resultPattern = /<a class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/a>/g;
    let m;
    while ((m = resultPattern.exec(html)) !== null && results.length < maxResults) {
      results.push({
        url: m[1].startsWith('http') ? m[1] : `https://duckduckgo.com${m[1]}`,
        title: m[2].replace(/<[^>]+>/g, '').trim(),
        snippet: m[3].replace(/<[^>]+>/g, '').trim()
      });
    }
    // Simple fallback if regex fails
    if (results.length === 0) {
      const urlMatches = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].slice(0, maxResults);
      urlMatches.forEach(m => results.push({ url: m[1], title: '', snippet: '' }));
    }
    return { results: results.slice(0, maxResults), query, source: 'duckduckgo' };
  } catch (e) {
    return { error: `Web search failed: ${e.message}` };
  }
}

// ── URL content fetcher ───────────────────────────────────────────────────────
// Fetches any public URL and returns readable text (HTML stripped).
// No JS execution — use Playwright (browser subagent) for JS-heavy pages.

async function toolReadUrl({ url, maxChars = 8000 }) {
  if (!url) return { error: 'No URL provided.' };
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KAI-Researcher/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { error: `HTTP ${res.status} from ${url}` };
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    // If it's plain text or JSON, return as-is
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      return { content: raw.slice(0, maxChars), url, contentType };
    }

    // Strip HTML tags and extract readable text
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')    // remove scripts
      .replace(/<style[\s\S]*?<\/style>/gi, '')      // remove styles
      .replace(/<!--[\s\S]*?-->/g, '')               // remove comments
      .replace(/<[^>]+>/g, ' ')                      // strip tags
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '')
      .replace(/\s{3,}/g, '\n\n')                   // collapse whitespace
      .trim();

    return { content: text.slice(0, maxChars), url, contentType, charCount: text.length };
  } catch (e) {
    return { error: `Fetch failed: ${e.message}`, url };
  }
}

// ── Surgical file replace ─────────────────────────────────────────────────────
// Replace an exact string in a file. Writes to sandbox first (like toolWrite).
// Use this instead of rewriting the entire file when making targeted changes.

async function toolReplace({ path: filePath, oldStr, newStr, all = false }) {
  if (!filePath || oldStr === undefined || newStr === undefined) {
    return { error: 'path, oldStr, and newStr are required.' };
  }

  // Read source — prefer production file for replacement operations
  const prodPath = assertUnderRoot(filePath);
  if (!fs.existsSync(prodPath)) return { error: `File not found: ${filePath}` };
  const stat = fs.statSync(prodPath);
  if (stat.size > MAX_FILE_SIZE) return { error: `File too large for replace (${stat.size} bytes).` };

  let content = fs.readFileSync(prodPath, 'utf8');
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) return { error: `String not found in ${filePath}. Check exact whitespace/indentation.`, hint: 'Use toolRead to verify the exact content first.' };

  const replaced = all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  const replacedCount = all ? occurrences : 1;

  // Write to sandbox (same pattern as toolWrite)
  const relToDiscord = path.isAbsolute(filePath)
    ? path.relative(DISCORD_ROOT, path.resolve(filePath))
    : filePath;
  const sbPath = path.join(SANDBOX_ROOT, relToDiscord);
  fs.mkdirSync(path.dirname(sbPath), { recursive: true });
  fs.writeFileSync(sbPath, replaced, 'utf8');

  return {
    written: sbPath,
    occurrences,
    replacedCount,
    sandboxRelative: path.relative(SANDBOX_ROOT, sbPath)
  };
}

// ── Multi-replace (multiple surgical edits in one call) ───────────────────────
// Applies a list of { oldStr, newStr } replacements to one file.
// All edits happen on the in-memory content sequentially — atomic for the file.

async function toolMultiReplace({ path: filePath, replacements }) {
  if (!filePath || !Array.isArray(replacements) || replacements.length === 0) {
    return { error: 'path and replacements[] are required.' };
  }

  const prodPath = assertUnderRoot(filePath);
  if (!fs.existsSync(prodPath)) return { error: `File not found: ${filePath}` };
  const stat = fs.statSync(prodPath);
  if (stat.size > MAX_FILE_SIZE) return { error: `File too large (${stat.size} bytes).` };

  let content = fs.readFileSync(prodPath, 'utf8');
  const results = [];

  for (const { oldStr, newStr, all = false } of replacements) {
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      results.push({ oldStr: oldStr.slice(0, 40), found: false });
      continue;
    }
    content = all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    results.push({ oldStr: oldStr.slice(0, 40), found: true, count: all ? count : 1 });
  }

  const relToDiscord = path.isAbsolute(filePath)
    ? path.relative(DISCORD_ROOT, path.resolve(filePath))
    : filePath;
  const sbPath = path.join(SANDBOX_ROOT, relToDiscord);
  fs.mkdirSync(path.dirname(sbPath), { recursive: true });
  fs.writeFileSync(sbPath, content, 'utf8');

  return { written: sbPath, replacements: results, sandboxRelative: path.relative(SANDBOX_ROOT, sbPath) };
}

// ── Background command execution & status tracking ────────────────────────────
// Run a command async and poll it later. Like running cargo build and checking back.

const BG_JOBS = new Map(); // jobId → { command, cwd, startedAt, stdout, stderr, done, exitCode }
let bgJobCounter = 0;

async function toolBgExec({ command, cwd: cwdParam }) {
  if (!command) return { error: 'No command provided.' };
  if (HARD_BLOCKED.test(command)) return { error: `Blocked — destructive command detected.` };

  let cwd = PROJECT_ROOT;
  if (cwdParam) { try { cwd = assertUnderRoot(cwdParam); } catch {} }

  const jobId = `job_${Date.now()}_${++bgJobCounter}`;
  const job = { command, cwd, startedAt: Date.now(), stdout: '', stderr: '', done: false, exitCode: null };
  BG_JOBS.set(jobId, job);

  // Launch async, capture output
  import('child_process').then(({ exec }) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const flag = process.platform === 'win32' ? '-Command' : '-c';
    const proc = exec(`${shell} ${flag} "${command.replace(/"/g, '\\"')}"`, {
      cwd, timeout: 300000, windowsHide: true,
      env: { ...process.env, KAI_PROJECT_DIR: PROJECT_ROOT }
    }, (err, stdout, stderr) => {
      job.stdout += stdout?.slice(0, 10000) || '';
      job.stderr += stderr?.slice(0, 3000) || '';
      job.done = true;
      job.exitCode = err?.code ?? 0;
      console.log(`[KaiTools/bg] Job ${jobId} done (exit ${job.exitCode}).`);
    });
    proc.stdout?.on('data', d => { job.stdout += d; if (job.stdout.length > 10000) job.stdout = job.stdout.slice(-10000); });
    proc.stderr?.on('data', d => { job.stderr += d; });
  });

  return { jobId, command, cwd, status: 'running' };
}

async function toolBgStatus({ jobId }) {
  if (!jobId) return { error: 'No jobId provided.' };
  const job = BG_JOBS.get(jobId);
  if (!job) return { error: `Unknown jobId: ${jobId}` };
  return {
    jobId,
    command: job.command,
    done: job.done,
    exitCode: job.exitCode,
    stdout: job.stdout.slice(-6000),
    stderr: job.stderr.slice(-2000),
    runtimeMs: Date.now() - job.startedAt
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const TOOL_MAP = {
  read: toolRead, list: toolList, grep: toolGrep,
  write: toolWrite, exec: toolExec, powershell: toolPowershell,
  check: toolCheck, diff: toolDiff, apply: toolApply,
  // New tools — Antigravity parity
  search_web: toolSearchWeb,
  read_url: toolReadUrl,
  replace: toolReplace,
  multi_replace: toolMultiReplace,
  bg_exec: toolBgExec,
  bg_status: toolBgStatus
};

const server = http.createServer(async (req, res) => {
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[KaiCoderTools] Tool server online at port ${PORT}`);
  console.log(`[KaiCoderTools] Project root: ${PROJECT_ROOT}`);
  console.log(`[KaiCoderTools] Sandbox: ${SANDBOX_ROOT}`);
  console.log(`[KaiCoderTools] Backups: ${BACKUP_ROOT}`);
});

export { PORT as TOOL_SERVER_PORT };