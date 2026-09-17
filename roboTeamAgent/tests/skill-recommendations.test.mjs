import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecommendedRepository } from '../public/skills-dialog.js';

const recommendation = { source: '/workspace/DocumentationSkills', url: 'https://github.com/AssistOS-AI/DocumentationSkills.git' };

test('recommendations recognize existing local and Git registrations on the current robot', () => {
    for (const source of [recommendation.source, `${recommendation.source}/`, recommendation.url,
        'https://github.com/AssistOS-AI/DocumentationSkills', 'https://github.com/AssistOS-AI/DocumentationSkills.git/']) {
        assert.equal(hasRecommendedRepository({ repositories: [{ source }] }, recommendation), true, source);
    }
    assert.equal(hasRecommendedRepository({ repositories: [{ source: 'https://github.com/another-owner/DocumentationSkills.git' }] }, recommendation), false);
    assert.equal(hasRecommendedRepository({ repositories: [] }, recommendation), false);
});

test('recommendations include workspace-only repositories with no remote and mixed repositories', async () => {
    const { loadSkillRecommendations } = await import('../public/skills-dialog.js');
    const recommendations = await loadSkillRecommendations(async () => ({
        ok: true, json: async () => ({ marketplace: { repositories: [
            { name: 'Local', kind: 'skills', warnings: ['skills/incomplete: missing SKILL.md'], skillSource: { source: '/workspace/Local', origin: 'workspace' } },
            { name: 'Mixed', kind: 'mixed', url: 'https://example.com/mixed.git' },
            { name: 'Agents', kind: 'agents', url: 'https://example.com/agents.git' }
        ] } })
    }));
    assert.deepEqual(recommendations.map(repo => repo.name), ['Local', 'Mixed']);
    assert.equal(recommendations[0].source, '/workspace/Local');
    assert.deepEqual(recommendations[0].warnings, ['skills/incomplete: missing SKILL.md']);
});
