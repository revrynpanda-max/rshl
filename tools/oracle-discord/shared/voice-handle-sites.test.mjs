import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const leoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bots', 'leo.mjs');
const src = fs.readFileSync(leoPath, 'utf8');

test('leo.mjs: exactly one handleUserVoice invocation inside deliverListenerCapturedVoice', () => {
  const deliverStart = src.indexOf('async function deliverListenerCapturedVoice');
  const handleStart = src.indexOf('async function handleUserVoice');
  assert.ok(deliverStart >= 0 && handleStart > deliverStart);
  const deliverBody = src.slice(deliverStart, handleStart);
  const invocations = (deliverBody.match(/await handleUserVoice\s*\(/g) || []).length;
  assert.equal(invocations, 1, `expected 1 await handleUserVoice in deliverListenerCapturedVoice, found ${invocations}`);
});

test('leo.mjs: no runSpeakingListenerProbeChain', () => {
  assert.doesNotMatch(src, /runSpeakingListenerProbeChain/);
});

test('leo.mjs: no legacy probe-only early-return ack branch', () => {
  assert.doesNotMatch(src, /Voice path probe acknowledged/);
});

test('leo.mjs: probe TTS after listener chain (not before noise gates)', () => {
  const probeTts = src.indexOf('Voice path structural check');
  const noiseGate = src.indexOf('NOISE GATE LAYER 1');
  assert.ok(probeTts > noiseGate, 'probe TTS must come after noise gates in handleUserVoice');
});

test('leo.mjs: handleUserVoice must not await capturePcm inside', () => {
  const fnStart = src.indexOf('async function handleUserVoice');
  assert.ok(fnStart >= 0);
  const fnBody = src.slice(fnStart, fnStart + 12000);
  assert.doesNotMatch(fnBody, /await capturePcm\s*\(/);
});

test('leo.mjs: mute guard blocks mic pipeline when Discord muted', () => {
  assert.match(src, /function isUserVoiceMuted/);
  assert.match(src, /Ignoring speaking\.start.*muted\/deafened/);
  assert.match(src, /if \(isUserVoiceMuted\(uid\)\) return;/);
});

test('leo.mjs: VOICE_PATH_PROBE bypasses transcript dedupe for repeat harness runs', () => {
  assert.match(src, /if \(!isVoicePathProbe && recentVoiceResponses\.has\(fuzzyHash\)\)/);
});

test('leo.mjs: activityEnd driven by gate hangover not per-frame 400ms', () => {
  assert.match(src, /activityEndSilenceMs/);
  assert.doesNotMatch(src, /signalActivityEnd\(\); \} catch \(_\) \{\}\s*\n\s*\}, 400\)/);
  assert.match(src, /Deferring GATE CLEAR/);
});

test('leo.mjs: early-weak barge-in guard via shouldHonorLiveBargeIn', () => {
  assert.match(src, /shouldHonorLiveBargeIn/);
  assert.match(src, /Ignoring spurious\/early-weak interrupt/);
});

test('leo.mjs: voice-path probe must not self-queue when currentAssignedUser is null', () => {
  assert.match(src, /busyWithOther = currentAssignedUser && currentAssignedUser !== userId/);
  assert.match(src, /!isVoicePathProbe && busyWithOther/);
});