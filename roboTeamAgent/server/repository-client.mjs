import { requireWorkspaceRoot } from './workspace-root.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

let client;
export async function repositoryClient() {
    const workspaceRoot = requireWorkspaceRoot();
    if (!client) {
        const candidate = ['/Agent/client/RepositoryClient.mjs', path.join(workspaceRoot, 'ploinky/Agent/client/RepositoryClient.mjs')]
            .find(file => fs.existsSync(file));
        if (!candidate) throw new Error('Ploinky repository client is unavailable');
        client = (await import(pathToFileURL(candidate).href)).createRepositoryClient();
    }
    return client;
}
