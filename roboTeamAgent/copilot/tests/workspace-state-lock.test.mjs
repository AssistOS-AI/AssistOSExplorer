import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireExecutionLease, withWorkspaceMutation } from '../src/lib/storage/workspaceStateLock.mjs';
import { getDisabledSkills, getSelectedModel, getPermissionMode, getCurrentSessionId } from '../src/lib/config/achillesSettings.mjs';
import { HistoryManager } from '../src/repl/HistoryManager.mjs';

const lockModule = new URL('../src/lib/storage/workspaceStateLock.mjs', import.meta.url).href;
const settingsModule = new URL('../src/lib/config/achillesSettings.mjs', import.meta.url).href;
const historyModule = new URL('../src/repl/HistoryManager.mjs', import.meta.url).href;

function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-locks-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function child(t, dir, code, extraEnv = {}) {
    const env = { ...process.env, WORKSPACE: dir, ...extraEnv };
    env.PLOINKY_WORKSPACE_ROOT ||= dir;
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
        `await settings.setSelectedModel(dir, 'shared-model');`,
        `await settings.setDisabledSkills(dir, ['skill-a']);`,
    ];
    const workers = scripts.map((setting, index) => child(t, dir, `
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
    assert.equal(getSelectedModel(dir), 'shared-model');
    assert.deepEqual(getDisabledSkills(dir), ['skill-a']);
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
            await withWorkspaceMutation(dir, () => settings.setSelectedModel(dir, ${JSON.stringify(index ? 'recovered-b' : 'recovered-a')}));
            await release();
        } catch (error) {
            if (!['WORKSPACE_STATE_BUSY', 'WORKSPACE_STATE_LOCK_RECOVERY'].includes(error.code)) throw error;
        }
    `));
    await Promise.all(contenders.map((worker) => worker.ready));
    contenders.forEach((worker) => worker.proc.send('go'));
    await Promise.all(contenders.map((worker) => worker.done));
    assert.ok(['recovered-a', 'recovered-b'].includes(getSelectedModel(dir)));
    const release = await acquireExecutionLease(dir, 'abandoned');
    await release();
});

