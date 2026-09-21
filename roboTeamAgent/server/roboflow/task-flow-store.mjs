import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    FLOWS_DIR, FLOW_ID_PATTERN, FLOW_STATUSES, INVOCATION_STATES, INVOCATION_ID_PATTERN,
    MAX_INVOCATIONS, MAX_LOG_BYTES,
} from './constants.mjs';
import { appendFileBounded, ensureDirectory, listDirectories, readFileBounded, readJson, withLock, writeJsonAtomic } from './storage.mjs';

const SCHEMA = 'roboflow-flow-v1';

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

export class TaskFlowStore {
    constructor(options = {}) {
        this.directory = path.resolve(options.directory || FLOWS_DIR);
    }

    async initialize() {
        await ensureDirectory(this.directory);
    }

    flowDirectory(flowId) {
        if (!FLOW_ID_PATTERN.test(String(flowId || ''))) throw invalid('invalid task flow id');
        const resolved = path.resolve(this.directory, flowId);
        if (path.dirname(resolved) !== this.directory) throw invalid('invalid task flow path');
        return resolved;
    }

    flowFile(flowId) {
        return path.join(this.flowDirectory(flowId), 'flow.json');
    }

    logFile(flowId, invocationId) {
        if (!INVOCATION_ID_PATTERN.test(String(invocationId || ''))) throw invalid('invalid invocation id');
        return path.join(this.flowDirectory(flowId), 'logs', `${invocationId}.log`);
    }

    eventsFile(flowId) {
        return path.join(this.flowDirectory(flowId), 'events.jsonl');
    }

    static newFlowId() {
        return `flow_${crypto.randomBytes(12).toString('hex')}`;
    }

    static newInvocationId() {
        return `inv_${crypto.randomBytes(12).toString('hex')}`;
    }

    async _read(flowId) {
        const record = await readJson(this.flowFile(flowId));
        if (!record) return null;
        if (record.schema !== SCHEMA || record.id !== flowId) throw new Error(`task flow record is invalid for ${flowId}`);
        return record;
    }

    async create(record) {
        await this.initialize();
        if (!FLOW_ID_PATTERN.test(String(record?.id || ''))) throw invalid('invalid task flow id');
        return withLock(`flow:${record.id}`, async () => {
            if (await this._read(record.id)) throw Object.assign(invalid('task flow already exists'), { statusCode: 409 });
            const now = new Date().toISOString();
            const value = {
                schema: SCHEMA,
                id: record.id,
                workflowTypeId: record.workflowTypeId,
                workflowName: record.workflowName,
                folder: record.folder,
                objective: record.objective,
                status: 'active',
                version: 0,
                createdBy: record.createdBy || '',
                createdAt: now,
                updatedAt: now,
                finishedAt: null,
                result: null,
                members: record.members,
                invocations: [],
            };
            await writeJsonAtomic(this.flowFile(value.id), value);
            await this.appendEvent(value.id, { type: 'flow-created', objective: value.objective, workflowTypeId: value.workflowTypeId });
            return value;
        });
    }

    async get(flowId) {
        await this.initialize();
        return this._read(flowId);
    }

    async list({ folder } = {}) {
        await this.initialize();
        const flows = [];
        for (const name of await listDirectories(this.directory)) {
            if (!FLOW_ID_PATTERN.test(name)) continue;
            try {
                const record = await this._read(name);
                if (!record) continue;
                if (folder && path.resolve(record.folder) !== path.resolve(folder)) continue;
                flows.push(record);
            } catch {
                // Corrupt records stay private and are omitted.
            }
        }
        return flows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    }

    // Read-modify-write under a per-flow lock. The mutator may return a value to
    // publish to the caller; the flow's optimistic version always advances.
    async update(flowId, mutator) {
        await this.initialize();
        return withLock(`flow:${flowId}`, async () => {
            const flow = await this._read(flowId);
            if (!flow) throw Object.assign(invalid('task flow not found'), { statusCode: 404 });
            const result = mutator(flow);
            flow.version = Number(flow.version || 0) + 1;
            flow.updatedAt = new Date().toISOString();
            await writeJsonAtomic(this.flowFile(flowId), flow);
            return result;
        });
    }

    async appendEvent(flowId, event) {
        const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
        await ensureDirectory(this.flowDirectory(flowId));
        await fs.appendFile(this.eventsFile(flowId), line, { mode: 0o600 }).catch(async (error) => {
            if (error.code !== 'ENOENT') throw error;
            await ensureDirectory(path.dirname(this.eventsFile(flowId)));
            await fs.appendFile(this.eventsFile(flowId), line, { mode: 0o600 });
        });
    }

    async readEvents(flowId) {
        const text = await readFileBounded(this.eventsFile(flowId), MAX_LOG_BYTES);
        return text.split('\n').filter(Boolean).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
    }

    async appendLog(flowId, invocationId, chunk) {
        return appendFileBounded(this.logFile(flowId, invocationId), chunk, MAX_LOG_BYTES);
    }

    async readLog(flowId, invocationId, limit = MAX_LOG_BYTES) {
        return readFileBounded(this.logFile(flowId, invocationId), limit);
    }

    assertFlowStatus(status) {
        if (!FLOW_STATUSES.includes(status)) throw invalid(`invalid task flow status: ${status}`);
    }

    assertInvocationState(state) {
        if (!INVOCATION_STATES.includes(state)) throw invalid(`invalid invocation state: ${state}`);
    }
}

export const taskFlowStoreInternals = { SCHEMA, MAX_INVOCATIONS };
