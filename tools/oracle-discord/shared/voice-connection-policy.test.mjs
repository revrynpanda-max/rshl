import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVoiceAction } from './voice-connection-policy.mjs';

const SOCIAL = '1489796367466500129';
const OTHER = '1505088473307283517';

test('Leo startup: always connect with mic', () => {
  const a = decideVoiceAction('Leo', { phase: 'startup', isWorkingHours: true, humanInRoom: false });
  assert.equal(a.shouldConnect, true);
  assert.equal(a.attachMic, true);
  assert.equal(a.logTag, 'Voice');
});

test('Groq work-hours no human: deny startup and keepalive', () => {
  for (const phase of ['startup', 'keepalive', 'connect']) {
    const a = decideVoiceAction('Groq', { phase, isWorkingHours: true, humanInRoom: false });
    assert.equal(a.shouldConnect, false, phase);
    assert.equal(a.reason, 'work_hours_no_human');
  }
});

test('Groq work-hours with human: allow radio connect', () => {
  const a = decideVoiceAction('Groq', { phase: 'keepalive', isWorkingHours: true, humanInRoom: true });
  assert.equal(a.shouldConnect, true);
  assert.equal(a.attachMic, false);
  assert.equal(a.reason, 'work_hours_human_present');
});

test('Groq off-hours: allow proactive radio anchor', () => {
  const a = decideVoiceAction('Groq', { phase: 'startup', isWorkingHours: false, humanInRoom: false });
  assert.equal(a.shouldConnect, true);
  assert.equal(a.reason, 'off_hours_radio');
});

test('Gemini social bot: never connects', () => {
  const a = decideVoiceAction('Gemini', { phase: 'voice_event', isWorkingHours: false, humanInRoom: true, channelId: SOCIAL, socialChannelId: SOCIAL });
  assert.equal(a.shouldConnect, false);
  assert.equal(a.reason, 'not_voice_agent');
});

test('Groq voice_event wrong channel: deny follow', () => {
  const a = decideVoiceAction('Groq', {
    phase: 'voice_event',
    isWorkingHours: false,
    humanInRoom: true,
    channelId: OTHER,
    socialChannelId: SOCIAL,
  });
  assert.equal(a.shouldConnect, false);
  assert.equal(a.reason, 'not_social_room');
});

test('Groq active work shift without human: deny keepalive (stops churn)', () => {
  const a = decideVoiceAction('Groq', { phase: 'keepalive', isWorkingHours: true, humanInRoom: false, hasActiveShift: true });
  assert.equal(a.shouldConnect, false);
  assert.equal(a.reason, 'work_shift_active');
});