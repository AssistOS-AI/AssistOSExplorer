import fs from 'node:fs/promises';
import path from 'node:path';
import { CODING_AGENT_NAMES } from './coding-agents.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { nativeEnvironment } from '../copilot/src/lib/execution/alaEnvironment.mjs';

// Whether a robot's home holds a login for each coding agent, and which agent ALA uses for it.
// Detection is ALA's own (`ala status`, src/coding-agents/logins.mjs): it checks that credential files or
// rows exist where each CLI keeps them, never runs a CLI and never returns a credential value. A stored
// login may still be expired or revoked; validity needs the CLI itself.
const FILE_LIMIT = 4 * 1024 * 1024;
const ALA_CONFIG = '.ala/config.json';
const NO_LOGINS = Object.freeze(Object.fromEntries(CODING_AGENT_NAMES.map(name => [name, false])));

// A robot controls these paths, so only a bounded regular file is ever opened (a FIFO would block).
async function readJson(file) {
    try {
        const metadata = await fs.lstat(file);
        if (!metadata.isFile() || metadata.size > FILE_LIMIT) return null;
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { return null; }
}

async function signature(files) {
    const parts = await Promise.all(files.map(async file => {
        const metadata = await fs.lstat(file).catch(() => null);
        return metadata ? `${file}:${metadata.mtimeMs}:${metadata.size}` : `${file}:-`;
    }));
    return parts.join('|');
}

// The robot's own agent state only: every agent directory under its home and no credential variable of
// this server, so a server-wide key never counts as a robot's login.
const robotEnvironment = home => nativeEnvironment({}, home);

export function createCodingAgentStatus({ installation = () => resolveAlaInstallation(), log = message => console.warn(message) } = {}) {
    const cache = new Map();
    let pending = null;
    let reported = false;
    // ALA is loaded once; a failed load is retried on the next listing and reported only once.
    async function ala() {
        pending ||= Promise.resolve().then(installation).then(api => {
            if (typeof api?.detectCodingAgentLogin !== 'function' || typeof api?.codingAgentLoginFiles !== 'function') {
                throw new Error('this ALA has no coding-agent login detection (src/coding-agents/logins.mjs)');
            }
            return api;
        });
        try { return await pending; } catch (error) {
            pending = null;
            if (!reported) log(`[roboTeam] coding-agent logins are unavailable: ${error?.message || error}`);
            reported = true;
            return null;
        }
    }
    async function cached(key, files, compute) {
        const stamp = await signature(files);
        const entry = cache.get(key);
        if (entry?.stamp === stamp) return entry.value;
        const value = await compute();
        cache.set(key, { stamp, value });
        return value;
    }
    return {
        // { codex, opencode, pi, claude } as booleans; only re-read when one of the agent's files changes.
        async logins(home) {
            const api = await ala();
            if (!api) return { ...NO_LOGINS };
            const env = robotEnvironment(home);
            const entries = await Promise.all(CODING_AGENT_NAMES.map(async name => [name,
                await cached(`${home}\0${name}`, api.codingAgentLoginFiles(name, { env }),
                    async () => (await api.detectCodingAgentLogin(name, { env })).loggedIn)]));
            return Object.fromEntries(entries);
        },
        // The agent ALA uses for the robot: its configured codingAgent when the robot has it enabled,
        // otherwise the first enabled agent, which is what ALA's configuration defaults to.
        async activeAgent(home, codingAgents) {
            const file = path.join(home, ALA_CONFIG);
            const configured = await cached(`${home}\0ala`, [file], async () => (await readJson(file))?.codingAgent);
            return codingAgents.includes(configured) ? configured : codingAgents[0];
        },
        forget(home) {
            for (const key of cache.keys()) if (key.startsWith(`${home}\0`)) cache.delete(key);
        },
    };
}
