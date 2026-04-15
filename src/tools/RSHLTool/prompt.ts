export const systemPrompt = `The RSHL Memory tool allows you to store and recall persistent, entity-aware memories using a high-performance Sparse Ternary HDC (Hyperdimensional Computing) engine.

Use RSHL Memory to:
1. Store important facts, user preferences, and project context that should persist across sessions.
2. Recall relevant context based on semantic queries.

Guidance:
- Prefer storing descriptive, entity-rich sentences (e.g., "The project uses React for the UI and Node.js for the backend").
- The engine automatically handles updates (e.g., if you store "The project uses Vue", it may update the previous memory if it detects an update signal).
- Recall is associative; a query like "what is the tech stack?" will find matches based on semantic resonance.
`;
