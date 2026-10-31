import assert from 'node:assert/strict';
import test from 'node:test';
import { SPEC_V2_MAX_SKILLS, skillsSelectionDigest, validateSpecificationV2 } from '../server/stateProtocol.mjs';
import { LIMITS } from './helpers/synthetic.mjs';

// T2 (M-22, deltas M2/M8): `specification.skills` in validateSpecificationV2: at most 64 {name, path, required?}, names unique and of the
// skill-name grammar, absolute normalized workspace paths (resolved later by the worker alone), and the recorded selection digest.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 1024 * 1024 });
const base = { version: 2, prompt: 'p', displayText: 'd', sessionId: 's1', turnId: 't1', permissions: 'full-access' };
const withSkills = (skills, digest = skillsSelectionDigest(skills)) => ({ ...base, skills, skillsDigest: digest });
const ok = (spec) => validateSpecificationV2(spec, LIMITS_X);
const refused = (spec, label) => assert.throws(() => validateSpecificationV2(spec, LIMITS_X), (error) => error.code === 'invalid_request', label);

test('skills: accepted shapes, boundaries 0 and 64, a 64-character name, the required flag', () => {
    ok(base);
    ok(withSkills([]));
    ok(withSkills([{ name: 'human-report', path: '/ws/.ploinky/repos/DocumentationSkills/skills/human-report', required: true }, { name: 'search', path: '/ws/team/skills/search' }]));
    ok(withSkills([{ name: 'x'.repeat(64), path: '/ws/a' }]));
    assert.equal(SPEC_V2_MAX_SKILLS, 64);
    ok(withSkills(Array.from({ length: 64 }, (_, i) => ({ name: `s${i}`, path: `/ws/skills/s${i}` }))));
});

test('skills: refusals (65 entries, names, paths, extra keys, the digest)', () => {
    refused(withSkills(Array.from({ length: 65 }, (_, i) => ({ name: `s${i}`, path: `/ws/skills/s${i}` }))), '65 skills');
    for (const name of ['x'.repeat(65), 'naïve', 'skill✓', '.hidden', '-dash', 'a/b', '', '..', 'a b', 7]) refused(withSkills([{ name, path: '/ws/a' }]), `name ${JSON.stringify(name)}`);
    refused(withSkills([{ name: 'a', path: '/ws/a' }, { name: 'a', path: '/ws/b' }]), 'duplicate name');
    for (const path of ['relative/path', '/', '/ws/../etc', '/ws/./a', '/ws//a', '/ws/a/', '/ws/a\u0000', '/ws/\\a', 'x'.repeat(1100)]) refused(withSkills([{ name: 'a', path }]), `path ${JSON.stringify(path).slice(0, 30)}`);
    refused(withSkills([{ name: 'a', path: '/ws/a', required: 'yes' }]), 'required not boolean');
    refused(withSkills([{ name: 'a', path: '/ws/a', access: 'write' }]), 'extra key');
    refused(withSkills([{ name: 'a' }]), 'missing path');
    refused(withSkills('not an array'), 'not an array');
    refused({ ...base, skills: [{ name: 'a', path: '/ws/a' }] }, 'missing digest');
    refused(withSkills([{ name: 'a', path: '/ws/a' }], skillsSelectionDigest([{ name: 'a', path: '/ws/b' }])), 'digest of another selection');
    refused({ ...base, skillsDigest: skillsSelectionDigest([]) }, 'a digest without skills');
});

test('the selection digest is the SHA-256 of the canonical JSON (keys sorted, order kept)', () => {
    const skills = [{ path: '/ws/b', name: 'b', required: true }, { name: 'a', path: '/ws/a' }];
    assert.match(skillsSelectionDigest(skills), /^[0-9a-f]{64}$/u);
    assert.equal(skillsSelectionDigest(skills), skillsSelectionDigest([{ name: 'b', path: '/ws/b', required: true }, { path: '/ws/a', name: 'a' }]));
    assert.notEqual(skillsSelectionDigest(skills), skillsSelectionDigest([...skills].reverse()));
    // RoboTeam builds the same canonical text with JSON.stringify of {name, path, required?} in that key order.
    const roboteam = (list) => JSON.stringify(list.map(({ name, path, required }) => ({ name, path, ...(required ? { required } : {}) })));
    const crypto = { hash: (text) => import('node:crypto').then((m) => m.createHash('sha256').update(text).digest('hex')) };
    return crypto.hash(roboteam(skills)).then((hex) => assert.equal(hex, skillsSelectionDigest(skills)));
});
