import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../../IDE-plugins/git-tool-button/git-tool-button-controller.js', import.meta.url), 'utf8');
const launcher = source.match(/async function openGitPanel\(options = \{\}\) \{[\s\S]*?\n    \}/)[0];

for (const options of [{}, { selectedRepoPath: '/workspace/project', openConflictHelper: true }]) {
    test(`Git delegates its ${options.openConflictHelper ? 'conflict' : 'normal'} opening to the shared plugin entry`, async () => {
        let descriptor;
        let finish;
        const closed = new Promise(resolve => { finish = resolve; });
        let complete = false;
        let synced = 0;
        let timers = 0;
        const open = vm.runInNewContext(`(${launcher})`, {
            ensureAutocommitTimer: () => { timers++; },
            syncConflictFlagFromRepos: async () => { synced++; },
            assistOS: { UI: { openPluginPanel: (key, context) => { descriptor = { key, context }; return closed; } } },
        });
        const result = open(options).then(() => { complete = true; });
        await Promise.resolve();
        assert.equal(complete, false);
        assert.equal(descriptor.key, 'gitAgent/git');
        assert.deepEqual(JSON.parse(JSON.stringify(descriptor.context)), {
            panelNavigation: { path: options.selectedRepoPath || '' },
            props: { openConflictHelper: Boolean(options.openConflictHelper) },
        });
        assert.equal(synced, 1);
        assert.equal(timers, 1);
        finish();
        await result;
        assert.equal(complete, true);
    });
}
