/**
 * Pure voice-path predicates — listener single-capture + reuse policy, probe PCM.
 */

/** True when handleUserVoice must NOT open a second receiver.subscribe. */
export function shouldSkipCapturePcm(preCaptured) {
  return !!(
    preCaptured &&
    preCaptured.pcm &&
    Buffer.isBuffer(preCaptured.pcm) &&
    preCaptured.pcm.length > 0
  );
}

/** Listener path: capture once, deliver pre-captured pcm+transcript to handleUserVoice. */
export function listenerDeliversPreCaptured(preCaptured) {
  return shouldSkipCapturePcm(preCaptured) && !!preCaptured?.fromListener;
}

/** Trailing silence before manual-VAD activityEnd (must exceed brief mid-word pauses). */
export function activityEndSilenceMs() {
  const raw = Number(process.env.LEO_ACTIVITY_END_MS);
  if (raw > 0) return raw;
  const eos = Number(process.env.LEO_END_OF_SPEECH_MS) || Number(process.env.LEO_SILENCE_FINALIZE_MS);
  if (eos > 0) return Math.min(eos, 1200);
  return 900;
}

/** Delay before GATE CLEAR after Discord stream end — lets Gemini input transcript land. */
export function gateClearGraceMs() {
  const raw = Number(process.env.LEO_GATE_CLEAR_GRACE_MS);
  return raw > 0 ? raw : 2200;
}

/**
 * Suppress early weak barge-ins (tail of prior utterance echoing while Leo starts replying).
 * Returns true when the interrupt should be HONORED (cut Leo).
 */
export function shouldHonorLiveBargeIn({
  lastRealAfterStart,
  sinceStartMs,
  framesSinceLeoStart = 0,
  peakRmsSinceLeoStart = 0,
}) {
  if (!lastRealAfterStart) return false;
  const minFrames = Number(process.env.LEO_BARGE_MIN_FRAMES) > 0
    ? Number(process.env.LEO_BARGE_MIN_FRAMES) : 12;
  const strongRms = Number(process.env.LEO_BARGE_STRONG_RMS) > 0
    ? Number(process.env.LEO_BARGE_STRONG_RMS) : 3500;
  const earlyWindowMs = Number(process.env.LEO_BARGE_EARLY_MS) > 0
    ? Number(process.env.LEO_BARGE_EARLY_MS) : 3500;
  if (sinceStartMs >= 0 && sinceStartMs < earlyWindowMs) {
    if (framesSinceLeoStart < minFrames && peakRmsSinceLeoStart < strongRms) return false;
  }
  return true;
}

/** Synthetic PCM that passes Leo noise-gate duration + RMS thresholds in probes. */
export function buildProbePcm(sampleRate = 48000, channels = 2, durationSec = 0.7) {
  const bytesPerSample = 2;
  const frameCount = Math.floor(sampleRate * durationSec);
  const buf = Buffer.alloc(frameCount * channels * bytesPerSample);
  const amplitude = 8000;
  for (let i = 0; i < frameCount; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    for (let ch = 0; ch < channels; ch++) {
      buf.writeInt16LE(sample, (i * channels + ch) * bytesPerSample);
    }
  }
  return buf;
}