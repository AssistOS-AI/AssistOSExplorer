import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalRunner, dispatchLocalLlm, localLlmHelp } from '../scripts/run-local-llm-e2e.mjs';

const blocks = {
    apple: 'mac-model-venus', 'apple-cpu': 'mac-model-cpu', nvidia: 'apparatus-model-nvidia', cpu: 'apparatus-model-cpu',
    'amd-apu': 'linux-model-amd-apu', 'amd-apu-pressure': 'linux-model-amd-apu-pressure', 'amd-apu-cpu': 'linux-model-amd-apu-cpu',
};
const manifest = (profile) => ({ block: blocks[profile], target: { execution: { model: { profile } } } });
const args = (profile, action = 'live') => ['--profile', profile, '--action', action, '--run', '/tmp/run.json', ...(action === 'prepare' ? ['--config', '/tmp/config.json', '--pins', '/tmp/pins.json'] : ['--authorization', '/tmp/auth.json'])];

function offline(profile, result = { status: 0 }) {
    const calls = [];
    return {
        calls,
        readJson: () => manifest(profile),
        spawn: (...values) => { calls.push(values); return result; },
    };
}

test('each explicit profile binds to the fixed sibling runner and canonical action', () => {
    assert.equal(canonicalRunner, fileURLToPath(new URL('../../../../ploinky/tests/hardware-limits/verify.mjs', import.meta.url)));
    for (const profile of Object.keys(blocks)) {
        for (const action of ['prepare', 'provision', 'live', 'cleanup']) {
            const injected = offline(profile);
            assert.equal(dispatchLocalLlm(args(profile, action), injected), 0);
            assert.equal(injected.calls.length, 1);
            const [command, argv, options] = injected.calls[0];
            assert.equal(command, process.execPath);
            assert.deepEqual(argv, action === 'prepare'
                ? [canonicalRunner, 'prepare-live', '--block', blocks[profile], '--run', '/tmp/run.json', '--config', '/tmp/config.json', '--pins', '/tmp/pins.json']
                : [canonicalRunner, action, '--run', '/tmp/run.json', '--authorization', '/tmp/auth.json']);
            assert.equal(options.shell, false);
            assert.equal(options.stdio, 'inherit');
        }
    }
});

test('invalid, missing, duplicate and unsupported options refuse before invocation', () => {
    const valid = args('cpu');
    const invalid = [[], ['--help', ...valid], valid.slice(2), valid.slice(0, 2),
        args('all'), args(''), args('cpu', 'all'), args('cpu', ''),
        [...valid, '--profile', 'cpu'], [...valid, '--executable', '/tmp/custom'],
        [...valid, '--block', blocks.cpu], [...valid, '--config', '/tmp/config'],
        valid.slice(0, -2), [...valid.slice(0, 5), 'relative', ...valid.slice(6)],
        [...valid.slice(0, -1), 'relative'], args('cpu', 'prepare').slice(0, -2),
    ];
    for (const argv of invalid) {
        const injected = offline('cpu');
        assert.throws(() => dispatchLocalLlm(argv, injected));
        assert.equal(injected.calls.length, 0);
    }
});

test('empty, wrong and malformed manifest bindings refuse every execution action', () => {
    for (const action of ['provision', 'live', 'cleanup']) {
        for (const record of [null, {}, manifest('apple'), { ...manifest('cpu'), block: blocks.nvidia },
            { block: blocks.cpu, target: { execution: { model: { profile: '' } } } }]) {
            const injected = offline('cpu');
            injected.readJson = () => record;
            assert.throws(() => dispatchLocalLlm(args('cpu', action), injected), /binding/);
            assert.equal(injected.calls.length, 0);
        }
    }
    const injected = offline('cpu');
    injected.readJson = () => { throw new Error('malformed JSON'); };
    assert.throws(() => dispatchLocalLlm(args('cpu'), injected), /malformed/);
    assert.equal(injected.calls.length, 0);
});

test('canonical nonzero exit codes propagate exactly and interrupted or failed launches cannot pass', () => {
    for (const status of [1, 2, 7, 42]) {
        assert.equal(dispatchLocalLlm(args('cpu'), offline('cpu', { status })), status);
    }
    assert.throws(() => dispatchLocalLlm(args('cpu'), offline('cpu', { status: null, signal: 'SIGTERM' })), /SIGTERM/);
    assert.throws(() => dispatchLocalLlm(args('cpu'), offline('cpu', { error: new Error('launch failed') })), /launch failed/);
});

