import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import {
    createLiveSkillsFixture, liveSkillSources, liveSkillsPrompt, conversationFromSettingsURL,
    isCompletedLiveSkillsTurn, validateLiveSkillsTurn, policyEvidence, liveSkillsHash,
} from './copilot-live-skills.mjs';
import { validateLiveSkillsRuntimeBinding } from './copilot-live-skills-runtime.mjs';

// The Box mounts the workspace at its own host path. None of these is the retired /workspace alias,
// except the last, which proves that a root that happens to be /workspace is still just a root.
const ROOT = '/srv/fresh workspace';
const ROOTS = [ROOT, '/Volumes/Ünïcode ws/ñ 数据 café', '/workspace'];

// Build every stage's fixture explicitly from the root so each stage is exercised on its own.
function samePathFixture(root = ROOT) {
    const fixture = createLiveSkillsFixture(root);
    fixture.workspace = path.posix.join(root, fixture.folder);
    return fixture;
}

function completedCase({ disabled = false, root = ROOT } = {}) {
    const fixture = samePathFixture(root);
    const phase = randomUUID();
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const robotRoot = '/data/robots/default-robot';
    const revision = 'a'.repeat(64);
    const selected = disabled ? [fixture.control] : [fixture.control, fixture.probe];
    const available = selected;
    const entries = selected.map(skill => ({ identity: `workspace:${fixture.folder}/.agents/skills/${skill.name}`,
        name: skill.name, fingerprint: liveSkillsHash(liveSkillSources(fixture, skill, root)) }));
    const policy = { mode: 'live', excludedSkills: disabled ? [`workspace:${fixture.folder}/.agents/skills/${fixture.probe.name}`] : [] };
    const inventory = { robot: 'default', scope: 'conversation', sessionId, policy, policyVersion: 3,
        cwd: fixture.workspace, lastRevision: revision, activeRevision: null };
    const native = { version: 1, id: sessionId, home: `${robotRoot}/home`, workspace: fixture.workspace,
        agent: 'codex', continuation: { threadId: randomUUID() } };
    const snapshot = { robotRoot, workspaceRoot: root, native, capturedAt: new Date().toISOString(),
        session: { sessionId, cwd: fixture.workspace, skillPolicyRef: sessionId,
            engine: { type: 'ala', backend: 'codex', sessionId, home: native.home, cwd: fixture.workspace },
            messages: [
                { role: 'user', id: randomUUID(), text: liveSkillsPrompt({ phase, selected }), turnId, status: 'completed' },
                { role: 'assistant', id: randomUUID(), text: selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker]).join('\n'), turnId, status: 'completed' },
            ],
            skillExecution: { active: false, revision, catalogId: revision, catalogPath: `${robotRoot}/runtime/skill-catalogs/${revision}`,
                cwd: fixture.workspace, policyId: sessionId, policyVersion: 3, entries, resolvedSkills: entries.map(entry => entry.identity) },
        },
        catalog: { version: 1, revision, policyVersion: 3, entries: structuredClone(entries) },
        capturedFiles: Object.fromEntries(selected.map(skill => {
            const source = liveSkillSources(fixture, skill, root);
            return [skill.name, { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 }];
        })),
        receipts: Object.fromEntries(selected.map(skill => [`${phase}-${skill.name}.json`, {
            version: 1, runId: fixture.runId, phase, skill: skill.name, marker: skill.helperMarker,
            executedPath: `/workspace/.agents/skills/${skill.name}/receipt.mjs`,
            helperSha256: liveSkillSources(fixture, skill, root).helperSha256, createdAt: new Date().toISOString(), pid: 12,
        }])),
    };
    return { workspaceRoot: root, fixture, phase, selected, available, absent: disabled ? [fixture.probe] : [], sessionId, snapshot, inventory,
        baselineIds: [], priorTurnIds: [], expectedPolicy: policyEvidence(inventory, sessionId), startedAt: Date.now() - 1000, finishedAt: Date.now() + 1000 };
}

