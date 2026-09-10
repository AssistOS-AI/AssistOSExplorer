import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createBootstrapBarrier, readLinuxProcessIdentity, runBootstrapCommand } from '../scripts/document-server-bootstrap.mjs';
import { fixtureBootstrapEnv, pinnedStaticGzipCommands } from './bootstrap-fixture.mjs';

async function temporaryDirectory(t) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-bootstrap-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('bootstrap completion is tied to the current process and invalidated on every start', async (t) => {
    const directory = await temporaryDirectory(t);
    let identity = { pid: 42, startTime: '100', bootId: '11111111-1111-1111-1111-111111111111' };
    const barrier = createBootstrapBarrier({ stateDirectory: path.join(directory, 'state'), readIdentity: async () => identity });
    await assert.rejects(barrier.verify);
    const nonce = await barrier.begin(42);
    await assert.rejects(barrier.verify);
    await barrier.complete(42, nonce);
    assert.equal(await barrier.verify(), nonce);
    assert.equal(await barrier.verify(nonce), nonce);

    identity = { ...identity, startTime: '101' };
    await assert.rejects(barrier.verify, /earlier process/);
    const nextNonce = await barrier.begin(42);
    assert.notEqual(nonce, nextNonce);
    await assert.rejects(barrier.verify);
    await assert.rejects(() => barrier.complete(42, nonce), /replaced/);
    await assert.rejects(() => barrier.complete(43, nextNonce), /replaced/);
    await barrier.complete(42, nextNonce);
    assert.equal(await barrier.verify(), nextNonce);
    await assert.rejects(() => barrier.verify(nonce), /changed during readiness/);
    identity = { ...identity, bootId: '22222222-2222-2222-2222-222222222222' };
    await assert.rejects(barrier.verify, /earlier process/);
});

test('bootstrap rejects malformed, stale, linked or writable completion records', async (t) => {
    const directory = await temporaryDirectory(t);
    const identity = { pid: 42, startTime: '100', bootId: '11111111-1111-1111-1111-111111111111' };
    const stateDirectory = path.join(directory, 'state');
    const barrier = createBootstrapBarrier({ stateDirectory, readIdentity: async () => identity });
    const nonce = await barrier.begin(42);
    await barrier.complete(42, nonce);
    const record = JSON.parse(await readFile(path.join(stateDirectory, 'ready.json'), 'utf8'));
    for (const value of [null, {}, { ...record, nonce: 'old' }, { ...record, pid: -1 }, { ...record, extra: true }]) {
        await writeFile(path.join(stateDirectory, 'ready.json'), JSON.stringify(value));
        await assert.rejects(barrier.verify);
    }
    await writeFile(path.join(stateDirectory, 'ready.json'), '{');
    await assert.rejects(barrier.verify);
    await writeFile(path.join(stateDirectory, 'ready.json'), JSON.stringify({ ...record, nonce: '22222222-2222-2222-2222-222222222222' }));
    await assert.rejects(barrier.verify, /has not completed/);
    await barrier.complete(42, nonce);
    await chmod(path.join(stateDirectory, 'ready.json'), 0o666);
    await assert.rejects(barrier.verify, /Unsafe bootstrap state file/);
    await rm(path.join(stateDirectory, 'ready.json'));
    await symlink(path.join(stateDirectory, 'startup.json'), path.join(stateDirectory, 'ready.json'));
    await assert.rejects(barrier.verify);
    await barrier.begin(42);
    await assert.rejects(barrier.verify);
});

test('an overlapping startup cannot make the previous completion ready', async (t) => {
    const directory = await temporaryDirectory(t);
    const identity = { pid: 42, startTime: '100', bootId: '11111111-1111-1111-1111-111111111111' };
    const stateDirectory = path.join(directory, 'state');
    const writer = createBootstrapBarrier({ stateDirectory, readIdentity: async () => identity });
    const nonce = await writer.begin(42);
    await writer.complete(42, nonce);
    const reader = createBootstrapBarrier({
        stateDirectory,
        readIdentity: async () => { await writer.begin(42); return identity; },
    });
    await assert.rejects(reader.verify, /changed during readiness/);
    await assert.rejects(writer.verify);
});

