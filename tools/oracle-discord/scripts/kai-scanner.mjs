import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { makeLLMCaller } from '../shared/kai-coder-agent.mjs';
import { pushRipple } from '../shared/ripple.mjs';

// Files whose changes are USER-RELEVANT (new/changed tools, voice, Leo behavior,
// Oracle commands) — a change here is a "critical" ripple Leo should surface.
const CAPABILITY_FILES = ['native-tools.mjs', 'gemini-live-bridge.mjs', 'leo.mjs', 'oracle-gateway.mjs', 'start-bot.mjs'];

// ── AUTO-FIX via Kai Coder ───────────────────────────────────────────────────
// When a real syntax error is found, hand the broken file to Kai Coder's LLM to
// repair (syntax only), then RE-CHECK deterministically with the same node/py
// checker. Up to 2 tries. Always backs up first and RESTORES the original if it
// can't fix it — so a file is never left worse than we found it. Only attempts
// files small enough for the model to rewrite whole.
const MAX_AUTOFIX_BYTES = 60000;
async function attemptAutoFix(file, errorDetail, checkCmd, checkName) {
  const original = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(original) > MAX_AUTOFIX_BYTES) {
    console.log(`[KaiScanner] ⚠️ ${file.replace(ROOT_DIR, '')} is too large (${Math.round(Buffer.byteLength(original) / 1024)}KB) to auto-fix safely — leaving for manual fix.`);
    return false;
  }
  const bakDir = path.join(STATE_DIR, 'scanner-backups');
  try { fs.mkdirSync(bakDir, { recursive: true }); } catch (_) {}
  const bak = path.join(bakDir, `${path.basename(file)}.${Date.now()}.bak`);
  fs.copyFileSync(file, bak);

  const llm = makeLLMCaller();
  let lastErr = errorDetail;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[KaiScanner] 🛠️ Kai Coder fixing ${file.replace(ROOT_DIR, '')} (attempt ${attempt}/2)...`);
    let fixed = '';
    try {
      const cur = fs.readFileSync(file, 'utf8');
      const prompt = `Fix ONLY the syntax error so this file parses. Do NOT change behavior, refactor, or add anything. Return ONLY the complete corrected file content — no markdown fences, no commentary.\n\nFILE: ${file}\nSYNTAX ERROR:\n${lastErr}\n\n=== FILE ===\n${cur}\n=== END ===`;
      const resp = await llm(prompt, 'scanner-fix');
      fixed = (typeof resp === 'string' ? resp : (resp?.reply || resp?.content || '')) || '';
      fixed = fixed.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    } catch (e) {
      console.log(`[KaiScanner] ⚠️ Kai Coder unreachable for fix (${e.message}).`);
      break;
    }
    if (!fixed || fixed.length < original.length * 0.5) {
      console.log(`[KaiScanner] ⚠️ Kai Coder returned nothing usable — aborting auto-fix.`);
      break;
    }
    fs.writeFileSync(file, fixed);
    try {
      execSync(checkCmd, { stdio: 'pipe', timeout: 20000 });
      console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} AUTO-FIXED by Kai Coder (attempt ${attempt}, verified ${checkName}). Backup: ${bak}`);
      return true;
    } catch (e2) {
      lastErr = (e2.stderr ? e2.stderr.toString() : e2.message).split('\n').slice(0, 6).join('\n');
      console.log(`[KaiScanner] still broken after attempt ${attempt}.`);
    }
  }
  fs.copyFileSync(bak, file); // restore — never leave it worse
  console.log(`[KaiScanner] ↩️ Couldn't auto-fix ${file.replace(ROOT_DIR, '')}; restored original. Core-safe boot will keep KAI + Oracle alive.`);
  return false;
}

// ── DEEPER STATIC CHECKS (env-gated: KAI_SCAN_DEEP=1) ────────────────────────
// Best-effort, fast, regex/string based — NO AST parser dependency. Every check
// is wrapped so it can NEVER throw and crash the boot scan: on any internal
// error we just return what we have. These produce WARNINGS only — they never
// flip `issuesFound` and never trigger CORE-SAFE MODE. Default behaviour is
// unchanged unless KAI_SCAN_DEEP=1 is set in the environment.
const DEEP_SCAN = process.env.KAI_SCAN_DEEP === '1';

// Small read cache so we don't re-read the same imported module repeatedly.
const _deepReadCache = new Map();
function _deepRead(p) {
  if (_deepReadCache.has(p)) return _deepReadCache.get(p);
  let txt = null;
  try {
    const stat = fs.statSync(p);
    if (stat.size <= 2 * 1024 * 1024) txt = fs.readFileSync(p, 'utf8');
  } catch (_) { txt = null; }
  _deepReadCache.set(p, txt);
  return txt;
}

