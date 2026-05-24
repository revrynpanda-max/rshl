import { Readable } from 'stream';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Extract the first URL from a string if present.
 * @param {string} text 
 * @returns {string|null}
 */
export function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[.,!?]+$/, '') : null;
}

/**
 * Read the content of any supported URL (GitHub Repo, GitHub File, or generic Web page).
 * @param {string} url 
 * @returns {Promise<{title: string, content: string, files?: string[]}|null>}
 */
export async function readUrlContent(url) {
  if (!url) return null;

  try {
    const githubFileMatch = url.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/i);
    const githubRepoMatch = url.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/i);

    let title = "";
    let rawContent = "";
    let files = [];

    if (githubFileMatch) {
      // 1. GitHub Direct File URL
      const [_, owner, repo, branch, path] = githubFileMatch;
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      console.log(`[URL Reader] Fetching raw GitHub file: ${rawUrl}`);
      
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawContent = await res.text();
      title = `${owner}/${repo} - ${path}`;
    } else if (githubRepoMatch) {
      // 2. GitHub Repository Root URL
      const [_, owner, repo] = githubRepoMatch;
      title = `${owner}/${repo} GitHub Repository`;
      console.log(`[URL Reader] Querying GitHub API for repository: ${owner}/${repo}`);
      
      // Fetch README content (up to 100,000 characters)
      let readmeContent = "";
      try {
        const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KAI-LinkReader/1.0)' },
          signal: AbortSignal.timeout(5000)
        });
        if (readmeRes.ok) {
          const readmeData = await readmeRes.json();
          if (readmeData.content && readmeData.encoding === 'base64') {
            readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf8');
          }
        }
      } catch (err) {
        console.warn(`[URL Reader] Failed to fetch README:`, err.message);
      }

      // Fetch file tree (try main first, fall back to master)
      let branchName = "main";
      for (const branch of ['main', 'master']) {
        try {
          const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KAI-LinkReader/1.0)' },
            signal: AbortSignal.timeout(6000)
          });
          if (treeRes.ok) {
            const treeData = await treeRes.json();
            if (treeData.tree && Array.isArray(treeData.tree)) {
              files = treeData.tree
                .filter(item => item.type === 'blob')
                .map(item => item.path);
              branchName = branch;
              break;
            }
          }
        } catch (_) {}
      }

      // Filter and concurrently ingest key documentation and source files (up to 12 files)
      const importantFiles = files.filter(f => {
        const lf = f.toLowerCase();
        if (lf.includes('package-lock.json') || lf.includes('cargo.lock')) return false;
        if (lf.includes('node_modules/') || lf.includes('.git/')) return false;
        return lf.endsWith('.md') || lf.endsWith('.txt') || lf.endsWith('.toml') || lf.endsWith('.json') || lf === 'src/main.rs' || lf === 'src/lib.rs' || lf === 'index.mjs';
      }).slice(0, 12);

      console.log(`[URL Reader] Deep Ingestion active: Fetching raw contents of ${importantFiles.length} critical files...`);
      
      const fileContentsArray = await Promise.all(
        importantFiles.map(async (filePath) => {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/${filePath}`;
            const fileRes = await fetch(rawUrl, { signal: AbortSignal.timeout(5000) });
            if (fileRes.ok) {
              const fileText = await fileRes.text();
              return `\n--- START FILE CONTENT: ${filePath} ---\n${fileText.slice(0, 15000)}\n--- END FILE CONTENT: ${filePath} ---\n`;
            }
          } catch (e) {
            console.warn(`[URL Reader] Deep Ingestion failed for ${filePath}:`, e.message);
          }
          return null;
        })
      );

      const deepContentsText = fileContentsArray.filter(Boolean).join('\n');
      const fileListText = files.length > 0 
        ? files.slice(0, 1500).map(f => `- ${f}`).join('\n') + (files.length > 1500 ? `\n...and ${files.length - 1500} more files.` : '')
        : 'Could not fetch file structure.';

      rawContent = `Repository: ${owner}/${repo}\n\n` +
        `### FILE STRUCTURE:\n${fileListText}\n\n` +
        `### DEEP INTEGRATION (RAW READ OF KEY FILES):\n${deepContentsText}`;
    } else {
      // 3. Generic Web Scraper (HTML to text)
      console.log(`[URL Reader] Scrapes generic URL: ${url}`);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      title = url;

      // Strip scripts, styles, and other metadata
      let cleanText = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<卫生)*/gi, '')
        .replace(/<\/?[^>]+(>|$)/g, ' ') // Strip tags
        .replace(/\s+/g, ' ')            // Normalize spaces
        .trim();
      rawContent = cleanText.slice(0, 100000);
    }

    // --- TWO-STAGE ARCHITECTURE: GEMINI COMPRESSION & STRUCTURING ---
    let content = rawContent;
    if (rawContent.length > 10000) {
      content = await compressWithGemini(title, rawContent);
    }

    return {
      title,
      content,
      files: files.length > 0 ? files : undefined
    };

  } catch (err) {
    console.error(`[URL Reader] Failed to read ${url}:`, err.message);
    return null;
  }
}

/**
 * Uses Gemini-Sovereign (gemini-1.5-pro) to structure and compress high-context text
 * into highly structured, sectioned outputs (1, 2, 3...) for downstream bots.
 * @param {string} title 
 * @param {string} text 
 * @returns {Promise<string>}
 */
