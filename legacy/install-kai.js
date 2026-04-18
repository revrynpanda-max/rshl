/**
 * install-kai.js — Create a proper Windows shortcut for KAI
 *
 * Creates:
 *   - KAI.cmd (launcher batch file that runs kai-tui.js)
 *   - Desktop shortcut with custom icon
 *   - Start Menu entry
 *
 * This is faster and cleaner than SEA for development.
 * The shortcut shows the KAI icon, "PandaProductionsLogo", etc.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ICON = path.join(ROOT, 'kai-icon.ico');
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\revry', 'Desktop');

console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║     Installing KAI Shortcuts         ║');
console.log('  ║     PandaProductionsLogo              ║');
console.log('  ╚══════════════════════════════════════╝');
console.log('');

// ── 1. Create KAI.cmd launcher ────────────────────────────────────────────────
console.log('  [1/3] Creating KAI.cmd launcher...');
const cmdContent = `@echo off
title KAI - Geometric Intelligence
cd /d "${ROOT}"
node kai-tui.js %*
`;
const cmdPath = path.join(ROOT, 'KAI.cmd');
fs.writeFileSync(cmdPath, cmdContent, 'utf8');
console.log(`    ✓ ${cmdPath}`);

// ── 2. Create Desktop shortcut via PowerShell ─────────────────────────────────
console.log('  [2/3] Creating Desktop shortcut...');
const shortcutPath = path.join(DESKTOP, 'KAI.lnk');
const ps = `
$WS = New-Object -ComObject WScript.Shell
$SC = $WS.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$SC.TargetPath = '${cmdPath.replace(/'/g, "''")}'
$SC.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'
$SC.IconLocation = '${ICON.replace(/'/g, "''")}'
$SC.Description = 'KAI RSHL UI - Geometric Intelligence by PandaProductionsLogo'
$SC.WindowStyle = 1
$SC.Save()
`;

try {
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, { stdio: 'pipe' });
    console.log(`    ✓ Desktop shortcut created`);
} catch (e) {
    console.log(`    ⚠ Shortcut failed: ${e.message}`);
}

// ── 3. Create Start Menu shortcut ─────────────────────────────────────────────
console.log('  [3/3] Creating Start Menu entry...');
const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const startShortcut = path.join(startMenu, 'KAI.lnk');

const ps2 = `
$WS = New-Object -ComObject WScript.Shell
$SC = $WS.CreateShortcut('${startShortcut.replace(/'/g, "''")}')
$SC.TargetPath = '${cmdPath.replace(/'/g, "''")}'
$SC.WorkingDirectory = '${ROOT.replace(/'/g, "''")}'
$SC.IconLocation = '${ICON.replace(/'/g, "''")}'
$SC.Description = 'KAI RSHL UI - Geometric Intelligence by PandaProductionsLogo'
$SC.WindowStyle = 1
$SC.Save()
`;

try {
    execSync(`powershell -NoProfile -Command "${ps2.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, { stdio: 'pipe' });
    console.log(`    ✓ Start Menu entry created`);
} catch (e) {
    console.log(`    ⚠ Start Menu failed: ${e.message}`);
}

console.log('');
console.log('  ✅ KAI installed');
console.log('');
console.log('  You can now:');
console.log('    • Double-click KAI on your Desktop');
console.log('    • Search "KAI" in Start Menu');
console.log('    • Run: KAI.cmd from terminal');
console.log('    • Run: node kai-tui.js');
console.log('');
console.log('  Company:     PandaProductionsLogo');
console.log('  Author:      Ryan Ervin');
console.log('  Description: KAI RSHL UI');
console.log('');
