import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { resolveAlaInstallation } from './ala-installation.mjs';
import { createOpenCodeModelCache } from './opencode-model-cache.mjs';
import { alaWorkspaceOptions } from './workspace-view.mjs';

// Runs only in the per-robot mount and network namespaces, before any native model query.
const input = JSON.parse(process.argv[2]);
const api = await resolveAlaInstallation({ entry: input.alaEntry });
const env = process.env;
const agents = await api.discoverCodingAgents({ env });
const signal = AbortSignal.timeout(90000);
const gateway = async () => ({ async request(operation, body, querySignal) {
    if (operation !== 'models') throw new Error('Only model discovery is available');
    return new Promise((resolve, reject) => {
        const request = http.get({ socketPath: input.soul + '/soul-gateway.sock', path: '/v1/models', signal: querySignal }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) response.destroy(new Error('Model catalog too large')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => {
                try { if (response.statusCode !== 200) throw new Error('Model catalog unavailable'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
    });
} });
const cache = input.agent === 'opencode' ? createOpenCodeModelCache({ root: input.dataDir, robotId: input.robotId, connect: gateway }) : null;
const config = { agents, api, cwd: input.cwd, home: input.home, env };
// A native catalog query runs OpenCode in the working folder, where other robots' conversations must stay hidden like
// in a run, and next to the same read-only view of the workspace with its private entries masked.
const shown = alaWorkspaceOptions(input.workspace, { cwd: input.cwd, home: input.home });
const ignoredPaths = shown.ignoredPaths;
const service = api.createCodingAgentService({ agents, home: input.home, workspace: input.cwd, cwd: input.cwd, env,
    workspaceIdentity: input.identity, ignoredPaths, folders: [...shown.folders, { source: input.soul, alias: 'roboteam-soul' }] });
try {
    // The mask needs an existing directory, and the robot home has no such folder. The workspace masks exist or are absent.
    if (input.cwd !== input.home) await fs.mkdir(path.join(input.cwd, '.roboteam'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const probe = cache ? await cache.probe(config, signal).catch(() => null) : null;
    const models = probe?.models || await service.listModels(input.agent, { signal, details: true });
    if (cache && !probe?.models) await cache.store(probe, models).catch(() => false);
    process.stdout.write(JSON.stringify(models));
} finally { await service.close(); }
