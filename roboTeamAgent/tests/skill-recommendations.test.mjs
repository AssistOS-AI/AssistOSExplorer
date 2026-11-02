import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecommendedRepository } from '../public/skills-dialog.js';

test('a recommendation is recognized by its Ploinky repository name', () => {
    const recommendation = { name: 'DocumentationSkills', source: '/workspace/DocumentationSkills', kind: 'skills' };
    assert.equal(hasRecommendedRepository({ repositories: [{ id: 'DocumentationSkills' }] }, recommendation), true);
    assert.equal(hasRecommendedRepository({ repositories: [{ id: 'Other', source: recommendation.source }] }, recommendation), false);
    assert.equal(hasRecommendedRepository({ repositories: [{ id: 'DocumentationSkills', builtin: true }] }, recommendation), false);
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
    assert.deepEqual(recommendations.map(repo => repo.kind), ['skills', 'mixed']);
    assert.equal(recommendations[0].source, '/workspace/Local');
    assert.deepEqual(recommendations[0].warnings, ['skills/incomplete: missing SKILL.md']);
});
