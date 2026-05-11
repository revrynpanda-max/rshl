/**
 * tts.mjs — Standalone TTS for the Radio DJ
 *
 * Synthesizes speech via ElevenLabs and plays it through the
 * provided AudioPlayer (djState.audioPlayer).  This keeps TTS
 * and music on the SAME player so they never conflict with each
 * other or with Leo's main voice pipeline.
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

const ELEVEN_LABS_KEY = process.env.ELEVEN_LABS_KEY || process.env.ELEVENLABS_API_KEY;
const LEO_VOICE_ID    = process.env.ELEVENLABS_LEO_VOICE_ID || 'av1BMOR1GPgThz9p4fLo';

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
      console.warn('[Radio/TTS] No ElevenLabs key — skipping voice.');
      return;
    }

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${LEO_VOICE_ID}/stream` +
      `?optimize_streaming_latency=4&output_format=pcm_48000`,
      {
        method:  'POST',
        headers: { 'xi-api-key': ELEVEN_LABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability:        0.22,
            similarity_boost: 0.80,
            style:            0.65,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!res.ok) {
      console.error(`[Radio/TTS] ElevenLabs ${res.status}: ${res.statusText}`);
      return;
    }

    // PCM 48kHz mono → stereo for Discord
    const ffmpeg = spawn(ffmpegPath, [
      '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
      '-af', 'volume=2.0,aresample=48000',
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ]);

    // Swallow broken-pipe errors silently
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs

    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    player.play(resource);

    await entersState(player, AudioPlayerStatus.Playing, 6_000);
    await entersState(player, AudioPlayerStatus.Idle,    90_000);

  } catch (e) {
    // "aborted" is expected when stopDJ() fires mid-speech — ignore silently
    if (e?.message && !e.message.includes('aborted') && !e.message.includes('Timeout')) {
      console.error('[Radio/TTS] Unexpected error:', e.message);
    }
  }
}
