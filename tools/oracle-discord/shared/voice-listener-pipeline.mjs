/**
 * Single listener capture sequence — capture once, transcribe, deliver pre-captured pcm.
 * Live fallback and VOICE_PATH_PROBE both call this with injected I/O.
 */

import { shouldSkipCapturePcm } from './voice-path-policy.mjs';

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.speakerName
 * @param {string} [opts.pathLabel='fallback']
 * @param {() => Promise<Buffer>} opts.capturePcm
 * @param {(pcm: Buffer) => Promise<string|null|undefined>} opts.transcribe
 * @param {(userId: string, pcm: Buffer, transcript: string, meta: object) => Promise<void>} opts.deliver
 * @param {(userId: string, speakerName: string) => void} [opts.onBeforeDeliver]
 * @param {(speakerName: string) => void} [opts.onTranscriptRejected]
 * @param {(userId: string, err: Error) => void} [opts.onCaptureFailed]
 * @param {{ info?: Function, error?: Function }} [opts.log]
 */
export async function runListenerCapturePipeline(opts) {
  const {
    userId,
    speakerName,
    pathLabel = 'fallback',
    capturePcm,
    transcribe,
    deliver,
    onBeforeDeliver,
    onTranscriptRejected,
    onCaptureFailed,
    log = console,
  } = opts;

  const info = (msg) => { try { log.info?.(msg); } catch { /* noop */ } };
  const error = (msg) => { try { log.error?.(msg); } catch { /* noop */ } };

  info(`[Leo/Voice] Speaking listener start uid=${userId} speaker=${speakerName} path=${pathLabel}`);
  try {
    const pcm = await capturePcm();
    info('[Leo/Audio] Voice stream ended. Processing...');
    const raw = await transcribe(pcm);
    const transcript = typeof raw === 'string' ? raw.trim() : '';
    if (!transcript || transcript.length < 3) {
      onTranscriptRejected?.(speakerName);
      return { ok: false, reason: 'transcript_too_short' };
    }
    onBeforeDeliver?.(userId, speakerName, transcript);
    await deliver(userId, pcm, transcript, { speakerName, fromListener: true });
    return { ok: true, pcm, transcript, skipCapture: shouldSkipCapturePcm({ pcm }) };
  } catch (e) {
    onCaptureFailed?.(userId, e);
    error(`[Leo/Audio] capturePcm failed for ${userId}: ${e?.message || e}`);
    return { ok: false, reason: e?.message || String(e) };
  }
}