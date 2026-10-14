import path from 'node:path';
import fs from 'node:fs/promises';
import { RoboFlowDatabase } from './database.mjs';
import { WorkflowFiles } from './workflow-files.mjs';
import { normalizeWorkflow, invalid, slugifyWorkflow, workflowCatalogEntry, workflowDefaultObjective } from './graph.mjs';
export { normalizeWorkflow, slugifyWorkflow, workflowCatalogEntry };

const protectedIds = new Set(['default', 'code-development']);
const presentWorkflow = graph => graph ? { ...graph, defaultObjective: workflowDefaultObjective(graph), readOnly: protectedIds.has(graph.id) } : null;
// A workflow from a workspace file carries its workspace-relative path; internal ones carry no source.
const presentFile = entry => ({ ...presentWorkflow(entry.graph), revision: entry.revision, source: { kind: 'file', path: entry.path } });
const conflict = message => Object.assign(invalid(message), { statusCode: 409 });

// Workflow types live in SQLite (internal) or, with a workspace root, also as JSON files in
// the workspace (see WorkflowFiles). Ids are unique across both: a file whose id is already
// taken, or that does not validate, is reported in fileErrors and never becomes a workflow.

// Definition-derived defaults follow edits; captured generation requirements remain intact.
function editedObjective(input, previous) {
    const defaultObjective = input.defaultObjective === undefined ? previous.defaultObjective : input.defaultObjective;
    return defaultObjective === previous.defaultObjective && previous.defaultObjective === workflowDefaultObjective({ ...previous, defaultObjective: '' }) ? undefined : defaultObjective;
}

export class WorkflowRegistry {
    constructor(options = {}) {
        this.database = options.database || new RoboFlowDatabase(options.databaseFile || (options.directory ? path.join(options.directory, 'roboflow.sqlite') : undefined));
        this.legacyDirectory = options.legacyDirectory;
        this.files = options.files || (options.workspaceRoot ? new WorkflowFiles({ workspaceRoot: options.workspaceRoot, folders: options.folders }) : null);
        this.fileIndex = new Map();
        this.fileErrors = [];
    }
    async refreshFiles() {
        if (!this.files) return;
        const internal = new Set(this.database.db.prepare('SELECT id FROM workflow_types').all().map(row => row.id));
        const entries = await this.files.scan(), counts = new Map();
        for (const entry of entries) if (!entry.error) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
        this.fileIndex = new Map();
        this.fileErrors = [];
        for (const entry of entries) {
            const error = entry.error || (internal.has(entry.id) ? `workflow id "${entry.id}" is already used by an internal workflow`
                : counts.get(entry.id) > 1 ? `workflow id "${entry.id}" is defined by more than one file` : null);
            if (error) this.fileErrors.push({ path: entry.path, message: error });
            else this.fileIndex.set(entry.id, entry);
        }
    }
    // Rereads the indexed file, so a running service sees edits made on disk.
    fileSync(id) {
        const indexed = this.fileIndex.get(id);
        if (!indexed) return null;
        const entry = this.files.readSync(indexed.file);
        return entry.error ? null : entry;
    }
    async initialize() {
        this.database.initialize();
        if (this.legacyDirectory) {
            const entries = await fs.readdir(this.legacyDirectory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
            for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) await fs.unlink(path.join(this.legacyDirectory, entry.name));
            this.legacyDirectory = null;
        }
    }
    internalSync(id) { const row = this.database.db.prepare('SELECT record FROM workflow_types WHERE id=?').get(id); return row ? presentWorkflow(JSON.parse(row.record)) : null; }
    getSync(id) {
        const internal = this.internalSync(id);
        if (internal) return internal;
        const entry = this.fileSync(id);
        return entry ? presentFile(entry) : null;
    }
    async get(id) { await this.initialize(); await this.refreshFiles(); return this.getSync(id); }
    async list() {
        await this.initialize();
        await this.refreshFiles();
        const internal = this.database.db.prepare('SELECT record FROM workflow_types').all().map(row => presentWorkflow(JSON.parse(row.record)));
        return [...internal, ...[...this.fileIndex.values()].map(presentFile)].sort((a, b) => a.name.localeCompare(b.name));
    }
    // With a location (a workspace folder), the workflow is created as <location>/flows/<id>.json.
    async create(input, builtin = false, { system = false, location } = {}) {
        await this.initialize();
        const graph = normalizeWorkflow(input, { builtin });
        if (graph.id === 'code-development' && !system) throw conflict('Code Development is a reserved workflow');
        await this.refreshFiles();
        if (this.fileIndex.has(graph.id)) throw conflict('workflow id already exists');
        if (location !== undefined) {
            if (!this.files) throw invalid('workflow files need a workspace');
            if (builtin || this.internalSync(graph.id)) throw conflict('workflow id already exists');
            const entry = await this.files.create(location, graph);
            if (entry.error) throw invalid(entry.error);
            this.fileIndex.set(entry.id, entry);
            return presentFile(entry);
        }
        return this.database.transaction(() => {
            if (this.getSync(graph.id)) throw conflict('workflow id already exists');
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
        if (!this.internalSync(id)) {
            await this.refreshFiles();
            const entry = this.fileSync(id);
            if (!entry) return null;
            const previous = presentFile(entry);
            if (input.revision !== previous.revision) throw conflict('workflow changed; reload before saving');
            const written = await this.files.write(entry, normalizeWorkflow({ ...input, defaultObjective: editedObjective(input, previous) }, { id }));
            if (written.error) throw invalid(written.error);
            this.fileIndex.set(id, written);
            return presentFile(written);
        }
        return this.database.transaction(() => {
            const previous = this.internalSync(id);
            if (!previous) return null;
            if (input.revision !== previous.revision) throw conflict('workflow changed; reload before saving');
            const graph = normalizeWorkflow({ ...input, defaultObjective: editedObjective(input, previous) }, { id });
            const record = { ...graph, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
            this.database.db.prepare('UPDATE workflow_types SET record=? WHERE id=?').run(JSON.stringify(record), id);
            return record;
        });
    }
    async remove(id, { beforeRemove = () => {} } = {}) {
        if (protectedIds.has(id)) throw Object.assign(invalid('built-in workflows cannot be deleted'), { statusCode: 409 });
        await this.initialize();
        if (!this.internalSync(id)) {
            await this.refreshFiles();
            const entry = this.fileIndex.get(id);
            if (!entry) return false;
            beforeRemove(id);
            this.fileIndex.delete(id);
            return this.files.remove(entry);
        }
        beforeRemove(id);
        return this.database.db.prepare('DELETE FROM workflow_types WHERE id=?').run(id).changes > 0;
    }
}
export const workflowRegistryInternals = { normalizeWorkflow, slugifyWorkflow, invalid };
