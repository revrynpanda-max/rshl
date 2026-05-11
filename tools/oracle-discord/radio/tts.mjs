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
const LEO_VOICE_ID    = 'av1BMOR1GPgThz9p4fLo'; // Same hardcoded voice as leo.mjs

/**
 * Synthesize `text` via ElevenLabs and play it through `player`.
 * Awaits full completion before resolving so callers can sequence
 * TTS → music cleanly.
 *
 * @param {string}      text
 * @param {AudioPlayer} player  — djState.audioPlayer
 */
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
      `?optimize_streaming_latency=3&output_format=pcm_48000`,
      {
        method:  'POST',
        headers: { 'xi-api-key': ELEVEN_LABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability:         0.22,
            similarity_boost:  0.80,
            style:             0.65,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!res.ok) {
      console.error(`[Radio/TTS] ElevenLabs ${res.status}: ${res.statusText}`);
      return;
    }

    // ElevenLabs PCM 48kHz mono → stereo for Discord
    const ffmpeg = spawn(ffmpegPath, [
      '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
      '-af', 'volume=0.8',
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

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
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
