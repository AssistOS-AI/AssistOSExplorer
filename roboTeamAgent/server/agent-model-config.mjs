import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CONFIG_VERSION = 1;
const BACKENDS = ['codex', 'opencode', 'pi'];
// OpenCode's built-in model. Pinning it in ALA's native config keeps headless
// runs on the same default the terminal uses instead of OpenCode's internal
// priority, which can prefer an unrelated provider model.
export const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Records the robot's default model for one coding backend in ALA's native
// config without overwriting a model the user already selected.
export async function ensureDefaultAgentModel(home, {
    backend = 'opencode', model = DEFAULT_OPENCODE_MODEL,
} = {}) {
    if (!BACKENDS.includes(backend) || typeof model !== 'string' || !model.trim()) return null;
    const directory = path.join(home, '.ala');
    const file = path.join(directory, 'config.json');
    let current = null;
    try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') return null; // Leave an unreadable config to ALA.
    }
    if (current !== null && (!isRecord(current) || current.version !== CONFIG_VERSION)) return null;
    const codingAgents = isRecord(current?.codingAgents) ? current.codingAgents : {};
    const models = isRecord(codingAgents.models) ? codingAgents.models : {};
    if (typeof models[backend] === 'string' && models[backend].trim()) return null;
    const record = {
        version: CONFIG_VERSION,
        codingAgents: { ...codingAgents, models: { ...models, [backend]: model.trim() } },
    };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return record;
}
