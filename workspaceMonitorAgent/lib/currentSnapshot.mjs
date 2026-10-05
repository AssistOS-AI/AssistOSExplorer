import fs from 'node:fs/promises';
import path from 'node:path';

import { dataRoot } from './settings.mjs';

export const CURRENT_SNAPSHOT_MAX_AGE_MS = 15_000;
const CURRENT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const CURRENT_SNAPSHOT_MAX_RUNTIMES = 4_096;

export function currentSnapshotPath(env = process.env) {
    return path.join(dataRoot(env), 'current-snapshot.json');
}

function boundedString(value, fallback = '', maxLength = 512) {
    return String(value ?? fallback).slice(0, maxLength);
}

function boundedHardwareText(value, maximum) {
    return Buffer.from(String(value ?? '')).subarray(0, maximum).toString('utf8').replace(/\uFFFD$/, '');
}

function finiteMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeMetrics(value = {}) {
    return {
        available: value?.available === true,
        cpuPercent: finiteMetric(value?.cpuPercent),
        memoryBytes: finiteMetric(value?.memoryBytes),
    };
}

function exactIdentity(value, maximum = 1024) {
    return typeof value === 'string' && Buffer.byteLength(value) <= maximum ? value : '';
}

function normalizeProblem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const field of ['state', 'code', 'field']) {
        if (typeof value[field] === 'string') result[field] = boundedHardwareText(value[field], 128);
    }
    for (const field of ['reason', 'fix']) {
        if (typeof value[field] === 'string') result[field] = boundedHardwareText(value[field], 2048);
    }
    for (const field of ['key', 'ref']) {
        if (typeof value[field] === 'string') result[field] = exactIdentity(value[field], field === 'ref' ? 257 : 1024);
    }
    for (const field of ['blockedBy', 'rootCause']) {
        if (!value[field] || typeof value[field] !== 'object') continue;
        const source = value[field];
        result[field] = { key: exactIdentity(source.key), ref: exactIdentity(source.ref, 257) };
        if (field === 'rootCause') {
            result[field].field = boundedHardwareText(source.field, 128);
            result[field].reason = boundedHardwareText(source.reason, 2048);
            result[field].fix = boundedHardwareText(source.fix, 2048);
        }
    }
    if (Array.isArray(value.requested)) result.requested = value.requested.slice(0, 4).map((entry) => ({
        field: boundedHardwareText(entry?.field, 128),
        value: typeof entry?.value === 'number' && Number.isFinite(entry.value) ? entry.value : boundedHardwareText(entry?.value, 256),
        source: boundedHardwareText(entry?.source, 128),
    }));
    if (Array.isArray(value.causalPath)) {
        let bytes = 0;
        result.causalPath = [];
        for (const entry of value.causalPath.slice(0, 32)) {
            const key = exactIdentity(entry);
            if (!key || bytes + Buffer.byteLength(key) > 8192) break;
            bytes += Buffer.byteLength(key);
            result.causalPath.push(key);
        }
        result.omittedPathCount = value.causalPath.length - result.causalPath.length;
    }
    for (const field of ['additionalCauseCount', 'omittedPathCount']) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = (result[field] || 0) + value[field];
    }
    while (result.causalPath?.length && Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) {
        result.causalPath.pop();
        result.omittedPathCount = (result.omittedPathCount || 0) + 1;
    }
    return result;
}

function normalizeLimits(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const [resource, fields, assurances] of [
        ['cpu', ['cores'], ['kernel', 'none']],
        ['memory', ['bytes'], ['kernel', 'none']],
        ['gpu', ['smPercent', 'vramBytes'], ['best-effort', 'none']],
    ]) {
        const source = value[resource];
        if (!source || !assurances.includes(source.assurance)) continue;
        if (fields.some((field) => source[field] != null && (!Number.isFinite(source[field]) || source[field] < 0 || source[field] > Number.MAX_SAFE_INTEGER))) continue;
        if (resource === 'gpu' && source.smPercent > 100) continue;
        if (source.assurance !== 'none' && fields.some((field) => !(source[field] > 0))) continue;
        result[resource] = { ...Object.fromEntries(fields.map((field) => [field, source[field] ?? null])), assurance: source.assurance };
    }
    return Object.keys(result).length ? result : null;
}

