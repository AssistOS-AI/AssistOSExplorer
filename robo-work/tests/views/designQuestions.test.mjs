import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DESIGN_QUESTIONS } from '../../server/views/designQuestions.mjs';

const directories = [new URL('../../server/views/', import.meta.url), new URL('./', import.meta.url), new URL('./vectors/', import.meta.url)];

test('every design-question identifier referenced in server/views and tests/views is defined', () => {
    const defined = new Set(DESIGN_QUESTIONS.map((question) => question.id));
    assert.equal(defined.size, DESIGN_QUESTIONS.length, 'identifiers are unique');
    const referenced = new Set();
    for (const directory of directories) {
        for (const name of fs.readdirSync(directory)) {
            if (!/\.(mjs|json)$/.test(name) || name === 'designQuestions.mjs' || name === 'designQuestions.test.mjs') continue;
            const text = fs.readFileSync(fileURLToPath(new URL(name, directory)), 'utf8');
            for (const match of text.matchAll(/D-S5-\d+/g)) referenced.add(match[0]);
        }
    }
    assert.ok(referenced.size >= 4, 'the code references some questions');
    for (const id of referenced) assert.ok(defined.has(id), `${id} is referenced but not defined`);
});

test('D-S5-6 and D-S5-10 are product decisions for Daniel and every other question is technical', () => {
    const product = DESIGN_QUESTIONS.filter((question) => question.kind === 'product').map((question) => question.id);
    assert.deepEqual(product, ['D-S5-6', 'D-S5-10']);
    assert.equal(DESIGN_QUESTIONS.filter((question) => question.kind === 'technical').length, DESIGN_QUESTIONS.length - 2);
});

test('the product questions D-S5-6 and D-S5-10 are decided with a plan section 16 reference, and no product question is open', () => {
    for (const question of DESIGN_QUESTIONS) {
        assert.ok(question.status === 'open' || question.status === 'decided', question.id);
        assert.ok(Object.isFrozen(question), question.id);
        if (question.status === 'decided') assert.match(question.decision, /plan §16, Decisions recorded 2026-10-28/, question.id);
        else assert.equal(question.decision, null, question.id);
    }
    const decided = DESIGN_QUESTIONS.filter((question) => question.status === 'decided').map((question) => question.id);
    assert.deepEqual(decided, ['D-S5-6', 'D-S5-10']);
    assert.deepEqual(DESIGN_QUESTIONS.filter((question) => question.kind === 'product' && question.status === 'open'), []);
    const timing = DESIGN_QUESTIONS.find((question) => question.id === 'D-S5-13');
    assert.equal(timing.kind, 'technical');
    assert.equal(timing.status, 'open');
    assert.match(timing.text, /G5/);
});
