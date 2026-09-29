import path from 'node:path';
import fs from 'node:fs/promises';
import { RoboFlowDatabase } from './database.mjs';
import { normalizeWorkflow, invalid, slugifyWorkflow, workflowCatalogEntry } from './graph.mjs';
export { normalizeWorkflow, slugifyWorkflow, workflowCatalogEntry };

const protectedIds = new Set(['default', 'code-development']);
const presentWorkflow = graph => graph ? { ...graph, readOnly: protectedIds.has(graph.id) } : null;

export class WorkflowRegistry {
    constructor(options = {}) {
        this.database = options.database || new RoboFlowDatabase(options.databaseFile || (options.directory ? path.join(options.directory, 'roboflow.sqlite') : undefined));
        this.legacyDirectory = options.legacyDirectory;
    }
    async initialize() {
        this.database.initialize();
        if (this.legacyDirectory) {
            const entries = await fs.readdir(this.legacyDirectory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
            for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) await fs.unlink(path.join(this.legacyDirectory, entry.name));
            this.legacyDirectory = null;
        }
    }
    getSync(id) { const row = this.database.db.prepare('SELECT record FROM workflow_types WHERE id=?').get(id); return row ? presentWorkflow(JSON.parse(row.record)) : null; }
    async get(id) { await this.initialize(); return this.getSync(id); }
    async list() { await this.initialize(); return this.database.db.prepare('SELECT record FROM workflow_types').all().map(row => presentWorkflow(JSON.parse(row.record))).sort((a, b) => a.name.localeCompare(b.name)); }
    async create(input, builtin = false, { system = false } = {}) {
        await this.initialize();
        const graph = normalizeWorkflow(input, { builtin });
        if (graph.id === 'code-development' && !system) throw Object.assign(invalid('Code Development is a reserved workflow'), { statusCode: 409 });
        return this.database.transaction(() => {
            if (this.getSync(graph.id)) throw Object.assign(invalid('workflow id already exists'), { statusCode: 409 });
            const now = new Date().toISOString();
            const record = { ...presentWorkflow(graph), revision: 1, createdAt: now, updatedAt: now };
            this.database.db.prepare('INSERT INTO workflow_types VALUES (?, ?)').run(record.id, JSON.stringify(record));
            return record;
        });
    }
    async ensure(input, { builtin = true, system = false } = {}) { return await this.get(input.id) || this.create(input, builtin, { system }); }
    async update(id, input) {
        if (protectedIds.has(id)) throw Object.assign(invalid('built-in workflows cannot be edited'), { statusCode: 409 });
        await this.initialize();
        const graph = normalizeWorkflow(input, { id });
        return this.database.transaction(() => {
            const previous = this.getSync(id);
            if (!previous) return null;
            if (input.revision !== previous.revision) throw Object.assign(invalid('workflow changed; reload before saving'), { statusCode: 409 });
            const record = { ...graph, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
            this.database.db.prepare('UPDATE workflow_types SET record=? WHERE id=?').run(JSON.stringify(record), id);
            return record;
        });
    }
    async remove(id) {
        if (protectedIds.has(id)) throw Object.assign(invalid('built-in workflows cannot be deleted'), { statusCode: 409 });
        await this.initialize();
        return this.database.db.prepare('DELETE FROM workflow_types WHERE id=?').run(id).changes > 0;
    }
}
export const workflowRegistryInternals = { normalizeWorkflow, slugifyWorkflow, invalid };
