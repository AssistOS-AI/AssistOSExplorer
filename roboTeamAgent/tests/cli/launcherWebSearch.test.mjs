import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { action } from '../roboTeamAgent/copilot/src/skills/launch-web-search/scripts/action.mjs';

describe('launch-web-search unavailable skill', () => {
    it('treats provider-looking @web-search text as ordinary chat input', async () => {
        const context = { providerLauncherResults: [] };
        const result = await action({
            prompt: '@web-search latest Node.js release',
            context,
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.deprecatedToken, true);
        assert.equal(result.diagnostics.providerAvailability, 'disabled');
        assert.match(result.result_text, /ordinary chat text/);
        assert.equal(context.providerLauncherResults.length, 1);
        assert.equal(context.providerLauncherResults[0].result.diagnostics.deprecatedToken, true);
    });

    it('records unavailable web prompts without any external provider calls', async () => {
        const context = { providerLauncherResults: [] };
        const result = await action({
            promptText: 'Search online for recent release notes.',
            context,
            callAgentTool: () => assert.fail('Unavailable search must not call a provider'),
            agentClient: { callToolWithoutWait: () => assert.fail('Unavailable search must not dispatch a worker') },
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.providerAvailability, 'disabled');
        assert.equal(result.diagnostics.promptProvided, true);
        assert.match(result.result_text, /not deployed/);
        assert.equal(result.persistence_hint.record_result, false);
        assert.equal(context.providerLauncherResults[0].result, result);
    });
});
