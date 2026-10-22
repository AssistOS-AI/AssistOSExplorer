import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveAlaCommand } from '../../../../server/ala-command.mjs';
import { ACHILLES_PRIVATE_DIRECTORY_NAME } from '../storage/privateDataRoot.mjs';

// ALA owns the conversation transcript files and their format. RoboTeam reads
// them only through ALA's exported transcript module, loaded once here.

function alaPackageRoot(env) {
    const explicit = String(env.ACHILLES_ALA_COMMAND || '').trim();
    const command = explicit && explicit.includes(path.sep) ? path.resolve(explicit) : resolveAlaCommand();
    let directory = path.dirname(fs.realpathSync(command));
    while (true) {
        try {
            if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === 'advanced-language-agent') return directory;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error('Cannot resolve the ALA package root from the executable.');
        directory = parent;
    }
}

async function loadTranscriptModule(env = process.env) {
    try {
        const module = await import(pathToFileURL(path.join(alaPackageRoot(env), 'src', 'transcript.mjs')).href);
        for (const name of ['readSessionSync', 'readTurnSync', 'readSessionSummarySync', 'listSessionsSync']) {
            if (typeof module[name] !== 'function') throw new Error(`ALA transcript module is missing ${name}.`);
        }
        return module;
    } catch (cause) {
        throw new Error(`ALA setup error: cannot load the ALA transcript reader (${cause.message}). Install ALA or set ACHILLES_ALA_COMMAND to its bin/ala.mjs entry.`, { cause });
    }
}

export const alaTranscript = await loadTranscriptModule();

// The directory passed to ALA as ALA_SESSIONS for a working folder.
export function alaSessionsRoot(workingDir) {
    return path.join(workingDir, ACHILLES_PRIVATE_DIRECTORY_NAME, '.ala');
}

// Returns null when ALA has not written a transcript for the session yet.
export function readAlaSession(workingDir, sessionId) {
    try { return alaTranscript.readSessionSync(alaSessionsRoot(workingDir), sessionId); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
