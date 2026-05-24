import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = 'c:/KAI';
const CORE_DIRS = [
  'c:/KAI/tools/oracle-discord/bots',
  'c:/KAI/tools/oracle-discord/shared',
  'c:/KAI/tools/oracle-discord/tools',
  'c:/KAI/tools/oracle-discord/radio',
  'c:/KAI/src',
  'c:/KAI/OpenJarvis-main/src'
];
const OUTPUT_FILE  = 'c:/KAI/tools/oracle-discord/state/project_snapshot.txt';
const ALLOW_EXTS  = new Set(['.mjs', '.js', '.rs', '.py', '.toml', '.env']);

function aggregate(results = []) {
  for (const coreDir of CORE_DIRS) {
    if (!fs.existsSync(coreDir)) continue;
    const entries = fs.readdirSync(coreDir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const full = path.join(e.parentPath, e.name);
      if (full.includes('node_modules') || full.includes('target') || full.includes('.git')) continue;
      
      const ext = path.extname(e.name);
      if (ALLOW_EXTS.has(ext)) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          results.push(`// FILE: ${path.relative(PROJECT_ROOT, full).replace(/\\/g, '/')}\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\``);
        } catch (err) {}
      }
    }
  }
  return results;
}

console.log("Aggregating core project logic for Kimi...");
const allCode = aggregate();
const finalContent = allCode.join('\n\n---\n\n');
fs.writeFileSync(OUTPUT_FILE, finalContent);
console.log(`Snapshot complete! Size: ${Math.round(finalContent.length / 1024)} KB`);
console.log(`Location: ${OUTPUT_FILE}`);
