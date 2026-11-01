import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateConfig, assertBox, selectAgent, assertNoAgentExec, assertVictimUnchanged,
    assertRefused, assertDualHome, assertDeleted } from './controller/contracts.mjs';
import { runControllerScenario } from './controller-scenarios.mjs';

const hash = 'a'.repeat(64);
const config = () => ({
    engine: 'podman', fixture: '/task/fixture', workspace: '/task/fixture', ploinkyRoot: '/task/ploinky',
    ploinkyRevision: 'a'.repeat(40), box: { id: hash, image: `sha256:${hash}`, startedAt: '2026-11-01T00:00:00Z' },
    rt: 'b'.repeat(64), rw: 'c'.repeat(64), attacker: 'owned-attacker', victim: 'owned-victim',
    sources: ['rt', 'rw', 'ala'].map(role => ({ role, root: `/task/${role}`, revision: 'b'.repeat(40),
        subdir: { rt: 'roboTeamAgent', rw: 'roboWorkAgent', ala: '' }[role], runtimePath: role === 'ala' ? '/opt/ala' : '/code' })),
});

test('config requires immutable distinct containers, exact revisions and all source roles', () => {
    validateConfig(config());
    for (const change of [c => { c.rt = c.rw; }, c => { c.box.id = 'short'; },
        c => { c.sources.pop(); }, c => { c.sources[0].revision = 'main'; },
        c => { c.fixture = '/'; }, c => { c.attacker = c.victim; }]) {
        const value = config(); change(value); assert.throws(() => validateConfig(value));
    }
});

test('wrong fixture, image, exact container and generation cannot satisfy Box proof', () => {
    const c = config();
    const good = { Id: c.box.id, Image: c.box.image, State: { Running: true, StartedAt: c.box.startedAt },
        Mounts: [{ Type: 'bind', Source: c.fixture, Destination: c.workspace }] };
    assertBox(c, good);
    for (const change of [row => { row.Id = 'd'.repeat(64); }, row => { row.Image = 'foreign'; },
        row => { row.State.StartedAt = 'other'; }, row => { row.State.Running = false; },
        row => { row.Mounts[0].Source = '/other/fixture'; }]) {
        const row = structuredClone(good); change(row); assert.throws(() => assertBox(c, row));
    }
});

test('orphan, nonexistent, foreign and ambiguous registry IDs fail', () => {
    const id = config().rt;
    const row = { type: 'agent', agentName: 'roboTeamAgent', repoName: 'AchillesIDE', containerId: id };
    assert.equal(selectAgent({ owned: row }, id, 'roboTeamAgent')[0], 'owned');
    for (const registry of [{}, { owned: { ...row, containerId: hash } },
        { owned: { ...row, repoName: 'foreign' } }, { first: row, second: row }]) {
        assert.throws(() => selectAgent(registry, id, 'roboTeamAgent'));
    }
});

test('manifest negative fixture detects agentExec and empty inventory is never passing', () => {
    assert.equal(assertNoAgentExec([{ name: 'safe', manifest: {} }]).count, 1);
    assert.throws(() => assertNoAgentExec([]));
    assert.throws(() => assertNoAgentExec([{ name: 'bad', manifest: { routerAccess: { agentExec: true } } }]));
    assert.throws(() => assertNoAgentExec([{ name: 'missing' }]));
});

test('victim control detects missing marker, bytes, modes, link and tree mutation', () => {
    const before = { markerHash: hash, treeHash: 'b'.repeat(64), entries: 4 };
    assertVictimUnchanged(before, { ...before });
    assert.throws(() => assertVictimUnchanged({ ...before, markerHash: '' }, { ...before, markerHash: '' }));
    for (const after of [{ ...before, markerHash: 'c'.repeat(64) }, { ...before, treeHash: 'c'.repeat(64) },
        { ...before, entries: 3 }]) assert.throws(() => assertVictimUnchanged(before, after));
});

test('grant rejection must be observed with exact refusal code, never transport error or success', () => {
    assertRefused({ ok: false, code: 'CWD_REFUSED' }, 'CWD_REFUSED');
    assert.throws(() => assertRefused({ ok: true, code: 'CWD_REFUSED' }, 'CWD_REFUSED'));
    assert.throws(() => assertRefused({ ok: false, code: 'TARGET_INACTIVE' }, 'CWD_REFUSED'));
    assert.throws(() => assertRefused(null, 'CWD_REFUSED'));
});

test('dual home requires positive directory identity on both device and inode', () => {
    const stat = { dev: 1, ino: 2, directory: true };
    assertDualHome([stat, { ...stat }]);
    for (const other of [{ ...stat, dev: 2 }, { ...stat, ino: 3 }, { ...stat, directory: false }]) {
        assert.throws(() => assertDualHome([stat, other]));
    }
    assert.throws(() => assertDualHome([]));
});

test('cleanup failure or absent confirmation cannot become successful evidence', () => {
    assertDeleted({ ok: true, result: { deleted: true } });
    for (const result of [null, { ok: false }, { ok: true, result: {} },
        { ok: true, result: { deleted: false } }]) assert.throws(() => assertDeleted(result));
});

test('unfinished scenarios refuse even a supplied fake passing config before any live access', async () => {
    for (const scenario of ['I2', 'I8', 'I10', 'P1', 'E1', 'RA1', 'unknown']) {
        await assert.rejects(runControllerScenario({ pass: true, results: { ok: true } }, scenario),
            error => error.code === 'ACCEPTANCE_PENDING' && !error.sentinel);
    }
});

test('standalone CLI missing prerequisites exits nonzero without success sentinel', async () => {
    const execute = promisify(execFile);
    const runner = fileURLToPath(new URL('./controller-scenarios.mjs', import.meta.url));
    const help = await execute(process.execPath, [runner, '--help']);
    assert.match(help.stdout, /I11 creates and deletes/u);
    await assert.rejects(execute(process.execPath, [runner]), error => {
        assert.equal(error.code, 1); assert.equal(error.stdout, '');
        assert.match(error.stderr, /CONTROLLER_ASSERTION_FAILED/u);
        assert.doesNotMatch(error.stderr, /ROBOWORK_CONTROLLER_PROBE_V1/u);
        return true;
    });
});
