import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../IDE-plugins/git-tool-button/components/git-panel/git-panel.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from [^;]+;\n/gm, '')
    .replace('export class GitPanel', 'class GitPanel');

test('removing the Git panel cancels polling, releases document listeners and refreshes the toolbar', () => {
    const events = [];
    const cleared = [];
    const scheduled = [];
    const context = vm.createContext({
        window: { dispatchEvent: (event) => events.push(event.type) },
        CustomEvent: class { constructor(type) { this.type = type; } },
        GIT_PANEL_CLOSED_EVENT: 'webskel-git-panel-closed',
        clearTimeout: (timer) => cleared.push(timer),
        setTimeout: (...args) => { scheduled.push(args); return 2; }
    });
    const GitPanel = vm.runInContext(`${source}\nGitPanel;`, context);
    const panel = Object.create(GitPanel.prototype);
    let aborted = false;
    panel.githubPollTimer = 1;
    panel.menuAbortController = { abort() { aborted = true; } };
    panel.afterUnload();
    assert.deepEqual(cleared, [1]);
    assert.equal(aborted, true);
    assert.equal(panel.menuAbortController, null);
    assert.deepEqual(events, ['webskel-git-panel-closed']);
    // A pending authentication response must not restart polling after removal.
    panel.scheduleGithubPoll();
    assert.equal(scheduled.length, 0);
});

test('updated conflict request waits for initial load and preserves the commit draft', async () => {
    const GitPanel = vm.runInNewContext(`${source}\nGitPanel;`);
    const panel = Object.create(GitPanel.prototype);
    let finish;
    panel.initialLoad = new Promise(resolve => { finish = resolve; });
    panel.props = {};
    panel.state = { commitMessage: 'Keep my draft', selectedRepoPath: 'repos/a' };
    panel.setState = patch => Object.assign(panel.state, patch);
    let opened = 0;
    panel.openConflictHelper = async () => { opened++; };
    const updating = panel.updateModalProps({ selectedRepoPath: 'repos/b', openConflictHelper: true });
    assert.equal(opened, 0);
    finish(); await updating;
    assert.equal(panel.state.selectedRepoPath, 'repos/b');
    assert.equal(panel.state.commitMessage, 'Keep my draft');
    assert.equal(opened, 1);
    panel.unloaded = true;
    await panel.updateModalProps({ selectedRepoPath: 'repos/c', openConflictHelper: true });
    assert.equal(opened, 1);
    assert.equal(panel.state.selectedRepoPath, 'repos/b');
});