test('Linux process identity rejects PID reuse, exited and malformed proc state', async (t) => {
    const directory = await temporaryDirectory(t);
    await mkdir(path.join(directory, '42'));
    await mkdir(path.join(directory, 'sys/kernel/random'), { recursive: true });
    const bootId = '11111111-1111-1111-1111-111111111111';
    await writeFile(path.join(directory, 'sys/kernel/random/boot_id'), `${bootId}\n`);
    const stat = (state, startTime) => `42 (bash (nested)) ${state} ${Array(18).fill('0').join(' ')} ${startTime} 0\n`;
    await writeFile(path.join(directory, '42/stat'), stat('S', '100'));
    assert.deepEqual(await readLinuxProcessIdentity(42, directory), { pid: 42, startTime: '100', bootId });
    for (const content of [stat('Z', '100'), stat('X', '100'), stat('S', '0'), '42 malformed']) {
        await writeFile(path.join(directory, '42/stat'), content);
        await assert.rejects(() => readLinuxProcessIdentity(42, directory));
    }
    for (const pid of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
        await assert.rejects(() => readLinuxProcessIdentity(pid, directory));
    }
    for (const args of [[], ['verify', 'extra'], ['begin', '-1'], ['complete', '42', 'invalid']]) {
        await assert.rejects(() => runBootstrapCommand(args), /Invalid bootstrap command/);
    }
});