test('a native completion proves both current source values, exact captured catalog, receipts and continuation', () => {
    const input = completedCase();
    const proof = validateLiveSkillsTurn(input);
    assert.equal(proof.messageId, input.snapshot.session.messages[1].id);
    assert.equal(proof.native.threadId, input.snapshot.native.continuation.threadId);
    assert.equal(proof.receipts.length, 2);
    assert.ok(!JSON.stringify(proof).includes(input.fixture.probe.helperMarker));
});

test('the negative turn requires a fresh positive control receipt and an absent probe in the captured catalog', () => {
    const input = completedCase({ disabled: true });
    assert.equal(validateLiveSkillsTurn(input).receipts.length, 1);
    delete input.snapshot.receipts[`${input.phase}-${input.fixture.control.name}.json`];
    assert.throws(() => validateLiveSkillsTurn(input), /receipts/);
});

test('descriptor and helper-only edits change distinct consumed values and prompts contain neither answer', () => {
    const fixture = samePathFixture();
    const before = liveSkillSources(fixture, fixture.probe, ROOT);
    const oldDescriptor = fixture.probe.descriptorMarker;
    fixture.probe.descriptorMarker = randomUUID();
    const descriptorChanged = liveSkillSources(fixture, fixture.probe, ROOT);
    assert.notEqual(descriptorChanged.descriptorSha256, before.descriptorSha256);
    assert.equal(descriptorChanged.helperSha256, before.helperSha256);
    assert.ok(!descriptorChanged.descriptor.includes(oldDescriptor));
    fixture.probe.helperMarker = randomUUID();
    const helperChanged = liveSkillSources(fixture, fixture.probe, ROOT);
    assert.equal(helperChanged.descriptorSha256, descriptorChanged.descriptorSha256);
    assert.notEqual(helperChanged.helperSha256, descriptorChanged.helperSha256);
    const prompt = liveSkillsPrompt({ phase: randomUUID(), selected: [fixture.control, fixture.probe] });
    for (const skill of [fixture.control, fixture.probe]) {
        assert.ok(!prompt.includes(skill.descriptorMarker) && !prompt.includes(skill.helperMarker));
        assert.match(liveSkillSources(fixture, skill, ROOT).helper, /flag: 'wx'/);
    }
});