function normalizeRuntime(value = {}) {
    const runtime = {
        containerName: boundedString(value?.containerName),
        agentName: boundedString(value?.agentName, '-'),
        repoName: boundedString(value?.repoName, '-'),
        runtime: boundedString(value?.runtime, 'container', 128),
        enabled: Boolean(value?.enabled),
        state: {
            status: boundedString(value?.state?.status, 'unknown', 128),
            running: Boolean(value?.state?.running),
            ready: typeof value?.state?.ready === 'boolean'
                ? value.state.ready
                : Boolean(value?.state?.running),
        },
        metrics: normalizeMetrics(value?.metrics),
    };
    const limits = normalizeLimits(value.limits);
    if (limits) runtime.limits = limits;
    if (['starting', 'ready', 'refused', 'blocked', 'failed', 'stopped'].includes(value.availability)) {
        runtime.availability = value.availability;
        if (['refused', 'blocked', 'failed', 'stopped'].includes(value.availability)) runtime.state.ready = false;
        runtime.problem = normalizeProblem(value.problem);
    }
    if (['applied', 'pending', 'not-enabled', 'unavailable'].includes(value.limitsState)) runtime.limitsState = value.limitsState;
    return runtime;
}

export function normalizeCurrentSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Current resource snapshot must be an object.');
    }
    const sampledAtMs = Date.parse(value.sampledAt);
    if (!Number.isFinite(sampledAtMs)) {
        throw new Error('Current resource snapshot requires a valid sampledAt instant.');
    }
    if (!Array.isArray(value.runtimes) || value.runtimes.length > CURRENT_SNAPSHOT_MAX_RUNTIMES) {
        throw new Error(`Current resource snapshot runtimes must contain at most ${CURRENT_SNAPSHOT_MAX_RUNTIMES} entries.`);
    }
    return {
        ok: true,
        sampledAt: new Date(sampledAtMs).toISOString(),
        router: {
            status: boundedString(value?.router?.status, 'unknown', 128),
            metrics: normalizeMetrics(value?.router?.metrics),
        },
        runtimes: value.runtimes.map(normalizeRuntime),
        total: {
            cpuPercent: finiteMetric(value?.total?.cpuPercent),
            memoryBytes: finiteMetric(value?.total?.memoryBytes),
        },
    };
}

export async function writeCurrentSnapshot(value, env = process.env) {
    const normalized = normalizeCurrentSnapshot(value);
    const serialized = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(serialized) > CURRENT_SNAPSHOT_MAX_BYTES) {
        throw new Error('Current resource snapshot exceeds the supported size.');
    }
    const target = currentSnapshotPath(env);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
        await fs.writeFile(temporary, serialized, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await fs.rename(temporary, target);
    } finally {
        await fs.rm(temporary, { force: true });
    }
    return normalized;
}

export async function readCurrentSnapshot(env = process.env) {
    const target = currentSnapshotPath(env);
    let size;
    try {
        size = (await fs.stat(target)).size;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (size > CURRENT_SNAPSHOT_MAX_BYTES) {
        throw new Error('Current resource snapshot exceeds the supported size.');
    }
    let text;
    try {
        text = await fs.readFile(target, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (Buffer.byteLength(text) > CURRENT_SNAPSHOT_MAX_BYTES) {
        throw new Error('Current resource snapshot exceeds the supported size.');
    }
    return normalizeCurrentSnapshot(JSON.parse(text));
}

export async function currentSnapshotState({
    env = process.env,
    now = () => Date.now(),
} = {}) {
    const snapshot = await readCurrentSnapshot(env);
    if (!snapshot) {
        return { ok: true, available: false, stale: true, ageMs: null, snapshot: null };
    }
    const ageMs = Math.max(0, now() - Date.parse(snapshot.sampledAt));
    return {
        ok: true,
        available: true,
        stale: ageMs > CURRENT_SNAPSHOT_MAX_AGE_MS,
        ageMs,
        snapshot,
    };
}
