"use strict";

/**
 * world-bridge.js — External World Intake Layer
 *
 * Biology analog: Sensory cortex + thalamic gating.
 * External stimuli (web, APIs, documents) enter through the same neural
 * tissue as internal activity. They are NOT pre-trusted. They arrive as
 * weak, unresolved, high-novelty traces that must survive the internal
 * validation pipeline (dreaming → candidate buffer → promotion) before
 * becoming durable beliefs.
 *
 * The bridge does NOT decide what to believe. It only:
 *   1. Accepts raw observations from external sources
 *   2. Checks for redundancy against existing field content
 *   3. Stores non-redundant observations as low-strength, unresolved cells
 *   4. Tags them so the dream loop and promotion pipeline can evaluate
 *
 * Intake flow:
 *   external source → extractFacts() → dedup via resonance → store as
 *   weak unresolved cell → dream loop picks it up → candidate buffer
 *   accumulates → promotion validates → belief formed (or not)
 *
 * Supported sources:
 *   - Raw text observations (manual or programmatic)
 *   - Web search results (via fetch)
 *   - GitHub repository data (via GitHub REST API)
 *   - RSS/feed style ingestion (structured items)
 *
 * Architecture rule: No LLM is used here. Fact extraction is simple
 * sentence splitting + deduplication via resonance. The field itself
 * decides what matters through emergence, not through a language model
 * summarizing things for us.
 */

const universe = require('./universe');
const { textVec, resonance } = require('./rshl-core');
const { clamp01 } = require('./field-state');

// ── Configuration ──────────────────────────────────────────────────────────────
const CONFIG = {
    // Resonance threshold above which an incoming observation is considered
    // redundant with existing field content (skip it — already known).
    redundancyThreshold: 0.82,

    // Initial strength for externally sourced observations.
    // Low enough that homeostasis will prune them if they never resonate
    // with anything, but high enough that they survive a few dream cycles.
    initialStrength: 0.6,

    // Maximum observations to ingest in a single batch (prevents flooding).
    maxBatchSize: 50,

    // Minimum text length to consider (filters out noise, headers, etc.)
    minTextLength: 12,

    // Maximum text length to store (long paragraphs dilute vector signal).
    maxTextLength: 500,

    // Default region for external observations.
    defaultRegion: 'memory',

    // Maximum number of sentences to extract from a single text block.
    maxSentencesPerBlock: 20,
};

// ── Intake log ─────────────────────────────────────────────────────────────────
// Tracks what was ingested, skipped, or failed — useful for diagnostics.
const _intakeLog = [];
const MAX_LOG_ENTRIES = 200;

function _log(action, detail) {
    _intakeLog.push({ action, detail, ts: Date.now() });
    if (_intakeLog.length > MAX_LOG_ENTRIES) _intakeLog.shift();
}

// ── Fact extraction ────────────────────────────────────────────────────────────
// No LLM. Split text into sentences. Filter noise. Each sentence is a
// potential observation for the field to evaluate through resonance.