test('the native prompt discovers current catalog paths and requests the bounded approval command forms', () => {
    const fixture = samePathFixture();
    const phase = randomUUID();
    const prompt = liveSkillsPrompt({ phase, selected: [fixture.control, fixture.probe] });
    assert.match(prompt, /Discover the currently registered skill paths from the current catalog/);
    assert.match(prompt, /Use cat to read the selected current SKILL\.md and helper source files/);
    assert.match(prompt, /use ls or ls -la only on the current skill catalog directory or a selected skill's directory/);
    assert.match(prompt, /Use node to run each adjacent receipt helper with the phase UUID as its sole argument/);
    assert.match(prompt, /literal absolute paths and arguments; commands may be sequenced with &&/);
    assert.ok(prompt.includes(phase));
    for (const skill of [fixture.control, fixture.probe]) {
        assert.ok(prompt.includes(skill.name));
        assert.ok(!prompt.includes(skill.descriptorMarker) && !prompt.includes(skill.helperMarker));
        assert.ok(!prompt.includes(`/workspace/.agents/skills/${skill.name}/receipt.mjs`), 'The prompt must require current catalog discovery.');
    }
});

const corruptions = {
    'stale completed assistant': input => { input.baselineIds = [input.snapshot.session.messages[1].id]; },
    'pending native turn': input => { input.snapshot.session.messages[1].status = 'pending'; },
    'failed native turn': input => { input.snapshot.session.messages[1].status = 'failed'; },
    'interrupted native turn': input => { input.snapshot.session.messages[1].status = 'interrupted'; },
    'unreleased execution': input => { input.snapshot.session.skillExecution.active = true; },
    'duplicate new assistant': input => { input.snapshot.session.messages.push({ ...input.snapshot.session.messages[1], id: randomUUID() }); },
    'reused turn id': input => { input.priorTurnIds = [input.snapshot.session.messages[1].turnId]; },
    'wrong persisted prompt': input => { input.snapshot.session.messages[0].text += ' changed'; },
    'expected answer injected in prompt': input => { input.snapshot.session.messages[0].text += input.fixture.probe.helperMarker; },
    'stale descriptor answer': input => { input.fixture.probe.descriptorMarker = randomUUID(); },
    'stale helper answer': input => { input.fixture.probe.helperMarker = randomUUID(); },
    'provider error with answers': input => { input.snapshot.session.messages[1].text += ' UNKNOWN_HOST'; },
    'different browser session': input => { input.sessionId = randomUUID(); },
    'different persisted session': input => { input.snapshot.session.sessionId = randomUUID(); },
    'different native session': input => { input.snapshot.native.id = randomUUID(); },
    'different native home': input => { input.snapshot.native.home += '-other'; },
    'different native workspace': input => { input.snapshot.native.workspace += '-other'; },
    'different backend': input => { input.snapshot.native.agent = 'claude'; },
    'missing native continuation': input => { input.snapshot.native.continuation = {}; },
    'changed native continuation': input => { input.nativeIdentity = { sessionId: input.sessionId,
        home: input.snapshot.native.home, workspace: input.fixture.workspace, agent: 'codex', threadId: randomUUID() }; },
    'fresh inventory substituted for captured catalog': input => { input.snapshot.catalog.revision = 'b'.repeat(64); },
    'different captured path': input => { input.snapshot.session.skillExecution.catalogPath += '-other'; },
    'stale catalog descriptor bytes': input => { input.snapshot.capturedFiles[input.fixture.probe.name].descriptorSha256 = 'b'.repeat(64); },
    'stale catalog helper bytes': input => { input.snapshot.capturedFiles[input.fixture.probe.name].helperSha256 = 'b'.repeat(64); },
    'catalog selection mismatch': input => { input.snapshot.session.skillExecution.resolvedSkills = []; },
    'catalog entry mismatch': input => { input.snapshot.catalog.entries[0].fingerprint = 'b'.repeat(64); },
    'wrong policy version': input => { input.snapshot.session.skillExecution.policyVersion += 1; },
    'wrong policy identity': input => { input.snapshot.session.skillExecution.policyId = randomUUID(); },
    'wrong last revision': input => { input.inventory.lastRevision = 'b'.repeat(64); },
    'active inventory revision': input => { input.inventory.activeRevision = { revision: 'a'.repeat(64) }; },
    'missing fresh receipt': input => { delete input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`]; },
    'copied helper outside registered mount': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].executedPath = '/workspace/copy/receipt.mjs'; },
    'reused catalog after mutation': input => { input.priorRevision = input.snapshot.session.skillExecution.revision; },
    'wrong receipt helper hash': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].helperSha256 = 'b'.repeat(64); },
    'wrong receipt run': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].runId = randomUUID(); },
    'wrong receipt challenge': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].phase = randomUUID(); },
    'stale receipt': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].createdAt = new Date(input.startedAt - 1).toISOString(); },
    'future receipt': input => { input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].createdAt = new Date(input.finishedAt + 1).toISOString(); },
    'replayed receipt': input => { input.priorReceiptNames = Object.keys(input.snapshot.receipts); },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
    test(`rejects ${name}`, () => {
        const input = completedCase();
        corrupt(input);
        assert.throws(() => validateLiveSkillsTurn(input));
    });
}

test('disabled probe cannot remain registered merely because the model ignored it', () => {
    const input = completedCase({ disabled: true });
    const entry = { name: input.fixture.probe.name, identity: `workspace:${input.fixture.folder}/.agents/skills/${input.fixture.probe.name}`, fingerprint: 'c'.repeat(64) };
    input.snapshot.catalog.entries.push(entry);
    input.snapshot.session.skillExecution.entries.push(entry);
    input.snapshot.session.skillExecution.resolvedSkills.push(entry.identity);
    assert.throws(() => validateLiveSkillsTurn(input), /remains in this turn/);
});

test('an excluded probe cannot produce a new receipt during the negative turn', () => {
    const input = completedCase({ disabled: true });
    input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`] = {};
    assert.throws(() => validateLiveSkillsTurn(input), /receipts/);
});

