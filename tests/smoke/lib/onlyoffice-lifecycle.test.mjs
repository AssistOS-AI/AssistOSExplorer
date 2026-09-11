import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { onlyOfficeGateTimeouts, restartOnlyOffice } from './onlyoffice-lifecycle.mjs';

test('OnlyOffice budgets both mandatory restarts plus UI and finalization', () => {
    const budgets = onlyOfficeGateTimeouts();
    // The failed release reached cleanup at 185.667 s after a 152.519 s
    // first restart. A second equally fast restart cannot fit in 300 s.
    const cleanupStartsAtMs = 185_667;
    const observedRestartMs = 152_519;
    assert.ok(cleanupStartsAtMs + observedRestartMs > 300_000);
    assert.ok(observedRestartMs < budgets.restartTimeoutMs);
    assert.ok(budgets.testTimeoutMs - cleanupStartsAtMs
        >= budgets.restartTimeoutMs + budgets.finalizationTimeoutMs);
    assert.equal(budgets.testTimeoutMs, 840_000);
    assert.equal(onlyOfficeGateTimeouts({ uiTimeoutMs: 240_000 }).testTimeoutMs, 960_000);
});

test('OnlyOffice rejects disabled, malformed and overflowing command or lifecycle timers', async () => {
    const invalid = [0, -1, '', '300000', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER];
    for (const value of invalid) {
        for (const key of ['uiTimeoutMs', 'restartTimeoutMs', 'finalizationTimeoutMs']) {
            assert.throws(() => onlyOfficeGateTimeouts({ [key]: value }), /finite positive timer interval/);
        }
        await assert.rejects(restartOnlyOffice({
            executable: process.execPath, workspaceRoot: os.tmpdir(), timeoutMs: value,
        }, { execute: () => assert.fail('Invalid timing must fail before a command starts.') }), /finite positive timer interval/);
    }
    assert.throws(() => onlyOfficeGateTimeouts({ restartTimeoutMs: 2_147_483_647 }), /total test timeout/);
});

test('OnlyOffice records both successful restart commands with exact scope and finite budgets', async () => {
    const calls = [];
    const env = { FIXTURE_VARIABLE: 'kept' };
    let elapsed = 0;
    const options = { executable: '/candidate/ploinky', workspaceRoot: '/candidate/workspace', timeoutMs: 300_000, env };
    const dependencies = {
        now: () => elapsed,
        execute: async (...args) => {
            calls.push(args);
            elapsed += 152_519;
            return { stdout: '✓ Agent restarted.\n', stderr: '' };
        },
    };
    for (let index = 0; index < 2; index++) {
        assert.deepEqual(await restartOnlyOffice(options, dependencies), {
            stdout: '✓ Agent restarted.\n', stderr: '', status: 'completed', code: 0,
            elapsedMs: 152_519, timeoutMs: 300_000,
        });
    }
    assert.equal(calls.length, 2);
    for (const [command, args, commandOptions] of calls) {
        assert.equal(command, options.executable);
        assert.deepEqual(args, ['restart', 'onlyOffice']);
        assert.equal(commandOptions.cwd, options.workspaceRoot);
        assert.deepEqual(commandOptions.env, { ...env, PLOINKY_CWD: options.workspaceRoot });
        assert.equal(commandOptions.timeout, 300_000);
        assert.equal(commandOptions.killSignal, 'SIGKILL');
    }
});

test('a hung restart command is terminated and never retried or reported as successful', { timeout: 5000 }, async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-restart-timeout-'));
    try {
        // Node treats the fixed command argument "restart" as this fixture
        // script; no Ploinky process or deployed service is started here.
        await fs.writeFile(path.join(workspaceRoot, 'restart'), [
            'require("node:fs").appendFileSync("invocations", "started\\n");',
            'process.on("SIGTERM", () => {});',
            'setInterval(() => {}, 1000);',
        ].join('\n'));
        await assert.rejects(restartOnlyOffice({
            executable: process.execPath, workspaceRoot, timeoutMs: 250,
        }), (error) => error.killed === true && error.signal === 'SIGKILL');
        assert.equal(await fs.readFile(path.join(workspaceRoot, 'invocations'), 'utf8'), 'started\n');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('a restart failure preserves its nonzero exit and output instead of completing', { timeout: 5000 }, async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-restart-failure-'));
    try {
        await fs.writeFile(path.join(workspaceRoot, 'restart'), 'process.stderr.write("fixture restart failed"); process.exit(7);');
        await assert.rejects(restartOnlyOffice({
            executable: process.execPath, workspaceRoot, timeoutMs: 2000,
        }), (error) => error.code === 7 && error.stderr === 'fixture restart failed');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});
