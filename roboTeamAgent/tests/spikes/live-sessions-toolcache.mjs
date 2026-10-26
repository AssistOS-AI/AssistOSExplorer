import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMountInfo } from './live-sessions-sandbox.mjs';

export const TOOL_CACHE_ROOT = '/data/tool-cache';
const FORBIDDEN = Object.freeze(['/', '/dev', '/dev/shm', '/run', '/data']);
const MOUNT_NAMESPACE = /^mnt:\[\d+\]$/;
const inside = (root, value) => value === root || value.startsWith(root === '/' ? '/' : `${root}/`);
const generationPattern = name => new RegExp(`^${TOOL_CACHE_ROOT}/${name}/generations/[0-9a-f]{64}$`);
const sha256File = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

// Pure checks over a recorded collector result; the assembler re-runs them.
// ALA ro-binds each runtime-mount source; every source must stay inside the
// agent's own cache generation and nothing may be mounted under the cache.
export function verifyToolCacheRecord(record) {
    assert.equal(record?.kind, 'toolcache-probe', 'Tool-cache record must come from the collector');
    assert.equal(record.status, 'observed', 'Tool-cache state must be observed');
    assert.equal(record.cacheRoot, TOOL_CACHE_ROOT, 'Tool cache must be the production cache root');
    assert.ok(typeof record.mountNamespace === 'string' && MOUNT_NAMESPACE.test(record.mountNamespace), 'Collector mount namespace is required');
    assert.ok(Array.isArray(record.agents) && record.agents.some(agent => agent?.name === 'claude'), 'Claude runtime mounts must be observed');
    assert.equal(new Set(record.agents.map(agent => agent.name)).size, record.agents.length, 'Coding agents must be unique');
    for (const agent of record.agents) {
        assert.ok(typeof agent.name === 'string' && /^[a-z]+$/.test(agent.name), 'Coding agent name is required');
        assert.ok(typeof agent.generation === 'string' && generationPattern(agent.name).test(agent.generation),
            `${agent.name} must resolve to a tool-cache generation`);
        assert.ok(typeof agent.realpath === 'string' && agent.realpath !== agent.generation && inside(agent.generation, agent.realpath),
            `${agent.name} executable must resolve inside its generation`);
        assert.ok(Array.isArray(agent.runtimeMounts) && agent.runtimeMounts.length > 0, `${agent.name} runtime mounts must be observed`);
        for (const source of agent.runtimeMounts) {
            assert.ok(typeof source === 'string' && path.posix.isAbsolute(source) && path.posix.normalize(source) === source,
                `${agent.name} runtime mount must be a normalized absolute path`);
            for (const forbidden of FORBIDDEN) {
                assert.ok(!inside(source, forbidden), `${agent.name} runtime mount must not equal or contain ${forbidden}`);
            }
            assert.ok(inside(agent.generation, source), `${agent.name} runtime mount must stay inside its tool-cache generation`);
        }
    }
    assert.ok(Number.isSafeInteger(record.mountinfoEntries) && record.mountinfoEntries > 0, 'Collector mountinfo must be observed');
    assert.ok(Array.isArray(record.cacheMounts), 'Tool-cache mount entries are required');
    assert.deepEqual(record.cacheMounts, [], 'Nothing may be mounted at or below the tool cache');
}

// Read-only: peeks the generation the service prepared, never prepares or
// downloads. Records paths and mount identities only, never environment values.
// Dependencies are injectable only for isolated unit tests.
export async function collectToolCache({ mountinfo, mountNamespace, toolCache, runtimeMounts } = {}) {
    if (mountinfo === undefined) {
        assert.equal(process.platform, 'linux', 'Tool-cache collection requires Linux');
        mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
        mountNamespace = await fs.readlink('/proc/self/ns/mnt');
    }
    const mounts = parseMountInfo(mountinfo);
    const { codingAgentEnvironment } = await import('../../server/coding-agents.mjs');
    if (!toolCache) {
        const { ToolCache } = await import('../../server/tool-cache.mjs');
        toolCache = new ToolCache({ log: () => {} });
    }
    const record = { kind: 'toolcache-probe', collectorSha256: await sha256File(fileURLToPath(import.meta.url)),
        mountNamespace, cacheRoot: toolCache.root, mountinfoEntries: mounts.length,
        cacheMounts: mounts.filter(mount => inside(TOOL_CACHE_ROOT, mount.target))
            .map(({ id, device, root, target, type }) => ({ id, device, root, target, type })) };
    const tools = await toolCache.peekShellTools();
    if (!tools) return { ...record, status: 'unavailable', agents: [] };
    let ala = null;
    if (!runtimeMounts) {
        // Same ALA resolution as the sandbox harness through prepareCopilotContext.
        const { resolveAlaCommand } = await import('../../server/ala-command.mjs');
        const { resolveAlaInstallation } = await import('../../copilot/src/lib/execution/alaInstallation.mjs');
        const installation = await resolveAlaInstallation({ env: { ...process.env, ACHILLES_ALA_COMMAND: resolveAlaCommand() } });
        const sandbox = path.join(installation.packageRoot, 'src', 'coding-agents', 'sandbox.mjs');
        runtimeMounts = (await import(pathToFileURL(sandbox).href)).collectAgentRuntimeMounts;
        ala = { packageRoot: installation.packageRoot, sandboxSha256: await sha256File(sandbox) };
    }
    // Production derives each <AGENT>_BIN from these agents with this helper.
    const binaries = codingAgentEnvironment(tools.agents, { PATH: '' }, toolCache.root);
    const agents = [];
    for (const name of Object.keys(tools.agents).sort()) {
        const binary = binaries[`${name.toUpperCase()}_BIN`];
        agents.push({ name, binary, realpath: await fs.realpath(binary), generation: await fs.realpath(tools.agents[name].path),
            runtimeMounts: [...runtimeMounts(binary)] });
    }
    return { ...record, status: 'observed', ala, agents };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        assert.equal(process.argv.length, 2, 'Usage: node live-sessions-toolcache.mjs');
        const record = await collectToolCache();
        console.log(JSON.stringify(record));
        verifyToolCacheRecord(record);
    } catch (error) {
        console.error(JSON.stringify({ kind: 'toolcache-probe', status: 'failed', code: error.code || error.name,
            message: error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : undefined }));
        process.exitCode = 1;
    }
}
