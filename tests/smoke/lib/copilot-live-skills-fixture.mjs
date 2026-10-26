import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSkillSources, liveSkillsHash, liveSkillsWorkspace, UUID } from './copilot-live-skills.mjs';

// The release verifier the canonical runner hands to every child (scripts/run-playwright.mjs), from this file's own location.
export const LIVE_SKILLS_RELEASE_VERIFIER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../ploinky/tests/release/verifyExplorerReleaseBundle.mjs');

const absoluteNormalized = value => typeof value === 'string' && value !== '' && !value.includes('\0') && path.isAbsolute(value) && path.normalize(value) === value;

// The C5 gate runs only under the route-A parent (`CODEX_TEST_AUTH_GATE=c5 node ./scripts/codex-test-auth.mjs run`), which owns the
// credential, the leak scan and the watchdog. Pure: no file system or network access. The message names variables only, never values.
// The checks run in a fixed order and the first unmet one is reported.
export function assertLiveSkillsLivePreflight(env = process.env, { expectedVerifier = LIVE_SKILLS_RELEASE_VERIFIER } = {}) {
    const refuse = detail => { throw new Error(`C5 live skills preflight refused: ${detail}. Launch it through CODEX_TEST_AUTH_GATE=c5 node ./scripts/codex-test-auth.mjs run.`); };
    const value = name => (typeof env?.[name] === 'string' ? env[name] : undefined);
    if (value('SMOKE_COPILOT_LIVE_SKILLS') !== '1') refuse('SMOKE_COPILOT_LIVE_SKILLS must be 1');
    if (value('CODEX_TEST_AUTH_GATE') !== 'c5') refuse('CODEX_TEST_AUTH_GATE must be c5');
    if (value('CODEX_TEST_AUTH_SOURCE') !== 'owner') refuse('CODEX_TEST_AUTH_SOURCE must be owner (route-mismatch)');
    if (!UUID.test(value('SMOKE_RUN_ID') ?? '')) refuse('SMOKE_RUN_ID must be a UUID v4');
    for (const name of ['CODEX_TEST_AUTH_ROOT', 'SMOKE_ARTIFACT_DIR', 'SMOKE_WORKSPACE_ROOT', 'SMOKE_RELEASE_MANIFEST', 'SMOKE_ALA_COMMAND']) {
        if (!absoluteNormalized(value(name))) refuse(`${name} must be an absolute normalized path`);
    }
    if (value('SMOKE_DEPLOYMENT_MODE') !== 'box') refuse('SMOKE_DEPLOYMENT_MODE must be box');
    for (const name of ['SMOKE_PLOINKY_BOX_CONTAINER', 'SMOKE_BOX_BASE_URL']) if (!value(name)) refuse(`${name} must be set`);
    if (![undefined, '', 'release'].includes(value('SMOKE_SOURCE_VERIFICATION'))) refuse('SMOKE_SOURCE_VERIFICATION must be unset or release');
    if (value('CODEX_TEST_AUTH_OWNER_AUTH') && !path.isAbsolute(value('CODEX_TEST_AUTH_OWNER_AUTH'))) refuse('CODEX_TEST_AUTH_OWNER_AUTH must be absolute');
    // Check 9: the exact explorer-release-bundle verifier the runner selects; a 421 or any other verifier is refused.
    if (value('SMOKE_COPILOT_RELEASE_VERIFIER') !== expectedVerifier) refuse('SMOKE_COPILOT_RELEASE_VERIFIER must be the runner\'s verifyExplorerReleaseBundle.mjs');
    return Object.freeze({ runId: env.SMOKE_RUN_ID, gate: 'c5', route: 'owner' });
}

// C4 (specs/06-copilot-codex-delegation.spec.mjs) targets the removed codexAgent, a product decision; it stays refused unconditionally.
export function assertCodexDelegationLiveBlocked() {
    throw new Error('SET2 live execution is blocked: phase6 credential preflight requires independently verified B+C and its reviewed integration.');
}

export function liveSkillsPhasePlan(fixture) {
    return [
        { label: 'original', selected: [fixture.control, fixture.probe], available: [fixture.control, fixture.probe], absent: [], revisionChange: null },
        { label: 'descriptor edit', selected: [fixture.control, fixture.probe], available: [fixture.control, fixture.probe], absent: [], revisionChange: 'same' },
        { label: 'helper-only edit', selected: [fixture.control, fixture.probe], available: [fixture.control, fixture.probe], absent: [], revisionChange: 'same' },
        { label: 'new skill', selected: [fixture.control, fixture.added], available: [fixture.control, fixture.probe, fixture.added], absent: [], revisionChange: 'changed' },
        { label: 'disabled probe', selected: [fixture.control], available: [fixture.control, fixture.added], absent: [fixture.probe], revisionChange: 'changed' },
        { label: 're-enabled probe', selected: [fixture.control, fixture.probe], available: [fixture.control, fixture.probe, fixture.added], absent: [], revisionChange: 'changed' },
        { label: 'deleted probe', selected: [fixture.control], available: [fixture.control, fixture.added], absent: [fixture.probe], revisionChange: 'changed' },
    ];
}

