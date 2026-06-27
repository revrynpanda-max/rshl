import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGroqBot, cloudFailoverOrder, enforceGroqPrimaryRoute, shouldSkipGeminiFailover, essentialsLimitedMode } from './groq-routing-policy.mjs';

test('isGroqBot', () => {
  assert.equal(isGroqBot('Groq'), true);
  assert.equal(isGroqBot('Leo'), false);
});

test('cloudFailoverOrder excludes gemini for Groq', () => {
  assert.deepEqual(cloudFailoverOrder('Groq'), ['groq']);
  assert.ok(cloudFailoverOrder('Leo').includes('gemini'));
});

test('essentials limited mode skips gemini for work bots', () => {
  const prev = process.env.KAI_FORCE_LIMITED;
  process.env.KAI_FORCE_LIMITED = '1';
  try {
    assert.equal(shouldSkipGeminiFailover('Researcher'), true);
    assert.equal(shouldSkipGeminiFailover('Analyst'), true);
    assert.equal(shouldSkipGeminiFailover('Leo'), false);
    assert.deepEqual(cloudFailoverOrder('Researcher'), ['groq']);
    assert.ok(cloudFailoverOrder('Leo').includes('gemini'));
    assert.equal(essentialsLimitedMode(), true);
  } finally {
    if (prev === undefined) delete process.env.KAI_FORCE_LIMITED;
    else process.env.KAI_FORCE_LIMITED = prev;
  }
});

test('enforceGroqPrimaryRoute forces groq', () => {
  const fixed = enforceGroqPrimaryRoute('Groq', { provider: 'gemini', modelAlias: 'x', realModel: 'gemini-2.5-flash' });
  assert.equal(fixed.provider, 'groq');
  assert.equal(enforceGroqPrimaryRoute('Leo', { provider: 'gemini', modelAlias: 'x', realModel: 'y' }).provider, 'gemini');
});