test('prior receipt content cannot be rewritten while keeping its filename', () => {
    const input = completedCase();
    const name = `${randomUUID()}-${input.fixture.control.name}.json`;
    input.priorReceiptNames = [name];
    input.priorReceiptHashes = { [name]: liveSkillsHash({ marker: 'before' }) };
    input.snapshot.receipts[name] = { marker: 'after' };
    assert.throws(() => validateLiveSkillsTurn(input), /prior helper receipt changed/);
});

test('pending polling never treats a previous completed assistant as a new native completion', () => {
    const input = completedCase();
    assert.equal(isCompletedLiveSkillsTurn(input.snapshot, [input.snapshot.session.messages[1].id]), false);
    input.snapshot.session.messages[1].status = 'pending';
    assert.equal(isCompletedLiveSkillsTurn(input.snapshot, []), false);
});

test('settings links bind one browser UUID to the selected application and default robot', () => {
    const id = randomUUID();
    const url = `/explorer/index.html?copilot-robot=default&copilot-session=${id}#file-exp/`;
    assert.equal(conversationFromSettingsURL(url, 'http://127.0.0.1:8088'), id);
    for (const invalid of [url.replace('default', 'other'), url.replace(id, 'bad'), `https://other.example${url}`]) {
        assert.throws(() => conversationFromSettingsURL(invalid, 'http://127.0.0.1:8088'));
    }
    assert.throws(() => conversationFromSettingsURL(url.replace('#', '&dir=other#'), 'http://127.0.0.1:8088'));
});

function runtimeFixture(root = ROOT) {
    const repository = `${root}/.ploinky/repos/AchillesCLI`;
    const runtime = { key: 'owned-runtime', containerId: 'a'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt: new Date().toISOString(), imageId: 'sha256:' + 'b'.repeat(64), mounts: [
            { Type: 'bind', Source: root, Destination: root, RW: true },
            { Type: 'bind', Source: `${root}/.data/roboTeamAgent`, Destination: '/data', RW: true },
            { Type: 'bind', Source: `${repository}/roboTeamAgent`, Destination: `${repository}/roboTeamAgent`, RW: true },
            { Type: 'bind', Source: `${root}/.ploinky/container-runtime/owned-runtime/code-123`, Destination: '/code', RW: true },
            { Type: 'bind', Source: `${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`, Destination: '/Agent', RW: false },
            { Type: 'bind', Source: '/opt/ploinky-agentlib', Destination: '/opt/ploinky-agentlib', RW: false },
        ] };
    return { runtime, repository };
}

test('runtime evidence binds the exact workspace, data and generated code to the selected registry entry', () => {
    const { runtime, repository } = runtimeFixture();
    assert.equal(validateLiveSkillsRuntimeBinding(runtime, repository, { workspaceRoot: ROOT }), runtime);
    for (const mutate of [
        value => { value.mounts[0].Source = '/other'; },
        value => { value.mounts[1].Source = `${ROOT}/.data/other`; },
        value => { value.mounts[2].Source = `${ROOT}/.ploinky/repos/other/roboTeamAgent`; },
        value => { value.mounts[3].Source = `${ROOT}/.ploinky/container-runtime/another/code-123`; },
        value => { value.mounts.push(value.mounts[1]); },
        value => { value.containerId = 'short-id'; },
        value => { value.instanceId = ''; },
    ]) {
        const changed = structuredClone(runtime);
        mutate(changed);
        assert.throws(() => validateLiveSkillsRuntimeBinding(changed, repository, { workspaceRoot: ROOT }));
    }
});

