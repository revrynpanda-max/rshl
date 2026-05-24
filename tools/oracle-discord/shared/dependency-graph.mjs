// shared/dependency-graph.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 3: dependency graph + blast-radius scoring.
//
// PURPOSE
//   The "car part" safety net. Before auto-repair (or any code-mutating tool)
//   writes a change to file X, it can ask: "how many other files depend on X?"
//   High blast radius = a change here ripples widely → push to human review.
//   Low blast radius = isolated helper → safer to auto-apply.
//
// METHOD
//   Scan every .mjs / .js file under tools/oracle-discord/ (skipping node_modules,
//   sandbox, .bak files, etc.). Parse each one with a regex pass that picks up
//   ESM `import ... from './path.mjs'` and CommonJS `require('./path')`.
//   Resolve relative paths to absolute project paths and build the reverse
//   graph: for each module, who imports it?
//
//   blastRadius(file) = transitive count of files that (directly or
//   indirectly) import this file. We cap traversal depth at 8 levels to
//   avoid runaway in cyclic graphs.
//
// USAGE
//   import { buildGraph, blastRadius, riskScore } from './dependency-graph.mjs';
//   const graph = buildGraph();
//   const score = blastRadius('shared/openjarvis.mjs', graph);  // e.g. 47
//   const risk  = riskScore(score);                              // 'high' | 'medium' | 'low'
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Auto-locate the project root: this file is at <root>/shared/dependency-graph.mjs,
// so walking up one level gives us <root>. Falls back to env var or hardcoded
// Windows path if URL parsing fails for any reason.
function resolveRoot() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..');  // <here>/shared -> project root
  } catch (_) {
    return process.env.KAI_PROJECT_ROOT || 'c:/KAI/tools/oracle-discord';
  }
}
const ROOT = resolveRoot();
const SKIP_DIRS = new Set(['node_modules', '.git', 'sandbox', '.kai-backups', 'state', 'logs']);

function walkJsFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.endsWith('.bak') || e.name.includes('.bak.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsFiles(full, out);
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Match ESM imports + dynamic imports + CommonJS requires for local paths.
const RE_IMPORT  = /\bimport\b[\s\S]*?\bfrom\s+['"](\.[^'"]+)['"]/g;
const RE_DYNIMP  = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const RE_REQUIRE = /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function extractDeps(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const dir = path.dirname(filePath);
  const deps = new Set();
  for (const re of [RE_IMPORT, RE_DYNIMP, RE_REQUIRE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let target = m[1];
      // Resolve to a real file: try as-is, then with .mjs/.js/.cjs/.json,
      // then as directory + index.{mjs,js}.
      const candidates = [
        target,
        target + '.mjs', target + '.js', target + '.cjs', target + '.json',
        path.join(target, 'index.mjs'),
        path.join(target, 'index.js'),
      ];
      let resolved = null;
      for (const c of candidates) {
        const full = path.resolve(dir, c);
        try { if (fs.statSync(full).isFile()) { resolved = full; break; } } catch (_) {}
      }
      if (resolved) deps.add(resolved);
    }
  }
  return [...deps];
}

/**
 * Build the full graph. Returns:
 *   { files: [...], importsOf: Map(file -> Set(deps)), dependentsOf: Map(file -> Set(parents)) }
 */
export function buildGraph(root = ROOT) {
  const files = walkJsFiles(root);
  const importsOf    = new Map();
  const dependentsOf = new Map();
  for (const f of files) {
    importsOf.set(f, new Set());
    dependentsOf.set(f, new Set());
  }
  for (const f of files) {
    for (const dep of extractDeps(f)) {
      if (!importsOf.has(dep)) continue;   // only count edges inside the scanned tree
      importsOf.get(f).add(dep);
      dependentsOf.get(dep).add(f);
    }
  }
  return { files, importsOf, dependentsOf, root };
}

/**
 * Transitive count of files that (directly or indirectly) import the target.
 * Returns 0 if the file isn't in the graph (e.g. not in tools/oracle-discord/).
 */
export function blastRadius(target, graph) {
  graph = graph || buildGraph();
  // Accept relative or absolute paths
  const abs = path.isAbsolute(target) ? target : path.resolve(graph.root, target);
  if (!graph.dependentsOf.has(abs)) return 0;

  const seen = new Set();
  const stack = [{ file: abs, depth: 0 }];
  while (stack.length) {
    const { file, depth } = stack.pop();
    if (depth > 8) continue;
    for (const parent of graph.dependentsOf.get(file) || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push({ file: parent, depth: depth + 1 });
    }
  }
  return seen.size;
}

/**
 * Map a blast-radius count into a risk tier. Tunable.
 *   0-2   low     — safe to auto-apply
 *   3-9   medium  — auto-apply with extra validation
 *   10+   high    — never auto-apply, always human review
 */
export function riskScore(blast) {
  if (blast <= 2)  return 'low';
  if (blast <= 9)  return 'medium';
  return 'high';
}

/**
 * Convenience: print a summary of the graph (top-N highest-blast files).
 */
export function summarize(graph, topN = 10) {
  graph = graph || buildGraph();
  const scored = graph.files.map(f => ({
    file: path.relative(graph.root, f),
    blast: blastRadius(f, graph),
    direct: graph.dependentsOf.get(f).size,
  }));
  scored.sort((a, b) => b.blast - a.blast);
  return scored.slice(0, topN);
}