function extractFacts(text) {
    if (!text || typeof text !== 'string') return [];

    // Split on sentence boundaries — period, exclamation, question mark,
    // newlines, semicolons. Preserve enough context per sentence.
    const raw = text
        .replace(/\r\n/g, '\n')
        .split(/(?<=[.!?;])\s+|\n{1,}/)
        .map(s => s.trim())
        .filter(s => s.length >= CONFIG.minTextLength);

    const facts = [];
    for (const sentence of raw) {
        if (facts.length >= CONFIG.maxSentencesPerBlock) break;

        // Truncate overly long sentences
        const cleaned = sentence.length > CONFIG.maxTextLength
            ? sentence.slice(0, CONFIG.maxTextLength)
            : sentence;

        // Skip if it looks like HTML/code/noise
        if (/^[<{]/.test(cleaned)) continue;
        if (/^\s*[/\\#*]/.test(cleaned)) continue;
        if ((cleaned.match(/[a-zA-Z]/g) || []).length < cleaned.length * 0.4) continue;

        facts.push(cleaned);
    }

    return facts;
}

// ── Redundancy check ───────────────────────────────────────────────────────────
// Check if an observation is already substantially present in the field.
// Uses resonance sweep against all cells — same mechanism as query().

function isRedundant(text) {
    const vec = textVec(text);
    const cells = universe.getCells();

    for (const cell of cells) {
        if (!cell.raw) continue;
        const sim = resonance(vec, cell.raw);
        if (sim >= CONFIG.redundancyThreshold) {
            return { redundant: true, matchedText: cell.text, sim };
        }
    }

    return { redundant: false };
}

// ── Single observation intake ──────────────────────────────────────────────────
/**
 * ingest(text, options)
 * Ingest a single observation into the field as an untrusted cell.
 *
 * @param {string} text        — the observation text
 * @param {object} options
 *   source {string}          — origin tag ('web', 'github', 'manual', 'rss')
 *   region {string}          — target region (default: 'memory')
 *   url {string}             — source URL for provenance tracking
 *   topic {string}           — topic tag for later filtering
 *   strength {number}        — override initial strength (default: CONFIG.initialStrength)
 *
 * @returns {{ stored: boolean, id?: number, reason?: string }}
 */
function ingest(text, options) {
    const opts = options || {};

    if (!text || typeof text !== 'string' || text.trim().length < CONFIG.minTextLength) {
        _log('skip', { reason: 'too-short', text: (text || '').slice(0, 40) });
        return { stored: false, reason: 'too-short' };
    }

    const clean = text.trim().slice(0, CONFIG.maxTextLength);

    // Redundancy check
    const dup = isRedundant(clean);
    if (dup.redundant) {
        _log('skip', { reason: 'redundant', text: clean.slice(0, 40), sim: dup.sim });
        return { stored: false, reason: 'redundant', matchedText: dup.matchedText };
    }

    // Store as low-strength, unresolved, high-novelty cell
    const region = opts.region || CONFIG.defaultRegion;
    const id = universe.store(clean, region, {
        source:        opts.source || 'external-intake',
        strength:      opts.strength || CONFIG.initialStrength,
        unresolved:    true,   // Mark as unresolved so dream loop prioritizes it
        novelty:       0.85,   // High novelty = high replay priority
        contradiction: 0,      // Unknown — let the field determine via resonance
        externalUrl:   opts.url || null,
        externalTopic: opts.topic || null,
        ingestedAt:    Date.now(),
    });

    _log('stored', { id, text: clean.slice(0, 60), source: opts.source || 'external-intake' });
    return { stored: true, id };
}

// ── Batch intake ───────────────────────────────────────────────────────────────
/**
 * ingestBatch(texts, options)
 * Ingest multiple observations. Applies extractFacts to each text block,
 * then ingests each extracted fact individually.
 *
 * @param {string[]} texts     — array of text blocks
 * @param {object}   options   — same as ingest() options (applied to all)
 *
 * @returns {{ stored: number, skipped: number, results: object[] }}
 */
function ingestBatch(texts, options) {
    if (!Array.isArray(texts)) return { stored: 0, skipped: 0, results: [] };

    const results = [];
    let stored = 0;
    let skipped = 0;
    let total = 0;

    for (const block of texts) {
        const facts = extractFacts(block);
        for (const fact of facts) {
            if (total >= CONFIG.maxBatchSize) break;
            total++;

            const result = ingest(fact, options);
            results.push({ text: fact.slice(0, 60), ...result });

            if (result.stored) stored++;
            else skipped++;
        }
        if (total >= CONFIG.maxBatchSize) break;
    }

    return { stored, skipped, results };
}

// ── Web search intake ──────────────────────────────────────────────────────────
/**
 * ingestFromWeb(query, options)
 * Performs a web search via fetch, extracts facts from results, and ingests.
 *
 * Uses a simple search API pattern. The actual search endpoint must be
 * configured via options.searchUrl or the BRIDGE_SEARCH_URL env var.
 *
 * The search is expected to return JSON: { results: [{ title, snippet, url }] }
 *
 * @param {string} query       — search query
 * @param {object} options
 *   searchUrl {string}       — search API endpoint
 *   maxResults {number}      — max results to process (default: 10)
 *   region {string}          — target region
 *
 * @returns {Promise<{ stored: number, skipped: number, results: object[] }>}
 */
async function ingestFromWeb(query, options) {
    const opts = options || {};
    const searchUrl = opts.searchUrl || process.env.BRIDGE_SEARCH_URL;

    if (!searchUrl) {
        _log('error', { reason: 'no-search-url', query });
        return { stored: 0, skipped: 0, error: 'No search URL configured. Set BRIDGE_SEARCH_URL or pass options.searchUrl' };
    }

    try {
        const url = `${searchUrl}?q=${encodeURIComponent(query)}&max=${opts.maxResults || 10}`;
        const resp = await fetch(url);

        if (!resp.ok) {
            _log('error', { reason: 'search-http-error', status: resp.status, query });
            return { stored: 0, skipped: 0, error: `Search returned HTTP ${resp.status}` };
        }

        const data = await resp.json();
        const items = Array.isArray(data.results) ? data.results : [];

        const texts = items.map(item => {
            const parts = [];
            if (item.title) parts.push(item.title);
            if (item.snippet) parts.push(item.snippet);
            if (item.content) parts.push(item.content);
            return parts.join('. ');
        }).filter(Boolean);

        return ingestBatch(texts, {
            source: 'web-search',
            url: searchUrl,
            topic: query,
            region: opts.region || 'memory',
            ...opts,
        });

    } catch (err) {
        _log('error', { reason: 'search-fetch-fail', message: err.message, query });
        return { stored: 0, skipped: 0, error: err.message };
    }
}

// ── GitHub intake ──────────────────────────────────────────────────────────────
/**
 * ingestFromGitHub(owner, repo, options)
 * Fetches repository metadata, README, and recent commits from GitHub
 * public API. Extracts facts and ingests them.
 *
 * @param {string} owner       — repo owner (e.g. 'revrynpanda-max')
 * @param {string} repo        — repo name (e.g. 'rshl')
 * @param {object} options
 *   token {string}           — GitHub PAT for private repos (optional)
 *   includeCommits {boolean} — also ingest recent commit messages (default: true)
 *   includeReadme {boolean}  — also ingest README content (default: true)
 *   maxCommits {number}      — max commits to ingest (default: 10)
 *   region {string}          — target region
 *
 * @returns {Promise<{ stored: number, skipped: number, results: object[] }>}
 */
async function ingestFromGitHub(owner, repo, options) {
    const opts = options || {};
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const texts = [];

    try {
        // 1. Repo metadata
        const repoResp = await fetch(baseUrl, { headers });
        if (repoResp.ok) {
            const repoData = await repoResp.json();
            if (repoData.description) {
                texts.push(`${owner}/${repo}: ${repoData.description}`);
            }
            if (repoData.topics && repoData.topics.length) {
                texts.push(`${owner}/${repo} topics: ${repoData.topics.join(', ')}`);
            }
            texts.push(
                `${owner}/${repo} has ${repoData.stargazers_count || 0} stars, ` +
                `${repoData.forks_count || 0} forks, ` +
                `primary language: ${repoData.language || 'unknown'}, ` +
                `created ${repoData.created_at || 'unknown'}.`
            );
        }

        // 2. README
        if (opts.includeReadme !== false) {
            const readmeResp = await fetch(`${baseUrl}/readme`, { headers });
            if (readmeResp.ok) {
                const readmeData = await readmeResp.json();
                if (readmeData.content) {
                    const decoded = Buffer.from(readmeData.content, 'base64').toString('utf8');
                    // Strip markdown formatting noise
                    const cleaned = decoded
                        .replace(/```[\s\S]*?```/g, '')   // code blocks
                        .replace(/!\[.*?\]\(.*?\)/g, '')    // images
                        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // links → text
                        .replace(/#{1,6}\s*/g, '')          // headers
                        .replace(/[*_~`]/g, '');            // emphasis
                    texts.push(cleaned);
                }
            }
        }

        // 3. Recent commits
        if (opts.includeCommits !== false) {
            const maxCommits = opts.maxCommits || 10;
            const commitsResp = await fetch(
                `${baseUrl}/commits?per_page=${maxCommits}`,
                { headers }
            );
            if (commitsResp.ok) {
                const commits = await commitsResp.json();
                for (const commit of commits) {
                    const msg = commit.commit && commit.commit.message;
                    if (msg && msg.length >= CONFIG.minTextLength) {
                        texts.push(`${owner}/${repo} commit: ${msg}`);
                    }
                }
            }
        }

    } catch (err) {
        _log('error', { reason: 'github-fetch-fail', message: err.message, repo: `${owner}/${repo}` });
        return { stored: 0, skipped: 0, error: err.message };
    }

    return ingestBatch(texts, {
        source: 'github',
        url: `https://github.com/${owner}/${repo}`,
        topic: `${owner}/${repo}`,
        region: opts.region || 'memory',
        ...opts,
    });
}

// ── Structured item intake (RSS-style) ─────────────────────────────────────────
/**
 * ingestItems(items, options)
 * For pre-structured data (RSS feeds, API responses, curated lists).
 *
 * @param {object[]} items — array of { title, body, url, topic }
 * @param {object}  options — same as ingest() options
 *
 * @returns {{ stored: number, skipped: number, results: object[] }}
 */
function ingestItems(items, options) {
    if (!Array.isArray(items)) return { stored: 0, skipped: 0, results: [] };

    const texts = items.map(item => {
        const parts = [];
        if (item.title) parts.push(item.title);
        if (item.body)  parts.push(item.body);
        if (item.summary) parts.push(item.summary);
        return parts.join('. ');
    }).filter(t => t.length >= CONFIG.minTextLength);

    return ingestBatch(texts, {
        source: 'rss',
        ...options,
    });
}

// ── Diagnostics ────────────────────────────────────────────────────────────────
/**
 * getIntakeLog() — Returns the intake log for diagnostic review.
 * getStats() — Returns summary statistics about external intake cells.
 */
function getIntakeLog() {
    return [..._intakeLog];
}

function getStats() {
    const cells = universe.getCells();
    const external = cells.filter(c => c.meta &&
        ['external-intake', 'web-search', 'github', 'rss', 'manual'].includes(c.meta.source)
    );

    const bySource = {};
    for (const cell of external) {
        const src = cell.meta.source || 'unknown';
        bySource[src] = (bySource[src] || 0) + 1;
    }

    const strengths = external.map(c => c.strength);
    const meanStr = strengths.length
        ? strengths.reduce((a, b) => a + b, 0) / strengths.length
        : 0;

    return {
        totalExternal: external.length,
        totalField: cells.length,
        externalRatio: cells.length > 0 ? clamp01(external.length / cells.length) : 0,
        bySource,
        meanStrength: meanStr,
        logEntries: _intakeLog.length,
    };
}

function clearLog() {
    _intakeLog.length = 0;
}

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
    CONFIG,
    extractFacts,
    isRedundant,
    ingest,
    ingestBatch,
    ingestFromWeb,
    ingestFromGitHub,
    ingestItems,
    getIntakeLog,
    getStats,
    clearLog,
};
