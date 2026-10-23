import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRobotShell } from '../server/robot-shell.mjs';

// The real script runs, unmodified except for one seam: its registry location
// is a single literal assignment, and the test copy substitutes only that line
// with a temporary directory, because /data/robots exists only inside the
// RoboTeam container. Every other byte is the production script.
const HOOK_SOURCE = new URL('../scripts/webtty-env.sh', import.meta.url);
const REGISTRY_LINE = 'roboteam_hook_registry=/data/robots';
const ROBOT_A = 'analyst-a1b2c3';
const ROBOT_B = 'analyst-d4e5f6';
const ROBOT_C = 'analyst-0a0b0c';

// The wrappers Ploinky runs (agentRuntime.mjs): the bootstrap sources the hook
// and exits 124 when it fails, then the command stands in for the interactive shell.
const WRAPPERS = [
    ['bash', '/bin/bash', ['--noprofile', '--norc', '-p', '-c']],
    ['sh', '/bin/sh', ['-p', '-c']],
];
// Container images may ship dash as /bin/sh; cover it where it is installed.
for (const dash of ['/bin/dash', '/usr/bin/dash']) {
    if (await fs.stat(dash).then(() => true, () => false)) { WRAPPERS.push(['dash', dash, ['-c']]); break; }
}

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-hook-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const registry = path.join(root, 'data', 'robots');
    const source = await fs.readFile(HOOK_SOURCE, 'utf8');
    const lines = source.split('\n');
    assert.equal(lines.filter(line => line === REGISTRY_LINE).length, 1, 'the registry location is one literal line');
    const hook = path.join(root, 'webtty-env.sh');
    await fs.writeFile(hook, lines.map(line => line === REGISTRY_LINE ? `roboteam_hook_registry=${registry}` : line).join('\n'));
    const robots = {};
    for (const id of [ROBOT_A, ROBOT_B, ROBOT_C]) {
        const home = path.join(registry, id, 'home');
        await fs.mkdir(path.join(registry, id, 'workspace'), { recursive: true });
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(registry, id, 'metadata.json'), '{}\n');
        await prepareRobotShell(home);
        robots[id] = { root: path.join(registry, id), home, folder: path.join(registry, id, 'workspace') };
    }
    // A second name for the same directories, as the workspace data mount is for /data.
    await fs.symlink(path.join(root, 'data'), path.join(root, 'alias'));
    const alias = file => file.replace(path.join(root, 'data'), path.join(root, 'alias'));
    return { root, registry, hook, robots, alias };
}

function run(shell, f, { cwd, home, profile, env = {}, command }) {
    const [, executable, flags] = shell;
    const environment = { PATH: process.env.PATH, HOME: home ?? '/nonexistent-home', ...env };
    if (profile) {
        environment.PLOINKY_WEBTTY_PROFILE_PROVIDER = profile.provider;
        environment.PLOINKY_WEBTTY_PROFILE_ID = profile.id;
        environment.PLOINKY_WEBTTY_PROFILE_LABEL = 'Analyst';
    }
    if (home === null) delete environment.HOME;
    const script = `if [ -f '${f.hook}' ]; then . '${f.hook}' || exit 124; fi; ${command || 'printf "HOME=%s\\nCODEX=%s\\nCWD=%s\\nLEAK=%s\\n" "$HOME" "${CODEX_HOME:-}" "$(pwd -P)" "$(set | grep -c roboteam_hoo[k]_ || true)"'}`;
    const result = spawnSync(executable, [...flags, script, 'marker'], { cwd, env: environment, encoding: 'utf8' });
    const values = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return { status: result.status, values, stderr: result.stderr };
}

const A = id => ({ provider: 'roboTeamAgent', id });

