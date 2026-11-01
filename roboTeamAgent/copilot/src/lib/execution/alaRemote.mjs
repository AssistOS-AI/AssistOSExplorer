import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceDataPath } from '../../../../server/workspace-paths.mjs';
import { repositoryClient } from '../../../../server/repository-client.mjs';

const inside = (root, value) => value === root || value.startsWith(root + path.sep);

// Translate RoboTeam's container aliases before the RoboWork MCP grant is
// made. Runtime mounts always name real workspace sources.
export async function targetPath(value, workspaceRoot, { repositoriesClient } = {}) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    if (!['/data', '/Agent', '/code'].some(root => inside(root, value))) return value;
    const resolved = await fs.realpath(value);
    const root = await fs.realpath(workspaceRoot);
    if (inside('/code', value) && !inside(root, resolved)) {
        const repositories = await (repositoriesClient || await repositoryClient()).listRepositories();
        const repository = repositories.find(entry => entry.name === 'AchillesIDE' && entry.origin !== 'remote');
        if (!repository?.source) throw new Error('RoboTeam code source is unavailable in the workspace');
        const projected = path.join(repository.source, 'roboTeamAgent', path.relative('/code', value));
        const [actual, visible] = await Promise.all([fs.stat(resolved), fs.stat(projected)]);
        if (actual.dev !== visible.dev || actual.ino !== visible.ino) throw new Error('RoboTeam code source projection does not match');
        return fs.realpath(projected);
    }
    return inside(root, resolved) ? resolved : workspaceDataPath(resolved, root);
}
