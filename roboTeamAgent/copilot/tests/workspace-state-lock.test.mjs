import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireExecutionLease, withWorkspaceMutation } from '../src/lib/workspaceStateLock.mjs';
import { getCodingAgentModels, getPermissionMode, getCurrentSessionId } from '../src/lib/achillesSettings.mjs';
import { HistoryManager } from '../src/repl/HistoryManager.mjs';

const lockModule = new URL('../src/lib/workspaceStateLock.mjs', import.meta.url).href;
const settingsModule = new URL('../src/lib/achillesSettings.mjs', import.meta.url).href;
const historyModule = new URL('../src/repl/HistoryManager.mjs', import.meta.url).href;

function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-locks-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function child(t, dir, code, extraEnv = {}) {
    const env = { ...process.env, WORKSPACE: dir, ...extraEnv };
    if (!Object.hasOwn(extraEnv, 'PLOINKY_WORKSPACE_ROOT')) delete env.PLOINKY_WORKSPACE_ROOT;
    const script = `
        import { acquireExecutionLease, withWorkspaceMutation } from ${JSON.stringify(lockModule)};
        import * as settings from ${JSON.stringify(settingsModule)};
        import { HistoryManager } from ${JSON.stringify(historyModule)};
        const dir = process.env.WORKSPACE;
        setTimeout(() => process.exit(91), 15000).unref();
        const go = new Promise(resolve => process.once('message', resolve));
        process.send('ready');
        await go;
        ${code}
        if (process.connected) process.disconnect();
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data; });
    const ready = new Promise((resolve, reject) => {
        proc.once('message', resolve);
        proc.once('error', reject);
        proc.once('exit', () => reject(new Error(`Child exited before readiness: ${stderr}`)));
    });
    const done = new Promise((resolve, reject) => {
        proc.once('error', reject);
        proc.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Child failed (${code}/${signal}): ${stderr}`)));
    });
    // Keep an early crash handled even while the caller is waiting for readiness.
    done.catch(() => {});
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    return { proc, ready, done };
}

test('separate processes preserve concurrent settings and multiline history in one canonical workspace', async (t) => {
    const dir = workspace(t);
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    const scripts = [
        `await settings.setPermissionMode(dir, 'full-access');`,
        `await settings.setCurrentSessionId(dir, 'session-shared');`,
        `await settings.setCodingAgentModel(dir, 'codex', 'native-codex');`,
        `await settings.setCodingAgentModel(dir, 'pi', 'native-pi');`,
    ];
    const workers = scripts.map((setting, index) => child(t, index % 2 ? nested : dir, `
        const history = new HistoryManager({ workingDir: dir });
        for (let i = 0; i < 12; i += 1) {
            ${setting}
            await history.add(${JSON.stringify(`writer-${index}\n`)} + i);
        }
    `, { PLOINKY_WORKSPACE_ROOT: dir }));
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach((worker) => worker.proc.send('go'));
    await Promise.all(workers.map((worker) => worker.done));
    assert.equal(getPermissionMode(dir), 'full-access');
    assert.equal(getCurrentSessionId(dir), 'session-shared');
    assert.deepEqual(getCodingAgentModels(dir), { codex: 'native-codex', pi: 'native-pi' });
    const entries = new HistoryManager({ workingDir: dir }).getAll();
    assert.deepEqual(entries.slice().sort(), scripts.flatMap((_, index) =>
        Array.from({ length: 12 }, (_, i) => `writer-${index}\n${i}`)).sort());
    assert.equal(fs.existsSync(path.join(nested, '.data')), false);
});

test('a live lease rejects a second process while another session can execute', async (t) => {
    const dir = workspace(t);
    const release = await acquireExecutionLease(dir, 'session:a');
    t.after(release);
    const worker = child(t, dir, `
        let busy = false;
        try { await acquireExecutionLease(dir, 'session:a'); }
        catch (error) { busy = error.code === 'WORKSPACE_STATE_BUSY'; }
        if (!busy) throw new Error('Duplicate execution accepted');
        const release = await acquireExecutionLease(dir, 'session:b');
        await release();
    `);
    await worker.ready;
    worker.proc.send('go');
    await worker.done;
    await release();
    await release();
    const next = await acquireExecutionLease(dir, 'session:a');
    await next();
});

test('a genuinely exited process leaves a recoverable execution lease', async (t) => {
    const dir = workspace(t);
    const crashed = child(t, dir, `await acquireExecutionLease(dir, 'abandoned'); process.exit(0);`);
    await crashed.ready;
    crashed.proc.send('go');
    await crashed.done;
    const contenders = [0, 1].map((index) => child(t, dir, `
        try {
            const release = await acquireExecutionLease(dir, 'abandoned');
            await withWorkspaceMutation(dir, () => settings.setCodingAgentModel(dir, ${JSON.stringify(index ? 'pi' : 'codex')}, 'recovered'));
            await release();
        } catch (error) {
            if (!['WORKSPACE_STATE_BUSY', 'WORKSPACE_STATE_LOCK_RECOVERY'].includes(error.code)) throw error;
        }
    `));
    await Promise.all(contenders.map((worker) => worker.ready));
    contenders.forEach((worker) => worker.proc.send('go'));
    await Promise.all(contenders.map((worker) => worker.done));
    assert.ok(Object.values(getCodingAgentModels(dir)).includes('recovered'));
    const release = await acquireExecutionLease(dir, 'abandoned');
    await release();
});

