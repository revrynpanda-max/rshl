/**
 * music-player.mjs — Audio streaming engine for Leo's AI Radio
 * Uses yt-dlp to find songs by title and streams audio via FFmpeg into Discord voice.
 *
 * NOTE: No --extractor-args are set. yt-dlp's default client selection works
 * reliably without PO tokens. Specific clients (android/ios/mweb) all require
 * GVS PO Tokens for HTTPS formats and fall back to images-only, killing the stream.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, mkdirSync, createReadStream, createWriteStream } from 'fs';
import ffmpegPath from 'ffmpeg-static';
import {
  createAudioResource,
  createAudioPlayer,
  AudioPlayerStatus,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { Readable, pipeline, PassThrough } from 'stream';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const CACHE_DIR = join(__dirname, '..', 'state', 'radio_cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ── Duration fetch (separate yt-dlp call, no download) ────────────────────────
export async function getSongDuration(title, artist) {
  return new Promise((resolve) => {
    const query = `${title} ${artist} audio`.trim();
    const proc = spawn('yt-dlp', [
      '--print', 'duration',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch1',
      '--socket-timeout', '10',
      '--geo-bypass',
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
    const isLongRequested = /10 hours|12 hours|sleep|rain|nature|ambient|long|meditation/i.test(query);
    const proc = spawn('yt-dlp', [
      '--print', '%(title)s|||%(duration)s|||%(uploader)s|||%(id)s',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch1',
      '--socket-timeout', '10',
      '--geo-bypass',
      `${query} lyrics audio`
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {}); // suppress warnings
    proc.on('close', () => {
      const line = output.trim().split('\n')[0] || '';
      const [title, dur, uploader, id] = line.split('|||');
      
      const duration = parseInt(dur, 10) || 0;
      const uploaderLower = (uploader || '').toLowerCase();
      const titleLower = (title || '').toLowerCase();
      
      // QUALITY GUARD: Relaxed to allow independent creators, but still avoid junk
      const isOfficial = uploaderLower.includes('topic') || uploaderLower.includes('vevo') || uploaderLower.includes('records') || uploaderLower.includes('official');
      
      // DURATION GUARD: Allow long tracks if specifically requested, otherwise limit to 15m
      const maxDur = isLongRequested ? 43200 : 900; 
      const isReasonableLength = duration >= 30 && duration <= maxDur; 
      
      // PODCAST GUARD: Explicitly reject if title or uploader suggests podcast/episode
      const isPodcast = (titleLower.includes('podcast') || titleLower.includes('episode') || uploaderLower.includes('podcast')) && !isLongRequested;
      
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const hasKeywords = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w));

      if (!hasKeywords || !isReasonableLength || isPodcast) {
        let reason = "";
        if (!hasKeywords) reason = "Keyword mismatch";
        else if (!isReasonableLength) reason = `Duration out of bounds (${duration}s)`;
        else if (isPodcast) reason = "Podcast detected";
        
        console.warn(`[Radio/Meta] Rejected: "${title}" by "${uploader}" (${duration}s). Reason: ${reason}`);
        resolve(null);
      } else {
        resolve({
          title:    title?.trim() || query,
          duration: duration || 210,
          uploader: uploader?.trim(),
          id:       id?.trim(),
          isOfficial
        });
      }
    });
    proc.on('error', () => resolve({ title: query, duration: 210 }));
  });
}

// ── Top choices search (returns 5 results) ────────────────────────────────────
export async function searchTopChoices(query) {
  return new Promise((resolve) => {
    const isLongRequested = /10 hours|12 hours|sleep|rain|nature|ambient|long|meditation/i.test(query);
    const proc = spawn('yt-dlp', [
      '--print', '%(title)s|||%(uploader)s|||%(duration)s',
      '--no-download',
      '--no-playlist',
      '--default-search', 'ytsearch5',
      '--socket-timeout', '10',
      '--geo-bypass',
      `${query} lyrics audio`
    ], { windowsHide: true });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const results = output.trim().split('\n').map(line => {
        const [title, artist, durationStr] = line.split('|||');
        const duration = parseInt(durationStr, 10) || 0;
        return {
          title: title?.trim(),
          artist: artist?.trim(),
          duration
        };
      }).filter(r => {
        const maxDur = isLongRequested ? 43200 : 900;
        return r.title && r.duration >= 30 && r.duration <= maxDur;
      });
      
      resolve(results.slice(0, 5));
    });
    proc.on('error', () => resolve([]));
  });
}

// ── Create audio player (shared across songs) ─────────────────────────────────
export function createRadioPlayer() {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });
  player.on('error', error => {
    console.error(`[AudioPlayer] Stream Error (${error.resource.metadata?.title || 'Unknown'}):`, error.message);
    // Resource cleanup is handled by @discordjs/voice, but we log for the Ecosystem Manager
  });
  return player;
}

export function streamSong(query, banter = null, urlOrId = null) {
  // Use a hash of the query for caching
  const cacheKey = query.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 100);
  const cachePath = join(CACHE_DIR, `${cacheKey}.opus.webm`);

  // Prioritize high-fidelity studio versions (VEVO and Topic are best)
  // Aggressively filtering out podcasts, interviews, vlogs, and long videos (>15 mins)
  // Prioritize high-fidelity versions but don't be TOO restrictive (e.g. allow radio edits)
  // Tightened filters to ensure STUDIO quality and NO PODCASTS
  const isLongRequested = /\d+\s*hour|sleep|rain|nature|ambient|meditation|white noise|asmr|lofi|study|focus|fireplace|ocean|waves|thunder/i.test(query);
  // For AMBIENT/LONG content (rain, sleep, nature, "10 hours"...), search the query
  // EXACTLY as asked — appending "official lyrics audio" sent yt-dlp hunting for a SONG
  // and missed the actual 10-hour rain video (a big "plays the wrong thing" cause). Only
  // real music tracks get the studio-quality suffix + the podcast/live exclusions.
  const searchQuery = urlOrId || (isLongRequested
    ? `${query} -podcast -interview -episode -news -talk -reaction`
    : `${query} official lyrics audio -live -concert -podcast -vlog -interview -episode -news -talk -review -reaction -compilation -mashup -"top 10" -"top 50" -"top 100"`);
  
  if (existsSync(cachePath) && !banter && !urlOrId) {
    console.log(`[Radio/Player] Cache Hit: ${query}`);
    const resource = createAudioResource(createReadStream(cachePath), {
        inputType: StreamType.WebmOpus,
        inlineVolume: true,
    });
    return { resource, ytdlpProc: null, ffmpegProc: null, kill: () => {} };
  }

  const ytArgs = [
    '--format', 'bestaudio/best',
    '--output', '-',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--buffer-size', '16M',
    '--socket-timeout', '10',
    '--geo-bypass',
  ];

  if (urlOrId) {
    ytArgs.push(urlOrId);
  } else {
    ytArgs.push('--default-search', 'ytsearch1');
    const maxDur = isLongRequested ? 43200 : 900;
    ytArgs.push('--match-filter', `duration < ${maxDur} & !is_live`); 
    ytArgs.push(searchQuery);
  }

  const ytProc = spawn('yt-dlp', ytArgs, { windowsHide: true });
  
  console.log(`[Leo's AI Radio] Starting ${banter ? 'Mixed' : 'Pure'} ${urlOrId ? 'Direct' : 'Search'} stream for: ${query}`);

  const ffmpegArgs = [
    '-i', 'pipe:0', // Input 0: Music from yt-dlp
  ];

  let filter = 'aresample=async=1, loudnorm=I=-16:TP=-1.5:LRA=11';

  if (banter && banter.buffer) {
    ffmpegArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3'); // Input 1: DJ Banter
    
    // RADIO-STYLE DUCKING (rewritten): a real radio doesn't go SILENT under the
    // DJ — it keeps a LOW MUSIC BED playing while he talks, then swells back up to
    // full when he's done. So:
    //   1. Music plays at a low bed (~18%) while the DJ talks over it
    //   2. ~0.6s before the DJ finishes it swells to ~55% (the "here comes the song")
    //   3. Then fades up to full as the DJ stops, so the track hits clean.
    // Tune the bed/swell with LEO_RADIO_DUCK / LEO_RADIO_SWELL.
    const d = banter.duration.toFixed(2);
    const kickIn = Math.max(0, banter.duration - 0.6).toFixed(2);
    const bed   = (Number(process.env.LEO_RADIO_DUCK)  > 0 ? Number(process.env.LEO_RADIO_DUCK)  : 0.18).toFixed(2);
    const swell = (Number(process.env.LEO_RADIO_SWELL) > 0 ? Number(process.env.LEO_RADIO_SWELL) : 0.55).toFixed(2);

    filter = `[0:a]aresample=async=1, volume=${bed}:enable='between(t,0,${kickIn})', volume=${swell}:enable='between(t,${kickIn},${d})'[d0]; ` +
             `[d0]afade=t=in:st=${d}:d=0.3[f0]; ` +
             `[1:a]aresample=async=1[b1]; ` +
             `[f0][b1]amix=inputs=2:duration=first:dropout_transition=0:weights='1 1', ` +
             `loudnorm=I=-16:TP=-1.5:LRA=11`;
  }

  const ffmpegProc = spawn(ffmpegPath, [
    ...ffmpegArgs,
    '-filter_complex', filter,
    '-c:a', 'libopus',
    '-application', 'audio',
    '-b:a', '192k', // Ultimate Fidelity
    '-vbr', 'on',
    '-ar', '48000',
    '-f', 'webm',
    '-dash', '1',
    'pipe:1'
  ], { 
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'] // Add pipe:3 for banter
  });

  if (banter && banter.buffer) {
    const banterStream = Readable.from(banter.buffer);
    pipeline(banterStream, ffmpegProc.stdio[3], (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('[Radio/Pipeline] Banter Pipe Error:', err.message);
        }
    });
  }

  pipeline(ytProc.stdout, ffmpegProc.stdin, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('[Radio/Pipeline] Music Pipe Error:', err.message);
    }
  });
  ytProc.on('error', (err) => console.warn(`[Radio/Player] yt-dlp error:`, err.message));
  ffmpegProc.on('error', (err) => console.warn(`[Radio/Player] ffmpeg error:`, err.message));

  const pass = new PassThrough();
  ffmpegProc.stdout.pipe(pass);

  const kill = () => {
    try { 
        ytProc.stdout.unpipe();
        ytProc.kill('SIGKILL'); // Force kill on Windows
    } catch (e) {}
    try { 
        ffmpegProc.stdin.unpipe();
        ffmpegProc.kill('SIGKILL'); 
    } catch (e) {}
  };

  // WATCHDOG: If no audio data flows within 45s, kill and retry
  const watchdog = setTimeout(() => {
    console.warn(`[Radio/Player] Stream watchdog triggered for: ${query}. No data for 45s.`);
    ytProc.emit('error', new Error('STREAM_TIMEOUT'));
    kill();
  }, 45000);

  ffmpegProc.stdout.once('data', () => {
    clearTimeout(watchdog);
    console.log(`[Radio/Player] Stream flow started for: ${query}`);
  });

  // CACHING: If not mixed with banter, save the output to cache
  if (!banter) {
    const cacheFile = createWriteStream(cachePath);
    pass.pipe(cacheFile); // Use PassThrough for non-blocking cache
    // Cleanup old cache files (keep last 20)
    import('fs').then(({ readdirSync, unlinkSync, statSync }) => {
        try {
            const files = readdirSync(CACHE_DIR).map(f => ({ name: f, time: statSync(join(CACHE_DIR, f)).mtimeMs }));
            if (files.length > 20) {
                files.sort((a, b) => a.time - b.time);
                unlinkSync(join(CACHE_DIR, files[0].name));
            }
        } catch (e) {}
    }).catch(e => console.error("[Radio/Cache] Cleanup error:", e.message));
  }

  const resource = createAudioResource(pass, {
    inputType: StreamType.WebmOpus,
    inlineVolume: true,
  });

  resource.volume.setVolume(1.0);

  return { resource, ytdlpProc: ytProc, ffmpegProc, kill };
}

// ── Volume helpers ────────────────────────────────────────────────────────────
export function dimVolume(resource, level = 0.18) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}

export function restoreVolume(resource, level = 1.0) {
  try { resource?.volume?.setVolume(level); } catch (_) {}
}
