import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RoboFlowDatabase } from './database.mjs';
import { FLOW_ID_PATTERN, INVOCATION_ID_PATTERN } from './constants.mjs';
import { invalid } from './graph.mjs';

export class TaskFlowStore {
    constructor(options = {}) { this.database = options.database || new RoboFlowDatabase(options.databaseFile); }
    async initialize() { this.database.initialize(); }
    static newFlowId() { return `flow_${crypto.randomBytes(12).toString('hex')}`; }
    static newInvocationId() { return `inv_${crypto.randomBytes(12).toString('hex')}`; }
    getSync(id) {
        const row = this.database.db.prepare('SELECT record FROM workflow_runs WHERE id=?').get(id);
        if (!row) return null;
        return { ...JSON.parse(row.record), instances: this.database.db.prepare('SELECT record FROM task_instances WHERE run_id=? ORDER BY sequence').all(id).map(entry => JSON.parse(entry.record)) };
    }
    saveSync(flow) {
        const { instances, result, ...record } = flow;
        this.database.db.prepare('INSERT INTO workflow_runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(flow.id, JSON.stringify(record));
        for (const instance of instances || []) this.database.db.prepare('INSERT INTO task_instances VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(instance.id, flow.id, instance.sequence, JSON.stringify(instance));
        return flow;
    }
    async createFromWorkflow(registry, workflowId, input) {
        await this.initialize();
        return this.database.transaction(() => {
            const graph = registry.getSync(workflowId);
            if (!graph) throw Object.assign(invalid('workflow not found'), { statusCode: 404 });
            const now = new Date().toISOString();
            return this.saveSync({ id: TaskFlowStore.newFlowId(), workflowTypeId: graph.id, workflowName: graph.name, graph,
                ...input, status: 'running', currentInstanceId: null, createdAt: now, updatedAt: now, finishedAt: null, error: null, instances: [] });
        });
    }
    async get(id) { await this.initialize(); return this.getSync(id); }
    async list() { await this.initialize(); return this.database.db.prepare('SELECT id FROM workflow_runs ORDER BY rowid DESC').all().map(row => this.getSync(row.id)); }
    async update(id, operation) {
        await this.initialize();
        return this.database.transaction(() => {
            const flow = this.getSync(id);
            if (!flow) throw Object.assign(invalid('workflow run not found'), { statusCode: 404 });
            operation(flow);
            flow.updatedAt = new Date().toISOString();
            return this.saveSync(flow);
        });
    }
    async outputPath(flowId, instanceId, suffix, create = false) {
        if (!FLOW_ID_PATTERN.test(flowId) || !INVOCATION_ID_PATTERN.test(instanceId) || !['log', 'result'].includes(suffix)) throw invalid('invalid task output reference');
        const flow = await this.get(flowId);
        if (!flow?.instances.some(instance => instance.id === instanceId)) throw invalid('task instance not found');
        const root = await fs.realpath(flow.folder);
        if (root !== path.resolve(flow.folder)) throw new Error('Workflow output folder was replaced by a symlink');
        let directory = root;
        for (const part of ['.achilles-cli', 'roboflow', flowId]) {
            directory = path.join(directory, part);
            if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workflow output directory');
        }
        return path.join(directory, `${instanceId}.${suffix}`);
    }
    async writeOutput(flowId, instanceId, value, suffix = 'log') {
        const file = await this.outputPath(flowId, instanceId, suffix, true);
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (suffix === 'log' ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
        const handle = await fs.open(file, flags, 0o600);
        try { await handle.writeFile(String(value || '')); } finally { await handle.close(); }
    }
    async readOutput(flowId, instanceId, suffix = 'log') {
        const file = await this.outputPath(flowId, instanceId, suffix);
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { return await handle.readFile('utf8'); } finally { await handle.close(); }
    }
}