test('ambiguous owners and symlinked locks fail closed; release cannot remove a replacement owner', async (t) => {
    const dir = workspace(t);
    await withWorkspaceMutation(dir, () => {});
    const mutationPath = path.join(dir, '.data', 'achilles-cli', 'locks', 'mutation.lock');
    fs.writeFileSync(mutationPath, '{partial');
    await assert.rejects(withWorkspaceMutation(dir, () => assert.fail('entered')), { code: 'WORKSPACE_STATE_LOCK_AMBIGUOUS' });
    assert.equal(fs.readFileSync(mutationPath, 'utf8'), '{partial');
    fs.unlinkSync(mutationPath);
    const outside = path.join(workspace(t), 'outside');
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, mutationPath);
    await assert.rejects(withWorkspaceMutation(dir, () => assert.fail('entered')), /symbolic link/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
    fs.unlinkSync(mutationPath);
    const release = await acquireExecutionLease(dir, 'replace');
    const lockDir = path.dirname(mutationPath);
    const file = path.join(lockDir, fs.readdirSync(lockDir).find((name) => name.startsWith('execution-')));
    const replacement = { ...JSON.parse(fs.readFileSync(file, 'utf8')), token: randomUUID() };
    fs.writeFileSync(file, JSON.stringify(replacement));
    await assert.rejects(release(), { code: 'WORKSPACE_STATE_LOCK_RECOVERY' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, replacement.token);
});

test('nested mutations join only their active callback and execution leases respect lock order', async (t) => {
    const dir = workspace(t);
    let startDetached;
    let detached;
    const events = [];
    await withWorkspaceMutation(dir, async () => {
        await withWorkspaceMutation(dir, () => { events.push('nested'); });
        await assert.rejects(acquireExecutionLease(dir, 'inverted'), { code: 'WORKSPACE_STATE_LOCK_ORDER' });
        const gate = new Promise((resolve) => { startDetached = resolve; });
        detached = gate.then(() => withWorkspaceMutation(dir, () => { events.push('detached'); }));
    });
    await withWorkspaceMutation(dir, async () => {
        startDetached();
        await delay(40);
        events.push('current-finished');
    });
    await detached;
    assert.deepEqual(events, ['nested', 'current-finished', 'detached']);
});

test('mutation contention stops within its bounded acquisition window without entering the callback', async (t) => {
    const dir = workspace(t);
    const worker = child(t, dir, `
        const started = Date.now();
        let rejected = false;
        try { await withWorkspaceMutation(dir, () => { throw new Error('Concurrent mutation entered'); }); }
        catch (error) { rejected = error.code === 'WORKSPACE_STATE_BUSY'; }
        if (!rejected || Date.now() - started < 4500 || Date.now() - started > 10000) {
            throw new Error('Mutation wait did not honor the bounded contention contract');
        }
    `);
    await worker.ready;
    await withWorkspaceMutation(dir, async () => {
        worker.proc.send('go');
        await worker.done;
    });
    await assert.rejects(withWorkspaceMutation(dir, () => { throw new Error('mutation failure'); }), /mutation failure/);
    const release = await acquireExecutionLease(dir, 'after-error');
    await release();
    await withWorkspaceMutation(dir, () => { fs.writeFileSync(path.join(dir, 'recovered'), 'yes'); });
    assert.equal(fs.readFileSync(path.join(dir, 'recovered'), 'utf8'), 'yes');
});

test('a reused PID identity is recoverable but an abandoned recovery claim is preserved for reconciliation', async (t) => {
    const dir = workspace(t);
    await acquireExecutionLease(dir, 'old-process');
    const lockDir = path.join(dir, '.data', 'achilles-cli', 'locks');
    const file = path.join(lockDir, fs.readdirSync(lockDir).find((name) => name.startsWith('execution-')));
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...owner, start: '0' }));
    const recovered = await acquireExecutionLease(dir, 'old-process');
    await recovered();
    const claim = path.join(lockDir, 'mutation.lock.recovery');
    fs.writeFileSync(claim, JSON.stringify({ ...owner, start: '0' }));
    const evidence = fs.readFileSync(claim, 'utf8');
    await assert.rejects(withWorkspaceMutation(dir, () => assert.fail('entered')), { code: 'WORKSPACE_STATE_LOCK_RECOVERY' });
    assert.equal(fs.readFileSync(claim, 'utf8'), evidence);
});