test('ambiguous owners and symlinked locks fail closed; release cannot remove a replacement owner', async (t) => {
    const dir = workspace(t);
    await withWorkspaceMutation(dir, () => {});
    const mutationPath = path.join(dir, '.roboteam', 'locks', 'mutation.lock');
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
    const lockDir = path.join(dir, '.roboteam', 'locks');
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

function rootedWorkspace(t) {
    const dir = fs.realpathSync(workspace(t));
    const old = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = dir;
    t.after(() => { if (old === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = old; });
    return dir;
}

function diagnosticRecords(dir) {
    const file = path.join(dir, '.roboteam', 'logs', 'copilot-diagnostics.jsonl');
    return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const linuxOnly = fs.existsSync('/proc/self/stat') ? false : 'workspace locks require Linux /proc';

test('a BUSY refusal logs the live owner and whether this process still holds the lease', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const release = await acquireExecutionLease(dir, 'session:diag', { label: 'unit' });
    t.after(() => release().catch(() => {}));
    await assert.rejects(acquireExecutionLease(dir, 'session:diag'), { code: 'WORKSPACE_STATE_BUSY' });
    const records = diagnosticRecords(dir);
    const busy = records.find((record) => record.event === 'lock.busy');
    assert.equal(busy.kind, 'session');
    assert.equal(busy.ownerPid, process.pid);
    assert.equal(busy.ownerIsThisProcess, true);
    assert.equal(busy.ownerState, 'live');
    assert.equal(busy.thisProcessHolds, true);
    assert.equal(busy.thisProcessHold.label, 'unit');
    assert.equal(busy.thisProcessHold.tokenMatchesFile, true);
    assert.match(busy.lock, /^execution-[0-9a-f]{64}\.lock$/);
    assert.equal(typeof busy.ino, 'number');
    const acquired = records.find((record) => record.event === 'lock.acquired');
    assert.equal(acquired.token, busy.ownerToken);
    assert.equal(JSON.stringify(records).includes(JSON.parse(fs.readFileSync(path.join(dir, '.roboteam', 'locks', busy.lock), 'utf8')).token), false);
    await release();
    assert.ok(diagnosticRecords(dir).some((record) => record.event === 'lock.release.done'));
});

test('a release that finds a replaced owner logs expected and current identity, then throws', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const release = await acquireExecutionLease(dir, 'session:replaced');
    const lock = fs.readdirSync(path.join(dir, '.roboteam', 'locks')).find((name) => name.startsWith('execution-'));
    const file = path.join(dir, '.roboteam', 'locks', lock);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...owner, token: randomUUID() })}\n`);
    await assert.rejects(release(), { code: 'WORKSPACE_STATE_LOCK_RECOVERY' });
    const records = diagnosticRecords(dir);
    const mismatch = records.find((record) => record.event === 'lock.remove' && record.result === 'mismatch');
    assert.notEqual(mismatch.expectedToken, mismatch.currentToken);
    assert.equal(mismatch.expectedIno, mismatch.currentIno);
    const failed = records.find((record) => record.event === 'lock.release.error');
    assert.equal(failed.code, 'WORKSPACE_STATE_LOCK_RECOVERY');
    assert.match(failed.stack, /removeOwned/);
    fs.rmSync(file);
});

function lockFile(dir, prefix = 'execution-') {
    const locks = path.join(dir, '.roboteam', 'locks');
    return path.join(locks, fs.readdirSync(locks).find((name) => name.startsWith(prefix) && !name.endsWith('.recovery')));
}

// Same bytes, new inode: what a virtiofs guest can report for an unchanged host file.
function replaceWithIdenticalCopy(file) {
    const before = fs.statSync(file).ino;
    const copy = `${file}.copy`;
    fs.writeFileSync(copy, fs.readFileSync(file));
    fs.renameSync(copy, file);
    assert.notEqual(fs.statSync(file).ino, before, 'the copy must have a new inode');
}

function simulatedIoError() {
    return Object.assign(new Error('EIO: simulated i/o error, unlink'), { code: 'EIO' });
}

function processStart(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

test('a lease and a mutation lock whose inode changed are still released by their owner token', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const release = await acquireExecutionLease(dir, 'session:moved');
    const file = lockFile(dir);
    const token = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    replaceWithIdenticalCopy(file);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, token);
    await release();
    assert.equal(fs.existsSync(file), false);
    const removed = diagnosticRecords(dir).find((record) => record.event === 'lock.remove'
        && record.result === 'identity-changed-token-match');
    assert.ok(removed, 'the identity change is logged');
    assert.notEqual(removed.expectedIno, removed.currentIno);
    assert.equal(removed.expectedToken, removed.currentToken);
    const next = await acquireExecutionLease(dir, 'session:moved');
    await next();
    await withWorkspaceMutation(dir, () => replaceWithIdenticalCopy(lockFile(dir, 'mutation.lock')));
    assert.equal(fs.existsSync(path.join(dir, '.roboteam', 'locks', 'mutation.lock')), false);
    await withWorkspaceMutation(dir, () => {});
});

test('a moved lock file with a different owner token is still never removed', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const release = await acquireExecutionLease(dir, 'session:foreign');
    const file = lockFile(dir);
    const foreign = { ...JSON.parse(fs.readFileSync(file, 'utf8')), token: randomUUID() };
    fs.writeFileSync(`${file}.copy`, JSON.stringify(foreign));
    fs.renameSync(`${file}.copy`, file);
    await assert.rejects(release(), { code: 'WORKSPACE_STATE_LOCK_RECOVERY' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, foreign.token);
    await assert.rejects(acquireExecutionLease(dir, 'session:foreign'), { code: 'WORKSPACE_STATE_BUSY' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, foreign.token);
    fs.rmSync(file);
});

test('a lease whose release failed is recovered by the next acquisition in the same process', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const first = await acquireExecutionLease(dir, 'session:orphan');
    const file = lockFile(dir);
    const failing = t.mock.method(fs, 'unlinkSync', () => { throw simulatedIoError(); });
    await assert.rejects(first(), { code: 'EIO' });
    failing.mock.restore();
    assert.equal(fs.existsSync(file), true);
    const second = await acquireExecutionLease(dir, 'session:orphan');
    const recovered = diagnosticRecords(dir).find((record) => record.event === 'lock.recovered-own-orphan');
    assert.ok(recovered, 'the own-orphan recovery is logged');
    const secondToken = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    // The new holder is active, so a concurrent turn of the same session is still refused.
    await assert.rejects(acquireExecutionLease(dir, 'session:orphan'), { code: 'WORKSPACE_STATE_BUSY' });
    // A late retry of the failed release cannot remove the new holder's lease.
    await first();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, secondToken);
    await second();
    assert.equal(fs.existsSync(file), false);
});

test('own-orphan recovery never reclaims a foreign token or another live process', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    const first = await acquireExecutionLease(dir, 'session:guarded');
    const file = lockFile(dir);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    const failing = t.mock.method(fs, 'unlinkSync', () => { throw simulatedIoError(); });
    await assert.rejects(first(), { code: 'EIO' });
    failing.mock.restore();
    // This process's pid with a token it never failed to release is a live holder.
    const foreignToken = { ...owner, token: randomUUID() };
    fs.writeFileSync(file, JSON.stringify(foreignToken));
    await assert.rejects(acquireExecutionLease(dir, 'session:guarded'), { code: 'WORKSPACE_STATE_BUSY' });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(foreignToken));
    // The failed token under another live process's identity is that process's lease.
    const otherProcess = { ...owner, pid: process.ppid, start: processStart(process.ppid) };
    fs.writeFileSync(file, JSON.stringify(otherProcess));
    await assert.rejects(acquireExecutionLease(dir, 'session:guarded'), { code: 'WORKSPACE_STATE_BUSY' });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(otherProcess));
    assert.equal(diagnosticRecords(dir).some((record) => record.event === 'lock.recovered-own-orphan'), false);
    fs.rmSync(file);
});

test('a recovery claim this process failed to remove does not block later acquisitions', { skip: linuxOnly }, async (t) => {
    const dir = rootedWorkspace(t);
    await acquireExecutionLease(dir, 'session:claim');
    const file = lockFile(dir);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...owner, start: '0' }));
    const unlink = fs.unlinkSync;
    const failing = t.mock.method(fs, 'unlinkSync', (target) => {
        if (String(target).endsWith('.recovery')) throw simulatedIoError();
        return unlink(target);
    });
    await assert.rejects(acquireExecutionLease(dir, 'session:claim'), { code: 'EIO' });
    failing.mock.restore();
    assert.equal(fs.existsSync(`${file}.recovery`), true);
    const release = await acquireExecutionLease(dir, 'session:claim');
    assert.equal(fs.existsSync(`${file}.recovery`), false);
    assert.ok(diagnosticRecords(dir).some((record) => record.event === 'lock.recovered-own-orphan'
        && record.suffix === '.recovery'));
    await release();
});
