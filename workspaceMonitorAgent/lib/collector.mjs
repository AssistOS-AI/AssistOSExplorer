import { writeCurrentSnapshot } from './currentSnapshot.mjs';
import { readSettings } from './settings.mjs';
import { createDatabaseHandleProvider, persistSamples } from './sqliteStore.mjs';

export const PERSIST_INTERVAL_MS = 10_000;
const PRIVATE_PATH = '/api/edge/workspace-metrics';
const PRIVATE_QUERY = '?follow=1';

export function runtimeSeriesId(runtime, index = 0) {
    const repoName = String(runtime?.repoName || '').trim();
    const agentName = String(runtime?.agentName || '').trim();
    const containerName = String(runtime?.containerName || '').trim();
    const identity = repoName && agentName && agentName !== '-'
        ? `${repoName}/${agentName}`
        : containerName || agentName || `runtime-${index}`;
    return encodeURIComponent(identity);
}

function metricDefinitions(snapshot, settings) {
    const runtimes = Array.isArray(snapshot?.runtimes) ? snapshot.runtimes : [];
    const runtimeTotals = runtimes.reduce((sum, runtime) => ({
        cpuPercent: sum.cpuPercent + (runtime?.metrics?.available === false ? 0 : Number(runtime?.metrics?.cpuPercent) || 0),
        memoryBytes: sum.memoryBytes + (runtime?.metrics?.available === false ? 0 : Number(runtime?.metrics?.memoryBytes) || 0),
    }), { cpuPercent: 0, memoryBytes: 0 });
    const routerCpu = Number(snapshot?.router?.metrics?.cpuPercent);
    const routerMemory = Number(snapshot?.router?.metrics?.memoryBytes);
    const agentsCpu = runtimes.length ? runtimeTotals.cpuPercent : Number(snapshot?.total?.cpuPercent) - routerCpu;
    const agentsMemory = runtimes.length ? runtimeTotals.memoryBytes : Number(snapshot?.total?.memoryBytes) - routerMemory;
    const aggregateMetrics = [
        { key: 'workspace.cpu', scope: 'workspace', resource: 'cpu', value: agentsCpu, threshold: settings.workspaceCpuPercent },
        { key: 'workspace.memory', scope: 'workspace', resource: 'memory', value: agentsMemory, threshold: settings.workspaceMemoryBytes },
        { key: 'router.cpu', scope: 'router', resource: 'cpu', value: routerCpu, threshold: settings.routerCpuPercent },
        { key: 'router.memory', scope: 'router', resource: 'memory', value: routerMemory, threshold: settings.routerMemoryBytes },
    ];
    const runtimeMetrics = runtimes.flatMap((runtime, index) => {
        if (runtime?.metrics?.available === false) return [];
        const cpuPercent = Number(runtime?.metrics?.cpuPercent);
        const memoryBytes = Number(runtime?.metrics?.memoryBytes);
        const id = runtimeSeriesId(runtime, index);
        return [
            { key: `runtime:${id}:cpu`, scope: 'runtime', runtimeId: id, resource: 'cpu', value: cpuPercent, threshold: 0 },
            { key: `runtime:${id}:memory`, scope: 'runtime', runtimeId: id, resource: 'memory', value: memoryBytes, threshold: 0 },
        ];
    });
    return [...aggregateMetrics, ...runtimeMetrics];
}

