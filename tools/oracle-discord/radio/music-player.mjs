/**
 * music-player.mjs — Audio streaming engine for Leo's AI Radio
 * Uses yt-dlp to find songs by title and streams audio via FFmpeg into Discord voice.
 *
 * NOTE: No --extractor-args are set. yt-dlp's default client selection works
 * reliably without PO tokens. Specific clients (android/ios/mweb) all require
 * GVS PO Tokens for HTTPS formats and fall back to images-only, killing the stream.
 */

import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  createAudioResource,
  createAudioPlayer,
  AudioPlayerStatus,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';

// ── Duration fetch (separate yt-dlp call, no download) ────────────────────────
export async function getSongDuration(title, artist) {
  return new Promise((resolve) => {
    const query = `${title} ${artist} audio`.trim();
    const proc = spawn('yt-dlp', [
      '--print', 'duration',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch1',
      query
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {}); // suppress warnings
    proc.on('close', () => {
      const secs = parseInt(output.trim(), 10);
      resolve(isNaN(secs) ? 210 : secs);
    });
    proc.on('error', () => resolve(210));
  });
}

// ── Real title/artist + duration lookup ───────────────────────────────────────
export async function resolveSongMeta(query) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [
      '--print', '%(title)s|||%(duration)s',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch1',
      `${query} audio`
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {}); // suppress warnings
    proc.on('close', () => {
      const line = output.trim().split('\n')[0] || '';
      const [title, dur] = line.split('|||');
      
      // Basic validation: does the title actually share a word with the query?
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const titleLower = (title || '').toLowerCase();
      const isMatch = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w));

      if (!isMatch && queryWords.length > 0) {
        console.warn(`[Radio/Meta] Query mismatch: "${query}" returned "${title}". Rejecting.`);
        resolve(null);
      } else {
        resolve({
          title:    title?.trim() || query,
          duration: parseInt(dur, 10) || 210
        });
      }
    });
    proc.on('error', () => resolve({ title: query, duration: 210 }));
  });
}

// ── Top choices search (returns 5 results) ────────────────────────────────────
export async function searchTopChoices(query) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', [
      '--print', '%(title)s|||%(uploader)s',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch5',
      `${query} song audio`
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const results = output.trim().split('\n').map(line => {
        const [title, artist] = line.split('|||');
        return {
          title: title?.trim(),
          artist: artist?.trim()
        };
      }).filter(r => r.title);
      resolve(results.slice(0, 5));
    });
    proc.on('error', () => resolve([]));
  });
}

// ── Create audio player (shared across songs) ─────────────────────────────────
export function createRadioPlayer() {
  return createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });
}

export function streamSong(query) {
  // Anti-Hallucination Query: Exclude compilations/mashups/live to avoid hearing irrelevant audio
  // Prioritize "Lyrics" versions for clean studio audio
  const searchQuery = (query.toLowerCase().includes('audio') ? query : `${query} lyrics audio`) 
    + ' -live -concert -compilation -mashup -"top 10" -"top 50" -"top 100"';
  
  const ytProc = spawn('yt-dlp', [
    '--format', 'bestaudio/best',
    '--output', '-',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--default-search', 'ytsearch1',
    searchQuery
  ], { windowsHide: true });

  ytProc.stdin?.on('error', () => {}); // swallow EPIPE

  // Pipe yt-dlp through ffmpeg to decode into 48kHz 16-bit stereo PCM.
  // This prevents the discordjs/voice demuxer from choking and causing scratchy audio.
  const ffmpegProc = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { windowsHide: true });

  ytProc.stdout.pipe(ffmpegProc.stdin);
  ytProc.stdout.on('error', () => {});
  ffmpegProc.stdin.on('error', () => {});

  const resource = createAudioResource(ffmpegProc.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });

  resource.volume.setVolume(1.0);

  // Return ffmpegProc as the main process to handle errors/kills, but keep ytProc referenced
  return { resource, ytdlpProc: ffmpegProc, originalYt: ytProc };
}

// ── Volume helpers ────────────────────────────────────────────────────────────
export function dimVolume(resource, level = 0.18) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}

export function restoreVolume(resource, level = 1.0) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}
