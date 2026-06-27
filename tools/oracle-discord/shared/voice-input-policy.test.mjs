import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowsMicCapture,
  shouldAttachSpeakingListener,
  voiceChannelLogTag,
  shouldProactiveRadioAnchor,
  isRadioOutputAgent,
  allowsSocialGeminiLiveSession,
} from './voice-input-policy.mjs';

const NON_LEO = ['Groq', 'Gemini', 'Claudey', 'X', 'KAI', 'Analyst', 'Researcher', 'Kai Coder', 'Oracle'];

test('allowsMicCapture: Leo only', () => {
  assert.equal(allowsMicCapture('Leo'), true);
  for (const name of NON_LEO) {
    assert.equal(allowsMicCapture(name), false, `${name} must not capture mic`);
  }
  assert.equal(allowsMicCapture(''), false);
  assert.equal(allowsMicCapture(null), false);
});

test('shouldAttachSpeakingListener mirrors allowsMicCapture', () => {
  assert.equal(shouldAttachSpeakingListener('Leo'), true);
  for (const name of NON_LEO) {
    assert.equal(shouldAttachSpeakingListener(name), allowsMicCapture(name));
    assert.equal(shouldAttachSpeakingListener(name), false);
  }
});

test('voiceChannelLogTag: Leo=Voice, others=RadioOut', () => {
  assert.equal(voiceChannelLogTag('Leo'), 'Voice');
  assert.equal(voiceChannelLogTag('Groq'), 'RadioOut');
  assert.equal(voiceChannelLogTag('Gemini'), 'RadioOut');
});

test('shouldProactiveRadioAnchor: Groq only', () => {
  assert.equal(shouldProactiveRadioAnchor('Groq'), true);
  for (const name of ['Leo', 'Gemini', 'Claudey', 'X']) {
    assert.equal(shouldProactiveRadioAnchor(name), false);
  }
  assert.equal(isRadioOutputAgent('Groq'), true);
  assert.equal(isRadioOutputAgent('Gemini'), false);
});

test('allowsSocialGeminiLiveSession: off by default (Leo owns Live)', () => {
  const prev = process.env.KAI_SOCIAL_GEMINI_LIVE;
  delete process.env.KAI_SOCIAL_GEMINI_LIVE;
  assert.equal(allowsSocialGeminiLiveSession('Leo'), false);
  assert.equal(allowsSocialGeminiLiveSession('Gemini'), false);
  assert.equal(allowsSocialGeminiLiveSession('Groq'), false);
  process.env.KAI_SOCIAL_GEMINI_LIVE = '1';
  assert.equal(allowsSocialGeminiLiveSession('Gemini'), true);
  assert.equal(allowsSocialGeminiLiveSession('Leo'), false);
  if (prev === undefined) delete process.env.KAI_SOCIAL_GEMINI_LIVE;
  else process.env.KAI_SOCIAL_GEMINI_LIVE = prev;
});