for (const shell of WRAPPERS) {
    const [name] = shell;

    test(`${name}: a folder in another robot's root keeps the cwd while HOME and tools are the selected robot's`, async t => {
        const f = await fixture(t);
        const a = f.robots[ROBOT_A];
        const b = f.robots[ROBOT_B];
        const result = run(shell, f, { cwd: b.folder, home: a.home, profile: A(ROBOT_A) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.values.CWD, b.folder);
        assert.equal(result.values.HOME, a.home);
        assert.equal(result.values.CODEX, path.join(a.home, '.codex'), 'the robot environment was sourced');
        assert.equal(result.values.LEAK, '0', 'no hook variable survives');
    });

    test(`${name}: the robot's own home folder keeps the cwd through both names of /data`, async t => {
        const f = await fixture(t);
        const a = f.robots[ROBOT_A];
        for (const cwd of [a.home, f.alias(a.home)]) {
            for (const home of [a.home, f.alias(a.home)]) {
                // The generated environment returns to the robot root when started in HOME.
                const result = run(shell, f, { cwd, home, profile: A(ROBOT_A), env: { ROBOTEAM_WORKING_DIRECTORY: a.root } });
                assert.equal(result.status, 0, `${cwd} ${home}: ${result.stderr}`);
                assert.equal(result.values.CWD, a.home, `${cwd} ${home}`);
                assert.equal(result.values.HOME, home);
                assert.equal(result.values.CODEX, path.join(home, '.codex'));
            }
        }
    });

    test(`${name}: the test detects the directory change the hook has to undo`, async t => {
        const f = await fixture(t);
        const a = f.robots[ROBOT_A];
        // Negative control: sourcing the generated environment alone moves a shell started in HOME.
        const control = run(shell, f, {
            cwd: a.home, home: a.home, env: { ROBOTEAM_WORKING_DIRECTORY: a.root },
            command: `. '${path.join(a.home, '.roboteam-env.sh')}'; printf 'CWD=%s\\n' "$(pwd -P)"`,
        });
        assert.equal(control.values.CWD, a.root);
        // A robot environment that changes directory is undone by the hook.
        const c = f.robots[ROBOT_C];
        await fs.appendFile(path.join(c.home, '.roboteam-env.sh'), 'cd /\n');
        const result = run(shell, f, { cwd: f.robots[ROBOT_B].folder, home: c.home, profile: A(ROBOT_C) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.values.CWD, f.robots[ROBOT_B].folder);
    });

    test(`${name}: without profile variables the shell stays plain and the hook succeeds`, async t => {
        const f = await fixture(t);
        const b = f.robots[ROBOT_B];
        const result = run(shell, f, { cwd: b.folder, home: f.root });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.values.HOME, f.root);
        assert.equal(result.values.CODEX, '', 'no robot environment');
        assert.equal(result.values.CWD, b.folder);
        // The old cwd-based inference is gone: a robot folder alone selects nothing.
        const inferred = run(shell, f, { cwd: f.robots[ROBOT_A].home, home: f.root });
        assert.equal(inferred.status, 0);
        assert.equal(inferred.values.HOME, f.root);
        assert.equal(inferred.values.CODEX, '');
        // A profile owned by another provider is not loaded either.
        const foreign = run(shell, f, { cwd: b.folder, home: f.root, profile: { provider: 'otherAgent', id: ROBOT_A } });
        assert.equal(foreign.status, 0, foreign.stderr);
        assert.equal(foreign.values.CODEX, '');
    });

    test(`${name}: a HOME that is not the profile robot's home, or a bad profile, makes the bootstrap exit 124`, async t => {
        const f = await fixture(t);
        const a = f.robots[ROBOT_A];
        const b = f.robots[ROBOT_B];
        const cwd = b.folder;
        const refused = [
            ['home of another robot', { home: b.home, profile: A(ROBOT_A) }],
            ['unrelated home', { home: f.root, profile: A(ROBOT_A) }],
            ['robot root instead of home', { home: a.root, profile: A(ROBOT_A) }],
            ['HOME unset', { home: null, profile: A(ROBOT_A) }],
            ['unknown robot', { home: a.home, profile: A('analyst-ffffff') }],
            ['id traversal', { home: a.home, profile: A('../analyst-a1b2c3') }],
            ['id with slash', { home: a.home, profile: A(`${ROBOT_A}/home`) }],
            ['uppercase id', { home: a.home, profile: A('ANALYST-A1B2C3') }],
            ['short id', { home: a.home, profile: A('ab') }],
            ['leading hyphen', { home: a.home, profile: A('-analyst-a1b2c3') }],
            ['id over 64 characters', { home: a.home, profile: A(`a${'b'.repeat(64)}`) }],
            ['provider without id', { home: a.home, profile: A('') }],
            ['id without provider', { home: a.home, profile: { provider: '', id: ROBOT_A } }],
        ];
        for (const [label, options] of refused) {
            const result = run(shell, f, { cwd, ...options });
            assert.equal(result.status, 124, `${label}: ${result.stdout ?? ''}${result.stderr}`);
        }
        // An environment file that is a symbolic link is never sourced.
        await fs.rm(path.join(a.home, '.roboteam-env.sh'));
        await fs.symlink(path.join(b.home, '.roboteam-env.sh'), path.join(a.home, '.roboteam-env.sh'));
        assert.equal(run(shell, f, { cwd, home: a.home, profile: A(ROBOT_A) }).status, 124, 'symlinked environment file');
        await fs.rm(path.join(a.home, '.roboteam-env.sh'));
        assert.equal(run(shell, f, { cwd, home: a.home, profile: A(ROBOT_A) }).status, 124, 'missing environment file');
        await fs.rm(path.join(b.root, 'metadata.json'));
        assert.equal(run(shell, f, { cwd, home: b.home, profile: A(ROBOT_B) }).status, 124, 'missing metadata');
    });
}

test('the shell wrappers under test are the ones Ploinky runs', async t => {
    const source = await fs.readFile(new URL('../../../ploinky/cli/server/webtty/agentRuntime.mjs', import.meta.url), 'utf8').catch(() => null);
    if (source === null) return t.skip('sibling ploinky checkout is missing');
    assert.match(source, /\. \/etc\/ploinky\/webtty-env\.sh \|\| exit 124/);
    assert.match(source, /'--noprofile', '--norc', '-p', '-c'/);
    assert.match(source, /wrapper: Object\.freeze\(\['-p', '-c', SH_WRAPPER\]\)/);
});
