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

const REFUSED_WRITE = ['EROFS', 'EACCES', 'EPERM'];
const within = (root, value) => value === root || value.startsWith(root === '/' ? '/' : `${root}/`);

// One mount per line of /proc/self/mountinfo: `id parent major:minor root mountpoint options [optional...] - fstype source super`.
// The kernel escapes a space, tab, newline and backslash in the mount point as \NNN octal.
export function parseMountinfo(content) {
    const entries = [];
    for (const line of String(content).split('\n')) {
        if (line === '') continue;
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        assert.ok(separator >= 6 && fields.length >= separator + 3 && /^\d+$/u.test(fields[0]) && /^\d+$/u.test(fields[1]) && fields[4].startsWith('/'),
            'The mount table is malformed.');
        const mountPoint = Buffer.from(Buffer.from(fields[4], 'utf8').toString('latin1')
            .replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8) & 0xff)), 'latin1').toString('utf8');
        entries.push({ id: Number(fields[0]), parent: Number(fields[1]), mountPoint, options: fields[5].split(',') });
    }
    return entries;
}

// The mounts whose content a process can reach. The kernel attaches a mount to the topmost mount at its path, so a mount
// stacked on another (a tmpfs mask over a copied submount) has the covered mount as its parent and the same mount point, and
// hides it with everything mounted below it. Two mounts of one parent are different: the one at the path or above hides the
// other, however they are ordered. A mount is also lost when its parent is not reachable.
export function visibleMounts(entries) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const stackedOver = entry => entries.some(other => other !== entry && other.parent === entry.id && other.mountPoint === entry.mountPoint);
    const memo = new Map();
    const reachable = entry => {
        if (memo.has(entry.id)) return memo.get(entry.id);
        memo.set(entry.id, false);
        const index = entries.indexOf(entry);
        const covered = entries.some((other, at) => other !== entry && other.parent === entry.parent
            && (other.mountPoint === entry.mountPoint ? at > index : within(other.mountPoint, entry.mountPoint)));
        const parent = byId.get(entry.parent);
        const result = !covered && (!parent || reachable(parent) && (entry.mountPoint === parent.mountPoint || !stackedOver(parent)));
        memo.set(entry.id, result);
        return result;
    };
    return entries.filter(entry => reachable(entry) && !stackedOver(entry));
}

// The visible writable mounts at or below the root, other than the working folder's own.
export function writableWorkspaceMounts(content, workspace, cwd) {
    return visibleMounts(parseMountinfo(content)).filter(entry => entry.options.includes('rw') && within(workspace, entry.mountPoint)
        && !within(cwd, entry.mountPoint)).map(entry => entry.mountPoint);
}

// Attempts to create a file where a robot has no write access and requires a refusal. A created file is removed again.
function assertCreateRefused(io, file) {
    let descriptor, error;
    try { descriptor = io.openSync(file, 'wx'); } catch (caught) { error = caught; }
    if (descriptor !== undefined) { io.closeSync(descriptor); try { io.unlinkSync?.(file); } catch { /* A leftover is itself the evidence. */ } }
    assert.ok(error && REFUSED_WRITE.includes(error.code), `A new file was admitted: ${file}`);
}

// A device node opens for writing even on a read-only mount unless the mount is `nodev`, and a `/dev/null` bound over `.env`
// by Podman may be one. A write to it persists nowhere, so the open may succeed only on that very device.
function assertNoPersistentWrite(io, file) {
    let descriptor, error;
    try { descriptor = io.openSync(file, 'r+'); } catch (caught) { error = caught; }
    if (descriptor === undefined) { assert.ok(error && REFUSED_WRITE.includes(error.code), `A writable open failed unexpectedly: ${file}`); return; }
    try {
        const opened = io.fstatSync(descriptor), discard = io.statSync('/dev/null');
        assert.ok(opened.isCharacterDevice() && opened.rdev === discard.rdev, `A writable open was admitted: ${file}`);
    } finally { io.closeSync(descriptor); }
}

function assertOpenRefused(io, file) {
    let descriptor, error;
    try { descriptor = io.openSync(file, 'r+'); } catch (caught) { error = caught; }
    if (descriptor !== undefined) io.closeSync(descriptor);
    assert.ok(error && REFUSED_WRITE.includes(error.code), `A writable open was admitted: ${file}`);
}

