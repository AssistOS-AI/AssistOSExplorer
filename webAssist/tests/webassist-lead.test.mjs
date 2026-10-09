import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { loadAkuContext } from '../src/runtime/load-aku-context.mjs';
import { action } from '../skills/webassist-lead/src/index.mjs';

const SITE_ID = 'demo-site';

function leadPayload(overrides = {}) {
    return {
        siteId: SITE_ID,
        sessionId: 'session-xyz',
        contactInfo: { email: 'test@example.com', name: 'John Doe' },
        profile: 'Developer',
        mandatoryConditionsSatisfied: true,
        matchExplanation: 'The visitor is planning an API integration and provided direct contact details.',
        summary: 'Wants to integrate an API.',
        ...overrides,
    };
}

test('webassist-lead writes a deterministic site-scoped lead', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());

    await ensureSiteAku({
        siteId: SITE_ID,
    });

    const firstResult = await action({
        promptText: JSON.stringify(leadPayload()),
        context: {
            siteDataDir: path.join(sandbox.webAssistDataDir, 'sites', SITE_ID),
            siteId: SITE_ID,
            sessionId: 'session-xyz',
        },
    });

    assert.ok(firstResult.includes('Lead created for profile'));

    const secondResult = await action({
        promptText: JSON.stringify(leadPayload({ summary: 'Ready to scope an implementation call.' })),
        context: {
            siteDataDir: path.join(sandbox.webAssistDataDir, 'sites', SITE_ID),
            siteId: SITE_ID,
            sessionId: 'session-xyz',
        },
    });

    assert.ok(secondResult.includes('Lead updated for profile'));

    const context = await loadAkuContext({
        siteId: SITE_ID,
        sessionId: 'session-xyz',
        message: 'What is the status?',
    });

    assert.equal(context.currentLead.exists, true);
    assert.equal(context.currentLead.profile, 'Developer');
    assert.equal(context.currentLead.contactInfo.email, 'test@example.com');
    assert.match(context.currentLead.state, /John Doe/);
});
