import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { currentLiveSkillsCase } from './copilot-live-skills-test-fixture.mjs';
import { liveSkillSources, validateLiveSkillsTurn, policyEvidence, liveSkillsHash } from './copilot-live-skills.mjs';

test('SET2 current registered source and installed-link evidence accepts a completed Codex ALA final', () => {
    const input = currentLiveSkillsCase();
    const proof = validateLiveSkillsTurn(input);
    assert.equal(proof.identity.robotId, input.fixture.robotId);
    assert.equal(proof.turnId, input.snapshot.native.turns[0].turnId);
});

test('SET2 descriptor/helper byte updates preserve managed-link revision and expose fresh source-only answers', () => {
    const before = currentLiveSkillsCase();
    const input = currentLiveSkillsCase();
    input.priorRevision = input.snapshot.session.skillExecution.revision;
    input.revisionChange = 'same';
    const first = liveSkillSources(input.fixture, input.fixture.probe, input.workspaceRoot);
    input.fixture.probe.descriptorMarker = randomUUID();
    const descriptor = liveSkillSources(input.fixture, input.fixture.probe, input.workspaceRoot);
    assert.equal(first.helperSha256, descriptor.helperSha256);
    input.fixture.probe.helperMarker = randomUUID();
    const helper = liveSkillSources(input.fixture, input.fixture.probe, input.workspaceRoot);
    assert.equal(descriptor.descriptorSha256, helper.descriptorSha256);
    input.snapshot.capturedFiles[input.fixture.probe.name] = { descriptorSha256: helper.descriptorSha256, helperSha256: helper.helperSha256 };
    const final = input.selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker]).join('\n');
    input.snapshot.session.messages[1].text = input.snapshot.native.turns[0].final = final;
    const receipt = input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`];
    receipt.marker = input.fixture.probe.helperMarker;
    receipt.helperSha256 = helper.helperSha256;
    assert.equal(validateLiveSkillsTurn(input).revision, input.priorRevision);
    assert.notEqual(before.fixture.runId, input.fixture.runId);
});

test('SET2 helper uses canonical execution cwd and records both invoked live link and resolved registered source', () => {
    const input = currentLiveSkillsCase();
    const source = liveSkillSources(input.fixture, input.fixture.probe, input.workspaceRoot);
    assert.ok(source.helper.includes(input.fixture.workspace));
    assert.ok(source.helper.includes(input.fixture.repositoryRoot));
    assert.match(source.helper, /invokedPath, resolvedSource, cwd/);
    assert.doesNotMatch(source.helper, /writeFileSync\("\/workspace\//);
});

test('SET2 policy evidence binds an explicit owned robot and rejects default substitution', () => {
    const input = currentLiveSkillsCase();
    assert.deepEqual(policyEvidence(input.inventory, input.sessionId, input.fixture.robotName), input.expectedPolicy);
    assert.throws(() => policyEvidence({ ...input.inventory, robot: 'default' }, input.sessionId, input.fixture.robotName));
});

for (const [name, corrupt] of Object.entries({
    'no joined ALA turn': input => { input.snapshot.native.turns = []; },
    'foreign ALA turn': input => { input.snapshot.native.turns[0].turnId = randomUUID(); },
    'failed ALA outcome masked by metadata completion': input => { input.snapshot.native.turns[0].status = 'failed'; },
    'no ALA final': input => { input.snapshot.native.turns[0].final = null; },
    'stale ALA turn': input => { input.snapshot.native.turns[0].startedAt = new Date(input.startedAt - 10).toISOString(); },
    'source identity substitution': input => { input.snapshot.session.skillExecution.entries[0].identity = 'unregistered/decoy'; },
    'copied execution representation': input => { input.snapshot.session.skillExecution.live = false; },
    'retargeted physical live link': input => { input.snapshot.liveLinks[input.fixture.probe.name].resolvedSource += '-decoy'; },
    'changed link record without revision': input => { input.snapshot.catalog.links.pop(); },
    'changed byte-edit revision': input => { input.priorRevision = liveSkillsHash('other'); input.revisionChange = 'same'; },
    'unchanged membership revision': input => { input.priorRevision = input.snapshot.catalog.revision; input.revisionChange = 'changed'; },
    'wrong source receipt': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].resolvedSource += '-copy'; },
    'wrong receipt cwd': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].cwd = '/workspace'; },
})) test(`SET2 rejects ${name}`, () => {
    const input = currentLiveSkillsCase(); corrupt(input);
    assert.throws(() => validateLiveSkillsTurn(input));
});
