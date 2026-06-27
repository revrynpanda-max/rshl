import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runListenerCapturePipeline } from './voice-listener-pipeline.mjs';
import { buildProbePcm, shouldSkipCapturePcm } from './voice-path-policy.mjs';

test('runListenerCapturePipeline: capturePcm called exactly once', async () => {
  let captureCalls = 0;
  const pcm = buildProbePcm();
  const logs = [];
  const result = await runListenerCapturePipeline({
    userId: 'uid-1',
    speakerName: 'Ryan',
    pathLabel: 'probe-inject',
    capturePcm: async () => { captureCalls++; return pcm; },
    transcribe: async () => 'Leo voice path probe',
    deliver: async () => {},
    log: { info: (m) => logs.push(m) },
  });
  assert.equal(captureCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.skipCapture, true);
  assert.ok(logs.some((l) => l.includes('path=probe-inject')));
  assert.ok(logs.some((l) => l.includes('Voice stream ended')));
});

test('runListenerCapturePipeline: deliver receives pcm+transcript+fromListener', async () => {
  const pcm = buildProbePcm();
  let delivered = null;
  await runListenerCapturePipeline({
    userId: 'uid-2',
    speakerName: 'Probe',
    pathLabel: 'fallback',
    capturePcm: async () => pcm,
    transcribe: async () => 'hello leo',
    deliver: async (userId, gotPcm, transcript, meta) => {
      delivered = { userId, gotPcm, transcript, meta };
    },
  });
  assert.ok(delivered);
  assert.equal(delivered.userId, 'uid-2');
  assert.equal(delivered.gotPcm, pcm);
  assert.equal(delivered.transcript, 'hello leo');
  assert.equal(delivered.meta.fromListener, true);
  assert.equal(delivered.meta.speakerName, 'Probe');
  assert.equal(shouldSkipCapturePcm({ pcm: delivered.gotPcm }), true);
});

test('runListenerCapturePipeline: short transcript does not deliver', async () => {
  let deliverCalls = 0;
  const result = await runListenerCapturePipeline({
    userId: 'uid-3',
    speakerName: 'Ryan',
    capturePcm: async () => buildProbePcm(),
    transcribe: async () => 'no',
    deliver: async () => { deliverCalls++; },
  });
  assert.equal(result.ok, false);
  assert.equal(deliverCalls, 0);
});