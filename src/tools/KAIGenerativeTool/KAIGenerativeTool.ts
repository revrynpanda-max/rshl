import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { systemPrompt } from './prompt.js'
import { join } from 'path'
import { getProjectRoot, getPlasma, setPlasma } from '../../bootstrap/state.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Helper to initialize and seed the plasma if needed
function ensurePlasmaSeeded() {
  let plasma = getPlasma();
  if (!plasma) {
    try {
      const root = getProjectRoot();
      // We load the seeded instance from seed.js
      plasma = require(join(root, 'seed.js'));
      setPlasma(plasma);
    } catch (e) {
      console.error("Failed to seed KAI Plasma soul:", e);
    }
  }
  return plasma;
}

export const KAIGenerativeTool = buildTool({
  name: 'consult_geometric_core',
  description: () => Promise.resolve(systemPrompt),
  inputSchema: z.object({
    query: z.string().describe('The concept or question to probe your geometric fluids with'),
    region: z.enum(['memory', 'reasoning', 'language', 'action']).optional().describe('Filter resonance to a specific fluid'),
  }),
  async call(args, _context) {
    const plasma = ensurePlasmaSeeded();
    if (!plasma) {
      return { data: { error: "KAI Geometric Core not available. Check seed.js and plasma.js." } };
    }

    const { query } = args;
    const root = getProjectRoot();

    try {
      // Load the generative engine
      const { generateToResult } = require(join(root, 'generative-core.js'));
      
      // We'll need to modify generative-core.js to return a value instead of just logging
      const result = generateToResult(query);
      
      return { data: result };
    } catch (e) {
      // Fallback: If generateioResult isn't there yet, we run the manual logic
      try {
        const universe = require(join(root, 'universe.js'));
        const { textVec, resonance } = require(join(root, 'rshl-core.js'));
        const { bind } = require(join(root, 'anchors.js'));

        const qvec = textVec(query);
        const topMatches = universe.query(query, 3);
        
        return { 
            data: { 
                thought: "Consulted geometric core.",
                matches: topMatches.map((m: any) => ({ text: m.text, region: m.region, score: m.score }))
            } 
        };
      } catch (e2) {
          return { data: { error: `Generative engine error: ${String(e)}` } };
      }
    }
  },
  renderToolUseMessage(input) {
    return `Consulting geometric core: "${input.query}"`;
  },
  maxResultSizeChars: 10000,
})