test('native helper writes under the ALA selected-workspace mapping while the observer retains the outer path', () => {
    const fixture = samePathFixture();
    const source = liveSkillSources(fixture, fixture.control, ROOT);
    assert.equal(fixture.workspace, `${ROOT}/${fixture.folder}`);
    assert.ok(source.helper.includes('writeFileSync("/workspace/.receipts/"'));
    assert.ok(!source.helper.includes(`${fixture.workspace}/.receipts`));
    assert.ok(source.helper.includes(fixture.runId), 'Receipt identity remains tied to the run despite the namespace mapping.');
});

// Primary defect: the Box mounts the workspace at its own host path, but the evidence chain required /workspace/<folder>.
for (const root of ROOTS) {
    test(`same-path root ${JSON.stringify(root)} reaches the fixture, source generation and turn validation`, () => {
        const fixture = createLiveSkillsFixture(root);
        assert.equal(fixture.workspace, `${root}/${fixture.folder}`, 'The fixture constructor ignored the admitted root.');
        const source = liveSkillSources(fixture, fixture.control, root);
        assert.match(source.descriptor, new RegExp(`name: ${fixture.control.name}\\n`));
        assert.ok(source.helper.includes('writeFileSync("/workspace/.receipts/"'), 'The ALA-native receipts namespace must stay native.');
        assert.ok(!source.helper.includes(root) || root === '/workspace', 'The outer root must not leak into the native helper.');
        const input = completedCase({ root });
        const proof = validateLiveSkillsTurn(input);
        assert.equal(proof.native.workspace, `${root}/${input.fixture.folder}`);
        assert.equal(proof.receipts.length, 2);
    });
}

test('source generation alone accepts a same-path fixture outside /workspace', () => {
    const fixture = samePathFixture();
    assert.equal(liveSkillSources(fixture, fixture.probe, ROOT).helperSha256.length, 64);
});

test('turn validation alone accepts a same-path completion outside /workspace', () => {
    assert.equal(validateLiveSkillsTurn(completedCase()).phase.length, 36);
});

// Roots the Box admits are one clean absolute same-path host root. Everything else is rejected before any fixture exists.
for (const [label, root] of [
    ['missing', undefined], ['empty', ''], ['relative', 'srv/fresh'], ['filesystem root', '/'], ['trailing slash', '/srv/fresh/'],
    ['doubled slash', '/srv//fresh'], ['dot segment', '/srv/./fresh'], ['traversal', '/srv/../fresh'], ['colon', '/srv/a:b'],
    ['backslash', '/srv/a\\b'], ['newline', '/srv/a\nb'], ['control character', '/srv/a\u0001b'], ['trailing space', '/srv/fresh '],
    ['lone surrogate', '/srv/\ud800'],
]) {
    test(`the fixture constructor rejects a ${label} root`, () => {
        assert.throws(() => createLiveSkillsFixture(root), /clean absolute host path/);
    });
}

