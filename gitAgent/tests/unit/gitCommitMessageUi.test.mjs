import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { createCommitMessageActions } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-commit-message.js';

const agentRoot = new URL('../../', import.meta.url);

async function readAgentFile(relativePath) {
    return fs.readFile(new URL(relativePath, agentRoot), 'utf8');
}

test('AI commit generation uses and clears the modal-local busy state', async () => {
    const busyStates = [];
    const statuses = [];
    let commitMessage = '';
    let buttonUpdates = 0;

    const actions = createCommitMessageActions({
        service: {
            async gitDiff() {
                return '+add a modal-local loader';
            },
            async generateCommitMessage() {
                return JSON.stringify({ ok: true, message: 'Keep Git visible during AI generation' });
            }
        },
        setStatusLine(message, isError = false) {
            statuses.push({ message, isError });
        },
        setCommitMessage(message) {
            commitMessage = message;
        },
        setCommitMessageBusy(isBusy) {
            busyStates.push(isBusy);
        },
        updateCommitButtons() {
            buttonUpdates += 1;
        },
        getSelectedReposForBatch() {
            return ['/workspace/repo'];
        },
        getPathsForCommitInRepo() {
            return ['src/modal.js'];
        }
    });

    await actions.generateCommitMessage();

    assert.deepEqual(busyStates, [true, false]);
    assert.equal(commitMessage, 'Keep Git visible during AI generation');
    assert.equal(buttonUpdates, 1);
    assert.deepEqual(statuses.at(-1), { message: 'Commit message generated.', isError: false });
});

test('AI commit generation clears the modal-local busy state after failure', async () => {
    const busyStates = [];
    const previousAssistOS = globalThis.assistOS;
    globalThis.assistOS = {
        UI: {
            async showModal() {
                return null;
            }
        }
    };

    try {
        const actions = createCommitMessageActions({
            service: {
                async gitDiff() {
                    throw new Error('provider unavailable');
                }
            },
            setStatusLine() {},
            setCommitMessage() {},
            setCommitMessageBusy(isBusy) {
                busyStates.push(isBusy);
            },
            updateCommitButtons() {},
            getSelectedReposForBatch() {
                return ['/workspace/repo'];
            },
            getPathsForCommitInRepo() {
                return ['src/modal.js'];
            }
        });

        await actions.generateCommitMessage();
        assert.deepEqual(busyStates, [true, false]);
    } finally {
        if (previousAssistOS === undefined) {
            delete globalThis.assistOS;
        } else {
            globalThis.assistOS = previousAssistOS;
        }
    }
});

test('AI commit generation sends every selected file without a global count limit', async () => {
    const files = Array.from({ length: 85 }, (_, index) => `src/file-${index + 1}.js`);
    const requestedFiles = [];
    let receivedDiffs = [];
    const actions = createCommitMessageActions({
        service: {
            async gitDiff({ file }) {
                requestedFiles.push(file);
                return `+change ${file}`;
            },
            async generateCommitMessage(diffs) {
                receivedDiffs = diffs;
                return JSON.stringify({ ok: true, message: 'Cover every selected file' });
            }
        },
        setStatusLine() {},
        setCommitMessage() {},
        setCommitMessageBusy() {},
        updateCommitButtons() {},
        getSelectedReposForBatch() { return []; },
        getPathsForCommitInRepo() { return []; }
    });

    const message = await actions.generateCommitMessageForSelections([
        { repoPath: '/workspace/repo', files }
    ]);

    assert.equal(message, 'Cover every selected file');
    assert.deepEqual(requestedFiles, files);
    assert.equal(receivedDiffs.length, files.length);
    assert.equal(receivedDiffs.at(-1).filePath, 'src/file-85.js');
});

test('Git commit modal uses one local loader for AI and Git operations', async () => {
    const [source, actions, branches, stash, gitOps, template, styles] = await Promise.all([
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-commit-message.js'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel-actions.js'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-branches.js'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-stash.js'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel.html'),
        readAgentFile('IDE-plugins/git-tool-button/components/git-panel/git-panel.css')
    ]);

    const modalSources = [source, actions, branches, stash, gitOps].join('\n');
    assert.doesNotMatch(modalSources, /withGlobalLoader|globalLoader\.js/);
    assert.match(modalSources, /withPanelLoader/);
    assert.match(template, /data-role="git-panel-loader"/);
    assert.match(template, /data-role="git-panel-loader-label"/);
    assert.match(styles, /\.git-panel\.git-panel-busy \.git-panel-content\s*\{[^}]*filter:\s*blur/s);
    assert.match(styles, /\.git-panel-loader\s*\{[^}]*position:\s*absolute/s);
});
