import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrchestratorSystemPrompt } from '../achilles-cli/src/prompts/orchestrator-prompt.mjs';
import { action as launchWebSearch } from '../achilles-cli/src/skills/launch-web-search/src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routerSkillPath = path.join(
    __dirname,
    '../achilles-cli/src/skills/copilot-router/oskill.md'
);
const cliIndexPath = path.join(
    __dirname,
    '../achilles-cli/src/index.mjs'
);

describe('generic Copilot orchestration contract', () => {
    it('uses the generic skill prompt without restoring the retired router skill', () => {
        assert.equal(fs.existsSync(routerSkillPath), false);
        const prompt = buildOrchestratorSystemPrompt();
        assert.match(prompt, /general-purpose CLI coding agent/);
        assert.match(prompt, /Delegate to a relevant orchestrator or skill/);
        assert.match(prompt, /Use bash for explicit command, filesystem, or git work/);
        assert.doesNotMatch(prompt, /copilot-router|Rule order is precedence/);
    });

    it('keeps the undeployed web-search launcher disabled for regular and @token prompts', async () => {
        const calls = [];
        for (const prompt of ['Search online for the latest release notes.', '@web-search latest release']) {
            const context = {
                providerLauncherResults: [],
                callAgentTool: async (...args) => calls.push(args),
            };
            const result = await launchWebSearch({ prompt, context });
            assert.equal(result.ok, false);
            assert.equal(result.backend, 'web-search');
            assert.equal(result.cacheable, false);
            assert.equal(result.persistence_hint.record_result, false);
            assert.equal(result.diagnostics.providerAvailability, 'disabled');
            assert.equal(Boolean(result.diagnostics.deprecatedToken), prompt.startsWith('@'));
            assert.equal(context.providerLauncherResults.length, 1);
            assert.equal(context.providerLauncherResults[0].result, result);
        }
        assert.deepEqual(calls, []);
    });

    it('routes WebChat turns through MainAgent executePrompt', () => {
        const source = fs.readFileSync(cliIndexPath, 'utf8');
        assert.match(source, /agent\.executePrompt\(akuPrompt\.prompt/);
        assert.doesNotMatch(source, /agent\.executeSkill\(['"]copilot-router['"]/);
    });
});