test('source generation and turn validation reject a fixture that does not belong to the explicit root', () => {
    const fixture = samePathFixture();
    for (const other of [`${ROOT}-evil`, `${ROOT}/nested`, '/workspace', '/srv/other workspace', `${ROOT}/..`]) {
        assert.throws(() => liveSkillSources(fixture, fixture.control, other), /admitted workspace root|clean absolute host path/, other);
    }
    assert.throws(() => liveSkillSources(fixture, fixture.control), /clean absolute host path/, 'The root is never implicit.');
    const input = completedCase();
    for (const other of [`${ROOT}-evil`, '/workspace', undefined]) {
        assert.throws(() => validateLiveSkillsTurn({ ...input, workspaceRoot: other }), /admitted workspace root|clean absolute host path/, String(other));
    }
    const lookalike = { ...fixture, workspace: `${ROOT}-evil/${fixture.folder}` };
    assert.throws(() => liveSkillSources(lookalike, fixture.control, ROOT), /admitted workspace root/);
    const wrongFolder = { ...fixture, folder: `copilot-live-skills-${randomUUID()}` };
    assert.throws(() => liveSkillSources(wrongFolder, fixture.control, ROOT));
    const traversal = { ...fixture, folder: '../escape', workspace: `${ROOT}/../escape` };
    assert.throws(() => liveSkillSources(traversal, fixture.control, ROOT));
});

const rootCorruptions = {
    'capture taken under another root': input => { input.snapshot.workspaceRoot = '/workspace'; },
    'capture without a root': input => { delete input.snapshot.workspaceRoot; },
    'session cwd under a prefix-lookalike root': input => { input.snapshot.session.cwd = `${ROOT}-evil/${input.fixture.folder}`; },
    'session cwd with traversal': input => { input.snapshot.session.cwd = `${ROOT}/../elsewhere/${input.fixture.folder}`; },
    'session cwd of another run folder': input => { input.snapshot.session.cwd = `${ROOT}/copilot-live-skills-${randomUUID()}`; },
    'session cwd still on the retired alias': input => { input.snapshot.session.cwd = `/workspace/${input.fixture.folder}`; },
    'engine cwd under another root': input => { input.snapshot.session.engine.cwd = `/workspace/${input.fixture.folder}`; },
    'native workspace under another root': input => { input.snapshot.native.workspace = `${ROOT}-evil/${input.fixture.folder}`; },
    'execution cwd under another root': input => { input.snapshot.session.skillExecution.cwd = `/workspace/${input.fixture.folder}`; },
    'inventory cwd under another root': input => { input.inventory.cwd = `${ROOT}/${input.fixture.folder}/..`; },
    'receipt executed from the outer root instead of the native mount': input => {
        input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].executedPath = `${ROOT}/.agents/skills/${input.fixture.probe.name}/receipt.mjs`;
    },
    'receipt executed from the fixture folder': input => {
        input.snapshot.receipts[`${input.phase}-${input.fixture.probe.name}.json`].executedPath = `${input.fixture.workspace}/.agents/skills/${input.fixture.probe.name}/receipt.mjs`;
    },
};
for (const [name, corrupt] of Object.entries(rootCorruptions)) {
    test(`turn validation rejects ${name}`, () => {
        const input = completedCase();
        corrupt(input);
        assert.throws(() => validateLiveSkillsTurn(input));
    });
}

for (const root of ROOTS) {
    test(`the disabled-probe turn is accepted under ${JSON.stringify(root)}`, () => {
        const input = completedCase({ disabled: true, root });
        assert.equal(validateLiveSkillsTurn(input).receipts.length, 1);
    });
}

test('the ALA-native namespaces stay native: receipts directory, executed helper path and runtime locations', () => {
    for (const root of ROOTS) {
        const fixture = samePathFixture(root);
        const { helper } = liveSkillSources(fixture, fixture.control, root);
        assert.ok(helper.includes('writeFileSync("/workspace/.receipts/"'));
        const input = completedCase({ root });
        const receipt = Object.values(input.snapshot.receipts)[0];
        assert.match(receipt.executedPath, /^\/workspace\/\.agents\/skills\/live-[a-f0-9]{8}-(control|probe)\/receipt\.mjs$/);
        assert.equal(input.snapshot.robotRoot, '/data/robots/default-robot');
        assert.ok(input.snapshot.session.skillExecution.catalogPath.startsWith('/data/robots/default-robot/runtime/skill-catalogs/'));
    }
});
