import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { REPLSession } from '../achilles-cli/src/repl/REPLSession.mjs';

function createMockAgent() {
    return {
        startDir: process.cwd(),
        llmAgent: {},
        logger: {
            debug() {},
            info() {},
            warn() {},
            error() {},
        },
        getSkills: () => [],
        executeSkill: async () => ({ result: 'ok' }),
        cancelCurrentSession() {},
    };
}

describe('REPLSession slash command cancellation wiring', () => {
    it('rehydrates hierarchical sub-option args and forwards AbortSignal', async () => {
        const session = new REPLSession(createMockAgent(), {
            workingDir: process.cwd(),
            skillsDir: path.join(process.cwd(), 'skills'),
        });

        let captured = null;
        session.slashHandler = {
            parseSlashCommand: () => ({
                command: 'list',
                subOption: 'repos',
                args: '',
            }),
            executeSlashCommand: async (command, args, options = {}) => {
                captured = { command, args, options };
                return { handled: true };
            },
        };

        await session._handleSlashCommand('/list repos');

        assert.equal(captured.command, 'list');
        assert.equal(captured.args, 'repos');
        assert.ok(captured.options.signal instanceof AbortSignal);
    });
});
