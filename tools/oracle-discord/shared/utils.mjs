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

export function chunkForDiscord(text) {
  const max = 1900;
  if (text.length <= max) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