async function compressWithGemini(title, text) {
  const googleKey = process.env.GEMINI_API_KEY;
  const zenKey = process.env.OPENCODE_ZEN_KEY;
  const moonshotKey = process.env.MOONSHOT_API_KEY;

  if (!googleKey && !zenKey && !moonshotKey) {
    console.log("[URL Reader] No API keys found for compression. Falling back to simple truncation.");
    return text.slice(0, 12000) + "\n\n[WARNING: Content truncated due to missing keys]";
  }

  // 1. Try Native Google Gemini API first (Massive 2M context, highly stable)
  if (googleKey) {
    console.log(`[URL Reader] Sending massive content (${text.length} chars) to Native Google Gemini (gemini-2.5-pro) for structuring...`);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${googleKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `Title: ${title}\n\nSource Data:\n${text}` }]
            }
          ],
          systemInstruction: {
            parts: [{
              text: `You are Gemini-Sovereign. Your task is to ingest and digest this massive, high-context source data (repository tree, README, file contents, or web documentation).
You must organize it into a structured, highly dense, section-by-section breakdown (e.g. 1., 2., 3...) so that downstream agent models can read it perfectly and gain absolute, flawless comprehension.
For repos: Highlight critical directory entrypoints and architectural design.
Respond directly with the structured sections. No introductions. No fluff.`
            }]
          },
          generationConfig: {
            temperature: 0.2
          }
        }),
        signal: AbortSignal.timeout(60000) // 60s timeout for large generation
      });

      if (res.ok) {
        const data = await res.json();
        const compressed = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (compressed) {
          console.log(`[URL Reader] Native Google Gemini successfully structured the content into ${compressed.length} chars!`);
          return `[STRUCTURED SECTIONS (Ingested by Gemini-Sovereign)]\n${compressed}`;
        }
      } else {
        console.warn(`[URL Reader] Native Google Gemini failed with status ${res.status}. Trying Zen...`);
      }
    } catch (err) {
      console.warn(`[URL Reader] Native Google Gemini call failed:`, err.message);
    }
  }

  // 2. Try Gemini (Zen) second (using Claude-Sonnet-4.5 which is fully working and verified)
  if (zenKey) {
    console.log(`[URL Reader] Sending massive content (${text.length} chars) to Zen (claude-sonnet-4-5) for structuring...`);
    try {
      const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zenKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [
            {
              role: "system",
              content: `You are Gemini-Sovereign. Your task is to ingest and digest this massive, high-context source data (repository tree, README, file contents, or web documentation).
You must organize it into a structured, highly dense, section-by-section breakdown (e.g. 1., 2., 3...) so that downstream agent models can read it perfectly and gain absolute, flawless comprehension.
For repos: Highlight critical directory entrypoints and architectural design.
Respond directly with the structured sections. No introductions. No fluff.`
            },
            {
              role: "user",
              content: `Title: ${title}\n\nSource Data:\n${text}`
            }
          ],
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(60000) // 60s timeout for large generation
      });

      if (res.ok) {
        const data = await res.json();
        const compressed = data.choices?.[0]?.message?.content?.trim();
        if (compressed) {
          console.log(`[URL Reader] Zen Claude-Sonnet successfully structured the content into ${compressed.length} chars!`);
          return `[STRUCTURED SECTIONS (Ingested by Gemini-Sovereign / Claude fallback)]\n${compressed}`;
        }
      } else {
        console.warn(`[URL Reader] Zen API failed with status ${res.status}. Trying Moonshot...`);
      }
    } catch (err) {
      console.warn(`[URL Reader] Zen call failed:`, err.message);
    }
  }

  // 3. Fallback: Try Moonshot Kimi-Sovereign (highly stable 128k context)
  if (moonshotKey) {
    console.log(`[URL Reader] Ingesting via Moonshot (kimi-k2.6) for structuring...`);
    try {
      const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${moonshotKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "kimi-k2.6",
          messages: [
            {
              role: "system",
              content: `You are Gemini-Sovereign. Your task is to ingest and digest this massive, high-context source data (repository tree, README, file contents, or web documentation).
You must organize it into a structured, highly dense, section-by-section breakdown (e.g. 1., 2., 3...) so that downstream agent models can read it perfectly and gain absolute, flawless comprehension.
For repos: Highlight critical directory entrypoints and architectural design.
Respond directly with the structured sections. No introductions. No fluff.`
            },
            {
              role: "user",
              content: `Title: ${title}\n\nSource Data:\n${text}`
            }
          ],
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(25000)
      });

      if (res.ok) {
        const data = await res.json();
        const compressed = data.choices?.[0]?.message?.content?.trim();
        if (compressed) {
          console.log(`[URL Reader] Moonshot successfully structured the content into ${compressed.length} chars!`);
          return `[STRUCTURED SECTIONS (Ingested by Gemini-Sovereign / Moonshot fallback)]\n${compressed}`;
        }
      } else {
        console.warn(`[URL Reader] Moonshot API failed with status ${res.status}.`);
      }
    } catch (err) {
      console.warn(`[URL Reader] Moonshot call failed:`, err.message);
    }
  }

  // Graceful fallback: return direct truncation
  return text.slice(0, 12000) + "\n\n[WARNING: Content truncated due to both API failures]";
}
