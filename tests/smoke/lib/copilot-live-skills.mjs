import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export const LIVE_SKILLS_TURN_TIMEOUT_MS = 150_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FAILURE = /\[input error\]|\[error\]|UNKNOWN_HOST|Misdirected Request|tier[_\s-]+exhausted|All models in tier exhausted|provider\s+(?:error|failure)|API\s+(?:error|failure)|startup\s+(?:error|failure)/i;

export function liveSkillsHash(value) {
    return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

export function createLiveSkillsFixture() {
    const runId = randomUUID();
    const folder = `copilot-live-skills-${runId}`;
    const prefix = `live-${runId.slice(0, 8)}`;
    const make = (role) => ({ name: `${prefix}-${role}`, descriptorMarker: randomUUID(), helperMarker: randomUUID() });
    return { runId, folder, workspace: `/workspace/${folder}`, control: make('control'), probe: make('probe'), added: make('added') };
}

export function liveSkillSources(fixture, skill) {
    assert.match(fixture.runId, UUID);
    assert.equal(fixture.workspace, `/workspace/copilot-live-skills-${fixture.runId}`);
    assert.match(skill.name, /^live-[a-f0-9]{8}-(control|probe|added)$/);
    assert.match(skill.descriptorMarker, UUID);
    assert.match(skill.helperMarker, UUID);
    const descriptor = `---\nname: ${skill.name}\ndescription: Run the explicit live skills conversation check and produce its fresh receipt.\n---\n\nUse this skill only when named in the current request. The request supplies a phase UUID. Run the receipt.mjs helper adjacent to this SKILL.md with Node.js, passing that UUID as its sole argument. Run the helper exactly once. Use the helper from the currently selected skill catalog. Never write or edit receipts yourself. Report the helper's output and this descriptor value verbatim: ${skill.descriptorMarker}\n`;
    // ALA binds the selected outer folder as native /workspace. Only the observer uses fixture.workspace.
    // The phase is a public challenge. Values used as answers exist only in the descriptor/helper source.
    const helper = `import { createHash } from 'node:crypto';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst phase = process.argv[2];\nif (!${UUID}.test(phase || '') || process.argv.length !== 3) throw new Error('Pass one phase UUID');\nconst marker = ${JSON.stringify(skill.helperMarker)};\nconst receipt = { version: 1, runId: ${JSON.stringify(fixture.runId)}, phase, skill: ${JSON.stringify(skill.name)}, marker, executedPath: fileURLToPath(import.meta.url), helperSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), createdAt: new Date().toISOString(), pid: process.pid };\nwriteFileSync(${JSON.stringify('/workspace/.receipts/')} + phase + '-' + receipt.skill + '.json', JSON.stringify(receipt) + '\\n', { flag: 'wx', mode: 0o600 });\nconsole.log(marker);\n`;
    return { descriptor, helper, descriptorSha256: liveSkillsHash(descriptor), helperSha256: liveSkillsHash(helper) };
}

export function liveSkillsPrompt({ phase, selected }) {
    assert.match(phase, UUID);
    assert.ok(selected.length > 0);
    return `Use each of these currently available skills for phase ${phase}: ${selected.map(skill => skill.name).join(', ')}. Read each selected skill's current instructions, run its adjacent receipt helper once as instructed, and report its current descriptor value and helper output. Use the currently registered skill paths. Do not reuse values or helper paths from earlier turns. Do not create, copy, alter or remove any files yourself; only the selected helpers may write their own receipts. Do not invoke other skills. Finish this turn after reporting the values.`;
}

export function conversationFromSettingsURL(value, origin) {
    const url = new URL(value, origin);
    assert.equal(url.origin, new URL(origin).origin, 'Conversation settings escaped the selected application origin.');
    assert.equal(url.pathname, '/explorer/index.html');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['copilot-robot', 'copilot-session']);
    assert.equal(url.searchParams.get('copilot-robot'), 'default');
    const sessionId = url.searchParams.get('copilot-session');
    assert.match(sessionId, UUID, 'The browser must identify one actual conversation UUID.');
    return sessionId;
}

