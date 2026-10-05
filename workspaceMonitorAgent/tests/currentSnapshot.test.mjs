import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CURRENT_SNAPSHOT_MAX_AGE_MS,
    currentSnapshotPath,
    currentSnapshotState,
    readCurrentSnapshot,
    writeCurrentSnapshot,
    normalizeCurrentSnapshot,
} from '../lib/currentSnapshot.mjs';
import { hardwareResourceDisplay, runtimeIsReady } from '../IDE-plugins/workspace-monitor/components/workspace-monitor-dashboard/workspace-monitor-resources.js';

function snapshot(sampledAt) {
    return {
        sampledAt,
        router: {
            status: 'running',
            pid: 1234,
            metrics: { available: true, cpuPercent: 4.5, memoryBytes: 512, secret: 'omit-me' },
        },
        runtimes: [{
            containerName: 'explorer-container',
            agentName: 'explorer',
            repoName: 'AchillesIDE',
            runtime: 'podman',
            enabled: true,
            state: { status: 'starting', running: true, ready: false, pid: 999 },
            metrics: { available: true, cpuPercent: 12.5, memoryBytes: 2_048 },
            privateField: 'omit-me',
        }],
        total: { cpuPercent: 17, memoryBytes: 2_560 },
        unexpected: 'omit-me',
    };
}

async function temporaryEnvironment(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-monitor-current-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { WORKSPACE_MONITOR_DATA_ROOT: root };
}

test('current snapshot is atomically persisted as an allowlisted resource projection', async (t) => {
    const env = await temporaryEnvironment(t);
    const sampledAt = '2026-08-27T10:00:00.000Z';
    const written = await writeCurrentSnapshot(snapshot(sampledAt), env);
    assert.deepEqual(await readCurrentSnapshot(env), written);
    assert.equal(Object.hasOwn(written, 'unexpected'), false);
    assert.equal(Object.hasOwn(written.router, 'pid'), false);
    assert.equal(Object.hasOwn(written.router.metrics, 'secret'), false);
    assert.equal(Object.hasOwn(written.runtimes[0], 'privateField'), false);
    assert.equal(Object.hasOwn(written.runtimes[0].state, 'pid'), false);
    assert.deepEqual(written.runtimes[0].state, {
        status: 'starting',
        running: true,
        ready: false,
    });
    assert.equal((await fs.stat(currentSnapshotPath(env))).mode & 0o777, 0o600);
    assert.equal((await fs.readdir(env.WORKSPACE_MONITOR_DATA_ROOT)).some((name) => name.endsWith('.tmp')), false);
});

test('current snapshot remains compatible with metrics sources that predate explicit readiness', async (t) => {
    const env = await temporaryEnvironment(t);
    const value = snapshot('2026-08-27T10:00:00.000Z');
    delete value.runtimes[0].state.ready;
    value.runtimes[0].state.status = 'running';
    const written = await writeCurrentSnapshot(value, env);
    assert.equal(written.runtimes[0].state.ready, true);
});

test('current snapshot state distinguishes unavailable, fresh, and stale data', async (t) => {
    const env = await temporaryEnvironment(t);
    assert.deepEqual(await currentSnapshotState({ env }), {
        ok: true,
        available: false,
        stale: true,
        ageMs: null,
        snapshot: null,
    });

    const sampledAt = Date.parse('2026-08-27T10:00:00.000Z');
    await writeCurrentSnapshot(snapshot(new Date(sampledAt).toISOString()), env);
    const fresh = await currentSnapshotState({ env, now: () => sampledAt + CURRENT_SNAPSHOT_MAX_AGE_MS });
    assert.equal(fresh.available, true);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.ageMs, CURRENT_SNAPSHOT_MAX_AGE_MS);

    const stale = await currentSnapshotState({ env, now: () => sampledAt + CURRENT_SNAPSHOT_MAX_AGE_MS + 1 });
    assert.equal(stale.available, true);
    assert.equal(stale.stale, true);
});

