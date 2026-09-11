import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function createLaunchFixture(t) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-launch-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const agentRoot = path.join(directory, "agent with spaces ' $ #");
    const cwd = path.join(directory, 'unrelated workspace');
    const home = path.join(directory, 'login home');
    const wrapper = path.join(agentRoot, 'scripts/run-document-server-with-autoassembly.sh');
    await mkdir(path.dirname(wrapper), { recursive: true });
    await mkdir(cwd);
    await mkdir(home);
    await cp(new URL('../src/', import.meta.url), path.join(agentRoot, 'src'), { recursive: true });
    await writeFile(wrapper, '#!/bin/bash\nprintf "bundled-wrapper\\n%s\\n" "$PWD"\n');
    await writeFile(path.join(home, '.bash_profile'), 'cd "$HOME"\nprintf login > "$HOME/login-ran"\n');
    const runner = path.join(directory, 'run.mjs');
    await writeFile(runner, `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startDocumentServerProcess } from ${JSON.stringify(pathToFileURL(path.join(agentRoot, 'src/index.mjs')).href)};
const options = JSON.parse(process.argv[2]);
let launch;
const runtime = startDocumentServerProcess({
    ...options,
    spawnProcess(file, args, spawnOptions) {
        launch = { file, args, detached: spawnOptions.detached };
        return spawn(file, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    },
});
let stdout = '';
let stderr = '';
runtime.child.stdout.on('data', (chunk) => { stdout += chunk; });
runtime.child.stderr.on('data', (chunk) => { stderr += chunk; });
const [code, signal] = await once(runtime.child, 'close');
process.stdout.write(JSON.stringify({ code, signal, stdout, stderr, launch }));
`);
    return {
        cwd,
        home,
        wrapper,
        async run(options = {}, env = {}) {
            const result = await execFileAsync(process.execPath, [runner, JSON.stringify(options)], {
                cwd,
                env: { PATH: process.env.PATH, HOME: home, ...env },
                timeout: 10_000,
            });
            assert.equal(result.stderr, '');
            return JSON.parse(result.stdout);
        },
    };
}

for (const emptyOverride of [false, true]) {
    test(`bundled DocumentServer starts outside its relocated agent directory${emptyOverride ? ' with an empty environment override' : ''}`, async (t) => {
        const fixture = await createLaunchFixture(t);
        const result = await fixture.run({}, emptyOverride ? { ONLYOFFICE_DOCUMENT_SERVER_COMMAND: '' } : {});

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `bundled-wrapper\n${fixture.cwd}\n`);
        assert.deepEqual(result.launch, {
            file: '/bin/bash',
            args: [fixture.wrapper],
            detached: true,
        });
        await assert.rejects(readFile(path.join(fixture.home, 'login-ran')), { code: 'ENOENT' });
    });
}

for (const overrideSource of ['option', 'environment']) {
    test(`DocumentServer preserves shell expansion and pipelines for the ${overrideSource} command override`, async (t) => {
        const fixture = await createLaunchFixture(t);
        const command = 'printf "%s\\n" "$ONLYOFFICE_LAUNCH_MARKER" | tr a-z A-Z';
        const env = { ONLYOFFICE_LAUNCH_MARKER: 'custom-command' };
        const options = {};
        if (overrideSource === 'option') {
            options.command = command;
            env.ONLYOFFICE_DOCUMENT_SERVER_COMMAND = 'exit 91';
        } else {
            env.ONLYOFFICE_DOCUMENT_SERVER_COMMAND = `  ${command}  `;
        }
        const result = await fixture.run(options, env);

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, 'CUSTOM-COMMAND\n');
        assert.deepEqual(result.launch, {
            file: '/bin/bash',
            args: ['-lc', command],
            detached: true,
        });
    });
}
