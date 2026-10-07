import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { normalizeCodingAgents } from './coding-agents.mjs';

const CONFIG_FIELDS = new Set(['codingAgent', 'models', 'efforts']);
// OpenCode's built-in model. Pinning it in ALA's config keeps headless runs on
// the same default the terminal uses instead of OpenCode's internal priority,
// which can prefer an unrelated provider model.
export const DEFAULT_OPENCODE_MODEL = 'opencode/big-pickle';

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Keeps the robot's ALA config (<home>/.ala/config.json) in step with the
// robot: codingAgent is the robot's agent, and OpenCode gets its default model
// unless a model was already chosen. An explicit codingAgent replaces the saved
// one; models and efforts chosen for any agent are kept. A config ALA would
// reject is left untouched for ALA to report.
export async function ensureAgentConfig(home, { codingAgents, codingAgent = null, model, effort } = {}) {
    const selected = normalizeCodingAgents(codingAgents);
    if (model !== undefined && (selected.length !== 1 || (model !== null
        && (typeof model !== 'string' || !model.trim() || model.length > 512 || /[\x00-\x1f]/u.test(model))))) {
        throw Object.assign(new Error('model must be null or a model ID for one coding agent'), { statusCode: 400 });
    }
    if (effort !== undefined && (model === undefined || (effort !== null
        && (typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(effort))))) {
        throw Object.assign(new Error('effort requires a model selection and must be null or a native effort name'), { statusCode: 400 });
    }
    const directory = path.join(home, '.ala');
    const file = await agentConfigPath(home);
    let current = {};
    try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            if (model !== undefined) throw new Error('Cannot update an invalid ALA configuration.');
            return null;
        }
    }
    if (!isRecord(current) || Object.keys(current).some(key => !CONFIG_FIELDS.has(key))) {
        if (model !== undefined) throw new Error('Cannot update an invalid ALA configuration.');
        return null;
    }
    const models = isRecord(current.models) ? { ...current.models } : {};
    const record = {
        codingAgent: codingAgent || current.codingAgent || selected[0],
        models,
        efforts: isRecord(current.efforts) ? { ...current.efforts } : {},
    };
    if (selected.includes('opencode') && !(typeof models.opencode === 'string' && models.opencode.trim())) {
        models.opencode = DEFAULT_OPENCODE_MODEL;
    }
    if (model !== undefined) {
        const agent = selected[0];
        const next = model === null ? (agent === 'opencode' ? DEFAULT_OPENCODE_MODEL : null) : model.trim();
        if (model === null || models[agent] !== next) delete record.efforts[agent];
        if (next) models[agent] = next;
        else delete models[agent];
    }
    if (effort !== undefined) {
        const agent = selected[0];
        if (effort && !models[agent]) throw Object.assign(new Error('effort requires an explicit model'), { statusCode: 400 });
        if (effort) record.efforts[agent] = effort;
        else delete record.efforts[agent];
    }
    if (JSON.stringify(record) === JSON.stringify(current)) return null;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return record;
}

export async function agentConfigPath(home) {
    const directory = path.join(home, '.ala'), file = path.join(directory, 'config.json');
    for (const [entryPath, kind] of [[home, 'isDirectory'], [directory, 'isDirectory'], [file, 'isFile']]) {
        try {
            const entry = await fs.lstat(entryPath);
            if (entry.isSymbolicLink() || !entry[kind]()) throw new Error('Unsafe ALA model configuration path.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return file;
}
