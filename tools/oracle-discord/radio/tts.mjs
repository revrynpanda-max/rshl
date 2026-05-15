/**
 * tts.mjs — Standalone TTS for the Radio DJ
 *
 * Synthesizes speech via ElevenLabs (same voice/key as leo.mjs) and plays it
 * through the provided AudioPlayer (djState.audioPlayer). Keeps TTS and music
 * on the SAME player so they never conflict with Leo's main voice pipeline.
 */

import { spawn }     from 'child_process';
import { Readable }  from 'stream';
import ffmpegPath    from 'ffmpeg-static';
import {
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';

// Match leo.mjs exactly — primary key is ELEVENLABS_API_KEY
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_KEY;
const LEO_VOICE_ID    = 'PPzYpIqttlTYA83688JI'; // Groq Radio DJ voice ID

if (!ELEVEN_LABS_KEY) {
  console.warn('[Radio/TTS] WARNING: No ElevenLabs API key found in environment (ELEVENLABS_API_KEY). Groq will be silent.');
}

/**
 * Synthesize `text` via ElevenLabs and play it through `player`.
 * Awaits full completion before resolving so callers can sequence
 * TTS → music cleanly.
 *
 * @param {string}      text
 * @param {AudioPlayer} player  — djState.audioPlayer
 */
/**
 * Synthesize `text` via ElevenLabs and return the raw PCM buffer + duration.
 * This is used for mixing the DJ banter OVER the music.
 */
export async function getBanterAudio(text) {
  if (!text?.trim() || !ELEVEN_LABS_KEY) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${LEO_VOICE_ID}/stream` +
      `?optimize_streaming_latency=3&output_format=mp3_44100_128`,
      {
        method:  'POST',
        headers: { 'xi-api-key': ELEVEN_LABS_KEY, 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.55, similarity_boost: 0.85 },
        }),
      }
    );
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => 'No body');
      console.error(`[Radio/TTS] ElevenLabs Error (${res.status}): ${errText}`);
      return null;
    }

    // Convert to PCM 48kHz Stereo for internal mixing
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', // Match music LUFS exactly
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ]);

    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(ffmpeg.stdin);

    ffmpeg.stdin.on('error', () => {}); // swallow EPIPE
    ffmpeg.stderr.on('data', () => {}); // ignore noise

    const chunks = [];
    for await (const chunk of ffmpeg.stdout) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    // 48000Hz * 2 channels * 2 bytes per sample = 192000 bytes per second
    const duration = buffer.length / 192000;

    return { buffer, duration };
  } catch (e) {
    console.error('[Radio/TTS] Banter buffer failed:', e.message);
    return null;
  }
}

export async function djTTS(text, player) {
  if (!text?.trim() || !player) return;

  try {
    if (!ELEVEN_LABS_KEY) {
      console.warn('[Radio/TTS] No ElevenLabs key (ELEVENLABS_API_KEY) — skipping voice.');
      return;
    }

    console.log(`[Radio/TTS] Synthesizing: "${text.slice(0, 50)}..."`);

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${LEO_VOICE_ID}/stream` +
      `?optimize_streaming_latency=3&output_format=mp3_44100_128`,
      {
        method:  'POST',
        headers: { 'xi-api-key': ELEVEN_LABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability:         0.40,
            similarity_boost:  0.80,
            style:             0.40,
            use_speaker_boost: false,
          },
        }),
      }
    );

    if (!res.ok) {
      console.error(`[Radio/TTS] ElevenLabs ${res.status}: ${res.statusText}`);
      return;
    }

    // FFmpeg will auto-detect mp3 and convert to stereo raw PCM for Discord
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-af', 'volume=1.0',
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ]);

    ffmpeg.stdin.on('error', () => {}); // swallow EPIPE
    ffmpeg.stderr.on('data', d => {
      const msg = d.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('[Radio/TTS/FFmpeg]', msg.trim());
      }
    });

    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(1.0);

    ffmpeg.on('error', (err) => console.error('[Radio/TTS/FFmpeg] Crash:', err.message));
    ffmpeg.stdout.on('error', () => {}); // Prevent unhandled stream error
    
    player.play(resource);

    await entersState(player, AudioPlayerStatus.Playing, 6_000);
    await entersState(player, AudioPlayerStatus.Idle,    90_000);

    console.log('[Radio/TTS] Speech complete.');

  } catch (e) {
    // "aborted" and "Timeout" are expected when stopDJ() fires mid-speech
    if (e?.message && !e.message.includes('aborted') && !e.message.includes('Timeout')) {
      console.error('[Radio/TTS] Error:', e.message);
    }
  }
}
