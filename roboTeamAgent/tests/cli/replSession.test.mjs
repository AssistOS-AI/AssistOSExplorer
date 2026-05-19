import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPLSession } from '../achilles-cli/src/repl/REPLSession.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(__dirname);

function createMockAgent(executeSkillImpl) {
    return {
        llmAgent: {},
        logger: {
            debug() {},
            info() {},
            warn() {},
            error() {},
        },
        getSkills: () => [],
        executeSkill: executeSkillImpl,
    };
}

describe('REPLSession', () => {
    it('falls back to built-in module when skill registry misses built-in skill', async () => {
        const builtInSkillsDir = path.join(repoRoot, 'achilles-cli', 'src', 'skills');
        const agent = createMockAgent(async () => {
            throw new Error('Skill "list-skills" not found.');
        });

        const session = new REPLSession(agent, {
            workingDir: process.cwd(),
            skillsDir: path.join(process.cwd(), 'skills'),
            builtInSkillsDir,
        });

        const result = await session._executeSkill('list-skills', 'list');
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('No user skills found') || result.includes('Create one'));
    });

    it('rethrows non-not-found errors from executeSkill', async () => {
        const agent = createMockAgent(async () => {
            throw new Error('Permission denied');
        });

        const session = new REPLSession(agent, {
            workingDir: process.cwd(),
            skillsDir: path.join(process.cwd(), 'skills'),
            builtInSkillsDir: path.join(repoRoot, 'achilles-cli', 'src', 'skills'),
        });

        await assert.rejects(
            () => session._executeSkill('list-skills', 'list'),
            /Permission denied/
        );
    });
});
