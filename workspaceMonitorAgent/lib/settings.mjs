import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
    workspaceCpuPercent: 80,
    workspaceMemoryBytes: 4 * 1024 ** 3,
    routerCpuPercent: 80,
    routerMemoryBytes: 512 * 1024 ** 2,
    logRetentionDays: 7,
});

export function dataRoot(env = process.env) {
    return path.resolve(String(env.WORKSPACE_MONITOR_DATA_ROOT || '/root'));
}

export function settingsPath(env = process.env) {
    return path.join(dataRoot(env), 'settings.json');
}

function finiteNumber(value, name, { min, max }) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${name} must be between ${min} and ${max}.`);
    }
    return number;
}

function integer(value, name, { min, max }) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return number;
}

export function normalizeSettings(value = {}) {
    return {
        workspaceCpuPercent: finiteNumber(value.workspaceCpuPercent, 'workspaceCpuPercent', { min: 0, max: 100_000 }),
        workspaceMemoryBytes: Math.round(finiteNumber(value.workspaceMemoryBytes, 'workspaceMemoryBytes', { min: 1, max: Number.MAX_SAFE_INTEGER })),
        routerCpuPercent: finiteNumber(value.routerCpuPercent, 'routerCpuPercent', { min: 0, max: 100_000 }),
        routerMemoryBytes: Math.round(finiteNumber(value.routerMemoryBytes, 'routerMemoryBytes', { min: 1, max: Number.MAX_SAFE_INTEGER })),
        logRetentionDays: integer(value.logRetentionDays, 'logRetentionDays', { min: 1, max: 365 }),
    };
}

export async function readSettings(env = process.env) {
    try {
        const parsed = JSON.parse(await fs.readFile(settingsPath(env), 'utf8'));
        return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    } catch (error) {
        if (error?.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
        throw error;
    }
}

export async function writeSettings(value, env = process.env) {
    const normalized = normalizeSettings(value);
    const target = settingsPath(env);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
    return normalized;
}