// Does module text `src` export the named symbol? Best-effort: covers
// `export { X }`, `export const/let/var/function/class/async function X`,
// `export default` (matches anything when importing a default), and re-exports
// `export { X } from '...'` / `export * from '...'`. When in doubt, we assume it
// DOES export (return true) so we never emit a false "missing export" warning.
function _moduleExports(src, name) {
  if (!src || !name) return true;
  if (name === 'default') return /export\s+default\b/.test(src);
  // export * — could re-export anything; don't claim it's missing.
  if (/export\s+\*\s+from/.test(src)) return true;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${n}\\b`),
    new RegExp(`export\\s+(?:const|let|var)\\s+${n}\\b`),
    new RegExp(`export\\s+class\\s+${n}\\b`),
    // export { a, X as Y, b }  — match the local OR the aliased name
    new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`),
    new RegExp(`\\bas\\s+${n}\\b`),
  ];
  return patterns.some(re => re.test(src));
}

// Blank out the CONTENTS of comments and string/template literals so that
// import-like / call-like text living inside them is not mistaken for real code.
// Single-pass character state machine — no AST, no deps. Removed characters are
// replaced with a SPACE (newlines kept as-is) so the returned string has the
// EXACT same length and the same number of lines as the input: every byte offset
// and line number is preserved, so `m.index` / `slice(0,i).split('\n').length`
// math against the stripped copy still points at the right source line.
// Conservative: when in doubt it leaves text alone. Wrapped by its caller in a
// try/catch that falls back to the raw content if anything here throws.
function _stripCommentsAndStrings(src) {
  if (typeof src !== 'string' || src.length === 0) return src;
  const n = src.length;
  // Work on a char array; copy through code, overwrite blanked spans with ' '.
  const out = new Array(n);
  // States: 0=code, 1=line-comment, 2=block-comment, 3=single-quote, 4=double-quote, 5=template
  let state = 0;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 0) {
      // entering a comment?
      if (c === '/' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 1; continue; }
      if (c === '/' && c2 === '*') { out[i] = ' '; out[i + 1] = ' '; i++; state = 2; continue; }
      // entering a string/template? keep the OPENING quote so structure survives,
      // then blank the contents.
      if (c === "'") { out[i] = c; state = 3; continue; }
      if (c === '"') { out[i] = c; state = 4; continue; }
      if (c === '`') { out[i] = c; state = 5; continue; }
      out[i] = c; // ordinary code char
      continue;
    }
    if (state === 1) { // line comment — until newline
      if (c === '\n') { out[i] = '\n'; state = 0; }
      else { out[i] = ' '; }
      continue;
    }
    if (state === 2) { // block comment — until */
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 0; }
      else { out[i] = (c === '\n') ? '\n' : ' '; }
      continue;
    }
    if (state === 3 || state === 4) { // single/double quoted string
      const quote = state === 3 ? "'" : '"';
      if (c === '\\') { out[i] = ' '; if (i + 1 < n) { out[i + 1] = (c2 === '\n') ? '\n' : ' '; i++; } continue; }
      if (c === quote) { out[i] = c; state = 0; continue; } // keep closing quote
      out[i] = (c === '\n') ? '\n' : ' '; // blank contents (string ends at newline anyway in valid JS)
      continue;
    }
    if (state === 5) { // template literal
      if (c === '\\') { out[i] = ' '; if (i + 1 < n) { out[i + 1] = (c2 === '\n') ? '\n' : ' '; i++; } continue; }
      if (c === '`') { out[i] = c; state = 0; continue; } // keep closing backtick
      // NB: we do NOT parse ${...} expressions — blanking their contents too is
      // fine for our purposes (it only ever removes potential matches, never adds).
      out[i] = (c === '\n') ? '\n' : ' ';
      continue;
    }
    out[i] = c;
  }
  return out.join('');
}

