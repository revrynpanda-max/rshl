#!/usr/bin/env node
/**
 * validate-imports.mjs — Pre-flight import check for the Oracle Discord fleet.
 * 
 * Reads each .mjs file in bots/ and shared/, extracts named imports,
 * then verifies each imported name exists as an export in the target file.
 * 
 * Usage: node scripts/validate-imports.mjs
 * Run before starting the server to catch import mismatches early.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Directories to scan for imports
const SCAN_DIRS = [
  path.join(ROOT, 'bots'),
  path.join(ROOT, 'shared'),
];

// Regex to match: import { name1, name2 } from './path.mjs';
const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

// Regex to match export statements
const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
const EXPORT_DEFAULT_RE = /export\s+default/;
const EXPORT_NAMED_RE = /export\s*\{([^}]+)\}/g;

function getExports(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const exports = new Set();
    
    let m;
    while ((m = EXPORT_RE.exec(content)) !== null) {
      exports.add(m[1]);
    }
    // Reset regex
    EXPORT_RE.lastIndex = 0;
    
    while ((m = EXPORT_NAMED_RE.exec(content)) !== null) {
      const names = m[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      });
      names.forEach(n => { if (n) exports.add(n); });
    }
    EXPORT_NAMED_RE.lastIndex = 0;
    
    return exports;
  } catch (e) {
    return null; // file doesn't exist
  }
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues = [];
  
  let m;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const importedNames = m[1].split(',').map(n => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[0].trim();
    }).filter(Boolean);
    
    const importPath = m[2];
    
    // Only check relative imports (our own files)
    if (!importPath.startsWith('.')) continue;
    
    const resolvedPath = path.resolve(path.dirname(filePath), importPath);
    
    if (!fs.existsSync(resolvedPath)) {
      issues.push({
        severity: 'CRITICAL',
        file: path.relative(ROOT, filePath),
        message: `Import target does not exist: ${importPath}`,
        names: importedNames,
      });
      continue;
    }
    
    const targetExports = getExports(resolvedPath);
    if (targetExports === null) continue;
    
    for (const name of importedNames) {
      if (!targetExports.has(name)) {
        issues.push({
          severity: 'CRITICAL',
          file: path.relative(ROOT, filePath),
          message: `'${name}' is not exported from '${importPath}'`,
          target: path.relative(ROOT, resolvedPath),
        });
      }
    }
  }
  IMPORT_RE.lastIndex = 0;
  
  return issues;
}

// Main
console.log('🔍 KAI Import Validator — checking all .mjs files...\n');

let totalIssues = 0;
let totalFiles = 0;

for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs'));
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    totalFiles++;
    
    const issues = scanFile(filePath);
    
    if (issues.length > 0) {
      for (const issue of issues) {
        console.log(`  ❌ [${issue.severity}] ${issue.file}: ${issue.message}`);
        if (issue.target) console.log(`     → target: ${issue.target}`);
      }
      totalIssues += issues.length;
    }
  }
}

console.log(`\n✅ Scanned ${totalFiles} files. Found ${totalIssues} issue(s).`);

if (totalIssues > 0) {
  console.log('\n⚠️  Fix these before starting the server!');
  process.exit(1);
} else {
  console.log('   All imports verified. Safe to start.');
  process.exit(0);
}
