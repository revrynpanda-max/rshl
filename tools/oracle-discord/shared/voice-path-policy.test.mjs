import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipCapturePcm,
  listenerDeliversPreCaptured,
  buildProbePcm,
  activityEndSilenceMs,
  gateClearGraceMs,
  shouldHonorLiveBargeIn,
} from './voice-path-policy.mjs';

test('shouldSkipCapturePcm: true for non-empty Buffer', () => {
  assert.equal(shouldSkipCapturePcm({ pcm: buildProbePcm() }), true);
});

test('shouldSkipCapturePcm: false for empty/missing pcm', () => {
  assert.equal(shouldSkipCapturePcm(null), false);
  assert.equal(shouldSkipCapturePcm({ pcm: Buffer.alloc(0) }), false);
});

test('listenerDeliversPreCaptured requires fromListener flag', () => {
  const pcm = buildProbePcm();
  assert.equal(listenerDeliversPreCaptured({ pcm, fromListener: true }), true);
  assert.equal(listenerDeliversPreCaptured({ pcm }), false);
});

test('buildProbePcm passes Leo MIN_DURATION_BYTES (~115200)', () => {
  assert.ok(buildProbePcm().length >= 48000 * 2 * 2 * 0.6);
});

test('activityEndSilenceMs defaults above brief mid-word pauses', () => {
  delete process.env.LEO_ACTIVITY_END_MS;
  delete process.env.LEO_END_OF_SPEECH_MS;
  assert.ok(activityEndSilenceMs() >= 800);
});

test('gateClearGraceMs defaults >= 2000 for transcript landing', () => {
  delete process.env.LEO_GATE_CLEAR_GRACE_MS;
  assert.ok(gateClearGraceMs() >= 2000);
});

test('shouldHonorLiveBargeIn: rejects early weak tail', () => {
  assert.equal(shouldHonorLiveBargeIn({
    lastRealAfterStart: true,
    sinceStartMs: 500,
    framesSinceLeoStart: 3,
    peakRmsSinceLeoStart: 900,
  }), false);
});

test('shouldHonorLiveBargeIn: honors sustained strong barge-in', () => {
  assert.equal(shouldHonorLiveBargeIn({
    lastRealAfterStart: true,
    sinceStartMs: 500,
    framesSinceLeoStart: 20,
    peakRmsSinceLeoStart: 8000,
  }), true);
});