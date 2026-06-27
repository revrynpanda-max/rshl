import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOvernightRoster,
  effectiveOvernightRoster,
  essentialsLimitedMode,
} from './overnight-roster-policy.mjs';

const FULL = parseOvernightRoster('Leo,Gemini,Claudey,X,Groq,Researcher,Analyst,Kai Coder,Oracle,KAI');

test('parseOvernightRoster excludes Oracle and KAI', () => {
  assert.ok(FULL.includes('Leo'));
  assert.ok(!FULL.some((b) => b.toLowerCase() === 'oracle'));
  assert.ok(!FULL.some((b) => b.toLowerCase() === 'kai'));
});

test('essentials limited mode keeps only social bots in overnight roster', () => {
  const prev = process.env.KAI_FORCE_LIMITED;
  process.env.KAI_FORCE_LIMITED = '1';
  try {
    assert.equal(essentialsLimitedMode(), true);
    const eff = effectiveOvernightRoster(FULL);
    assert.deepEqual(eff, ['Gemini', 'Claudey', 'X']);
    assert.ok(!eff.includes('Leo'));
    assert.ok(!eff.includes('Groq'));
  } finally {
    if (prev === undefined) delete process.env.KAI_FORCE_LIMITED;
    else process.env.KAI_FORCE_LIMITED = prev;
  }
});

test('full fleet mode sleeps entire roster', () => {
  const eff = effectiveOvernightRoster(FULL, { forceLimited: false });
  assert.deepEqual(eff, FULL);
});