export function policyEvidence(catalog, sessionId = null) {
    assert.equal(catalog.robot, 'default');
    assert.equal(catalog.scope, sessionId ? 'conversation' : 'defaults');
    assert.equal(catalog.sessionId, sessionId);
    assert.ok(Number.isSafeInteger(catalog.policyVersion));
    assert.ok(catalog.policy && typeof catalog.policy === 'object');
    return { policyVersion: catalog.policyVersion, policySha256: liveSkillsHash(catalog.policy) };
}

export function isCompletedLiveSkillsTurn(snapshot, baselineIds) {
    const assistants = (snapshot.session?.messages || []).filter(message => message.role === 'assistant' && !baselineIds.includes(message.id));
    assert.ok(assistants.length <= 1, 'One browser submit produced multiple assistant turns.');
    if (assistants.length === 0) return false;
    assert.ok(!['failed', 'interrupted'].includes(assistants[0].status), 'The native turn failed or was interrupted.');
    return assistants[0].status === 'completed' && snapshot.session.skillExecution?.active === false;
}

export function validateLiveSkillsTurn({ snapshot, inventory, baselineIds, priorTurnIds, sessionId, nativeIdentity,
    fixture, phase, selected, available, absent = [], startedAt, finishedAt, expectedPolicy, priorReceiptNames = [], priorReceiptHashes = {}, priorRevision }) {
    assert.ok(isCompletedLiveSkillsTurn(snapshot, baselineIds), 'The persisted native turn is not complete.');
    const session = snapshot.session;
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.cwd, fixture.workspace);
    const assistant = session.messages.find(message => message.role === 'assistant' && !baselineIds.includes(message.id));
    assert.match(assistant.id, UUID);
    assert.ok(typeof assistant.turnId === 'string' && assistant.turnId.length > 0);
    assert.ok(!priorTurnIds.includes(assistant.turnId), 'Turn ID was reused.');
    assert.equal(session.messages.filter(message => message.role === 'assistant' && message.turnId === assistant.turnId).length, 1);
    const user = session.messages.filter(message => message.role === 'user' && message.turnId === assistant.turnId);
    assert.equal(user.length, 1);
    assert.equal(user[0].text, liveSkillsPrompt({ phase, selected }), 'Persisted prompt does not match the browser submission.');
    assert.ok(!FAILURE.test(assistant.text || ''), 'Completed assistant text contains a provider/runtime failure.');
    for (const marker of selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker])) {
        assert.ok(!user[0].text.includes(marker), 'An expected answer leaked into the prompt.');
        assert.ok(assistant.text.includes(marker), 'The assistant did not report a current source-only answer.');
    }
    assert.equal(session.engine?.type, 'ala');
    assert.equal(session.engine.backend, 'codex');
    assert.equal(session.engine.sessionId, sessionId);
    assert.equal(session.engine.cwd, fixture.workspace);
    assert.equal(session.engine.home, `${snapshot.robotRoot}/home`);
    const native = snapshot.native;
    assert.equal(native?.id, sessionId);
    assert.equal(native.version, 1);
    assert.equal(native.home, session.engine.home);
    assert.equal(native.workspace, fixture.workspace);
    assert.equal(native.agent, 'codex');
    assert.ok(typeof native.continuation?.threadId === 'string' && native.continuation.threadId.length > 0,
        'Completed deployed turn has no native continuation.');
    const identity = { sessionId, home: native.home, workspace: native.workspace, agent: native.agent, threadId: native.continuation.threadId };
    if (nativeIdentity) assert.deepEqual(identity, nativeIdentity, 'The native conversation changed between phases.');
    const execution = session.skillExecution;
    assert.match(execution.revision, HASH);
    if (priorRevision) assert.notEqual(execution.revision, priorRevision, 'The mutated phase reused the prior captured catalog revision.');
    assert.equal(execution.catalogPath, `${snapshot.robotRoot}/runtime/skill-catalogs/${execution.revision}`);
    assert.equal(execution.catalogId, execution.revision);
    assert.equal(execution.cwd, fixture.workspace);
    assert.equal(execution.policyVersion, expectedPolicy.policyVersion);
    assert.deepEqual(policyEvidence(inventory, sessionId), expectedPolicy);
    assert.equal(inventory.lastRevision, execution.revision, 'Inventory does not refer to this completed turn.');
    assert.equal(inventory.activeRevision, null);
    assert.equal(inventory.cwd, fixture.workspace);
    assert.equal(session.skillPolicyRef, execution.policyId);
    assert.equal(execution.policyId, sessionId);
    assert.equal(snapshot.catalog?.version, 1);
    assert.equal(snapshot.catalog.revision, execution.revision, 'A different catalog was supplied as execution evidence.');
    assert.equal(snapshot.catalog.policyVersion, execution.policyVersion);
    assert.deepEqual(snapshot.catalog.entries, execution.entries);
    assert.deepEqual(execution.resolvedSkills, execution.entries.map(entry => entry.identity));
    assert.equal(new Set(execution.entries.map(entry => entry.name)).size, execution.entries.length);
    for (const skill of available) {
        const entries = execution.entries.filter(entry => entry.name === skill.name);
        assert.equal(entries.length, 1, `Captured execution must include ${skill.name}.`);
        assert.equal(entries[0].identity, `workspace:${fixture.folder}/.agents/skills/${skill.name}`);
        assert.match(entries[0].fingerprint, HASH);
        const source = liveSkillSources(fixture, skill);
        assert.deepEqual(snapshot.capturedFiles[skill.name], { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 },
            `Captured files for ${skill.name} are stale or came from a different source.`);
    }
    for (const skill of absent) {
        assert.ok(!execution.entries.some(entry => entry.name === skill.name || entry.identity === `workspace:${fixture.folder}/.agents/skills/${skill.name}`),
            `Disabled/deleted ${skill.name} remains in this turn's captured catalog.`);
        assert.equal(snapshot.capturedFiles[skill.name], undefined);
    }
    for (const [name, sha256] of Object.entries(priorReceiptHashes)) {
        assert.equal(liveSkillsHash(snapshot.receipts[name]), sha256, 'A prior helper receipt changed.');
    }
    const expectedNames = selected.map(skill => `${phase}-${skill.name}.json`).sort();
    const newReceiptNames = Object.keys(snapshot.receipts).filter(name => !priorReceiptNames.includes(name)).sort();
    assert.deepEqual(newReceiptNames, expectedNames, 'Missing, extra or unexpected helper receipts were produced by this turn.');
    for (const skill of selected) {
        const receipt = snapshot.receipts[`${phase}-${skill.name}.json`];
        assert.equal(receipt.version, 1);
        assert.equal(receipt.runId, fixture.runId);
        assert.equal(receipt.phase, phase);
        assert.equal(receipt.skill, skill.name);
        assert.equal(receipt.marker, skill.helperMarker);
        assert.equal(receipt.executedPath, `/workspace/.agents/skills/${skill.name}/receipt.mjs`,
            'The receipt came from a copied helper outside its selected native skill mount.');
        assert.equal(receipt.helperSha256, liveSkillSources(fixture, skill).helperSha256);
        assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
        assert.ok(Number.isFinite(Date.parse(receipt.createdAt)) && Date.parse(receipt.createdAt) >= startedAt
            && Date.parse(receipt.createdAt) <= finishedAt, 'Receipt is stale or outside the native turn.');
    }
    return { identity, turnId: assistant.turnId, messageId: assistant.id, phase,
        revision: execution.revision, policyId: execution.policyId, policyVersion: execution.policyVersion,
        selected: selected.map(skill => skill.name), available: available.map(skill => skill.name), absent: absent.map(skill => skill.name),
        capturedEntries: execution.entries.filter(entry => [...available, ...absent].some(skill => skill.name === entry.name)),
        receipts: expectedNames.map(name => ({ name, sha256: liveSkillsHash(snapshot.receipts[name]) })),
        assistantSha256: liveSkillsHash(assistant.text), native: identity };
}
