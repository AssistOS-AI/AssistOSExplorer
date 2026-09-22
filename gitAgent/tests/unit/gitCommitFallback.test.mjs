import test from 'node:test';
import assert from 'node:assert/strict';

import {
    humanizeGitError,
    isGitAuthError,
    isLlmUnavailableError,
    buildFallbackCommitMessage,
    buildEditableFallbackCommitMessage
} from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-utils.js';

test('isLlmUnavailableError matches missing model configuration failures', () => {
    assert.equal(
        isLlmUnavailableError('No LLM models are configured in /code/node_modules/achillesAgentLib/LLMConfig.json.'),
        true
    );
    assert.equal(isLlmUnavailableError('No default LLM agent available.'), true);
    assert.equal(isLlmUnavailableError('Authentication failed.'), false);
});

test('missing GitHub token for remote creation is treated as an auth error', () => {
    const message = 'GitHub authentication is required to create the remote repository.';
    assert.equal(isGitAuthError(message), true);
    assert.equal(
        humanizeGitError(message, { action: 'push' }),
        'Authentication required. Connect GitHub or enter your token to create the remote repository.'
    );
});

test('buildFallbackCommitMessage uses specific filenames for a single repo selection', () => {
    assert.equal(
        buildFallbackCommitMessage([
            {
                repoPath: '/workspace/demo-repo',
                files: ['/workspace/demo-repo/README.md']
            }
        ]),
        'Update README.md'
    );

    assert.equal(
        buildFallbackCommitMessage([
            {
                repoPath: '/workspace/demo-repo',
                files: [
                    '/workspace/demo-repo/README.md',
                    '/workspace/demo-repo/src/index.js',
                    '/workspace/demo-repo/src/utils.js'
                ]
            }
        ]),
        'Update README.md and 2 more files'
    );
});

test('buildFallbackCommitMessage summarizes multi-repo selections', () => {
    assert.equal(
        buildFallbackCommitMessage([
            {
                repoPath: '/workspace/repo-a',
                files: ['/workspace/repo-a/README.md']
            },
            {
                repoPath: '/workspace/repo-b',
                files: ['/workspace/repo-b/index.js']
            }
        ]),
        'Sync changes across 2 repositories'
    );
});

test('buildEditableFallbackCommitMessage includes the complete affected file list', () => {
    const message = buildEditableFallbackCommitMessage([
        {
            repoPath: '/workspace/demo-repo',
            files: [
                'README.md',
                'src/index.js',
                'src/utils/helpers.js'
            ]
        }
    ]);

    assert.equal(
        message,
        [
            'Update selected files',
            '',
            'Affected files:',
            '- README.md',
            '- src/index.js',
            '- src/utils/helpers.js'
        ].join('\n')
    );
});

test('buildEditableFallbackCommitMessage preserves distinct relative paths', () => {
    const message = buildEditableFallbackCommitMessage([
        {
            repoPath: '/workspace/demo-repo',
            files: [
                '/workspace/demo-repo/client/index.js',
                '/workspace/demo-repo/server/index.js',
                '/workspace/demo-repo/client/index.js'
            ]
        }
    ]);

    assert.equal(message.includes('- client/index.js'), true);
    assert.equal(message.includes('- server/index.js'), true);
    assert.equal(message.match(/client\/index\.js/g)?.length, 1);
});

test('buildEditableFallbackCommitMessage is not empty for valid selections', () => {
    const message = buildEditableFallbackCommitMessage([
        {
            repoPath: '/workspace/demo-repo',
            files: ['package.json']
        }
    ]);

    assert.equal(Boolean(message.trim()), true);
});
