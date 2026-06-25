/**
 * gemi-image.mjs
 * Gemi's image generation layer — Google Gemini native image model.
 *
 * When a user (or another AI) asks Gemi to make an image, this module:
 *   1. Detects the image request and extracts the prompt
 *   2. Calls gemini-2.5-flash-image via generateContent (responseModalities
 *      ["TEXT","IMAGE"]) and reads image bytes from candidates[].content.parts[].inlineData
 *   3. Returns a Buffer of the image so the caller can send it as a Discord attachment
 *
 * OWNER DECISION: the deprecated imagen-3.0-generate-001 primary and the 429'd
 * gemini-2.0-flash fallback were BOTH replaced with the single working model
 * gemini-2.5-flash-image. Note: image generation may have its own free-tier quota.
 *
 * No extra packages required — uses Node.js native fetch.
 * Requires: GEMINI_API_KEY (or GOOGLE_API_KEY) in environment.
 */

import dotenv from 'dotenv';
dotenv.config();

// ── Image request detection ────────────────────────────────────────────────────

const IMAGE_TRIGGERS = [
  /\b(generate|create|make|draw|paint|render|produce|show me|give me|design)\b.{0,40}\b(image|picture|photo|art|artwork|illustration|drawing|painting|sketch|visual|pic)\b/i,
  /\b(image|picture|photo|art|illustration|drawing|sketch|visual)\b.{0,20}\b(of|showing|depicting|with|featuring)\b/i,
  /\bcan you (draw|paint|make|generate|create|design)\b/i,
  /\b(draw|paint|illustrate|visualize)\b.{0,60}/i,
  /\bwhat does.{0,40}look like\b/i,
  /\bshow me.{0,20}\b(what|how|a|an|the)\b/i,
];

/**
 * Returns true if the text is an image generation request.
 */
export function isImageRequest(text) {
  return IMAGE_TRIGGERS.some(pattern => pattern.test(text));
}

/**
 * Extracts the image subject/prompt from the user's message.
 * Strips the "generate an image of..." wrapper and returns just the description.
 */
export function extractImagePrompt(text) {
  // Strip common wrappers to get to the core description
  let prompt = text
    .replace(/^(hey gemi[,!]?\s*|gemi[,!]?\s*)/i, '')
    .replace(/^(can you|could you|please|pls)?\s*(generate|create|make|draw|paint|render|produce|design)\s*(me\s+)?(an?\s+)?(image|picture|photo|art|artwork|illustration|drawing|painting|sketch|visual|pic)?\s*(of\s+|showing\s+|depicting\s+|of\s+a\s+|of\s+an\s+)?/i, '')
    .replace(/^(show me|give me)\s*(an?\s+)?(image|picture|photo|visual|pic)?\s*(of\s+)?/i, '')
    .replace(/^(draw|paint|illustrate|visualize)\s*/i, '')
    .trim();

  // If stripping left nothing useful, use the original text
  if (prompt.length < 5) prompt = text;

  // Cap at 500 chars (keep the prompt tight for the image model)
  return prompt.slice(0, 500).trim();
}

// ── Gemini native image model ──────────────────────────────────────────────────
// gemini-2.5-flash-image via generateContent. Image bytes come back as base64 in
// candidates[].content.parts[].inlineData. Same GEMINI/GOOGLE key the fleet uses.
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const IMAGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;

/**
 * Generate an image from a prompt using gemini-2.5-flash-image.
 * Defensive: handles non-200 and no-image responses gracefully (returns null).
 *
 * @param {string} prompt - The image description
 * @returns {{ buffer: Buffer, mimeType: string, model: string } | null}
 */
export async function generateImage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[Gemi/Image] No GEMINI_API_KEY/GOOGLE_API_KEY — cannot generate image.');
    return null;
  }

  try {
    console.log(`[Gemi/Image] Calling ${IMAGE_MODEL}: "${prompt.slice(0, 60)}..."`);
    const res = await fetch(`${IMAGE_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      console.warn(`[Gemi/Image] ${IMAGE_MODEL} failed (${res.status}): ${String(errText).slice(0, 120)}`);
      return null;
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/') && p.inlineData?.data);
    if (imagePart?.inlineData?.data) {
      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      console.log(`[Gemi/Image] ${IMAGE_MODEL} success — ${buffer.length} bytes (${mimeType}).`);
      return { buffer, mimeType, model: IMAGE_MODEL };
    }

    console.warn(`[Gemi/Image] ${IMAGE_MODEL} returned no image (text-only or empty response).`);
    return null;
  } catch (e) {
    console.warn(`[Gemi/Image] ${IMAGE_MODEL} error: ${e.message}`);
    return null;
  }
}

/**
 * Full pipeline: detect → extract prompt → generate → return result.
 * Returns null if the message isn't an image request or generation failed.
 *
 * @param {string} messageText
 * @returns {{ buffer: Buffer, mimeType: string, prompt: string, model: string } | null}
 */
export async function handleImageRequest(messageText) {
  if (!isImageRequest(messageText)) return null;
  const prompt = extractImagePrompt(messageText);
  console.log(`[Gemi/Image] Image request — prompt: "${prompt}"`);
  const result = await generateImage(prompt);
  if (!result) return null;
  return { ...result, prompt };
}