export function createSnapshotProcessor({
    readSettingsImpl = readSettings,
    persistSamplesImpl = null,
    databaseProvider = createDatabaseHandleProvider(),
    now = () => Date.now(),
} = {}) {
    // One database handle serves every persist of this collector process; a persist
    // error closes and drops it, so the next persist reopens the database.
    const persist = persistSamplesImpl
        || ((samples, timestamp) => persistSamples(samples, timestamp, { databaseProvider }));
    const lastPersisted = new Map();
    return async function processSnapshot(snapshot) {
        const settings = await readSettingsImpl();
        const timestamp = Number.isFinite(Date.parse(snapshot?.sampledAt)) ? Date.parse(snapshot.sampledAt) : now();
        const due = metricDefinitions(snapshot, settings).filter((metric) => Number.isFinite(metric.value)
            && timestamp - Number(lastPersisted.get(metric.key) || 0) >= PERSIST_INTERVAL_MS);
        if (!due.length) return { persisted: [] };
        await persist(due, timestamp);
        for (const metric of due) lastPersisted.set(metric.key, timestamp);
        return { persisted: due.map((metric) => metric.key) };
    };
}

export function createCollectorSnapshotConsumer({
    env = process.env,
    now = () => Date.now(),
    writeCurrentSnapshotImpl = writeCurrentSnapshot,
    processSnapshotImpl = createSnapshotProcessor(),
    reportError = (message) => console.error(message),
} = {}) {
    let currentRetryAt = 0;
    let currentDelayMs = 1_000;
    let persistenceRetryAt = 0;
    let persistenceDelayMs = 1_000;
    return async function consumeSnapshot(snapshot) {
        const timestamp = now();
        if (timestamp >= currentRetryAt) {
            try {
                await writeCurrentSnapshotImpl(snapshot, env);
                currentRetryAt = 0;
                currentDelayMs = 1_000;
            } catch (error) {
                currentRetryAt = timestamp + currentDelayMs;
                currentDelayMs = Math.min(currentDelayMs * 2, 30_000);
                reportError(`[workspace-monitor] current snapshot write failed: ${error?.message || error}`);
            }
        }
        if (timestamp < persistenceRetryAt) return;
        try {
            await processSnapshotImpl(snapshot);
            persistenceRetryAt = 0;
            persistenceDelayMs = 1_000;
        } catch (error) {
            persistenceRetryAt = timestamp + persistenceDelayMs;
            persistenceDelayMs = Math.min(persistenceDelayMs * 2, 30_000);
            reportError(`[workspace-monitor] sample persistence failed: ${error?.message || error}`);
        }
    };
}

export async function consumeNdjson(response, onSnapshot) {
    if (!response.ok || !response.body) throw new Error(`Metrics stream failed with HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.trim()) await onSnapshot(JSON.parse(line));
        }
        if (done) {
            if (buffer.trim()) await onSnapshot(JSON.parse(buffer));
            return;
        }
    }
}

async function loadAssertionSigner() {
    const module = await import('/Agent/lib/agentAssertion.mjs');
    if (typeof module.signPrivateRouterAssertion !== 'function') throw new Error('Private Router assertion signer is unavailable.');
    return module.signPrivateRouterAssertion;
}

export async function runCollector({ env = process.env, fetchImpl = fetch, signal } = {}) {
    const routerUrl = String(env.PLOINKY_INTERNAL_ROUTER_URL || '').replace(/\/$/, '');
    if (!routerUrl) throw new Error('PLOINKY_INTERNAL_ROUTER_URL is required.');
    const sign = await loadAssertionSigner();
    const consumeSnapshot = createCollectorSnapshotConsumer({ env });
    let delayMs = 1_000;
    while (!signal?.aborted) {
        try {
            const assertion = sign({ method: 'GET', path: PRIVATE_PATH, query: PRIVATE_QUERY, env });
            const response = await fetchImpl(`${routerUrl}${PRIVATE_PATH}${PRIVATE_QUERY}`, {
                headers: { 'ploinky-agent-assertion': assertion, accept: 'application/x-ndjson' },
                signal,
            });
            delayMs = 1_000;
            await consumeNdjson(response, consumeSnapshot);
        } catch (error) {
            if (signal?.aborted) return;
            console.error(`[workspace-monitor] metrics stream unavailable: ${error?.message || error}`);
        }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        delayMs = Math.min(delayMs * 2, 30_000);
    }
}