export function liveSkillsOwnedLaunchURL(baseURL, fixture) {
    assert.match(fixture.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
    const url = new URL('/webchat', baseURL);
    for (const [name, value] of Object.entries({ agent: 'roboTeamAgent', robot: fixture.robotName, 'workspace-dir': fixture.folder, 'forward-envelope': '1' })) url.searchParams.set(name, value);
    return url.toString();
}

export function defaultRobotEvidence(robot, catalog) {
    assert.equal(robot.name, 'default');
    assert.equal(catalog.robot, 'default');
    assert.equal(catalog.scope, 'defaults');
    assert.equal(catalog.sessionId, null);
    assert.ok(Number.isSafeInteger(catalog.policyVersion) && catalog.policyVersion >= 1);
    const { id, name, codingAgents, skillsets, skillRepositories, repositories } = robot;
    return { robotId: id, configurationSha256: liveSkillsHash({ id, name, codingAgents, skillsets, skillRepositories, repositories }),
        policyVersion: catalog.policyVersion, policySha256: liveSkillsHash(catalog.policy) };
}

// APIs are injected so offline tests exercise the same ownership and ordering checks without browsers or services.
export function createOwnedLiveSkillsFixture({ fixture, workspaceRoot, api, listRepositories, fsTool, operate }) {
    assert.equal(fixture.workspace, liveSkillsWorkspace(workspaceRoot, fixture.folder));
    assert.equal(fixture.repositoryRoot, `${workspaceRoot}/${fixture.repositoryName}`);
    const state = { prepareAttempted: false, robotCreationAttempted: false, prepared: false, createdRobot: false, registered: false, seeded: false, cleanup: 'pending' };
    const request = async (input, status) => {
        const result = await api(input);
        assert.equal(result.status, status, `Owned fixture API ${input.method || 'GET'} ${input.path} failed.`);
        return result.payload;
    };
    const robots = async () => {
        const payload = await request({ path: 'api/robots' }, 200);
        assert.ok(Array.isArray(payload.robots));
        return payload;
    };
    async function ownedRobot() {
        assert.equal(state.createdRobot, true);
        const matches = (await robots()).robots.filter(robot => robot.id === fixture.robotId);
        assert.equal(matches.length, 1, 'Owned robot disappeared or its identity became ambiguous.');
        assert.equal(matches[0].name, fixture.robotName);
        assert.deepEqual(matches[0].codingAgents, ['codex']);
        return matches[0];
    }
    async function writeSource(relative, content) {
        const prefix = `${fixture.repositoryName}/skills/`;
        assert.ok(relative.startsWith(prefix));
        const [name, file, ...extra] = relative.slice(prefix.length).split('/');
        assert.ok([fixture.control.name, fixture.probe.name, fixture.added.name].includes(name));
        assert.ok(['SKILL.md', 'receipt.mjs'].includes(file) && extra.length === 0);
        assert.match((await fsTool('write_file', { path: relative, content })).rawText || '', /^Successfully wrote to /);
        assert.equal((await fsTool('read_file', { path: relative })).rawText, content);
    }
    async function installSkill(skill) {
        assert.equal(state.prepared, true);
        const directory = `${fixture.repositoryName}/skills/${skill.name}`;
        assert.match((await fsTool('create_directory', { path: directory })).rawText || '', /^Successfully created directory /);
        const source = liveSkillSources(fixture, skill, workspaceRoot);
        await writeSource(`${directory}/SKILL.md`, source.descriptor);
        await writeSource(`${directory}/receipt.mjs`, source.helper);
    }
    return {
        state, robots, ownedRobot, writeSource, installSkill,
        async setup() {
            assert.equal(fixture.robotId, null);
            const before = await robots();
            assert.equal(before.canAdmin, true, 'Fixture creation requires the selected administrator.');
            assert.ok(!before.robots.some(robot => robot.name === fixture.robotName), 'Refuse an existing robot name.');
            state.prepareAttempted = true;
            await operate('prepare'); state.prepared = true;
            await installSkill(fixture.control); await installSkill(fixture.probe);
            const repositories = await listRepositories();
            assert.ok(Array.isArray(repositories));
            const source = repositories.filter(repo => repo.name === fixture.repositoryName);
            assert.equal(source.length, 1, 'Marketplace must discover exactly the owned Git source.');
            assert.equal(source[0].source, fixture.repositoryRoot);
            assert.equal(source[0].origin, 'workspace');
            assert.equal(source[0].kind, 'skills');
            assert.ok(repositories.some(repo => repo.name === 'DocumentationSkills' && repo.origin !== 'remote'), 'Required DocumentationSkills must already be local.');
            state.robotCreationAttempted = true;
            const payload = await request({ method: 'POST', path: 'api/robots', body: { name: fixture.robotName, codingAgents: ['codex'] } }, 201);
            assert.equal(payload.robot?.name, fixture.robotName); assert.deepEqual(payload.robot.codingAgents, ['codex']);
            assert.match(payload.robot.id || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
            fixture.robotId = payload.robot.id; state.createdRobot = true;
            await request({ method: 'POST', path: `api/robots/${fixture.robotId}/skillsets`, body: { name: fixture.repositoryName, source: source[0].source } }, 200);
            state.registered = true;
            const robot = await ownedRobot();
            const registered = robot.repositories.filter(repo => repo.id === fixture.repositoryName);
            assert.equal(registered.length, 1); assert.equal(registered[0].source, fixture.repositoryRoot);
            const seeded = await operate('seed-defaults');
            assert.equal(seeded.robotId, fixture.robotId); assert.equal(seeded.source, fixture.repositoryRoot);
            assert.equal(seeded.seeded, true); assert.equal(seeded.policyVersion, 1); assert.match(seeded.generation, UUID);
            state.seeded = true;
            return { runId: fixture.runId, robotId: fixture.robotId, robotName: fixture.robotName, repositoryName: fixture.repositoryName,
                repositoryRoot: fixture.repositoryRoot, workspace: fixture.workspace, source: source[0], defaults: seeded };
        },
        // `onStep` is told each completed step, in order: links-removed, source-unregistered, robot-deleted, folders-removed. A step with
        // nothing to remove is complete as soon as that is established. The C5 lifecycle turns these into its cleanup flags.
        async cleanup({ quiescent, onStep = () => {} }) {
            if (state.cleanup === 'passed') return;
            state.cleanup = 'failed';
            assert.equal(quiescent, true, 'Cleanup needs observed native quiescence.');
            assert.ok(!state.prepareAttempted || state.prepared, 'Fixture preparation outcome is ambiguous; retain ownership.');
            assert.ok(!state.robotCreationAttempted || state.createdRobot, 'Robot creation outcome is ambiguous; retain ownership.');
            if (state.createdRobot) {
                const robot = await ownedRobot();
                const registered = robot.repositories.filter(repo => repo.id === fixture.repositoryName);
                assert.ok(registered.length <= 1);
                if (registered.length) {
                    assert.equal(registered[0].source, fixture.repositoryRoot);
                    await operate('remove-links');
                    onStep('links-removed');
                    await request({ method: 'DELETE', path: `api/robots/${fixture.robotId}/skillsets`, body: { name: fixture.repositoryName } }, 200);
                    state.registered = false;
                    onStep('source-unregistered');
                } else { onStep('links-removed'); onStep('source-unregistered'); }
                await request({ method: 'POST', path: 'api/control', body: { operation: 'robot-delete', robotId: fixture.robotId } }, 200);
                assert.ok(!(await robots()).robots.some(robot => robot.id === fixture.robotId), 'Owned robot deletion is not confirmed.');
                state.createdRobot = false;
            } else { onStep('links-removed'); onStep('source-unregistered'); }
            onStep('robot-deleted');
            if (state.prepared) { await operate('remove-folders'); state.prepared = false; }
            onStep('folders-removed');
            state.cleanup = 'passed';
        },
        // Recovery of a crashed C5 run (G4), in a fresh process, from observed state only: the registration listing for the robot the
        // marker names, then its unregistration, its deletion and the recovery-mode folder removal (which itself checks for every present
        // root and its ownership marker). Links are not removed one by one: they live in the run folder, which the folder removal deletes.
        // Nothing here trusts an in-memory flag of the crashed process.
        async recover({ onStep = () => {} } = {}) {
            const listed = (await robots()).robots.filter(robot => robot.name === fixture.robotName);
            assert.ok(listed.length <= 1, 'The marker robot name is ambiguous.');
            const robot = listed[0] || null;
            if (robot) {
                assert.match(robot.id || '', /^[a-z0-9][a-z0-9-]{2,63}$/);
                assert.deepEqual(robot.codingAgents, ['codex'], 'The marker robot is not the owned Codex-only robot.');
                fixture.robotId = robot.id;
                const registered = (robot.repositories || []).filter(repo => repo.id === fixture.repositoryName);
                assert.ok(registered.length <= 1);
                if (registered.length) {
                    assert.equal(registered[0].source, fixture.repositoryRoot);
                    await request({ method: 'DELETE', path: `api/robots/${robot.id}/skillsets`, body: { name: fixture.repositoryName } }, 200);
                }
                onStep('source-unregistered');
                await request({ method: 'POST', path: 'api/control', body: { operation: 'robot-delete', robotId: robot.id } }, 200);
                assert.ok(!(await robots()).robots.some(entry => entry.id === robot.id), 'Recovered robot deletion is not confirmed.');
            } else onStep('source-unregistered');
            onStep('robot-deleted');
            await operate('remove-folders', { recovery: true });
            onStep('folders-removed');
            return { robotId: robot?.id ?? null };
        },
    };
}