async function runWrapper(t, {
    failPhase = '', failInnerPhase = '', failGzipChild = '', gzipFixtureFiles = false,
    alterSource = (source) => source, alterStaticGzipSource = (source) => source,
} = {}) {
    const directory = await temporaryDirectory(t);
    const bootstrapEnv = await fixtureBootstrapEnv(directory);
    const noOp = path.join(directory, 'no-op.sh');
    await writeFile(noOp, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const fakeVendor = path.join(directory, 'vendor.sh');
    await writeFile(fakeVendor, alterSource([
        '#!/bin/bash',
        'CHILD=""',
        'start_process() {',
        '  "$@" &',
        '  CHILD=$!; wait "$CHILD"; CHILD="";',
        '}',
        'function clean_exit {',
        '  [[ -z "$CHILD" ]] || kill -s SIGTERM "$CHILD" 2>/dev/null',
        '  /usr/bin/documentserver-prepare4shutdown.sh',
        '  exit',
        '}',
        'trap clean_exit SIGTERM SIGQUIT SIGABRT SIGINT',
        'JSON=/usr/bin/true',
        'service() { :; }',
        'install() { :; }',
        'start-stop-daemon() { :; }',
        'LOCAL_SERVICES=(rabbitmq-server)',
        '#start needed local services',
        'for i in "${LOCAL_SERVICES[@]}"; do',
        '  service $i start',
        'done',
        'service supervisor start',
        'phase() {',
        '  echo "$1-started"',
        '  IFS= read -r release < "$FIXTURE_DIRECTORY/$1.pipe"',
        '  [ "$FAIL_PHASE" != "$1" ] || return 17',
        '  echo "$1-completed"',
        '}',
        'start_process documentserver-generate-allfonts.sh ${ONLYOFFICE_DATA_CONTAINER}',
        'start_process documentserver-static-gzip.sh ${ONLYOFFICE_DATA_CONTAINER}',
        'bash() { phase tail; }',
        'start_process bash -c "find /tmp -type f -name *.log | xargs tail -F"',
    ].join('\n')), { mode: 0o755 });
    for (const phase of ['fonts', 'gzip', 'tail']) {
        const result = spawnSync('mkfifo', [path.join(directory, `${phase}.pipe`)], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    for (const [phase, name] of [['fonts', 'documentserver-generate-allfonts.sh'], ['gzip', 'documentserver-static-gzip.sh']]) {
        const source = [
            '#!/bin/sh',
            `phase=${phase}`,
            'echo "$phase-started"',
            'IFS= read -r release < "$FIXTURE_DIRECTORY/$phase.pipe"',
            '[ "$FAIL_PHASE" != "$phase" ] || exit 17',
            'if [ "$FAIL_INNER_PHASE" = "$phase" ]; then false; fi',
            ...(phase === 'gzip' ? [
                'cd "$ONLYOFFICE_GZIP_FIXTURE_DIRECTORY"',
                ...pinnedStaticGzipCommands,
            ] : []),
            'echo "$phase-completed"',
        ].join('\n');
        await writeFile(path.join(directory, 'bootstrap-commands', name),
            phase === 'gzip' ? alterStaticGzipSource(source) : source, { mode: 0o755 });
    }
    if (failGzipChild) {
        const target = failGzipChild === 'assets' ? ['sdkjs', 'fixture.js'] : ['fonts', 'fixturefont'];
        await writeFile(path.join(bootstrapEnv.ONLYOFFICE_GZIP_FIXTURE_DIRECTORY, ...target), 'fixture');
        await writeFile(path.join(directory, 'bootstrap-commands', 'gzip'),
            '#!/bin/sh\necho gzip-child-failed >&2\nexit 17\n', { mode: 0o755 });
    }
    if (gzipFixtureFiles) {
        for (const target of [['sdkjs', 'fixture asset.js'], ['fonts', 'fixture font']]) {
            await writeFile(path.join(bootstrapEnv.ONLYOFFICE_GZIP_FIXTURE_DIRECTORY, ...target), 'original fixture contents');
        }
    }
    const readiness = await readFile(new URL('../scripts/healthcheck.sh', import.meta.url), 'utf8');
    const readinessPath = path.join(directory, 'healthcheck.sh');
    const fakeBin = path.join(directory, 'bin');
    await mkdir(fakeBin);
    const fixtureNode = path.join(fakeBin, 'node');
    const replaceStartup = path.join(directory, 'replace-startup.mjs');
    await writeFile(replaceStartup, [
        `import { readFile } from 'node:fs/promises';`,
        `import { spawnSync } from 'node:child_process';`,
        `const startup = JSON.parse(await readFile(${JSON.stringify(path.join(directory, 'bootstrap/startup.json'))}, 'utf8'));`,
        `const script = ${JSON.stringify(bootstrapEnv.ONLYOFFICE_BOOTSTRAP_SCRIPT)};`,
        `const next = spawnSync(process.execPath, [script, 'begin', String(startup.pid)], { encoding: 'utf8' });`,
        `if (next.status !== 0) process.exit(98);`,
        `process.exit(spawnSync(process.execPath, [script, 'complete', String(startup.pid), next.stdout.trim()]).status);`,
    ].join('\n'));
    await writeFile(fixtureNode, [
        '#!/bin/sh',
        'case "$1" in',
        '  /code/scripts/document-server-bootstrap.mjs)',
        '    shift',
        `    exec "${process.execPath}" "${bootstrapEnv.ONLYOFFICE_BOOTSTRAP_SCRIPT}" "$@" ;;`,
        // The real validators have separate fixture tests; this test exercises
        // the entire readiness shell and its bootstrap/HTTP/ss decision paths.
        '  /code/scripts/verify-document-server-jwt-config.mjs)',
        `    if [ "\${FIXTURE_REPLACE_STARTUP:-}" = 1 ]; then exec "${process.execPath}" "${replaceStartup}"; fi`,
        '    exit 0 ;;',
        '  /code/scripts/configure-docservice-nginx-loopback.mjs) exit 0 ;;',
        '  *) exit 99 ;;',
        'esac',
    ].join('\n'), { mode: 0o755 });
    await writeFile(readinessPath, readiness.replaceAll('/usr/local/bin/node', `"${fixtureNode}"`));
    await writeFile(path.join(fakeBin, 'curl'), [
        '#!/bin/sh',
        'for argument do url="$argument"; done',
        'case "$url" in',
        '  http://127.0.0.1:80/healthcheck) printf "%s" "${FIXTURE_HEALTH_BODY-true}" ;;',
        '  http://127.0.0.1:80/web-apps/apps/api/documents/api.js) exit 0 ;;',
        '  http://127.0.0.1:7000/__ready|http://127.0.0.1:9100/__ready) printf 404 ;;',
        '  *) exit 99 ;;',
        'esac',
    ].join('\n'), { mode: 0o755 });
    await writeFile(path.join(fakeBin, 'ss'), [
        '#!/bin/sh',
        'for argument do port="${argument##*:}"; done',
        'address=127.0.0.1',
        'case "$port" in',
        '  7000|8080) address=0.0.0.0; owner=node ;;',
        '  9100) owner=node ;;',
        '  80) owner=nginx ;;',
        '  5432) owner=postgres ;;',
        '  5672|25672) owner=beam.smp ;;',
        '  4369) owner=epmd ;;',
        '  8000) address="[::1]"; owner=docservice ;;',
        '  6379|9000) exit 0 ;;',
        '  *) exit 99 ;;',
        'esac',
        'printf \'LISTEN 0 128 %s:%s *:* users:(("%s",pid=1,fd=1))\\n\' "$address" "$port" "$owner"',
    ].join('\n'), { mode: 0o755 });
    const child = spawn('/bin/bash', ['scripts/run-document-server-with-autoassembly.sh'], {
        cwd: new URL('..', import.meta.url),
        detached: true,
        env: {
            ...process.env, ...bootstrapEnv,
            ONLYOFFICE_DOCUMENT_SERVER_BASE_SCRIPT: fakeVendor,
            ONLYOFFICE_V5_CONFIGURE_SCRIPT: noOp,
            ONLYOFFICE_SUPPORT_LISTENER_SCRIPT: noOp,
            ONLYOFFICE_BOUNDED_SHUTDOWN_SCRIPT: noOp,
            FIXTURE_DIRECTORY: directory, FAIL_PHASE: failPhase, FAIL_INNER_PHASE: failInnerPhase,
        },
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode !== null || child.signalCode) return;
        process.kill(-child.pid, 'SIGKILL');
        await exit;
    });
    return {
        child, exit, stderr: () => stderr,
        staticDirectory: bootstrapEnv.ONLYOFFICE_GZIP_FIXTURE_DIRECTORY,
        async waitFor(text) {
            const deadline = Date.now() + 5000;
            while (!output.includes(text)) {
                assert.equal(child.exitCode, null, stderr);
                assert.ok(Date.now() < deadline, `missing ${text}: ${output} ${stderr}`);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        },
        release: (phase) => writeFile(path.join(directory, `${phase}.pipe`), 'continue\n'),
        verify: () => spawnSync(process.execPath, [bootstrapEnv.ONLYOFFICE_BOOTSTRAP_SCRIPT, 'verify'], { encoding: 'utf8' }),
        health: (body = 'true', replaceStartup = false) => spawnSync('/bin/bash', [readinessPath], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FIXTURE_HEALTH_BODY: body,
                FIXTURE_REPLACE_STARTUP: replaceStartup ? '1' : '' },
        }),
    };
}

test('readiness waits for delayed font restarts and static gzip while the wrapper stays alive', async (t) => {
    const fixture = await runWrapper(t);
    await fixture.waitFor('fonts-started');
    assert.notEqual(fixture.health().status, 0, 'reachable services during font generation cannot be ready');
    await fixture.release('fonts');
    await fixture.waitFor('gzip-started');
    assert.notEqual(fixture.health().status, 0, 'reachable services during static compression cannot be ready');
    await fixture.release('gzip');
    await fixture.waitFor('tail-started');
    const ready = fixture.health();
    assert.equal(ready.status, 0, ready.stderr);
    assert.notEqual(fixture.health('false').status, 0, 'bootstrap completion cannot replace live DocService health');
    assert.notEqual(fixture.health('not true').status, 0, 'DocService health must match the exact success body');
    for (const body of ['false\ntrue', 'true\nfalse', '\ntrue', 'true\n', '']) {
        assert.notEqual(fixture.health(body).status, 0, 'a matching line cannot replace an exact success body');
    }
    assert.notEqual(fixture.health('true', true).status, 0, 'a new completed startup cannot reuse probes from the preceding startup');
    assert.equal(fixture.health().status, 0, 'a complete health run against the new startup can pass');
    await fixture.release('tail');
    assert.deepEqual(await fixture.exit, [0, null], fixture.stderr());
    assert.notEqual(fixture.verify().status, 0, 'a dead bootstrap process must never remain ready');
});

for (const failPhase of ['fonts', 'gzip']) {
    test(`${failPhase} failure cannot publish readiness despite the vendor wait clearing CHILD`, async (t) => {
        const fixture = await runWrapper(t, { failPhase });
        await fixture.waitFor('fonts-started');
        await fixture.release('fonts');
        if (failPhase === 'gzip') {
            await fixture.waitFor('gzip-started');
            await fixture.release('gzip');
        }
        assert.deepEqual(await fixture.exit, [1, null]);
        assert.match(fixture.stderr(), /failed; refusing startup/);
        assert.notEqual(fixture.verify().status, 0);
    });
    test(`${failPhase} internal command failure cannot be hidden by a later successful echo`, async (t) => {
        const fixture = await runWrapper(t, { failInnerPhase: failPhase });
        await fixture.waitFor('fonts-started');
        await fixture.release('fonts');
        if (failPhase === 'gzip') {
            await fixture.waitFor('gzip-started');
            await fixture.release('gzip');
        }
        assert.deepEqual(await fixture.exit, [1, null]);
        assert.match(fixture.stderr(), /failed; refusing startup/);
        assert.notEqual(fixture.verify().status, 0);
    });
}

test('unknown vendor bootstrap layout fails before starting any service', async (t) => {
    const fixture = await runWrapper(t, {
        alterSource: (source) => source.replace('start_process documentserver-static-gzip.sh ${ONLYOFFICE_DATA_CONTAINER}', ':'),
    });
    assert.deepEqual(await fixture.exit, [45, null]);
    assert.notEqual(fixture.verify().status, 0);
});

for (const target of ['assets', 'fonts']) {
    test(target + ' gzip child failure cannot be hidden by find or publish readiness', async (t) => {
        const fixture = await runWrapper(t, { failGzipChild: target });
        await fixture.waitFor('fonts-started');
        await fixture.release('fonts');
        await fixture.waitFor('gzip-started');
        await fixture.release('gzip');
        assert.deepEqual(await fixture.exit, [1, null]);
        assert.match(fixture.stderr(), /gzip-child-failed/);
        assert.match(fixture.stderr(), /static compression failed; refusing startup/);
        assert.notEqual(fixture.verify().status, 0);
    });
}

test('batched gzip retains original assets and compresses space-containing asset and font paths', async (t) => {
    const fixture = await runWrapper(t, { gzipFixtureFiles: true });
    await fixture.waitFor('fonts-started');
    await fixture.release('fonts');
    await fixture.waitFor('gzip-started');
    await fixture.release('gzip');
    await fixture.waitFor('tail-started');
    assert.equal(fixture.health().status, 0);
    for (const target of [['sdkjs', 'fixture asset.js'], ['fonts', 'fixture font']]) {
        const original = path.join(fixture.staticDirectory, ...target);
        assert.equal(await readFile(original, 'utf8'), 'original fixture contents');
        assert.equal(gunzipSync(await readFile(original + '.gz')).toString(), 'original fixture contents');
    }
    await fixture.release('tail');
    assert.deepEqual(await fixture.exit, [0, null]);
});

for (const [label, alterStaticGzipSource] of [
    ['missing font command', (source) => source.replace(pinnedStaticGzipCommands[1], ':')],
    ['changed gzip options', (source) => source.replace('-kf9', '-k9')],
    ['duplicate asset command', (source) => source + '\n' + pinnedStaticGzipCommands[0]],
    ['additional gzip command', (source) => source + '\nfind ./extra -type f -exec gzip -kf9 {} \\;'],
    ['reordered commands', (source) => source.replace(pinnedStaticGzipCommands.join('\n'), [...pinnedStaticGzipCommands].reverse().join('\n'))],
]) {
    test('unknown static gzip layout fails before starting services: ' + label, async (t) => {
        const fixture = await runWrapper(t, { alterStaticGzipSource });
        assert.deepEqual(await fixture.exit, [46, null]);
        assert.notEqual(fixture.verify().status, 0);
    });
}
