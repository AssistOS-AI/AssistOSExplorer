import test from 'node:test';
import assert from 'node:assert/strict';
import { gitPanelPropsFromNavigation } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-navigation.js';

test('a new Git tab selects the repository while keeping its normal fresh-state defaults', () => {
    const props = gitPanelPropsFromNavigation({ panelNavigation: { path: '/workspace/repos/project' } }, '/workspace/');
    assert.equal(props.repoPath, '/workspace/repos/project');
    assert.equal(props.selectedRepoPath, '/workspace/repos/project');
    assert.equal(props.commitMessage, undefined);
    assert.equal(props.token, undefined);
    assert.deepEqual(gitPanelPropsFromNavigation({}, '/workspace'), {});
});

test('repository navigation cannot escape the active workspace', () => {
    for (const path of ['/other/project', '/workspace-other/project', '/workspace/../other', '//workspace/project', '/workspace/project\\other', '/workspace/project\n']) {
        assert.throws(() => gitPanelPropsFromNavigation({ panelNavigation: { path } }, '/workspace'), /outside this workspace or its path is invalid/);
    }
});
