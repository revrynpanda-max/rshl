/**
 * build-exe.js — Bundle KAI into a single KAI.exe
 *
 * Uses Node 22 Single Executable Application (SEA) feature.
 * This script:
 *   1. Bundles all KAI source into one file (inline requires)
 *   2. Generates the SEA config
 *   3. Creates the blob
 *   4. Copies node.exe → KAI.exe and injects the blob
 *
 * Run: node build-exe.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, 'build');
const BUNDLE_FILE = path.join(BUILD_DIR, 'kai-bundle.js');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const SEA_BLOB = path.join(BUILD_DIR, 'kai.blob');
const EXE_NAME = path.join(ROOT, 'KAI.exe');

// ── Step 0: Create build directory ────────────────────────────────────────────
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║       Building KAI.exe               ║');
console.log('  ╚══════════════════════════════════════╝');
console.log('');

// ── Step 1: Bundle all source into one file ───────────────────────────────────
// We use a simple approach: create a launcher that sets up the module resolution
// and then requires kai-tui.js. The SEA will snapshot the entry point.
console.log('  [1/4] Creating bundle...');

// The SEA entry point just needs to require the TUI
// We need to handle the fact that require() in SEA resolves from the exe location
// So we bundle everything inline

// Collect all JS files needed
const entryFile = 'kai-tui.js';
const allFiles = [
    'rshl-core.js', 'plasma.js', 'anchors.js', 'universe.js',
    'field-state.js', 'generative-core.js', 'rshl-lattice.js',
    'candidate-buffer.js', 'promotion.js', 'homeostasis.js',
    'heartbeat.js', 'persistence.js', 'world-bridge.js',
    'drive.js', 'seed.js', 'chat.js', 'kai-tui.js',
];

// Build a self-contained bundle by wrapping each module
let bundle = `"use strict";
// KAI v5.0 — Single Executable Bundle
// Generated ${new Date().toISOString()}

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Override __dirname for data file paths
const _kaiDir = process.env.KAI_HOME || process.cwd();

// Module registry
const _modules = {};
const _moduleCache = {};

function _require(name) {
    if (_moduleCache[name]) return _moduleCache[name].exports;
    const mod = _modules[name];
    if (!mod) {
        // Fall back to native require for builtins
        return require(name);
    }
    const module = { exports: {} };
    _moduleCache[name] = module;
    mod(module, module.exports, function(dep) {
        // Resolve relative requires
        if (dep.startsWith('./')) dep = dep.slice(2);
        if (dep.endsWith('.js')) dep = dep.slice(0, -3);
        return _require(dep);
    });
    return module.exports;
}

`;

for (const file of allFiles) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) {
        console.log(`    ⚠ Skipping ${file} (not found)`);
        continue;
    }
    let code = fs.readFileSync(filePath, 'utf8');

    // Replace require('./xxx') with _require('xxx')
    code = code.replace(/require\s*\(\s*'\.\/([^']+)'\s*\)/g, "_require('$1')");
    code = code.replace(/require\s*\(\s*"\.\/([^"]+)"\s*\)/g, '_require("$1")');

    // Replace __dirname with _kaiDir for data paths
    code = code.replace(/__dirname/g, '_kaiDir');

    const modName = file.replace('.js', '');

    bundle += `// ── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}
_modules['${modName}'] = function(module, exports, require) {
${code}
};

`;
}

// Add the entry point
bundle += `
// ── Entry Point ───────────────────────────────────────────────────────────────
_require('kai-tui');
`;

fs.writeFileSync(BUNDLE_FILE, bundle, 'utf8');
const bundleSize = Math.round(fs.statSync(BUNDLE_FILE).size / 1024);
console.log(`    ✓ Bundle created (${bundleSize} KB, ${allFiles.length} modules)`);

// ── Step 2: Generate SEA config ───────────────────────────────────────────────
console.log('  [2/4] Generating SEA config...');

const seaConfig = {
    main: BUNDLE_FILE,
    output: SEA_BLOB,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
};

fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2), 'utf8');
console.log('    ✓ sea-config.json written');

// ── Step 3: Generate the blob ─────────────────────────────────────────────────
console.log('  [3/4] Generating SEA blob...');
try {
    execSync(`node --experimental-sea-config "${SEA_CONFIG}"`, {
        cwd: BUILD_DIR,
        stdio: 'pipe',
    });
    console.log('    ✓ Blob generated');
} catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    if (stderr.includes('ExperimentalWarning')) {
        console.log('    ✓ Blob generated (with experimental warning)');
    } else {
        console.error('    ✗ Blob generation failed:', stderr || e.message);
        process.exit(1);
    }
}

// ── Step 4: Copy node.exe → KAI.exe and inject blob ──────────────────────────
console.log('  [4/4] Creating KAI.exe...');

const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, EXE_NAME);
console.log(`    ✓ Copied ${path.basename(nodeExe)} → KAI.exe`);

// Remove signature (required on Windows before injection)
try {
    execSync(`signtool remove /s "${EXE_NAME}"`, { stdio: 'pipe' });
} catch {
    // signtool may not be available, try postject directly
}

// Inject the blob using postject
try {
    execSync(
        `npx -y postject "${EXE_NAME}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
        { cwd: ROOT, stdio: 'pipe', timeout: 120000 }
    );
    console.log('    ✓ Blob injected into KAI.exe');
} catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    if (stderr.includes('warning')) {
        console.log('    ✓ Blob injected (with warnings)');
    } else {
        console.error('    ✗ Injection failed:', stderr || e.message);
        console.log('');
        console.log('    Try running manually:');
        console.log(`    npx postject "${EXE_NAME}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
        process.exit(1);
    }
}

const exeSize = Math.round(fs.statSync(EXE_NAME).size / (1024 * 1024));
console.log('');
console.log(`  ✅ KAI.exe created (${exeSize} MB)`);
console.log(`     Location: ${EXE_NAME}`);
console.log('');
console.log('  Run it:');
console.log('    .\\KAI.exe');
console.log('');
console.log('  Note: Run from C:\\KAI so it can find data/kai-state.json');
console.log('  Or set KAI_HOME=C:\\KAI before running from elsewhere.');
console.log('');
