import fsSync from 'node:fs';
import path from 'node:path';
import { WORKFLOW_ID_PATTERN } from './constants.mjs';
import { ensureDirectory } from './storage.mjs';
import { WorkflowFiles } from './workflow-files.mjs';
import { normalizeWorkflow, invalid, slugifyWorkflow, workflowCatalogEntry, workflowDefaultObjective } from './graph.mjs';
export { normalizeWorkflow, slugifyWorkflow, workflowCatalogEntry };

const present = (graph, extra) => ({ ...graph, defaultObjective: workflowDefaultObjective(graph), readOnly: false, ...extra });
const conflict = message => Object.assign(invalid(message), { statusCode: 409 });

// Workflow types are JSON files, never database records; runs and Cron jobs refer to them by id.
// Three sources share one id space:
// - built-in presets (see workflow-presets.mjs), read-only and loaded by the service;
// - internal workflows, one <id>.json in the agent's data folder, written by Save;
// - workspace files in <repository>/flows/ or <repository>/<folder>/flows/, written by Save as.
// A file whose id is reserved by a preset, already used by an internal workflow, defined twice
// in the workspace or that does not validate is reported in fileErrors and is not a workflow.

// Definition-derived defaults follow edits; captured generation requirements remain intact.
function editedObjective(input, previous) {
    const defaultObjective = input.defaultObjective === undefined ? previous.defaultObjective : input.defaultObjective;
    return defaultObjective === previous.defaultObjective && previous.defaultObjective === workflowDefaultObjective({ ...previous, defaultObjective: '' }) ? undefined : defaultObjective;
}

export class WorkflowRegistry {
    constructor(options = {}) {
        if (!options.directory) throw new Error('WorkflowRegistry requires the internal workflows directory');
        this.directory = options.directory;
        this.workspace = Boolean(options.workspaceRoot);
        this.files = new WorkflowFiles({ workspaceRoot: options.workspaceRoot || options.directory, folders: options.folders });
        this.presetIds = new Set(options.presetIds || []);
        this.presets = new Map();
        this.internalIndex = new Map();
        this.fileIndex = new Map();
        this.fileErrors = [];
    }
    async initialize() { await ensureDirectory(this.directory); }
    addPreset(graph) {
        this.presetIds.add(graph.id);
        this.presets.set(graph.id, present(graph, { readOnly: true }));
    }
    async refresh() {
        await this.initialize();
        const internal = (await this.files.scanFolder(this.directory)).map(entry => ({ ...entry, path: entry.file, internal: true }));
        const workspace = this.workspace ? await this.files.scan() : [];
        const counts = new Map();
        for (const entry of workspace) if (!entry.error) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
        this.internalIndex = new Map();
        this.fileIndex = new Map();
        this.fileErrors = [];
        for (const entry of [...internal, ...workspace]) {
            const error = entry.error || (this.presetIds.has(entry.id) ? `workflow id "${entry.id}" is reserved by a built-in workflow`
                : !entry.internal && this.internalIndex.has(entry.id) ? `workflow id "${entry.id}" is already used by an internal workflow`
                : !entry.internal && counts.get(entry.id) > 1 ? `workflow id "${entry.id}" is defined by more than one file` : null);
            if (error) this.fileErrors.push({ path: entry.path, message: error });
            else (entry.internal ? this.internalIndex : this.fileIndex).set(entry.id, entry);
        }
    }
    presentEntry(entry) {
        return present(entry.graph, { revision: entry.revision, source: entry.internal ? { kind: 'internal' } : { kind: 'file', path: entry.path } });
    }
    // Reads the file again, so a running service sees edits made on disk.
    entrySync(id) {
        if (this.presetIds.has(id) || !WORKFLOW_ID_PATTERN.test(id)) return null;
        const file = path.join(this.directory, `${id}.json`);
        if (fsSync.existsSync(file)) {
            const entry = this.files.readSync(file);
            return entry.error ? null : { ...entry, path: file, internal: true };
        }
        const indexed = this.fileIndex.get(id);
        if (!indexed) return null;
        const entry = this.files.readSync(indexed.file);
        return entry.error ? null : entry;
    }
    getSync(id) {
        if (this.presets.has(id)) return this.presets.get(id);
        const entry = this.entrySync(id);
        return entry ? this.presentEntry(entry) : null;
    }
    async get(id) { await this.refresh(); return this.getSync(id); }
    async list() {
        await this.refresh();
        return [...this.presets.values(), ...[...this.internalIndex.values(), ...this.fileIndex.values()].map(entry => this.presentEntry(entry))]
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    // Without a location the workflow is internal; with one (a workspace folder) it is created as <location>/flows/<id>.json.
    async create(input, { location } = {}) {
        const graph = normalizeWorkflow(input);
        await this.refresh();
        if (this.presetIds.has(graph.id) || this.internalIndex.has(graph.id) || this.fileIndex.has(graph.id)) throw conflict('workflow id already exists');
        if (location !== undefined && !this.workspace) throw invalid('workflow files need a workspace');
        const created = location !== undefined ? await this.files.create(location, graph) : await this.files.createIn(this.directory, graph);
        if (created.error) throw invalid(created.error);
        const entry = location !== undefined ? created : { ...created, path: created.file, internal: true };
        (entry.internal ? this.internalIndex : this.fileIndex).set(entry.id, entry);
        return this.presentEntry(entry);
    }
    async update(id, input) {
        if (this.presetIds.has(id)) throw conflict('built-in workflows cannot be edited');
        await this.refresh();
        const entry = this.entrySync(id);
        if (!entry) return null;
        const previous = this.presentEntry(entry);
        if (input.revision !== previous.revision) throw conflict('workflow changed; reload before saving');
        const written = await this.files.write(entry, normalizeWorkflow({ ...input, defaultObjective: editedObjective(input, previous) }, { id }));
        if (written.error) throw invalid(written.error);
        const updated = entry.internal ? { ...written, path: written.file, internal: true } : written;
        (updated.internal ? this.internalIndex : this.fileIndex).set(id, updated);
        return this.presentEntry(updated);
    }
    async remove(id, { beforeRemove = () => {} } = {}) {
        if (this.presetIds.has(id)) throw conflict('built-in workflows cannot be deleted');
        await this.refresh();
        const entry = this.internalIndex.get(id) || this.fileIndex.get(id);
        if (!entry) return false;
        beforeRemove(id);
        (entry.internal ? this.internalIndex : this.fileIndex).delete(id);
        return this.files.remove(entry);
    }
}
export const workflowRegistryInternals = { normalizeWorkflow, slugifyWorkflow, invalid };