test('current snapshot rejects malformed source data', async (t) => {
    const env = await temporaryEnvironment(t);
    await assert.rejects(writeCurrentSnapshot({ sampledAt: 'invalid', runtimes: [] }, env), /sampledAt/);
    await fs.writeFile(currentSnapshotPath(env), '{not-json', 'utf8');
    await assert.rejects(readCurrentSnapshot(env), /JSON/);

    await fs.writeFile(currentSnapshotPath(env), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');
    await assert.rejects(readCurrentSnapshot(env), /exceeds the supported size/);
});

test('current snapshot rejects an oversized normalized projection before replacing the current file', async (t) => {
    const env = await temporaryEnvironment(t);
    const sampledAt = '2026-08-27T10:00:00.000Z';
    const original = await writeCurrentSnapshot(snapshot(sampledAt), env);
    const runtime = {
        containerName: 'c'.repeat(512),
        agentName: 'a'.repeat(512),
        repoName: 'r'.repeat(512),
        runtime: 'container',
        enabled: true,
        state: { status: 'running', running: true },
        metrics: { available: true, cpuPercent: 1, memoryBytes: 2 },
    };
    await assert.rejects(writeCurrentSnapshot({
        sampledAt,
        router: snapshot(sampledAt).router,
        runtimes: Array.from({ length: 2_048 }, () => runtime),
        total: { cpuPercent: 1, memoryBytes: 2 },
    }, env), /exceeds the supported size/);
    assert.deepEqual(await readCurrentSnapshot(env), original);
});

test('X.monitor-old-shape', () => {
    const old = normalizeCurrentSnapshot(snapshot('2026-08-27T10:00:00.000Z'));
    assert.deepEqual(Object.keys(old.runtimes[0]), ['containerName', 'agentName', 'repoName', 'runtime', 'enabled', 'state', 'metrics']);
    assert.deepEqual(hardwareResourceDisplay(old.runtimes[0]), { cpu: '', memory: '', gpu: '', status: 'starting', reason: '' });
    assert.equal(Object.hasOwn(old.runtimes[0], 'limits'), false);
});

test('X.monitor-readonly', () => {
    const value = snapshot('2026-08-27T10:00:00.000Z');
    Object.assign(value.runtimes[0], {
        limits: { cpu: { cores: 0.5, assurance: 'kernel', secret: 'omit' }, memory: { bytes: 1024 ** 3, assurance: 'kernel' }, gpu: { smPercent: 25, vramBytes: 512 * 1024 ** 2, assurance: 'best-effort' }, env: { secret: 'omit' } },
        availability: 'blocked', limitsState: 'applied',
        problem: { state: 'blocked', reason: 'Needs dependency.', blockedBy: { key: 'direct', ref: 'repo/direct', privateField: 'omit' }, rootCause: { key: 'root', ref: 'repo/root', field: 'memory', reason: 'No memory controller.', fix: 'Host repair.', secret: 'omit' }, causalPath: ['explorer', 'direct', 'root'], privateField: 'omit' },
    });
    value.runtimes[0].state.ready = true;
    const normalized = normalizeCurrentSnapshot(value).runtimes[0];
    assert.equal(normalized.state.ready, false);
    assert.equal(runtimeIsReady(normalized), false);
    assert.doesNotMatch(JSON.stringify(normalized), /"omit"/);
    assert.deepEqual(normalized.limits.memory, { bytes: 1024 ** 3, assurance: 'kernel' });
    const display = hardwareResourceDisplay(normalized);
    assert.match(display.cpu, /50% quota \(0.5 cores, kernel\)/);
    assert.match(display.memory, /1.0 GB kernel limit/);
    assert.match(display.gpu, /25% SM.*best-effort/);
    assert.match(display.reason, /Blocked by repo\/direct.*Root refusal repo\/root.*Host repair/);
    assert.equal(display.status, 'blocked');
    assert.equal(value.runtimes[0].state.ready, true);
});

test('hardware projection bounds causal data and drops invalid limits without changing source', () => {
    const value = snapshot('2026-08-27T10:00:00.000Z');
    Object.assign(value.runtimes[0], {
        availability: 'refused', limits: { cpu: { cores: NaN, assurance: 'kernel' }, memory: { bytes: -1, assurance: 'kernel' }, gpu: { smPercent: 101, vramBytes: 1, assurance: 'best-effort' } },
        problem: { reason: 'ă'.repeat(6000), fix: 'x'.repeat(6000), rootCause: { reason: 'x'.repeat(6000), fix: 'x'.repeat(6000) }, causalPath: Array.from({ length: 40 }, () => 'x'.repeat(1024)), additionalCauseCount: 3 },
    });
    const normalized = normalizeCurrentSnapshot(value).runtimes[0];
    assert.equal(Object.hasOwn(normalized, 'limits'), false);
    assert.ok(Buffer.byteLength(normalized.problem.reason) <= 2048);
    assert.ok(Buffer.byteLength(JSON.stringify(normalized.problem)) <= 16 * 1024);
    assert.ok(normalized.problem.omittedPathCount > 0);
    assert.equal(normalized.problem.additionalCauseCount, 3);
    assert.ok(normalized.problem.rootCause);
});
