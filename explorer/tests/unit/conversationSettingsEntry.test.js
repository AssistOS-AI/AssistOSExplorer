import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { completeInitialApplicationRoute } from '../../services/runtime/initial-application-route.js';

test('application bootstrap does not open conversation skill settings', async () => {
    const windowRef = {};
    const webSkel = {};
    await completeInitialApplicationRoute({ webSkel, windowRef, presenter: {
        openConversationSettingsFromLocation() { assert.fail('Retired settings route called'); }
    } });
    assert.equal(windowRef.webSkel, webSkel);
    const source = await fs.readFile(new URL('../../web-components/pages/file-exp/file-exp-search.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /copilotContext|conversation-settings-route|openConversationSettingsFromLocation|'copilot'/);
});
