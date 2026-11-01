import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAlaCommand } from './ala-command.mjs';

export async function resolveAlaInstallation({ entry = resolveAlaCommand() } = {}) {
    const entryPath = await fs.realpath(entry);
    const packageRoot = path.dirname(path.dirname(entryPath));
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'advanced-language-agent') throw new Error('Invalid ALA installation');
    const load = name => import(pathToFileURL(path.join(packageRoot, 'src', name)).href);
    const [config, discovery, service, logins] = await Promise.all([
        load('config.mjs'), load('coding-agents/discovery.mjs'), load('coding-agents/service.mjs'), load('coding-agents/logins.mjs'),
    ]);
    return { entryPath, packageRoot, ...config, ...discovery, ...service, ...logins };
}