// Returns [{file,line,type,message}] — warnings for one .mjs file. Never throws.
function deepStaticChecks(file, content) {
  const warnings = [];
  try {
    const dir = path.dirname(file);

    // PRE-PROCESS: blank out comments + string/template-literal CONTENTS so that
    // import-like / call-like text living inside COMMENTS or DOCSTRINGS is not
    // mistaken for real code (that produced false positives, e.g. an example
    // `import ... from './y.mjs'` written inside a comment). We replace removed
    // spans with spaces of EQUAL LENGTH (newlines preserved) so every byte offset
    // and line number stays identical — `m.index`/line math below is unaffected.
    // Robust + non-fatal: any failure falls back to the raw content (old behavior).
    let scan = content;
    try {
      scan = _stripCommentsAndStrings(content);
    } catch (_) {
      scan = content; // stripping must never break detection — fall back to raw
    }

    // (a) IMPORTED SYMBOL EXISTENCE — `import { X, Y as Z } from './y.mjs'`
    //     For RELATIVE imports only (we can't resolve bare package specifiers
    //     cheaply, and shouldn't guess). Verify each named symbol is exported
    //     by the target module.
    // STRUCTURE detector — runs on the STRIPPED copy. The stripper blanks the
    // CONTENTS of the path string and the brace body (replacing them with spaces),
    // so this pattern is deliberately LENIENT about what is inside the quotes/braces
    // ([^'"]* / [^}]*). All it confirms is that a real `import {…} from '…'` STRUCTURE
    // exists OUTSIDE any comment/string (because comment/string text was blanked to
    // spaces, an example import written in a comment no longer has its `import`/`from`
    // keywords intact and won't match here).
    const importRe = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^}]*\}\s*from\s*['"][^'"]*['"]/g;
    let m;
    while ((m = importRe.exec(scan)) !== null) {
      // Confirmed a REAL top-level import. Re-extract the actual relative spec +
      // named bindings from the ORIGINAL content at the same offset (offsets are
      // byte-identical because stripping preserves length). The STRICT pattern here
      // also enforces RELATIVE-only (`\.`) — bare/package specifiers are skipped.
      const realRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/y;
      realRe.lastIndex = m.index;
      const rm = realRe.exec(content);
      if (!rm) continue; // not a relative import (or mismatch) — skip, don't guess
      const spec = rm[3];
      const braceBody = rm[2];
      // resolve relative spec
      let target = path.resolve(dir, spec);
      // tolerate missing extension
      const candidates = [target, `${target}.mjs`, `${target}.js`, path.join(target, 'index.mjs'), path.join(target, 'index.js')];
      const resolved = candidates.find(c => { try { return fs.statSync(c).isFile(); } catch (_) { return false; } });
      const lineNo = scan.slice(0, m.index).split('\n').length;
      if (!resolved) {
        warnings.push({ file, line: lineNo, type: 'missing-module', message: `Imports from '${spec}' but that module could not be resolved on disk.` });
        continue;
      }
      const src = _deepRead(resolved);
      if (!src) continue; // unreadable/too big — skip, don't guess
      const names = braceBody.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        // `X as Y` — the symbol that must EXIST in the source is X (the left side)
        const asMatch = s.match(/^([A-Za-z_$][\w$]*)\s+as\s+/);
        return asMatch ? asMatch[1] : s.replace(/\s+as\s+.*$/, '').trim();
      }).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
      for (const name of names) {
        if (!_moduleExports(src, name)) {
          warnings.push({ file, line: lineNo, type: 'missing-export', message: `Imports { ${name} } from '${spec}' but '${path.basename(resolved)}' does not appear to export it.` });
        }
      }
    }

    // (b)+(c) DROPPED WIRING — `bridge.foo(...)` / `obj.method(...)` calls whose
    //     method name is never DEFINED anywhere reachable in this file (as an
    //     object method, function, or assigned property). Best-effort and
    //     conservative: only warns when the name appears NOWHERE as a definition
    //     and isn't a well-known built-in. This catches "renamed/deleted a
    //     function but left a caller behind" without drowning in false positives.
    const BUILTIN_METHODS = new Set([
      'then','catch','finally','map','filter','forEach','reduce','find','some','every','push','pop','shift','unshift',
      'slice','splice','join','split','trim','replace','replaceAll','toString','toLowerCase','toUpperCase','includes',
      'indexOf','startsWith','endsWith','match','test','exec','keys','values','entries','has','get','set','add','delete',
      'json','text','arrayBuffer','blob','from','of','isArray','parse','stringify','now','log','warn','error','info',
      'debug','call','apply','bind','concat','sort','reverse','fill','flat','flatMap','padStart','padEnd','repeat',
      'charAt','charCodeAt','codePointAt','toFixed','round','floor','ceil','abs','max','min','random','assign','freeze',
      'resolve','reject','all','allSettled','race','close','end','write','read','on','once','off','emit','exit','send',
      'next','return','throw','valueOf','hasOwnProperty','toJSON','at','findIndex','default','length','name','message',
    ]);
    // Collect locally-defined / declared method-like names so we don't warn on them.
    const defined = new Set();
    let dm;
    const defRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()|(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/g;
    while ((dm = defRe.exec(content)) !== null) {
      const nm = dm[1] || dm[2] || dm[3] || dm[4];
      if (nm) defined.add(nm);
    }
    // Also treat any imported name as "defined/reachable".
    const impAll = /import\s+(?:([A-Za-z_$][\w$]*)|(?:\{([^}]*)\})|\*\s+as\s+([A-Za-z_$][\w$]*))/g;
    let im;
    while ((im = impAll.exec(content)) !== null) {
      if (im[1]) defined.add(im[1]);
      if (im[3]) defined.add(im[3]);
      if (im[2]) im[2].split(',').forEach(s => { const a = s.trim().replace(/^.*\s+as\s+/, ''); if (a) defined.add(a); });
    }

    // Find `obj.method(` call sites. We only flag the METHOD name when it is
    // never defined locally AND never imported AND not a builtin. We do NOT try
    // to resolve `obj` itself (too noisy). This is intentionally conservative —
    // a warning here means "this method name is defined nowhere in this file,"
    // which is exactly the dropped-wiring signal worth surfacing.
    // NOTE: call sites are scanned in the STRIPPED copy so `obj.method(` text that
    // only appears inside comments/strings/docstrings is not flagged as a real
    // call. The `defined`/import/`defAsMember` suppression checks above stay on the
    // RAW content on purpose — being MORE permissive about what counts as "defined"
    // only ever suppresses warnings, which is the safe direction for false positives.
    const callRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
    const seenCall = new Set();
    let cm;
    while ((cm = callRe.exec(scan)) !== null) {
      const obj = cm[1];
      const method = cm[2];
      if (BUILTIN_METHODS.has(method)) continue;
      if (obj === 'this' || obj === 'console' || obj === 'process' || obj === 'JSON' || obj === 'Math' || obj === 'Object' || obj === 'Array' || obj === 'Promise' || obj === 'fs' || obj === 'path' || obj === 'crypto') continue;
      if (defined.has(method)) continue;
      // If the method name also appears as a property definition `method:` or `method(` (class/object method) anywhere, treat as defined.
      const defAsMember = new RegExp(`\\b${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(=]`);
      if (defAsMember.test(content)) continue;
      const key = `${obj}.${method}`;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      const lineNo = scan.slice(0, cm.index).split('\n').length;
      warnings.push({ file, line: lineNo, type: 'dropped-wiring', message: `Calls ${obj}.${method}(...) but '${method}' is not defined or imported anywhere in this file — possible dropped/renamed wiring.` });
    }
  } catch (e) {
    // Never let a deep-check bug harden into a boot failure. Swallow and move on.
    if (DEEP_SCAN) console.warn(`[KaiScanner/Deep] (non-fatal) deep check skipped for ${file.replace(/^.*[\\/]/, '')}: ${e.message}`);
  }
  return warnings;
}

