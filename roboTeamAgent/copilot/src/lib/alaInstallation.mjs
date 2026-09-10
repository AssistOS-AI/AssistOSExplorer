import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveAlaCommand } from '../../../server/ala-command.mjs';

async function executableOnPath(name, env) {
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.resolve(directory, name);
        try {
            await fs.access(candidate, constants.X_OK);
            if ((await fs.stat(candidate)).isFile()) return candidate;
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
        }
    }
    return null;
}

export async function resolveAlaInstallation({ env = process.env } = {}) {
    const explicit = String(env.ACHILLES_ALA_COMMAND || '').trim();
    const candidate = explicit
        ? (explicit.includes(path.sep) ? path.resolve(explicit) : await executableOnPath(explicit, env))
        : resolveAlaCommand();
    const instruction = 'Install ALA and its dependencies, or set ACHILLES_ALA_COMMAND to its bin/ala.mjs Node entry (not a shell command or opaque wrapper).';
    try {
        if (!candidate) throw new Error('ALA command was not found on PATH.');
        const entryPath = await fs.realpath(candidate);
        if (!(await fs.stat(entryPath)).isFile()) throw new Error('ALA entry is not a file.');
        await fs.access(entryPath, /\.(?:mjs|cjs|js)$/i.test(entryPath) ? constants.R_OK : constants.X_OK);
        let packageRoot = path.dirname(entryPath);
        while (true) {
            try {
                const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
                if (metadata.name === 'advanced-language-agent') break;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            const parent = path.dirname(packageRoot);
            if (parent === packageRoot) throw new Error('Cannot resolve the ALA package root from the executable.');
            packageRoot = parent;
        }
        const load = (relative) => import(pathToFileURL(path.join(packageRoot, 'src', relative)).href);
        const [repositories, discovery, service] = await Promise.all([
            load('repositories.mjs'),
            load('coding-agents/discovery.mjs'), load('coding-agents/service.mjs'),
        ]);
        const api = {
            entryPath, packageRoot,
            discoverTaskSkills: repositories.discoverTaskSkills,
            discoverCodingAgents: discovery.discoverCodingAgents,
            createCodingAgentService: service.createCodingAgentService,
        };
        for (const [name, value] of Object.entries(api)) {
            if (!['entryPath', 'packageRoot'].includes(name) && typeof value !== 'function') {
                throw new Error(`ALA installation is missing ${name}.`);
            }
        }
        return Object.freeze(api);
    } catch (cause) {
        throw new Error(`ALA setup error: ${cause.message} ${instruction}`, { cause });
    }
}
