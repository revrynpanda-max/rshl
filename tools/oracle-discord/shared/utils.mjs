export function isInternalMonologue(text) {
  if (!text) return false;
  return (
    text.startsWith("Lattice Conflict:") ||
    text.startsWith("KAI Observation:") ||
    text.startsWith("KAI Diagnostic:") ||
    text.startsWith("Claim ingested:") ||
    text.startsWith("Identity seeding") ||
    text.includes("thermal constraint") ||
    text.startsWith("Ecosystem:") ||
    text.startsWith("Panelist Status:") ||
    text.startsWith("Roundtable")
  );
}

export function isLoopingResponse(text) {
  if (!text) return false;
  const loopPhrases = [
    "i am here to assist",
    "i'm here to assist",
    "i am an ai",
    "how can i help you",
    "i don't have personal feelings",
    "i cannot answer that",
    "as an ai",
    "does not compute",
    "i am having trouble"
  ];
  const t = text.toLowerCase();
  for (const phrase of loopPhrases) {
    if (t.includes(phrase)) return true;
  }
  return false;
}