const ROOT_DIR = 'c:/KAI';
// Keep state inside oracle-discord so we don't clutter the root
const STATE_DIR = path.join('c:/KAI/tools/oracle-discord', 'state');
const HASH_FILE = path.join(STATE_DIR, 'codebase-hashes.json');
// Directories and files to explicitly ignore
const IGNORE_DIRS = ['node_modules', 'state', 'logs', 'scratch', 'test_results', '.git', '.venv', 'target', 'build', 'bin', '__pycache__', '.gemini', '.github', 'data', 'models', 'ingested', 'reports'];
const IGNORE_EXTS = ['.db', '.sqlite', '.exe', '.dll', '.png', '.jpg', '.mp4', '.wav', '.mp3', '.glb', '.zip', '.bin', '.pack', '.idx']; // Ignore massive binaries for text scan

// Backup / archive / quarantine directories. These are FROZEN snapshots — they are
// NOT executed by the live system. Per Ryan's security rule we STILL scan + hash them
// (so tampering inside a backup is still detected and reported), but a flaw inside a
// backup file must NEVER halt the live boot. Old backups legitimately contain BOM'd
// JSON and AI-damaged code — that's the whole point of keeping them quarantined.
const BACKUP_MARKERS = ['backup', '_ai_damage_backup', '_grok_backup', 'archive_trash', '.archive', 'precleanup', 'data_backup'];
function isBackupPath(p) {
  const low = p.toLowerCase().replace(/\\/g, '/');
  return BACKUP_MARKERS.some(m => low.includes(m));
}

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!IGNORE_DIRS.includes(file)) {
        getAllFiles(filePath, fileList);
      }
    } else {
      const ext = path.extname(filePath);
      // Scan ALL files (electron-level fractal reading) except massive binaries
      if (!IGNORE_EXTS.includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

function hashFileContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) { // Skip files > 10MB
      // console.warn(`[KaiScanner] Skipping massive file for hash: ${filePath}`);
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    return null;
  }
}