// Run inside the robot's sandbox. A robot with a user namespace of its own tries to take a mask away: it unmounts the private
// entries, binds the root without its submounts and binds it recursively. Anything printed SHOWN or UNMOUNTED is a hole.
const SHOWTHROUGH = ['R=$1; V=$2', 'umount "$R/.data" 2>/dev/null && echo UNMOUNTED', 'umount "$R/.ploinky" 2>/dev/null && echo UNMOUNTED',
    'umount "$R/.ploinky-box" 2>/dev/null && echo UNMOUNTED', 'mkdir -p /tmp/robowork-flat /tmp/robowork-deep',
    'mount --bind "$R" /tmp/robowork-flat 2>/dev/null', 'mount --rbind "$R" /tmp/robowork-deep 2>/dev/null',
    'for base in "$R" /tmp/robowork-flat /tmp/robowork-deep; do',
    '  [ -e "$base/.data/.private/roboWorkAgent/robots/$V/home/marker-B" ] && echo SHOWN',
    '  for name in .data .ploinky .ploinky-box; do [ -n "$(ls -A "$base/$name" 2>/dev/null)" ] && echo SHOWN; done',
    '  [ -s "$base/.env" ] && echo SHOWN', 'done', 'exit 0'].join('\n');

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
        // The workspace is a separate mount in every path, so the search above does not enter it.
        const shown = await run('find', [workspace, '-name', 'marker-B', '-print'], { timeout: 60000, maxBuffer: 1024 * 1024 }).catch(error => {
            assert.ok(error.code === 1 && typeof error.stdout === 'string', 'Workspace marker search failed without bounded evidence.');
            return error;
        });
        await checked('workspace marker search empty', () => assert.equal(shown.stdout.trim(), ''));
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
        // A robot started in a project folder sees the workspace read-only at its canonical path: the private entries are
        // empty read-only masks, other projects can be read and not written, and only the working folder is writable.
        const cwd = options.control && path.posix.dirname(options.control);
        assert.ok(cwd && cwd.startsWith(`${workspace}/`), 'A control file directly in a working folder below the workspace root is required.');
        const siblingFolder = options.sibling && path.posix.dirname(options.sibling);
        assert.ok(siblingFolder && path.posix.isAbsolute(siblingFolder) && siblingFolder.startsWith(`${workspace}/`)
            && !within(cwd, siblingFolder) && !within(siblingFolder, cwd),
        'A sibling file in another project folder below the workspace root is required.');
        assert.ok(['present', 'absent'].includes(options.env), 'The expected state of the root .env, present or absent, is required.');
        const entries = io.readdirSync(workspace);
        for (const name of ['.data', '.ploinky', '.ploinky-box', ...entries.filter(entry => entry.startsWith('.ploinky-box.'))]) {
            await checked(`${name} exists, lists nothing and refuses a new file`, () => {
                assert.deepEqual(io.readdirSync(`${workspace}/${name}`), [], `${name} is not empty`);
                assertCreateRefused(io, `${workspace}/${name}/robowork-probe`);
            });
        }
        await checked(`root .env is ${options.env}, and holds no readable content when present`, () => {
            const env = `${workspace}/.env`;
            if (options.env === 'absent') { assert.throws(() => io.lstatSync(env), { code: 'ENOENT' }); return; }
            io.lstatSync(env);
            let content;
            try { content = io.readFileSync(env, 'utf8'); } catch (error) { assert.equal(error.code, 'EACCES', 'The masked .env fails unexpectedly.'); }
            assert.ok(content === undefined || content === '', 'The root .env content is readable.');
            assertNoPersistentWrite(io, env);
        });
        await checked('victim paths are denied, including through the workspace', () => assertDeniedPaths(protectedFiles, io));
        await checked('another project reads and cannot be written', () => {
            const descriptor = io.openSync(options.sibling, 'r'); io.closeSync(descriptor);
            assertOpenRefused(io, options.sibling);
            assertCreateRefused(io, `${siblingFolder}/robowork-probe`);
        });
        await checked('the root refuses a new file and lists the path to the working folder and to the other project', () => {
            assertCreateRefused(io, `${workspace}/robowork-probe`);
            for (const target of [cwd, options.sibling]) assert.ok(entries.includes(target.slice(workspace.length + 1).split('/')[0]), `The root does not list ${target}`);
        });
        await checked('working folder positive-control file readable and writable', () => {
            const descriptor = io.openSync(options.control, 'r+'); io.closeSync(descriptor);
        });
        await checked('the working folder .roboteam is empty and refuses a new file', () => {
            assert.deepEqual(io.readdirSync(`${cwd}/.roboteam`), [], 'The working folder .roboteam is not empty');
            assertCreateRefused(io, `${cwd}/.roboteam/robowork-probe`);
        });
        await checked('no visible writable mount at or below the root outside the working folder', () => {
            assert.deepEqual(writableWorkspaceMounts(io.readFileSync('/proc/self/mountinfo', 'utf8'), workspace, cwd), []);
        });
        // `find` exits 1 on any directory it cannot read, which says nothing about sockets; its bounded output still decides.
        const sockets = await run('find', [workspace, '-path', cwd, '-prune', '-o', '-type', 's', '-print'], { timeout: 60000, maxBuffer: 1024 * 1024 })
            .catch(error => {
                assert.ok(error.code === 1 && typeof error.stdout === 'string', 'Socket search failed without bounded evidence.');
                return error;
            });
        await checked('no socket outside the working folder', () => assert.equal(sockets.stdout.trim(), ''));
    } else if (probe === 'showthrough') {
        // A permission refusal of `unshare` means no robot can build a namespace to attack a mask from. A missing binary
        // means the probe could not run, and fails.
        const outcome = await run('unshare', ['-Urm', '/bin/sh', '-c', SHOWTHROUGH, 'sh', workspace, victim], { timeout: 30000, maxBuffer: 65536 })
            .then(result => ({ result }), error => ({ error }));
        if (outcome.error) {
            await checked('unshare is refused by permission, so no mask can be attacked', () => {
                assert.notEqual(outcome.error.code, 'ENOENT', 'unshare is required to run this probe.');
                assert.match(String(outcome.error.stderr || ''), /not permitted|permission denied/iu, 'unshare failed for a reason other than a permission refusal.');
            });
        } else {
            await checked('no mask can be unmounted or bypassed from a namespace of the robot', () => {
                assert.doesNotMatch(String(outcome.result.stdout), /SHOWN|UNMOUNTED/u, 'A mask was bypassed.');
            });
        }
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
