/**
 * music-player.mjs — Audio streaming engine for Leo's AI Radio
 * Uses yt-dlp to find songs by title and streams audio via FFmpeg into Discord voice.
 *
 * NOTE: No --extractor-args are set. yt-dlp's default client selection works
 * reliably without PO tokens. Specific clients (android/ios/mweb) all require
 * GVS PO Tokens for HTTPS formats and fall back to images-only, killing the stream.
 */

import { spawn } from 'child_process';
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
    const query = `${title} ${artist}`.trim();
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
      query
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {}); // suppress warnings
    proc.on('close', () => {
      const line = output.trim().split('\n')[0] || '';
      const [title, dur] = line.split('|||');
      resolve({
        title:    title?.trim() || query,
        duration: parseInt(dur, 10) || 210
      });
    });
    proc.on('error', () => resolve({ title: query, duration: 210 }));
  });
}

// ── Create audio player (shared across songs) ─────────────────────────────────
export function createRadioPlayer() {
  return createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });
}

// ── Stream a song and return { resource, ytdlpProc } ─────────────────────────
export function streamSong(query) {
  const ytProc = spawn('yt-dlp', [
    '--format', 'bestaudio/best',
    '--output', '-',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--default-search', 'ytsearch1',
    query
  ], { windowsHide: true });

  ytProc.stdin?.on('error', () => {}); // swallow EPIPE

  const resource = createAudioResource(ytProc.stdout, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });

  resource.volume.setVolume(1.0);

  return { resource, ytdlpProc: ytProc };
}

// ── Volume helpers ────────────────────────────────────────────────────────────
export function dimVolume(resource, level = 0.18) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}

export function restoreVolume(resource, level = 1.0) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}
