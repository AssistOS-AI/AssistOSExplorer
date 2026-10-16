import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateMountedRequiredSkills } from '../server/required-skills.mjs';

async function fixture(t, descriptor = '---\nname: human-report\ndescription: Final response\n---\nReport.') {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'required-skills-startup-'));
    const root = await fs.realpath(temporary);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repository = path.join(root, 'DocumentationSkills');
    const skill = path.join(repository, 'skills/human-report');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), descriptor);
    const linked = path.join(root, 'linked');
    await fs.symlink(repository, linked, 'dir');
    return { root, repository, skill, linked };
}

test('startup validates the mounted dependency through its Agent link without a marketplace request', async t => {
    const f = await fixture(t);
    const entry = await validateMountedRequiredSkills({ repositoryPath: f.linked });
    assert.equal(entry.owner, f.repository);
    assert.equal(entry.sourcePath, f.skill);
    assert.equal(entry.name, 'human-report');
    assert.equal(entry.required, true);
    assert.equal(entry.readOnly, true);
});

test('a workspace checkout cannot satisfy startup when its container mount is missing', async t => {
    const f = await fixture(t);
    await assert.rejects(validateMountedRequiredSkills({ repositoryPath: path.join(f.root, 'unmounted') }),
        /Required DocumentationSkills\/human-report dependency is unavailable:.*ENOENT/);
});

test('missing required skill prevents startup even when the repository is mounted', async t => {
    const f = await fixture(t);
    await fs.rm(f.skill, { recursive: true });
    await assert.rejects(validateMountedRequiredSkills({ repositoryPath: f.linked }),
        /Required DocumentationSkills\/human-report dependency is unavailable:.*ENOENT/);
});

test('invalid or incorrectly named required descriptors prevent startup', async t => {
    const f = await fixture(t, '---\nname: another-skill\ndescription: Final response\n---\nReport.');
    await assert.rejects(validateMountedRequiredSkills({ repositoryPath: f.linked }), /invalid name/);
    await fs.writeFile(path.join(f.skill, 'SKILL.md'), 'No descriptor');
    await assert.rejects(validateMountedRequiredSkills({ repositoryPath: f.linked }), /Anthropic skill descriptor/);
});

test('startup rejects a required skill escaping its mounted repository', async t => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await fs.rename(f.skill, outside);
    await fs.symlink(outside, f.skill, 'dir');
    await assert.rejects(validateMountedRequiredSkills({ repositoryPath: f.linked }), /outside its repository/);
});
