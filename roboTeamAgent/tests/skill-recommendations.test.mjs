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
