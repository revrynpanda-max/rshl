/**
 * gemi-image.mjs
 * Gemi's image generation layer — Google Imagen 3 via Gemini API.
 *
 * When a user (or another AI) asks Gemi to make an image, this module:
 *   1. Detects the image request and extracts the prompt
 *   2. Calls Google Imagen 3 (or flash fallback) via raw fetch
 *   3. Returns a Buffer of the PNG so the caller can send it as a Discord attachment
 *
 * No extra packages required — uses Node.js native fetch.
 * Requires: GEMINI_API_KEY in environment.
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

  // Cap at 500 chars (Imagen 3 prompt limit)
  return prompt.slice(0, 500).trim();
}

// ── Gemini Imagen 3 API call ───────────────────────────────────────────────────

const IMAGEN3_URL = `https://generativelanguage.googleapis.com/v1/models/imagen-3.0-generate-001:predict`;
const FLASH_IMAGE_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent`;

/**
 * Generate an image from a prompt using Google Imagen 3.
 * Falls back to gemini-2.0-flash image generation if Imagen 3 fails.
 *
 * @param {string} prompt - The image description
 * @returns {{ buffer: Buffer, mimeType: string } | null}
 */
export async function generateImage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[Gemi/Image] No GEMINI_API_KEY — cannot generate image.');
    return null;
  }

  // ── Try Imagen 3 first ──────────────────────────────────────────────────────
  try {
    console.log(`[Gemi/Image] Calling Imagen 3: "${prompt.slice(0, 60)}..."`);
    const res = await fetch(`${IMAGEN3_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '1:1',
          safetyFilterLevel: 'block_some',
          personGeneration: 'allow_adult'
        }
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (res.ok) {
      const data = await res.json();
      const prediction = data?.predictions?.[0];
      if (prediction?.bytesBase64Encoded) {
        const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
        const mimeType = prediction.mimeType || 'image/png';
        console.log(`[Gemi/Image] Imagen 3 success — ${buffer.length} bytes.`);
        return { buffer, mimeType, model: 'imagen-3' };
      }
    } else {
      const errText = await res.text().catch(() => res.status);
      console.warn(`[Gemi/Image] Imagen 3 failed (${res.status}): Model might be deprecated or restricted.`);
    }
  } catch (e) {
    console.warn(`[Gemi/Image] Imagen 3 error: ${e.message}`);
  }

  // ── Fallback: gemini-2.0-flash image generation ────────────────────────────
  try {
    console.log(`[Gemi/Image] Falling back to stable gemini-2.0-flash...`);
    const res = await fetch(`${FLASH_IMAGE_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Generate a high-quality image: ${prompt}` }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (imagePart?.inlineData?.data) {
        const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
        console.log(`[Gemi/Image] Flash image fallback success — ${buffer.length} bytes.`);
        return { buffer, mimeType: imagePart.inlineData.mimeType, model: 'gemini-flash' };
      }
    } else {
      const errText = await res.text().catch(() => res.status);
      console.warn(`[Gemi/Image] Flash fallback failed (${res.status}): model-switching to text-only.`);
    }
  } catch (e) {
    console.warn(`[Gemi/Image] Flash fallback error: ${e.message}`);
  }

  return null;
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
