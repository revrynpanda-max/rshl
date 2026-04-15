"use strict";

const { store, query, queryRegion, clear } = require('./universe');
const { textVec, debugTokens } = require('./rshl-core');

function header(title) {
    console.log('\n' + '='.repeat(72));
    console.log(title);
    console.log('='.repeat(72));
}

// ── Populate a realistic KAI memory bank ───────────────────────────────────────
header('1) Populating realistic KAI data (30 items)');

// Memory — episodic facts about the user
store('I went to the store yesterday',                    'memory');
store('My birthday is March 15th',                        'memory');
store('I had coffee with Sarah last Tuesday',             'memory');
store('I live in Austin Texas',                           'memory');
store('My favorite color is blue',                        'memory');
store('I started a new job last month',                   'memory');
store('I adopted a golden retriever named Max',           'memory');
store('I graduated from UT in 2019',                      'memory');

// Reasoning — plans, inferences, conflicts
store('If it rains tomorrow I should bring an umbrella',  'reasoning');
store('The meeting conflicts with my dentist appointment','reasoning');
store('I should save money if I want to buy a house',     'reasoning');
store('Working out in the morning would help my sleep',   'reasoning');
store('If traffic is bad I should leave early',           'reasoning');
store('I need to renew my passport before the trip',      'reasoning');
store('Learning Python would help my career',             'reasoning');

// Language — rewriting, translation, definitions
store('Can you say that in a nicer way?',                 'language');
store('Translate this to formal English',                 'language');
store('What does serendipity mean?',                      'language');
store('How do you pronounce this word?',                  'language');
store('Rephrase this email to sound more professional',   'language');
store('What is another word for happy?',                  'language');
store('Fix the grammar in this paragraph',                'language');

// Action — commands, device control
store('Open Chrome and play some jazz',                   'action');
store('Turn on the living room lights',                   'action');
store('Set a timer for 10 minutes',                       'action');
store('Send an email to my boss',                         'action');
store('Take a screenshot of this page',                   'action');
store('Create a new folder on the desktop',               'action');
store('Close all browser tabs',                           'action');
store('Restart the computer',                             'action');

console.log('Stored 30 items (8 memory, 7 reasoning, 7 language, 8 action).');

// ── Stress test: 30 queries across all regions ─────────────────────────────────
header('2) Stress test — 30 auto-detect queries');

const tests = [
    // Memory queries
    { text: 'What did I do yesterday?',            expected: 'memory' },
    { text: 'When is my birthday?',                expected: 'memory' },
    { text: 'Who did I have coffee with?',         expected: 'memory' },
    { text: 'Where do I live?',                    expected: 'memory' },
    { text: 'What is my favorite color?',          expected: 'memory' },
    { text: 'When did I start my job?',            expected: 'memory' },
    { text: 'What is my dogs name?',               expected: 'memory' },

    // Reasoning queries
    { text: 'Should I bring an umbrella?',         expected: 'reasoning' },
    { text: 'If it rains what should I do?',       expected: 'reasoning' },
    { text: 'Is there a scheduling conflict?',     expected: 'reasoning' },
    { text: 'How can I save money?',               expected: 'reasoning' },
    { text: 'Would working out help me sleep?',    expected: 'reasoning' },
    { text: 'Should I leave early for the meeting?', expected: 'reasoning' },
    { text: 'Do I need to renew my passport?',     expected: 'reasoning' },

    // Language queries
    { text: 'How can I say this more politely?',   expected: 'language' },
    { text: 'What does this word mean?',           expected: 'language' },
    { text: 'How do you pronounce this?',          expected: 'language' },
    { text: 'Make this email sound professional',  expected: 'language' },
    { text: 'What is a synonym for happy?',        expected: 'language' },
    { text: 'Fix the grammar in this',             expected: 'language' },
    { text: 'Translate this to formal English',    expected: 'language' },

    // Action queries
    { text: 'Turn on the lights',                  expected: 'action' },
    { text: 'Play some music',                     expected: 'action' },
    { text: 'Set a timer for 5 minutes',           expected: 'action' },
    { text: 'Send an email',                       expected: 'action' },
    { text: 'Take a screenshot',                   expected: 'action' },
    { text: 'Create a new folder',                 expected: 'action' },
    { text: 'Close all browser tabs',              expected: 'action' },
    { text: 'Open Chrome',                         expected: 'action' },
    { text: 'Restart the computer',                expected: 'action' },
];

const regionStats = { memory: [0,0], reasoning: [0,0], language: [0,0], action: [0,0] };
let total = 0, correct = 0;

for (const t of tests) {
    total++;
    const results = query(t.text, 1);
    const top = results[0];
    const ok = top.region === t.expected;
    if (ok) { correct++; regionStats[t.expected][0]++; }
    regionStats[t.expected][1]++;

    const mark = ok ? 'Y' : 'X';
    console.log(`${mark}  "${t.text}"`);
    if (!ok) {
        console.log(`     EXPECTED: ${t.expected} | GOT: ${top.region}`);
        console.log(`     matched: "${top.text}" (${top.score.toFixed(4)})`);
        // Show what tokens survived normalization
        const qtoks = debugTokens(t.text).map(x => x.tok).join(', ');
        const mtoks = debugTokens(top.text).map(x => x.tok).join(', ');
        console.log(`     query tokens:   [${qtoks}]`);
        console.log(`     matched tokens: [${mtoks}]`);
    }
}

header('3) Results');
console.log(`Overall accuracy: ${correct}/${total} (${(100*correct/total).toFixed(1)}%)`);
console.log(`Per-region breakdown:`);
for (const [region, [hit, tot]] of Object.entries(regionStats)) {
    console.log(`  ${region.padEnd(10)}: ${hit}/${tot} (${tot ? (100*hit/tot).toFixed(0) : 0}%)`);
}

// ── Isolation gap analysis ─────────────────────────────────────────────────────
header('4) Isolation gap per region');
for (const region of ['memory', 'reasoning', 'language', 'action']) {
    const probe = region === 'memory'    ? 'I went to the store yesterday' :
                  region === 'reasoning' ? 'If it rains should I bring umbrella' :
                  region === 'language'  ? 'say that in a nicer way' :
                                           'open chrome and play music';
    const all = queryRegion(probe, region, 30);
    const same = all.filter(r => r.region === region);
    const diff = all.filter(r => r.region !== region);
    const avgSame = same.length ? same.reduce((s, r) => s + r.score, 0) / same.length : 0;
    const avgDiff = diff.length ? diff.reduce((s, r) => s + r.score, 0) / diff.length : 0;
    console.log(`${region.padEnd(10)}: same=${avgSame.toFixed(4)} other=${avgDiff.toFixed(4)} gap=${(avgSame-avgDiff).toFixed(4)}`);
}