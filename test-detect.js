"use strict";
const { textVec, resonance, debugTokens } = require('./rshl-core');
const { bind, REGIONS } = require('./anchors');

// Test the key insight: if we only keep results where the scan-region
// matches the item's stored region, cross-region noise is eliminated.

function mulberry32(a) {
    return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const _cells = [];
let _id = 0;

function store(text, region) {
    const r = String(region).toLowerCase();
    const raw = textVec(text);
    const vec = bind(raw, r);
    _cells.push({ id: ++_id, text, region: r, vec });
}

function queryV2(text, topK) {
    const raw = textVec(text);
    const k = topK || 5;
    const results = [];

    for (const region of REGIONS) {
        const q = bind(raw, region);
        for (const cell of _cells) {
            // ONLY score items that live in the region we're currently scanning
            if (cell.region !== region) continue;
            results.push({
                text: cell.text,
                region: cell.region,
                score: resonance(q, cell.vec),
            });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
}

// Populate
store('I went to the store yesterday',                    'memory');
store('My birthday is March 15th',                        'memory');
store('I had coffee with Sarah last Tuesday',             'memory');
store('I live in Austin Texas',                           'memory');
store('My favorite color is blue',                        'memory');
store('I started a new job last month',                   'memory');
store('I adopted a golden retriever named Max',           'memory');
store('I graduated from UT in 2019',                      'memory');

store('If it rains tomorrow I should bring an umbrella',  'reasoning');
store('The meeting conflicts with my dentist appointment','reasoning');
store('I should save money if I want to buy a house',     'reasoning');
store('Working out in the morning would help my sleep',   'reasoning');
store('If traffic is bad I should leave early',           'reasoning');
store('I need to renew my passport before the trip',      'reasoning');
store('Learning Python would help my career',             'reasoning');

store('Can you say that in a nicer way?',                 'language');
store('Translate this to formal English',                 'language');
store('What does serendipity mean?',                      'language');
store('How do you pronounce this word?',                  'language');
store('Rephrase this email to sound more professional',   'language');
store('What is another word for happy?',                  'language');
store('Fix the grammar in this paragraph',                'language');

store('Open Chrome and play some jazz',                   'action');
store('Turn on the living room lights',                   'action');
store('Set a timer for 10 minutes',                       'action');
store('Send an email to my boss',                         'action');
store('Take a screenshot of this page',                   'action');
store('Create a new folder on the desktop',               'action');
store('Close all browser tabs',                           'action');
store('Restart the computer',                             'action');

// Test
const tests = [
    { text: 'What did I do yesterday?',            expected: 'memory' },
    { text: 'When is my birthday?',                expected: 'memory' },
    { text: 'Who did I have coffee with?',         expected: 'memory' },
    { text: 'Where do I live?',                    expected: 'memory' },
    { text: 'What is my favorite color?',          expected: 'memory' },
    { text: 'When did I start my job?',            expected: 'memory' },
    { text: 'What is my dogs name?',               expected: 'memory' },
    { text: 'Should I bring an umbrella?',         expected: 'reasoning' },
    { text: 'If it rains what should I do?',       expected: 'reasoning' },
    { text: 'Is there a scheduling conflict?',     expected: 'reasoning' },
    { text: 'How can I save money?',               expected: 'reasoning' },
    { text: 'Would working out help me sleep?',    expected: 'reasoning' },
    { text: 'Should I leave early for the meeting?', expected: 'reasoning' },
    { text: 'Do I need to renew my passport?',     expected: 'reasoning' },
    { text: 'How can I say this more politely?',   expected: 'language' },
    { text: 'What does this word mean?',           expected: 'language' },
    { text: 'How do you pronounce this?',          expected: 'language' },
    { text: 'Make this email sound professional',  expected: 'language' },
    { text: 'What is a synonym for happy?',        expected: 'language' },
    { text: 'Fix the grammar in this',             expected: 'language' },
    { text: 'Translate this to formal English',    expected: 'language' },
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

let total = 0, correct = 0;
const regionStats = { memory: [0,0], reasoning: [0,0], language: [0,0], action: [0,0] };

for (const t of tests) {
    total++;
    const results = queryV2(t.text, 1);
    const top = results[0];
    const ok = top.region === t.expected;
    if (ok) { correct++; regionStats[t.expected][0]++; }
    regionStats[t.expected][1]++;

    const mark = ok ? 'Y' : 'X';
    if (!ok) {
        console.log(mark + '  ' + t.text);
        console.log('     EXPECTED: ' + t.expected + ' | GOT: ' + top.region);
        console.log('     matched: ' + top.text + ' (' + top.score.toFixed(4) + ')');
    } else {
        console.log(mark + '  ' + t.text + ' -> [' + top.region + '] (' + top.score.toFixed(4) + ')');
    }
}

console.log('\nOverall: ' + correct + '/' + total + ' (' + (100*correct/total).toFixed(1) + '%)');
for (const [region, [hit, tot]] of Object.entries(regionStats)) {
    console.log('  ' + region.padEnd(10) + ': ' + hit + '/' + tot);
}