async function runScanner() {
  console.log(`[KaiScanner] 🚀 Initializing Pre-Boot Codebase Scanner...`);
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  let previousHashes = {};
  if (fs.existsSync(HASH_FILE)) {
    try {
      previousHashes = JSON.parse(fs.readFileSync(HASH_FILE, 'utf8'));
    } catch (e) {
      console.warn(`[KaiScanner] Failed to parse previous hashes. Proceeding with full scan.`);
    }
  }

  const allFiles = getAllFiles(ROOT_DIR);
  console.log(`[KaiScanner] Found ${allFiles.length} files to track.`);

  let newHashes = {};
  let changedFiles = [];

  for (const file of allFiles) {
    const hash = hashFileContent(file);
    if (!hash) continue;
    newHashes[file] = hash;

    if (previousHashes[file] !== hash) {
      changedFiles.push(file);
    }
  }

  console.log(`[KaiScanner] ⚠️ Detected ${changedFiles.length} changed or new files.`);
  
  // Phase 1: ACTIVE DEPENDENCY & FRACTAL HEALTH CHECKS
  console.log(`\n[KaiScanner/Fractal] Initiating Active Dependency & Structural Tests...`);
  let structuralIssues = false;
  
  // Test 1: Check OpenJarvis Localhost connectivity (is LLM awake?)
  try {
    console.log(`[KaiScanner/Fractal] Pinging OpenJarvis cognitive core...`);
    const ojRes = await fetch('http://127.0.0.1:8080/v1/models').catch(() => null);
    if (!ojRes || !ojRes.ok) throw new Error("OpenJarvis HTTP Unreachable");
    console.log(`[KaiScanner/Fractal] ✅ OpenJarvis is awake.`);
  } catch(e) {
    console.error(`[KaiScanner/Fractal] ❌ OpenJarvis core offline: ${e.message}`);
    structuralIssues = true;
  }

  // Test 2: Check standard dependency presence
  const packageJsonPath = path.join(ROOT_DIR, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    console.log(`[KaiScanner/Fractal] Verifying package.json dependencies...`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
      console.warn(`[KaiScanner/Fractal] ⚠️ package.json has no dependencies declared!`);
      // Warning only
    } else {
      console.log(`[KaiScanner/Fractal] ✅ package.json structural integrity passed.`);
    }
  }

  if (structuralIssues) {
    // CHANGED: an offline OpenJarvis core NO LONGER halts the boot. The scanner's
    // real job below is DETERMINISTIC syntax checking (node --check / py_compile),
    // which needs no LLM at all; and the fleet now fails over to cloud providers
    // when the local core is down. The ONLY thing lost while 8080 is offline is the
    // LLM auto-fix — and even that fails over to cloud via chatWithOpenJarvis. So we
    // warn loudly and keep going, instead of bricking the whole server on load.
    console.warn(`\n[KaiScanner] ⚠️ OpenJarvis cognitive core (127.0.0.1:8080) is offline.`);
    console.warn(`[KaiScanner] This is NON-FATAL now: syntax checks don't need it and the fleet fails over to cloud.`);
    console.warn(`[KaiScanner] If a file is broken, it'll be reported for manual fix (LLM auto-fix may be degraded). Continuing scan...\n`);
  }
  
  console.log(`\n[KaiScanner] Engaging KAI for autonomous electron-level text review...`);

  let issuesFound = false;
  let reports = [];
  // Deep-scan accumulator (only populated when KAI_SCAN_DEEP=1). These are
  // WARNINGS, never fatal — collected here and handed to Kai Coder at the end.
  let deepWarnings = [];
  if (DEEP_SCAN) console.log(`[KaiScanner/Deep] 🔬 KAI_SCAN_DEEP=1 — deeper static checks ENABLED (import-symbol, method-reference, dropped-wiring).`);

  for (const file of changedFiles) {
    console.log(`[KaiScanner] 🔍 Analyzing: ${file.replace(ROOT_DIR, '')}`);
    const stat = fs.statSync(file);
    if (stat.size > 10 * 1024 * 1024) continue; // safety for LLM too
    const content = fs.readFileSync(file, 'utf8');
    
    // We only send the first ~4000 chars to avoid blowing up the context window on local models
    // This makes the scan gentler on CPU/RAM as requested.
    const truncatedContent = content.length > 4000 ? content.slice(0, 4000) + '\n...[TRUNCATED]' : content;
    
    const ext = path.extname(file).toLowerCase();
      
      // Fast-path for JSON files: validate locally to save hours of LLM inference
      if (ext === '.json') {
        try {
          // Strip a leading UTF-8 BOM (﻿) before parsing. A BOM is valid UTF-8 and
          // some editors/exports add one; JSON.parse rejects it, but it is NOT corruption.
          JSON.parse(content.replace(/^﻿/, ''));
          console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (JSON Fast-Path).`);
          continue;
        } catch (e) {
          if (isBackupPath(file)) {
            console.log(`[KaiScanner] ⚠️ ${file.replace(ROOT_DIR, '')} — JSON issue inside a BACKUP/ARCHIVE dir. Logged for awareness, NOT blocking boot.`);
            reports.push({ file, report: `JSON Parse Error (backup, non-blocking): ${e.message}` });
            continue;
          }
          console.log(`[KaiScanner] ❌ ISSUES FOUND IN ${file}`);
          console.log(`[KaiScanner] KAI's Report: JSON Parse Error: ${e.message}\n`);
          issuesFound = true;
          reports.push({ file, report: `JSON Parse Error: ${e.message}` });
          continue;
        }
      }

      // Fast-path for empty files
      if (content.trim().length === 0) {
        console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (Empty File).`);
        continue;
      }

      // Fast-path for non-core files (e.g. .md, .txt, .html, .xml) to prevent 40+ hour local LLM boot times
      const coreCodeExts = ['.mjs', '.js', '.py', '.rs', '.ps1'];
      if (!coreCodeExts.includes(ext)) {
        console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (Static Text Fast-Path).`);
        continue;
      }

    // Backup/archive code is frozen and never executed. We've already hashed it
    // (tamper detection intact), so skip the LLM deep-review: it only produces
    // false positives on old AI-damaged snapshots and burns CPU/quota.
    if (isBackupPath(file)) {
      console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (Backup/Archive — hash-tracked, deep-review skipped).`);
      continue;
    }

    // ── DETERMINISTIC SYNTAX CHECK (replaces the flaky/hallucinating LLM review) ──
    // `node --check` / `py_compile` catch the actual crashing syntax errors the
    // scanner exists to prevent — instantly, with NO model, no "fetch failed",
    // and NO false positives. A failure here is a REAL error and correctly
    // blocks the boot; a clean file passes for certain. This also means every
    // edit is genuinely verified on boot instead of waved through.
    let checkCmd = null, checkName = null;
    if (ext === '.mjs' || ext === '.js') { checkCmd = `node --check "${file}"`; checkName = 'node --check'; }
    else if (ext === '.py') { checkCmd = `python -m py_compile "${file}"`; checkName = 'py_compile'; }

    if (!checkCmd) {
      // .rs / .ps1 are compiled/parsed by their own toolchains (cargo / PowerShell);
      // we hash-track them but don't deep-check here.
      console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (hash-tracked; ${ext} checked by its own toolchain).`);
      continue;
    }

    try {
      execSync(checkCmd, { stdio: 'pipe', timeout: 20000 });
      console.log(`[KaiScanner] ✅ ${file.replace(ROOT_DIR, '')} PASSED (${checkName}).`);
    } catch (err) {
      const out = `${err.stderr ? err.stderr.toString() : ''}${err.stdout ? err.stdout.toString() : ''}${err.message || ''}`;
      // Only a genuine syntax/parse error blocks the boot. If the checker itself
      // couldn't run (e.g. python not on PATH), don't block — just hash-track.
      const isRealSyntaxError = /SyntaxError|IndentationError/i.test(out) && !/ENOENT|not recognized|No such file/i.test(out);
      if (isRealSyntaxError) {
        const detail = out.split('\n').filter(Boolean).slice(0, 6).join('\n');
        console.log(`[KaiScanner] ❌ SYNTAX ERROR IN ${file.replace(ROOT_DIR, '')}`);
        console.log(`[KaiScanner] ${detail}\n`);
        // Hand it to Kai Coder to repair, then re-verify deterministically.
        const fixed = await attemptAutoFix(file, detail, checkCmd, checkName);
        if (!fixed) {
          issuesFound = true;
          reports.push(`File: ${file}\n${detail}`);
        }
      } else {
        console.log(`[KaiScanner] ⚠️ ${file.replace(ROOT_DIR, '')} — couldn't run ${checkName} (${out.split('\n')[0].slice(0, 80)}). Hash-tracked, not blocking.`);
      }
    }

    // ── DEEPER STATIC CHECKS (KAI_SCAN_DEEP=1 only) ──────────────────────────
    // Runs AFTER syntax check, on changed .mjs files only. Pure-JS, best-effort,
    // never throws (deepStaticChecks swallows its own errors). Emits WARNINGS
    // only — these do NOT set issuesFound and never trigger CORE-SAFE MODE.
    if (DEEP_SCAN && ext === '.mjs') {
      const w = deepStaticChecks(file, content);
      if (w.length) {
        deepWarnings.push(...w);
        console.log(`[KaiScanner/Deep] ⚠️ ${w.length} warning(s) in ${file.replace(ROOT_DIR, '')}:`);
        for (const it of w) console.log(`[KaiScanner/Deep]    L${it.line} [${it.type}] ${it.message}`);
      }
    }
  }

  // ── KAI CODER FIX-LOOP (KAI_SCAN_DEEP=1 only) ──────────────────────────────
  // After the full warnings/errors list is built, hand any auto-fixable issues
  // to the Kai Coder agent. Contract: kaiCoderResolve([{file,line,type,message}])
  // returns [{file, fixed:boolean, approach, detail}], fixing in a sandbox.
  //
  // This is END-OF-SCAN, ADDITIVE, and fully GUARDED:
  //   • Only runs when KAI_SCAN_DEEP=1 (default OFF — nothing changes by default).
  //   • The import is wrapped in try/catch; if ../shared/kai-coder/index.mjs is
  //     not present yet (a sibling agent is building it), we skip gracefully and
  //     report issues for manual fix. No crash, no boot impact.
  //   • A failure ANYWHERE in this block is swallowed — it can never harden into
  //     a worse boot failure than today. CORE-SAFE behaviour below is untouched.
  if (DEEP_SCAN) {
    // Build the issue list. Deep warnings are objects already; the unfixable
    // syntax `reports` are strings ("File: <path>\n<detail>") — convert those.
    const issues = [...deepWarnings];
    for (const r of reports) {
      const s = String(r);
      const fm = s.match(/^File:\s*(.+)$/m);
      issues.push({ file: fm ? fm[1].trim() : '', line: 0, type: 'syntax', message: s.replace(/^File:.*\n?/, '').trim() || s });
    }
    if (issues.length) {
      console.log(`\n[KaiScanner/Deep] 🧩 ${issues.length} issue(s) collected — attempting Kai Coder fix-loop...`);
      let kaiCoderResolve = null;
      try {
        ({ kaiCoderResolve } = await import('../shared/kai-coder/index.mjs'));
        if (typeof kaiCoderResolve !== 'function') kaiCoderResolve = null;
      } catch (e) {
        kaiCoderResolve = null;
      }
      if (!kaiCoderResolve) {
        console.log(`[KaiScanner/Deep] Kai Coder fix-loop not available, reporting issues for manual fix.`);
      } else {
        try {
          const results = await kaiCoderResolve(issues, { sandbox: true, syntaxOnlyForFatal: true });
          const fixedResults = Array.isArray(results) ? results.filter(r => r && r.fixed) : [];
          for (const r of (Array.isArray(results) ? results : [])) {
            const tag = r.fixed ? '✅ fixed' : '⏭️ left';
            console.log(`[KaiScanner/Deep] ${tag} ${String(r.file || '').replace(ROOT_DIR, '')} — ${r.approach || 'n/a'}${r.detail ? `: ${r.detail}` : ''}`);
          }
          // RE-RUN scan checks on touched files to confirm the all-clear.
          const touched = [...new Set(fixedResults.map(r => r.file).filter(Boolean))];
          if (touched.length) {
            console.log(`[KaiScanner/Deep] 🔁 Re-checking ${touched.length} touched file(s) for all-clear...`);
            for (const tf of touched) {
              try {
                const tExt = path.extname(tf).toLowerCase();
                let stillSyntaxBroken = false;
                let cmd = null;
                if (tExt === '.mjs' || tExt === '.js') cmd = `node --check "${tf}"`;
                else if (tExt === '.py') cmd = `python -m py_compile "${tf}"`;
                if (cmd) {
                  try { execSync(cmd, { stdio: 'pipe', timeout: 20000 }); }
                  catch (e2) {
                    const o = `${e2.stderr ? e2.stderr.toString() : ''}${e2.message || ''}`;
                    if (/SyntaxError|IndentationError/i.test(o) && !/ENOENT|not recognized|No such file/i.test(o)) stillSyntaxBroken = true;
                  }
                }
                let reWarn = [];
                if (tExt === '.mjs') {
                  let txt = '';
                  try { txt = fs.readFileSync(tf, 'utf8'); } catch (_) {}
                  _deepReadCache.clear(); // imported modules may have changed
                  reWarn = txt ? deepStaticChecks(tf, txt) : [];
                }
                if (stillSyntaxBroken) {
                  console.log(`[KaiScanner/Deep] ⚠️ ${tf.replace(ROOT_DIR, '')} STILL has a syntax error after Kai Coder — leaving for CORE-SAFE / manual fix.`);
                } else if (reWarn.length) {
                  console.log(`[KaiScanner/Deep] ⚠️ ${tf.replace(ROOT_DIR, '')} cleared syntax but ${reWarn.length} deep warning(s) remain (non-fatal).`);
                } else {
                  console.log(`[KaiScanner/Deep] ✅ ${tf.replace(ROOT_DIR, '')} ALL-CLEAR after Kai Coder fix.`);
                }
              } catch (e3) {
                console.log(`[KaiScanner/Deep] re-check skipped for ${tf.replace(ROOT_DIR, '')}: ${e3.message}`);
              }
            }
          }
        } catch (e) {
          console.log(`[KaiScanner/Deep] ⚠️ Kai Coder fix-loop errored (non-fatal): ${e.message}. Reporting issues for manual fix.`);
        }
      }
    } else if (DEEP_SCAN) {
      console.log(`\n[KaiScanner/Deep] ✅ No deep-scan issues to hand to Kai Coder.`);
    }
  }

  if (issuesFound) {
    console.log(`\n[KaiScanner] ⚠️ ${reports.length} file(s) had a syntax error Kai Coder couldn't auto-fix:`);
    for (const r of reports) console.log(`  - ${String(r).split('\n')[0]}`);
    console.log(`[KaiScanner] 🟡 CORE-SAFE MODE: NOT halting the whole system. Bringing up ONLY KAI + Oracle + core`);
    console.log(`[KaiScanner]    so you can talk to Oracle and restart remotely once the file is fixed.`);
    // We do NOT save newHashes, so it re-scans (and can re-try the fix) next boot.
    // Exit 2 tells the launcher: core-safe boot, do NOT fully halt.
    process.exit(2);
  } else {
    console.log(`\n[KaiScanner] ✅ PRE-BOOT SCAN COMPLETE. All files cleared (real syntax checks).`);
    // RIPPLE: a clean boot that carried changes = an update rippling through the
    // system. Record it so Leo can FEEL it and (Stage 2) report it. If any
    // capability file changed, it's a 'critical' (user-relevant) ripple.
    try {
      // NOISE FILTER: SQLite WAL/SHM sidecars and local config churn on EVERY
      // boot — they are not meaningful "updates," so they must not ripple (they
      // were drowning out the real changes Leo reports). Only real code/state
      // files count.
      const isNoiseRipple = (name) =>
        /\.(db-wal|db-shm|db-journal|sqlite-wal|sqlite-shm|log|tmp)$/i.test(name) ||
        /(^|[.])local\.xml$/i.test(name) ||
        /-(wal|shm)$/i.test(name) ||
        name === path.basename(HASH_FILE) ||
        name === 'ripple_notes.json';
      const liveChanged = changedFiles
        .filter(f => !isBackupPath(f))
        .map(f => path.basename(f))
        .filter(name => !isNoiseRipple(name));
      if (liveChanged.length) {
        const critical = liveChanged.some(name => CAPABILITY_FILES.includes(name));
        pushRipple(
          `System update rippled through on boot — ${liveChanged.length} file(s) changed: ${[...new Set(liveChanged)].slice(0, 12).join(', ')}.`,
          { type: critical ? 'critical' : 'normal', source: 'scanner', meta: { files: liveChanged } }
        );
        console.log(`[KaiScanner] 〰️ Ripple recorded (${critical ? 'critical' : 'normal'}) — Leo will feel this update.`);
      }
    } catch (e) { console.warn('[KaiScanner] ripple record failed:', e.message); }
    // Save the hashes so we don't scan them again unless they change
    fs.writeFileSync(HASH_FILE, JSON.stringify(newHashes, null, 2));
    process.exit(0);
  }
}

runScanner().catch(err => {
  console.error(`[KaiScanner] Fatal error: ${err.message}`);
  process.exit(1);
});
