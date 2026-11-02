import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
export const SENTINEL = 'ROBOWORK_COMMAND_PROBE_V1';

export function argumentsFrom(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 2) {
        assert.match(argv[index], /^--[a-z][a-z-]*$/u);
        assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), 'Every option needs a value.');
        const key = argv[index].slice(2);
        assert.ok(!Object.hasOwn(result, key), 'Duplicate option.');
        result[key] = argv[index + 1];
    }
    return result;
}

export function victimPaths({ robot, victim, workspace, servicePid }) {
    assert.match(robot || '', ID); assert.match(victim || '', ID); assert.notEqual(robot, victim);
    assert.ok(workspace && path.posix.isAbsolute(workspace) && path.posix.normalize(workspace) === workspace && workspace !== '/');
    const homes = [`/home/${victim}`, `/data/robots/${victim}/home`,
        `${workspace}/.data/.private/roboWorkAgent/robots/${victim}/home`];
    if (servicePid !== undefined) {
        assert.match(String(servicePid), /^[1-9][0-9]*$/u);
        homes.push(`/proc/${servicePid}/root/data/robots/${victim}/home`,
            `/proc/${servicePid}/root${workspace}/.data/.private/roboWorkAgent/robots/${victim}/home`);
    }
    return homes.map(home => `${home}/marker-B`);
}

export function assertDeniedPaths(files, io = fs) {
    for (const file of files) {
        for (const flags of ['r', 'r+']) {
            let descriptor, error;
            try { descriptor = io.openSync(file, flags); } catch (caught) { error = caught; }
            finally { if (descriptor !== undefined) io.closeSync(descriptor); }
            assert.ok(error && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'EROFS'].includes(error.code),
                `Protected path admitted ${flags} access: ${file}`);
        }
    }
}

