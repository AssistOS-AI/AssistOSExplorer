import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceDataPath } from '../../../../server/workspace-paths.mjs';
import { requireWorkspaceRoot } from '../../../../server/workspace-root.mjs';
import { spawnInAgent } from '../../../../server/agent-exec-client.mjs';

// Runs one ALA turn inside another global-mode Ploinky agent's container (a terminal workflow phase
// with an agent environment). That container sees the workspace at the same path but not RoboTeam's
// /data alias or its /Agent mount, so every RoboTeam path in ALA's arguments and environment is
// rewritten to its workspace spelling: /data/... becomes <workspace>/.data/roboTeamAgent/..., and
// /Agent/linked/<repo> resolves to the linked workspace checkout. The static bwrap and ALA come from the
// tool cache; ALA and the coding agents run on the `node` of the target image, found on the PATH, to
// which the Router appends the target image's own PATH.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const RUNTIME_VARIABLES = ['ROBOTEAM_RUNTIME_BWRAP', 'ROBOTEAM_RUNTIME_ALA', 'ROBOTEAM_CHANNEL_DIR'];

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The workspace spelling of a RoboTeam path, or the path unchanged when it is not RoboTeam's own.
export async function targetPath(value, workspaceRoot) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    const own = value === '/data' || value.startsWith('/data/') || value.startsWith('/Agent/');
    if (!own) return value;
    let resolved;
    try { resolved = await fs.realpath(value); } catch { return value; }
    const root = await fs.realpath(workspaceRoot);
    if (isWithin(root, resolved)) return resolved;
    return workspaceDataPath(resolved, root);
}

async function requiredTargetPath(value, label, workspaceRoot) {
    const translated = await targetPath(value, workspaceRoot);
    const root = await fs.realpath(workspaceRoot);
    if (!translated || !isWithin(root, await fs.realpath(translated))) {
        throw new Error(`The ${label} for agent environments is not inside the workspace`);
    }
    return translated;
}

export async function translateArguments(args, workspaceRoot) {
    return Promise.all(args.map(arg => targetPath(arg, workspaceRoot)));
}

// The environment ALA gets in the target: RoboTeam's (already free of secrets) with paths rewritten,
// without PLOINKY_* variables (the Router refuses them) or RoboTeam's runtime handoff variables.
export async function translateEnvironment(env, workspaceRoot) {
    const result = {};
    for (const [name, value] of Object.entries(env)) {
        if (!ENV_NAME.test(name) || name.startsWith('PLOINKY_') || RUNTIME_VARIABLES.includes(name) || typeof value !== 'string') continue;
        result[name] = value.includes(':') && value.split(':').every(part => part === '' || path.isAbsolute(part))
            ? (await Promise.all(value.split(':').map(part => targetPath(part, workspaceRoot)))).join(':')
            : await targetPath(value, workspaceRoot);
    }
    return result;
}

export async function spawnAlaInAgent({ environment, args, env, cwd, workspaceRoot = requireWorkspaceRoot(), spawn = spawnInAgent }) {
    const [ala, bwrap] = await Promise.all([
        requiredTargetPath(env.ROBOTEAM_RUNTIME_ALA, 'ALA entry', workspaceRoot),
        requiredTargetPath(env.ROBOTEAM_RUNTIME_BWRAP, 'Bubblewrap binary', workspaceRoot),
    ]);
    const targetEnv = await translateEnvironment(env, workspaceRoot);
    targetEnv.ALA_BWRAP = bwrap;
    // `env` finds the target image's node on PATH; an image without Node.js fails with "node: not found".
    return spawn({ target: environment, argv: ['/usr/bin/env', 'node', ala, ...await translateArguments(args, workspaceRoot)],
        env: targetEnv, cwd });
}
