import fs from 'fs';
import path from 'path';

const STATE_PATH = 'c:/KAI/data/kai-state.json';
const BACKUP_DIR = 'c:/KAI/data/archive';

async function purge() {
  console.log("Starting Lattice Deep Clean...");

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `kai-state-pre-clean-${Date.now()}.json`);
  fs.copyFileSync(STATE_PATH, backupPath);
  console.log(`Backup created at ${backupPath}`);

  const raw = fs.readFileSync(STATE_PATH, 'utf8');
  const state = JSON.parse(raw);

  const initialCount = state.universe.cells.length;
  console.log(`Initial cell count: ${initialCount}`);

  // Filtering criteria
  const cleanedCells = state.universe.cells.filter(cell => {
    const text = (cell.label || cell.claim?.text || "").toLowerCase();
    const source = cell.claim?.source || "";
    const confidence = cell.claim?.confidence || 0;

    // 1. Always keep seed data
    if (source === 'seed') return true;

    // 2. Keep core identity markers
    if (text.includes("kai") || text.includes("oracle") || text.includes("leo") || text.includes("ryan")) {
      if (confidence > 0.5) return true;
    }

    // 3. Keep physics/theory anchors if they have decent confidence
    const theoryKeywords = ["dimension", "vector", "geometric", "lattice", "sparse", "ternary", "resonance", "phi", "vortex"];
    if (theoryKeywords.some(k => text.includes(k)) && confidence > 0.8) return true;

    // 4. Discard everything else (the "garbage")
    return false;
  });

  state.universe.cells = cleanedCells;
  state.saved_at = `epoch-${Math.floor(Date.now() / 1000)}`;
  
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`Clean complete. Removed ${initialCount - cleanedCells.length} corrupted cells.`);
  console.log(`Final cell count: ${cleanedCells.length}`);
}

purge().catch(console.error);