export async function runIsolationProbe(options, { io = fs, run = execute, env = process.env, request = fetch } = {}) {
    const { probe, robot, victim, workspace } = options;
    const protectedFiles = victimPaths({ robot, victim, workspace, servicePid: options['service-pid'] });
    const checks = [];
    const checked = async (name, operation) => { await operation(); checks.push(name); };
    if (probe === 'paths' || probe === 'hostlink') {
        await checked('victim read and writable-open refused, including proc aliases', () => assertDeniedPaths(protectedFiles, io));
        const result = await run('find', ['/', '-xdev', '-name', 'marker-B', '-print'],
            { timeout: 15000, maxBuffer: 1024 * 1024 }).catch(error => {
            assert.ok(error.code === 1 && typeof error.stdout === 'string', 'Marker search failed without bounded evidence.');
            return error;
        });
        await checked('global marker search empty', () => assert.equal(result.stdout.trim(), ''));
        if (probe === 'hostlink') await checked('planted project transcript and home links cannot reach victim', () => {
            assert.ok(options.project && path.posix.isAbsolute(options.project), 'Hostlink requires a planted project.');
            assertDeniedPaths([`${options.project}/.roboteam/.ala/marker-B`, `/home/${robot}/.ala/marker-B`], io);
        });
    } else if (probe === 'proc') {
        const self = io.readlinkSync('/proc/self/ns/pid');
        const pids = io.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/u.test(value));
        assert.ok(pids.length > 0 && pids.length <= 512);
        for (const pid of pids) {
            await checked(`pid ${pid} shares only sandbox namespace`, () => assert.equal(io.readlinkSync(`/proc/${pid}/ns/pid`), self));
            await checked(`pid ${pid} has no credential environment`, () => assert.doesNotMatch(io.readFileSync(`/proc/${pid}/environ`, 'utf8'), /(?:^|\0)PLOINKY_/u));
            await checked(`pid ${pid} root has no sibling home`, () => assertDeniedPaths([`/proc/${pid}/root/data/robots/${victim}/home/marker-B`], io));
        }
        await checked('pid 1 is not a service', () => assert.doesNotMatch(io.readFileSync('/proc/1/cmdline', 'utf8'), /AgentServer|server\/main\.mjs|robot-cli|robot-task/u));
    } else if (probe === 'fds') {
        const result = await run('ls', ['-l', '/proc/self/fd'], { timeout: 5000, maxBuffer: 65536 });
        const links = result.stdout.split('\n').filter(line => / -> /u.test(line));
        await checked('descriptor inventory bounded and free of service data', () => {
            assert.ok(links.length >= 3 && links.length <= 5);
            assert.doesNotMatch(result.stdout, / -> (?:.*\/root)?\/data(?:\/|$)/mu);
            for (const line of links) {
                const match = /\s([0-9]+) -> (.+)$/u.exec(line);
                assert.ok(match && (Number(match[1]) <= 2 || /^\/proc\/[0-9]+\/fd$/u.test(match[2])), 'Unexpected inherited descriptor.');
            }
        });
    } else if (probe === 'masks') {
        // A robot started in a project folder sees no other part of the workspace: its private children are absent
        // and the workspace root lists only the path to the working folder.
        for (const name of ['.data', '.ploinky', '.env']) await checked(`${name} is not mounted`, () => assert.throws(() => io.lstatSync(`${workspace}/${name}`), { code: 'ENOENT' }));
        await checked('workspace root shows only the working folder path', () => {
            assert.ok(options.control && path.posix.dirname(options.control).startsWith(`${workspace}/`), 'A control file inside the working folder is required.');
            assert.deepEqual(io.readdirSync(workspace), [path.posix.relative(workspace, options.control).split('/')[0]]);
        });
        await checked('working folder positive-control file readable and writable', () => {
            const descriptor = io.openSync(options.control, 'r+'); io.closeSync(descriptor);
        });
    } else if (probe === 'service') {
        await checked('no Ploinky environment', () => assert.deepEqual(Object.keys(env).filter(key => key.startsWith('PLOINKY_')), []));
        const result = await run('grep', ['-R', '-l', 'PLOINKY_', '/workspace/ploinky-runtime'], { timeout: 5000, maxBuffer: 65536 })
            .catch(error => { assert.equal(error.code, 1); return error; });
        await checked('runtime context has no Ploinky key', () => assert.equal(result.stdout.trim(), ''));
        assert.ok(options.router, 'Service probe requires the deployed Router tool URL.');
        const response = await request(options.router, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000), redirect: 'manual' });
        await checked('unsigned Router tool call refused', () => assert.ok([401, 403].includes(response.status)));
    } else if (probe === 'gui') {
        assert.ok(options.denied && options.own, 'GUI probe requires all forbidden URLs and its own MCP URL.');
        for (const url of options.denied.split(',')) {
            const result = await run('curl', ['--noproxy', '*', '-sS', '-m', '3', '-o', '/dev/null', url], { timeout: 5000, maxBuffer: 65536 })
                .then(() => true, error => { assert.ok([7, 28].includes(error.code), 'Unexpected network probe error.'); return false; });
            await checked('forbidden GUI/service port refused', () => assert.equal(result, false));
        }
        await checked('own GUI MCP port answers', async () => { await run('curl', ['--noproxy', '*', '-sS', '-m', '3', '-o', '/dev/null', options.own], { timeout: 5000, maxBuffer: 65536 }); });
    } else if (probe === 'channels') {
        await checked('data exposes only read-only tool cache', () => assert.ok(io.readdirSync('/data').every(name => name === 'tool-cache')));
        assert.ok(options.foreign, 'Channel probe requires another run’s known channel path.');
        await checked('foreign channel inaccessible', () => assertDeniedPaths([`${options.foreign}/context.json`], io));
        assert.ok(options.cache, 'Channel probe requires an existing cache file.');
        await checked('cache positive read', () => { const fd = io.openSync(options.cache, 'r'); io.closeSync(fd); });
        await checked('cache write refused', () => {
            let fd, error; try { fd = io.openSync(options.cache, 'r+'); } catch (caught) { error = caught; }
            finally { if (fd !== undefined) io.closeSync(fd); }
            assert.ok(error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code));
        });
    } else throw new Error(`Probe ${probe} requires the controller acceptance scenario; it cannot pass inside a sandbox alone.`);
    assert.ok(checks.length);
    return { sentinel: SENTINEL, probe, robot, victim, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { process.stdout.write(JSON.stringify(await runIsolationProbe(argumentsFrom(process.argv.slice(2)))) + '\n'); }
    catch (error) { console.error(`RoboWork command probe failed: ${error.message}`); process.exitCode = 1; }
}
