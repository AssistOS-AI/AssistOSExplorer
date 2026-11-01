import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const profile of ['robot-a.default', 'robot-a.environment']) {
    test(`strict HTTP service and existing run survive failed ${profile} and Environment preparation`, async t => {
        const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-prepare-'));
        const runtime = path.join(root, 'runtime');
        await fs.mkdir(path.join(runtime, 'lib'), { recursive: true });
        // Route-authority fixture only; this test targets rejection handling after authentication.
        await fs.writeFile(path.join(runtime, 'lib', 'invocationAuth.mjs'), `
export const readAgentSecret = () => 'fixture';
export const expectedAudienceForSelf = () => 'fixture';
export const verifyHttpRouteAuthInfoFromHeaders = () => ({ok:true,payload:{sub:'user:owner',actor:{kind:'user',id:'user:owner',roles:['admin']}}});
`);
        const child = spawn(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(new URL('./fixtures/preparation-service.mjs', import.meta.url))], {
            env: { FIXTURE_ROOT: root, PLOINKY_AGENT_RUNTIME_ROOT: runtime }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stderr = '', activePid;
        child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
        t.after(async () => {
            if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
            if (activePid) { try { process.kill(-activePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
            await fs.rm(root, { recursive: true, force: true });
        });
        const ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error(stderr || 'Fixture exited before readiness'); })]);
        activePid = ready.pid;
        const base = `http://127.0.0.1:${ready.port}`;
        const internal = (tool, input) => fetch(base + '/internal/' + tool, { method: 'POST', headers: { 'x-robowork-internal-token': 'fixture-token' }, body: JSON.stringify(input) });
        const failedEnvironment = await internal('run_start', { runId: 'environment-run', robotId: 'robot-a', cwd: ready.cwd,
            ala: { sessionId: 'environment-session' }, folders: [], channels: [], ignore: [], tag: {}, environment: 'repo/agent' });
        assert.equal(failedEnvironment.status, 500);
        assert.equal((await failedEnvironment.json()).code, 'INTERNAL_ERROR');
        const failedTerminal = await fetch(`${base}/api/terminal-profiles/${profile}/prepare`, { method: 'POST', headers: { 'x-ploinky-auth-info': '{}' }, body: '{}' });
        assert.equal(failedTerminal.status, 500);
        assert.equal((await failedTerminal.json()).code, 'INTERNAL_ERROR');
        assert.equal((await fetch(base + '/health')).status, 200);
        const listed = await (await internal('run_list', {})).json();
        assert.equal(listed.find(run => run.runId === 'active-run').state, 'running');
        assert.equal((await internal('run_input', { runId: 'active-run', data: Buffer.from('still running\n').toString('base64') })).status, 200);
        let records = [];
        for (let attempt = 0; attempt < 20 && !records.length; attempt++) records = (await (await internal('run_read', { runId: 'active-run', after: 0, waitMs: 100 })).json()).records;
        assert.equal(records.map(record => Buffer.from(record.data, 'base64').toString()).join(''), 'still running\n');
        const next = await fetch(base + '/api/terminal-profiles', { headers: { 'x-ploinky-auth-info': '{}' } });
        assert.equal(next.status, 200); assert.equal((await next.json()).profiles.length, 1);
        assert.equal(child.exitCode, null, stderr);
    });
}

test('startup creates a private configured XDG runtime directory before Podman initialization and refuses symlinks', async t => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-xdg-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin'), directory = path.join(root, 'runtime'), seen = path.join(root, 'seen.json');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    await fs.writeFile(path.join(bin, 'roboteam-podman-init'), `#!/bin/sh
node --input-type=module -e 'import fs from "node:fs"; const s=fs.lstatSync(process.env.XDG_RUNTIME_DIR); if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&511)!==448)process.exit(91); fs.writeFileSync(process.env.FIXTURE_SEEN,JSON.stringify({mode:s.mode&511}));'
status=$?
[ "$status" -eq 0 ] || exit "$status"
exit 17
`, { mode: 0o700 });
    const run = () => new Promise(resolve => {
        const child = spawn('/bin/sh', [fileURLToPath(new URL('../scripts/startAgent.sh', import.meta.url))], {
            env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: directory, FIXTURE_SEEN: seen }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.resume(); child.stderr.resume(); child.on('exit', code => resolve(code));
    });
    assert.equal(await run(), 17);
    assert.deepEqual(JSON.parse(await fs.readFile(seen, 'utf8')), { mode: 0o700 });
    await fs.chmod(directory, 0o755); assert.equal(await run(), 17);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    await fs.rm(seen); await fs.rename(directory, directory + '-target'); await fs.symlink(directory + '-target', directory);
    assert.notEqual(await run(), 17);
    await assert.rejects(fs.access(seen), { code: 'ENOENT' });
});
