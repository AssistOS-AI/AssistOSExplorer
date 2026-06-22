import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSkillsManifestPath,
    isMissingManifestError,
    PRECONFIGURED_SKILL_REPOSITORIES,
    parseSkillsManifest,
    serializeSkillsManifest,
    validateRepositoryUrl
} from '../achilles-cli/IDE-plugins/edit-skills-manifest/skills-manifest-utils.mjs';

test('skills manifest utilities parse and serialize repository arrays', () => {
    const repositories = parseSkillsManifest(JSON.stringify([
        ' https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git ',
        'git@github.com:AssistOS-AI/private-skills.git'
    ]));

    assert.deepEqual(repositories, [
        'https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git',
        'git@github.com:AssistOS-AI/private-skills.git'
    ]);
    assert.equal(
        serializeSkillsManifest(repositories),
        '[\n  "https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git",\n  "git@github.com:AssistOS-AI/private-skills.git"\n]\n'
    );
});

test('skills manifest utilities reject invalid manifest shapes', () => {
    assert.throws(() => parseSkillsManifest('{"repo":"https://example.test/repo.git"}'), /expected a JSON array/);
    assert.throws(() => parseSkillsManifest('[42]'), /must be a string/);
    assert.throws(() => parseSkillsManifest('[""]'), /is empty/);
});

test('skills manifest repository URL validation accepts git remotes and rejects duplicates', () => {
    assert.deepEqual(
        validateRepositoryUrl(' https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git ', []),
        { ok: true, value: 'https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git' }
    );
    assert.equal(validateRepositoryUrl('', []).ok, false);
    assert.equal(validateRepositoryUrl('not a url', []).ok, false);
    assert.equal(
        validateRepositoryUrl('git@github.com:AssistOS-AI/private-skills.git', ['git@github.com:AssistOS-AI/private-skills.git']).ok,
        false
    );
});

test('skills manifest path and missing-file detection are stable', () => {
    assert.equal(
        buildSkillsManifestPath('/workspace/project/'),
        '/workspace/project/ploinky-skills-manifest.json'
    );
    assert.equal(isMissingManifestError(new Error('ENOENT: no such file or directory')), true);
    assert.equal(isMissingManifestError(new Error('Invalid JSON')), false);
});

test('skills manifest plugin exposes the default suggested repository', () => {
    assert.deepEqual(PRECONFIGURED_SKILL_REPOSITORIES, [
        {
            label: 'Achilles Copilot Basic Skills',
            url: 'https://github.com/AssistOS-AI/AchillesCopilotBasicSkills.git'
        }
    ]);
});
