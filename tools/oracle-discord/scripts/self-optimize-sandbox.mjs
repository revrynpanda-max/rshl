import assert from 'node:assert/strict';
import { evaluateSelfOptimize, TIERS } from '../shared/resource-saver.mjs';
import {
  BOT_PORTS,
  CHANNEL_IDS,
  CHANNEL_SPEAKER_RULES,
  TRANSCRIPT_USER_INFO,
  USER_TRANSCRIPT_MAP,
  isAllowed
} from '../shared/channel-rules.mjs';
import { AI_REGISTRY, HUMAN_REGISTRY } from '../shared/identities.mjs';

const scenarios = [
  {
    name: 'normal headroom',
    input: {
      cpuLoad: 28,
      gpuLoad: 12,
      memLoad: 48,
      totalMemMB: 32768,
      freeMemMB: 17000,
      projectMemMB: 1400,
      projectProcessCount: 12,
      vitals: { phi_g: 1.15, chi: 0.016 }
    },
    expectedTier: TIERS.NORMAL
  },
  {
    name: 'project pressure reduced',
    input: {
      cpuLoad: 74,
      gpuLoad: 44,
      memLoad: 62,
      totalMemMB: 32768,
      freeMemMB: 12000,
      projectMemMB: 3600,
      projectProcessCount: 16,
      features: { autonomousWork: 1, socialLoop: 2, radio: true },
      vitals: { phi_g: 1.12, chi: 0.03 }
    },
    expectedTier: TIERS.REDUCED
  },
  {
    name: 'drift protect',
    input: {
      cpuLoad: 52,
      gpuLoad: 20,
      memLoad: 58,
      totalMemMB: 32768,
      freeMemMB: 13500,
      projectMemMB: 1800,
      projectProcessCount: 10,
      vitals: { phi_g: 0.78, chi: 0.14 }
    },
    expectedTier: TIERS.PROTECT
  },
  {
    name: 'hardware protect',
    input: {
      cpuLoad: 96,
      gpuLoad: 88,
      memLoad: 83,
      totalMemMB: 32768,
      freeMemMB: 5500,
      projectMemMB: 2200,
      projectProcessCount: 11,
      vitals: { phi_g: 1.10, chi: 0.02 }
    },
    expectedTier: TIERS.PROTECT
  }
];

const rows = [];
for (const scenario of scenarios) {
  const snapshot = evaluateSelfOptimize(scenario.input);
  assert.equal(snapshot.tier, scenario.expectedTier, scenario.name);
  assert.equal(snapshot.spots.KAI.allowed, true, `${scenario.name}: KAI reserve must stay available`);
  assert.equal(snapshot.spots.Oracle.allowed, true, `${scenario.name}: Oracle reserve must stay available`);
  rows.push({
    scenario: scenario.name,
    tier: snapshot.tier,
    projectPressure: snapshot.project.pressure,
    drift: snapshot.project.drift,
    leoAllowed: snapshot.spots.Leo.allowed,
    radioAllowed: snapshot.spots.Radio.allowed,
    socialAllowed: snapshot.spots.Gemini.allowed
  });
}

assert.equal(isAllowed('Leo', CHANNEL_IDS.SELF_OPTIMIZE), false, 'Leo must not speak in self-optimize lane');
assert.equal(isAllowed('KAI', CHANNEL_IDS.SELF_OPTIMIZE), true, 'KAI must speak in self-optimize lane');
assert.equal(isAllowed('Analyst', CHANNEL_IDS.SELF_OPTIMIZE), true, 'Analyst must speak in self-optimize lane');

for (const [name, human] of Object.entries(HUMAN_REGISTRY)) {
  assert.match(human.id, /^\d{17,20}$/, `${name}: human Discord ID must be numeric`);
  assert.equal(USER_TRANSCRIPT_MAP[human.id], human.transcriptChannelId, `${name}: transcript map mismatch`);
  assert.equal(TRANSCRIPT_USER_INFO[human.transcriptChannelId]?.userId, human.id, `${name}: reverse transcript map mismatch`);
}

for (const [name, ai] of Object.entries(AI_REGISTRY)) {
  if (name === 'Oracle') continue;
  assert.match(ai.id, /^\d{17,20}$/, `${name}: AI Discord ID must be numeric`);
  assert.equal(BOT_PORTS[name], ai.port, `${name}: AI port registry mismatch`);
}

assert.equal(CHANNEL_SPEAKER_RULES[CHANNEL_IDS.PUBLIC].has('Leo'), true, 'Leo must own public chat');
assert.equal(CHANNEL_SPEAKER_RULES[CHANNEL_IDS.PUBLIC].has('KAI'), false, 'KAI must not enter Leo public chat');
assert.equal(CHANNEL_SPEAKER_RULES[CHANNEL_IDS.SUNDAY].has('Leo'), false, 'Leo must not enter AI social chat');
assert.equal(CHANNEL_SPEAKER_RULES[CHANNEL_IDS.SELF_OPTIMIZE].has('Gemini'), false, 'Social bots must not enter self-optimize lane');

console.table(rows);
console.log('Self Optimize sandbox passed.');
