import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getGithubRepositoryApiUrl,
    getGithubRepositoryCreateUrl,
    parseGithubRepositoryRemote
} from '../../IDE-plugins/git-tool-button/components/git-panel/github-remote-utils.js';

test('parseGithubRepositoryRemote returns canonical GitHub HTTPS remote details', () => {
    assert.deepEqual(
        parseGithubRepositoryRemote('https://github.com/AssistosTest/rrrr.git/'),
        {
            owner: 'AssistosTest',
            repo: 'rrrr',
            canonicalUrl: 'https://github.com/AssistosTest/rrrr.git',
            transport: 'https',
        }
    );
});

test('parseGithubRepositoryRemote returns canonical GitHub SSH remote details', () => {
    assert.deepEqual(
        parseGithubRepositoryRemote('git@github.com:AssistosTest/rrrr.git/'),
        {
            owner: 'AssistosTest',
            repo: 'rrrr',
            canonicalUrl: 'git@github.com:AssistosTest/rrrr.git',
            transport: 'ssh',
        }
    );
});

test('getGithubRepositoryCreateUrl creates under authenticated user only when owner matches login', () => {
    assert.equal(
        getGithubRepositoryCreateUrl('AssistosTest', 'AssistosTest'),
        'https://api.github.com/user/repos'
    );
    assert.equal(
        getGithubRepositoryCreateUrl('AssistosTest', 'adrian'),
        'https://api.github.com/orgs/AssistosTest/repos'
    );
});

test('getGithubRepositoryApiUrl encodes owner and repository path segments', () => {
    assert.equal(
        getGithubRepositoryApiUrl('AssistosTest', 'repo.name'),
        'https://api.github.com/repos/AssistosTest/repo.name'
    );
});
