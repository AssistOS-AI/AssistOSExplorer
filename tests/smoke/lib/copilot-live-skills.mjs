import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { assertBoxWorkspacePath } from './box-workspace.mjs';

export const LIVE_SKILLS_TURN_TIMEOUT_MS = 150_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FAILURE = /\[input error\]|\[error\]|UNKNOWN_HOST|Misdirected Request|tier[_\s-]+exhausted|All models in tier exhausted|provider\s+(?:error|failure)|API\s+(?:error|failure)|startup\s+(?:error|failure)/i;

export function liveSkillsHash(value) {
    return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

// Observer and native execution use the same canonical selected workspace path.
export function liveSkillsWorkspace(workspaceRoot, folder) {
    assert.match(folder, /^copilot-live-skills-[0-9a-f-]{36}$/);
    return path.posix.join(assertBoxWorkspacePath(workspaceRoot), folder);
}

export function createLiveSkillsFixture(workspaceRoot) {
    const runId = randomUUID();
    const folder = `copilot-live-skills-${runId}`;
    const prefix = `live-${runId.slice(0, 8)}`;
    const make = (role) => ({ name: `${prefix}-${role}`, descriptorMarker: randomUUID(), helperMarker: randomUUID() });
    const repositoryName = `copilot-live-source-${runId}`;
    const workspace = liveSkillsWorkspace(workspaceRoot, folder);
    const repositoryRoot = path.posix.join(workspaceRoot, repositoryName);
    return { runId, folder, workspace, robotId: null, robotName: `copilot-live-${runId}`, repositoryName, repositoryRoot,
        ownedPaths: [workspace, repositoryRoot], control: make('control'), probe: make('probe'), added: make('added') };
}

export function liveSkillSources(fixture, skill, workspaceRoot) {
    assert.match(fixture.runId, UUID);
    assert.equal(fixture.folder, `copilot-live-skills-${fixture.runId}`);
    assert.equal(fixture.workspace, liveSkillsWorkspace(workspaceRoot, fixture.folder), 'The fixture is not under the admitted workspace root.');
    assert.equal(fixture.repositoryName, `copilot-live-source-${fixture.runId}`);
    assert.equal(fixture.repositoryRoot, `${workspaceRoot}/${fixture.repositoryName}`);
    assert.equal(fixture.robotName, `copilot-live-${fixture.runId}`);
    assert.match(skill.name, /^live-[a-f0-9]{8}-(control|probe|added)$/);
    assert.ok(skill.name.startsWith(`live-${fixture.runId.slice(0, 8)}-`));
    assert.match(skill.descriptorMarker, UUID);
    assert.match(skill.helperMarker, UUID);
    const descriptor = `---\nname: ${skill.name}\ndescription: Run the explicit live skills conversation check and produce its fresh receipt.\n---\n\nUse this skill only when named in the current request. The request supplies a phase UUID. Run the receipt.mjs helper through its installed live link at ${fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs with Node.js, passing that UUID as its sole argument. Run the helper exactly once. Use the helper from the currently selected skill catalog. Never write or edit receipts yourself. Report the helper's output and this descriptor value verbatim: ${skill.descriptorMarker}\n`;
    // The public challenge is separate from values available only in current descriptor/helper bytes.
    // Node resolves import.meta.url through the live link; argv[1] records the invoked link.
    const helper = `import { createHash } from 'node:crypto';\nimport { readFileSync, writeFileSync, realpathSync } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst phase = process.argv[2];\nif (!${UUID}.test(phase || '') || process.argv.length !== 3) throw new Error('Pass one phase UUID');\nconst marker = ${JSON.stringify(skill.helperMarker)};\nconst cwd = realpathSync(process.cwd());\nif (cwd !== ${JSON.stringify(fixture.workspace)}) throw new Error('Unexpected execution folder');\nconst invokedPath = path.resolve(process.argv[1]);\nconst resolvedSource = fileURLToPath(import.meta.url);\nif (invokedPath !== path.join(cwd, '.agents', 'skills', ${JSON.stringify(skill.name)}, 'receipt.mjs') || realpathSync(invokedPath) !== resolvedSource || resolvedSource !== ${JSON.stringify(path.posix.join(fixture.repositoryRoot, 'skills', skill.name, 'receipt.mjs'))}) throw new Error('Unexpected live skill source');\nconst receipt = { version: 2, runId: ${JSON.stringify(fixture.runId)}, phase, skill: ${JSON.stringify(skill.name)}, marker, invokedPath, resolvedSource, cwd, helperSha256: createHash('sha256').update(readFileSync(resolvedSource)).digest('hex'), createdAt: new Date().toISOString(), pid: process.pid };\nwriteFileSync(path.join(cwd, '.receipts', phase + '-' + receipt.skill + '.json'), JSON.stringify(receipt) + '\\n', { flag: 'wx', mode: 0o600 });\nconsole.log(marker);\n`;
    return { descriptor, helper, descriptorSha256: liveSkillsHash(descriptor), helperSha256: liveSkillsHash(helper) };
}

export function liveSkillsPrompt({ phase, selected }) {
    assert.match(phase, UUID);
    assert.ok(selected.length > 0);
    return `Use each of these currently available skills for phase ${phase}: ${selected.map(skill => skill.name).join(', ')}. Read each selected skill's current instructions, run its adjacent receipt helper once as instructed, and report its current descriptor value and helper output. Discover the currently registered skill paths from the current catalog. Use cat to read the selected current SKILL.md and helper source files. If a directory listing is needed, use ls or ls -la only on the current skill catalog directory or a selected skill's directory. Use node to run each adjacent receipt helper with the phase UUID as its sole argument, as instructed by that skill. Use literal absolute paths and arguments; commands may be sequenced with &&. Use only these command forms for this check. Do not reuse values or helper paths from earlier turns. Do not create, copy, alter or remove any files yourself; only the selected helpers may write their own receipts. Do not invoke other skills. Finish this turn after reporting the values.`;
}

export function policyEvidence(catalog, sessionId = null, robotName) {
    assert.ok(typeof robotName === 'string' && robotName !== 'default', 'An explicit owned robot name is required.');
    assert.equal(catalog.robot, robotName);
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
    fixture, workspaceRoot, phase, selected, available, absent = [], startedAt, finishedAt, expectedPolicy, priorReceiptNames = [], priorReceiptHashes = {}, priorRevision, revisionChange }) {
    assert.ok(isCompletedLiveSkillsTurn(snapshot, baselineIds), 'The persisted native turn is not complete.');
    // Both the capture metadata and every persisted cwd must follow the one admitted root.
    const workspace = liveSkillsWorkspace(workspaceRoot, fixture.folder);
    assert.equal(fixture.workspace, workspace, 'The fixture is not under the admitted workspace root.');
    assert.equal(snapshot.workspaceRoot, workspaceRoot, 'The runtime capture used a different workspace root.');
    const session = snapshot.session;
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.cwd, workspace);
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
    assert.equal(session.engine.version, 1);
    assert.equal(session.engine.backend, 'codex');
    assert.equal(session.engine.sessionId, sessionId);
    assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/, 'An explicit owned robot ID is required.');
    assert.equal(snapshot.robot.id, fixture.robotId);
    assert.equal(snapshot.robot.name, fixture.robotName);
    assert.equal(snapshot.robot.repository.name, fixture.repositoryName);
    assert.equal(snapshot.robot.repository.source, fixture.repositoryRoot);
    assert.match(snapshot.robot.repository.generation, UUID);
    assert.equal(session.engine.robotId, fixture.robotId);
    assert.equal(session.engine.cwd, workspace);
    assert.equal(session.engine.home, `${snapshot.robotRoot}/home`);
    const native = snapshot.native;
    assert.equal(native?.id, sessionId);
    assert.equal(native.home, session.engine.home);
    assert.equal(native.workspace, workspace);
    assert.equal(native.agent, 'codex');
    assert.ok(typeof native.continuation?.threadId === 'string' && native.continuation.threadId.length > 0,
        'Completed deployed turn has no native continuation.');
    const nativeTurns = native.turns.filter(turn => turn.turnId === assistant.turnId);
    assert.equal(nativeTurns.length, 1, 'Browser message must join exactly one ALA turn.');
    assert.equal(nativeTurns[0].status, 'completed');
    const nativeFinal = nativeTurns[0].final;
    assert.equal(typeof nativeFinal, 'string', 'Completed turn lacks an ALA final record.');
    const presentations = (session.presentations || []).filter(presentation => presentation.turnId === assistant.turnId
        || presentation.assistantMessageId === assistant.id);
    assert.ok(presentations.length <= 1, 'Completed message has ambiguous presentation metadata.');
    let displayedFinal = nativeFinal;
    if (presentations.length) {
        const [presentation] = presentations;
        assert.equal(presentation.turnId, assistant.turnId, 'Thinking link belongs to another turn.');
        assert.equal(presentation.assistantMessageId, assistant.id, 'Thinking link belongs to another message.');
        assert.equal(presentation.thinkingUrl, `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${sessionId}/${assistant.id}`,
            'Thinking link must name this session and assistant message on the supported route.');
        displayedFinal += `\n\n[View Thinking](${presentation.thinkingUrl})`;
    }
    assert.equal(assistant.text, displayedFinal, 'Completed presentation must contain the exact ALA final and its bound thinking link.');
    assert.ok(!FAILURE.test(nativeFinal), 'Completed native final contains a provider/runtime failure.');
    for (const marker of selected.flatMap(skill => [skill.descriptorMarker, skill.helperMarker])) {
        assert.ok(nativeFinal.includes(marker), 'The native final did not report a current source-only answer.');
    }
    assert.equal(nativeTurns[0].user, user[0].text);
    const nativeStarted = Date.parse(nativeTurns[0].startedAt), nativeEnded = Date.parse(nativeTurns[0].endedAt);
    assert.ok(nativeStarted >= startedAt && nativeStarted <= nativeEnded && nativeEnded <= finishedAt, 'ALA turn is stale or outside this submission.');
    const identity = { sessionId, robotId: fixture.robotId, home: native.home, workspace: native.workspace, agent: native.agent, threadId: native.continuation.threadId };
    if (nativeIdentity) assert.deepEqual(identity, nativeIdentity, 'The native conversation changed between phases.');
    const execution = session.skillExecution;
    assert.match(execution.revision, HASH);
    assert.equal(execution.live, true, 'Execution must use installed live skills.');
    if (priorRevision) {
        assert.ok(['same', 'changed'].includes(revisionChange), 'Declare whether link membership changed.');
        if (revisionChange === 'same') assert.equal(execution.revision, priorRevision, 'Byte edits changed installed-link revision.');
        else assert.notEqual(execution.revision, priorRevision, 'Changed membership reused installed-link revision.');
    }
    assert.equal(execution.policyVersion, expectedPolicy.policyVersion);
    assert.deepEqual(policyEvidence(inventory, sessionId, fixture.robotName), expectedPolicy);
    assert.equal(inventory.lastRevision, execution.revision, 'Inventory does not refer to this completed turn.');
    assert.equal(inventory.activeRevision, null);
    assert.equal(inventory.cwd, workspace);
    assert.equal(session.skillPolicyRef, sessionId);
    assert.equal(snapshot.catalog.revision, execution.revision, 'A different link record was supplied as execution evidence.');
    assert.equal(liveSkillsHash(snapshot.catalog.links), execution.revision, 'Revision must identify managed installed links.');
    assert.deepEqual(snapshot.catalog.entries, execution.entries);
    assert.equal(new Set(execution.entries.map(entry => entry.name)).size, execution.entries.length);
    assert.ok(selected.length > 0 && selected.every(skill => available.some(entry => entry.name === skill.name)), 'Selected helper must be available in this turn.');
    for (const skill of available) {
        const entries = execution.entries.filter(entry => entry.name === skill.name);
        assert.equal(entries.length, 1, `Captured execution must include ${skill.name}.`);
        assert.equal(entries[0].identity, `${fixture.repositoryName}/${skill.name}`);
        assert.match(entries[0].fingerprint, HASH);
        assert.equal(entries[0].source, fixture.repositoryName);
        assert.equal(entries[0].sourcePath, `${fixture.repositoryRoot}/skills/${skill.name}`);
        const link = snapshot.catalog.links.filter(link => link.destination === `${workspace}/.agents/skills/${skill.name}`);
        assert.equal(link.length, 1, 'Selected source lacks a managed installed link.');
        assert.equal(link[0].repoName, fixture.repositoryName);
        assert.equal(link[0].sourcePath, `skills/${skill.name}`);
        assert.equal(path.posix.resolve(path.posix.dirname(link[0].destination), link[0].linkTarget), entries[0].sourcePath);
        assert.equal(snapshot.liveLinks[skill.name].destination, link[0].destination);
        assert.equal(snapshot.liveLinks[skill.name].linkTarget, link[0].linkTarget);
        assert.equal(snapshot.liveLinks[skill.name].resolvedSource, entries[0].sourcePath);
        const source = liveSkillSources(fixture, skill, workspaceRoot);
        assert.deepEqual(snapshot.capturedFiles[skill.name], { descriptorSha256: source.descriptorSha256, helperSha256: source.helperSha256 },
            `Captured files for ${skill.name} are stale or came from a different source.`);
    }
    for (const skill of absent) {
        assert.ok(!execution.entries.some(entry => entry.name === skill.name || entry.identity === `${fixture.repositoryName}/${skill.name}`),
            `Disabled/deleted ${skill.name} remains in this turn's captured catalog.`);
        assert.equal(snapshot.capturedFiles[skill.name], undefined);
        assert.ok(!snapshot.catalog.links.some(link => link.destination === `${workspace}/.agents/skills/${skill.name}`));
        assert.equal(snapshot.liveLinks[skill.name], undefined);
    }
    for (const [name, sha256] of Object.entries(priorReceiptHashes)) {
        assert.equal(liveSkillsHash(snapshot.receipts[name]), sha256, 'A prior helper receipt changed.');
    }
    const expectedNames = selected.map(skill => `${phase}-${skill.name}.json`).sort();
    const newReceiptNames = Object.keys(snapshot.receipts).filter(name => !priorReceiptNames.includes(name)).sort();
    assert.deepEqual(newReceiptNames, expectedNames, 'Missing, extra or unexpected helper receipts were produced by this turn.');
    for (const skill of selected) {
        const receipt = snapshot.receipts[`${phase}-${skill.name}.json`];
        assert.equal(receipt.version, 2);
        assert.equal(receipt.runId, fixture.runId);
        assert.equal(receipt.phase, phase);
        assert.equal(receipt.skill, skill.name);
        assert.equal(receipt.marker, skill.helperMarker);
        assert.equal(receipt.invokedPath, `${workspace}/.agents/skills/${skill.name}/receipt.mjs`, 'The receipt came from a copied helper outside its installed live link.');
        assert.equal(receipt.resolvedSource, `${fixture.repositoryRoot}/skills/${skill.name}/receipt.mjs`);
        assert.equal(receipt.cwd, workspace);
        assert.equal(receipt.helperSha256, liveSkillSources(fixture, skill, workspaceRoot).helperSha256);
        assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
        assert.ok(Number.isFinite(Date.parse(receipt.createdAt)) && Date.parse(receipt.createdAt) >= startedAt
            && Date.parse(receipt.createdAt) <= finishedAt, 'Receipt is stale or outside the native turn.');
    }
    return { identity, turnId: assistant.turnId, messageId: assistant.id, phase,
        revision: execution.revision, policyId: session.skillPolicyRef, policyVersion: execution.policyVersion,
        selected: selected.map(skill => skill.name), available: available.map(skill => skill.name), absent: absent.map(skill => skill.name),
        capturedEntries: execution.entries.filter(entry => [...available, ...absent].some(skill => skill.name === entry.name)),
        receipts: expectedNames.map(name => ({ name, sha256: liveSkillsHash(snapshot.receipts[name]) })),
        assistantSha256: liveSkillsHash(assistant.text), nativeFinalSha256: liveSkillsHash(nativeFinal), native: identity };
}
