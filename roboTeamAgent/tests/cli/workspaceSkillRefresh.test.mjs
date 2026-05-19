import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    drainWorkspaceSkillsRefresh,
    installWorkspaceSkillRefreshHook,
    refreshWorkspaceSkillsNow,
    requestWorkspaceSkillsRefresh,
} from '../achilles-cli/src/lib/workspaceSkillRefresh.mjs';

describe('workspace skill refresh hook', () => {
    it('marks refresh pending and drains once', async () => {
        let refreshCalls = 0;
        const agent = {
            refreshSkills: () => {
                refreshCalls += 1;
                return {
                    registered: 3,
                    added: ['new-skill'],
                    updated: [],
                    removed: [],
                };
            },
        };

        installWorkspaceSkillRefreshHook(agent);
        assert.equal(agent.hasPendingWorkspaceSkillsRefresh(), false);

        const requested = requestWorkspaceSkillsRefresh(agent, {
            operation: 'write-skill',
            skillName: 'new-skill',
            filePath: '/tmp/new-skill/cskill.md',
        });

        assert.equal(requested, true);
        assert.equal(agent.hasPendingWorkspaceSkillsRefresh(), true);

        const summary = await drainWorkspaceSkillsRefresh(agent);

        assert.equal(refreshCalls, 1);
        assert.equal(agent.hasPendingWorkspaceSkillsRefresh(), false);
        assert.deepEqual(summary.added, ['new-skill']);
        assert.equal(summary.requests.length, 1);
        assert.equal(summary.requests[0].operation, 'write-skill');

        const second = await drainWorkspaceSkillsRefresh(agent);
        assert.equal(second, null);
        assert.equal(refreshCalls, 1);
    });

    it('explicit refresh clears pending state', async () => {
        let refreshCalls = 0;
        const agent = {
            getSkills: () => [],
            refreshSkills: () => {
                refreshCalls += 1;
                return {
                    registered: 0,
                    added: [],
                    updated: [],
                    removed: [],
                };
            },
        };

        installWorkspaceSkillRefreshHook(agent);
        agent.requestWorkspaceSkillsRefresh({ operation: 'delete-skill' });

        const summary = await refreshWorkspaceSkillsNow(agent);

        assert.equal(refreshCalls, 1);
        assert.equal(agent.hasPendingWorkspaceSkillsRefresh(), false);
        assert.equal(summary.registered, 0);
    });

    it('does not put refresh metadata in skill output', async () => {
        const { action } = await import('../achilles-cli/src/skills/write-skill/src/index.mjs');
        let requested = false;
        const tempRoot = new URL(`./temp_refresh_${Date.now()}/`, import.meta.url).pathname;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const agent = {
            startDir: tempRoot,
            requestWorkspaceSkillsRefresh: () => {
                requested = true;
            },
        };

        try {
            const output = await action({
                mainAgent: agent,
                promptText: JSON.stringify({
                    skillName: 'plain-output',
                    fileName: 'cskill.md',
                    content: '# Plain Output',
                }),
            });

            assert.equal(requested, true);
            assert.equal(output.includes('requestWorkspaceSkillsRefresh'), false);
            assert.equal(output.includes('skillsChanged'), false);
            assert.ok(output.includes('Created'));
            assert.ok(fs.existsSync(path.join(tempRoot, 'skills', 'plain-output', 'cskill.md')));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
