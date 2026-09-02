import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePositionalInput,
    parseSingleArgInput,
} from '../achilles-cli/src/lib/skillInputParser.mjs';

describe('skillInputParser', () => {
    it('parses positional args and trailing multiline block', () => {
        const parsed = parsePositionalInput('demo-skill cskill.md --begin-content--\n# Demo\n\nHello\n--end-content--', {
            usage: 'write-skill <skillName> <fileName> --begin-content--',
            minArgs: 2,
            maxArgs: 2,
            block: true,
            blockRequired: true,
        });

        assert.equal(parsed.error, null);
        assert.deepEqual(parsed.args, ['demo-skill', 'cskill.md']);
        assert.equal(parsed.content, '# Demo\n\nHello');
    });

    it('supports quoted positional args', () => {
        const parsed = parsePositionalInput('demo "Input Format" --begin-content--\n- input\n--end-content--', {
            usage: 'update-section <skillName> <section> --begin-content--',
            minArgs: 2,
            maxArgs: 2,
            block: true,
            blockRequired: true,
        });

        assert.equal(parsed.error, null);
        assert.deepEqual(parsed.args, ['demo', 'Input Format']);
        assert.equal(parsed.content, '- input');
    });

    it('rejects JSON input', () => {
        const parsed = parseSingleArgInput('{"skillName":"demo"}', 'read-skill <skillName>');

        assert.match(parsed.error, /JSON input is not supported/);
    });

    it('requires block to be the final argument', () => {
        const parsed = parsePositionalInput('demo cskill.md --begin-content--\n# Demo\n--end-content-- extra', {
            usage: 'write-skill <skillName> <fileName> --begin-content--',
            minArgs: 2,
            maxArgs: 2,
            block: true,
            blockRequired: true,
        });

        assert.match(parsed.error, /final argument/);
    });
});
