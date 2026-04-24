import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { systemPrompt } from './prompt.js'
import { join } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Try to load the RSHL engine
let RSHLLattice: any;
try {
  const root = getProjectRoot();
  // rshl-lattice.js is in the root
  RSHLLattice = require(join(root, 'rshl-lattice.js')).RSHLLattice;
} catch (e) {
  // Fallback if root is not what we think
  try {
     RSHLLattice = require('../../../../rshl-lattice.js').RSHLLattice;
  } catch (e2) {
     console.error("Failed to load RSHLLattice:", e2);
  }
}

let latticeInstance: any = null;
const MEMORY_FILE = 'rshl-memory.json';

function getLattice() {
  if (!latticeInstance && RSHLLattice) {
    latticeInstance = new RSHLLattice({ userName: "User" });
    const root = getProjectRoot();
    const memoryPath = join(root, MEMORY_FILE);
    latticeInstance.load(memoryPath);
  }
  return latticeInstance;
}

export const RSHLTool = buildTool({
  name: 'RSHLMemory',
  description: () => Promise.resolve(systemPrompt),
  inputSchema: z.object({
    action: z.enum(['store', 'recall', 'stats', 'forget']),
    text: z.string().optional().describe('Text to store or query to recall'),
    key: z.string().optional().describe('Optional key for the memory cell'),
    topK: z.number().int().optional().default(5).describe('Number of memories to recall'),
  }),
  async call(args, _context) {
    const lattice = getLattice();
    if (!lattice) {
      return { data: { error: "RSHL Engine not available. Check rshl-lattice.js in project root." } };
    }

    const { action, text, key, topK } = args;
    const root = getProjectRoot();
    const savePath = join(root, MEMORY_FILE);

    switch (action) {
      case 'store':
        if (!text) return { data: { error: "Text is required for store" } };
        const record = lattice.store(text, key);
        lattice.save(savePath);
        return { data: record };

      case 'recall':
        if (!text) return { data: { error: "Query text is required for recall" } };
        const results = lattice.recall(text, topK);
        return { data: { results } };

      case 'forget':
        if (!key) return { data: { error: "Key is required for forget" } };
        const deleted = lattice.forget(key);
        lattice.save(savePath);
        return { data: { deleted } };

      case 'stats':
        return { data: lattice.stats() };

      default:
        return { data: { error: "Invalid action" } };
    }
  },
  renderToolUseMessage(input) {
    return `RSHL Memory ${input.action}${input.text ? `: ${input.text}` : ''}`;
  },
  maxResultSizeChars: 10000,
})
