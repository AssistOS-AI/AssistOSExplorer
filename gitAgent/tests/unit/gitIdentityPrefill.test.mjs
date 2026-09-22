import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPrefilledGitIdentityState,
    getEffectiveGitIdentity
} from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-utils.js';

test('buildPrefilledGitIdentityState uses GitHub identity even without an explicit repo path', () => {
    const result = buildPrefilledGitIdentityState({
        identityPrompt: {
            visible: true,
            repoPath: null,
            pendingAction: null,
            name: '',
            email: ''
        },
        repoPath: '',
        rememberedIdentity: { name: '', email: '' },
        githubUser: {
            login: 'skutner',
            name: 'Sava Daniel',
            email: 'sava.dumitru.daniel@gmail.com'
        },
        authMethod: 'github'
    });

    assert.deepEqual(result.identityPrompt, {
        visible: true,
        repoPath: null,
        pendingAction: null,
        name: 'skutner',
        email: 'sava.dumitru.daniel@gmail.com'
    });
    assert.deepEqual(result.credentialsBaseline, {
        name: 'skutner',
        email: 'sava.dumitru.daniel@gmail.com',
        authMethod: 'github'
    });
});

test('buildPrefilledGitIdentityState preserves a selected repo path when present', () => {
    const result = buildPrefilledGitIdentityState({
        identityPrompt: {
            visible: true,
            repoPath: '/workspace/demo-repo',
            pendingAction: null,
            name: '',
            email: ''
        },
        repoPath: '',
        rememberedIdentity: { name: '', email: '' },
        githubUser: {
            login: 'skutner',
            name: 'Sava Daniel',
            email: 'sava.dumitru.daniel@gmail.com'
        },
        authMethod: 'github'
    });

    assert.equal(result.identityPrompt.repoPath, '/workspace/demo-repo');
    assert.equal(result.identityPrompt.name, 'skutner');
    assert.equal(result.identityPrompt.email, 'sava.dumitru.daniel@gmail.com');
});

test('getEffectiveGitIdentity uses the same GitHub fallback shown in Authentication', () => {
    const result = getEffectiveGitIdentity({
        identityPrompt: { name: '', email: '' },
        rememberedIdentity: { name: '', email: '' },
        githubAuth: {
            connected: true,
            connection: {
                source: 'github',
                user: {
                    login: 'octocat',
                    name: 'Mona Lisa',
                    email: 'octocat@example.com'
                }
            }
        }
    });

    assert.deepEqual(result, {
        name: 'octocat',
        email: 'octocat@example.com'
    });
});

test('getEffectiveGitIdentity prefers typed prompt values over saved values', () => {
    const result = getEffectiveGitIdentity({
        identityPrompt: { name: 'Current User', email: 'current@example.com' },
        rememberedIdentity: { name: 'Old User', email: 'old@example.com' },
        githubAuth: {
            connected: true,
            connection: {
                source: 'github',
                user: { login: 'octocat', email: 'octocat@example.com' }
            }
        }
    });

    assert.deepEqual(result, {
        name: 'Current User',
        email: 'current@example.com'
    });
});