test('prepare rejects a successful canonical result with a mismatched generated manifest', () => {
    assert.throws(() => dispatchLocalLlm(args('cpu', 'prepare'), offline('apple')), /binding/);
});

test('AMD profiles reject every foreign run binding and preserve canonical failure results', () => {
    for (const profile of ['amd-apu', 'amd-apu-pressure', 'amd-apu-cpu']) {
        for (const action of ['prepare', 'provision', 'live', 'cleanup']) {
            for (const foreign of Object.keys(blocks).filter(value => value !== profile)) {
                const injected = offline(foreign);
                assert.throws(() => dispatchLocalLlm(args(profile, action), injected), /binding/);
                assert.equal(injected.calls.length, action === 'prepare' ? 1 : 0);
            }
        }
        for (const status of [1, 2, 7]) assert.equal(dispatchLocalLlm(args(profile), offline(profile, { status })), status);
        assert.throws(() => dispatchLocalLlm(args(profile), offline(profile, { status: null, signal: 'SIGTERM' })), /SIGTERM/);
    }
});

test('help is read-only and exposes the complete explicit interface', () => {
    const injected = offline('cpu');
    injected.readJson = () => { throw new Error('help must not read'); };
    assert.equal(dispatchLocalLlm(['--help'], injected), 0);
    assert.equal(injected.calls.length, 0);
    for (const value of ['apple|apple-cpu|nvidia|cpu|amd-apu|amd-apu-pressure|amd-apu-cpu', 'prepare|provision|live|cleanup', '--run', '--config', '--pins', '--authorization',
        'mac-model-cpu / LIVE-L7', 'linux-model-amd-apu / LIVE-L13,LIVE-L9,LIVE-L11,LIVE-L12',
        'linux-model-amd-apu-pressure / LIVE-L10', 'linux-model-amd-apu-cpu / LIVE-L8']) assert.ok(localLlmHelp.includes(value));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-local-llm-e2e.mjs', import.meta.url)), '--help'], { encoding: 'utf8', cwd: '/' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), localLlmHelp.trim());
});

test('Mac CPU and Linux CPU cannot be redirected into each other or override frozen scenarios', () => {
    for (const profile of ['apple-cpu', 'cpu']) {
        for (const action of ['provision', 'live', 'cleanup']) {
            for (const foreign of Object.keys(blocks).filter(value => value !== profile)) {
                const injected = offline(foreign);
                assert.throws(() => dispatchLocalLlm(args(profile, action), injected), /binding/);
                assert.equal(injected.calls.length, 0);
            }
            for (const option of ['scenario', 'measurement', 'context', 'pins', 'config']) {
                const injected = offline(profile);
                assert.throws(() => dispatchLocalLlm([...args(profile, action), `--${option}`, '/tmp/override'], injected));
                assert.equal(injected.calls.length, 0);
            }
        }
    }
});

test('the opt-in script preserves baseline scripts and Playwright discovery', () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const current = JSON.parse(fs.readFileSync(packagePath));
    assert.equal(current.scripts['test:local-llm'], 'node ./scripts/run-local-llm-e2e.mjs');
    assert.equal(current.scripts.test, 'node ./scripts/run-playwright.mjs');
    assert.equal(current.scripts['test:quick'], 'node ./scripts/run-playwright.mjs --grep-invert @external');
    assert.equal(current.scripts['test:full'], 'SMOKE_GITHUB=1 SMOKE_GPT_RESEARCHER=1 SMOKE_ONLYOFFICE=1 SMOKE_UMAMI=1 SMOKE_WEBMEET_HEADLESS=1 SMOKE_WEBMEET_MEDIA=1 SMOKE_OPEN_INTERPRETER=1 SMOKE_WEBTTY_CORE=1 node ./scripts/run-playwright.mjs');
    assert.equal(current.scripts['test:webmeet-network-matrix'], 'node ./scripts/run-webmeet-network-matrix.mjs');
    assert.equal(current.scripts['test:copilot-codex'], 'node ./scripts/codex-test-auth.mjs run');
    const config = fs.readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
    assert.match(config, /testDir: '\.\/specs'/);
    assert.equal(config.includes('local-llm-e2e'), false);
    assert.equal(fs.readFileSync(new URL('../scripts/run-playwright.mjs', import.meta.url), 'utf8').includes('run-local-llm-e2e'), false);
});
