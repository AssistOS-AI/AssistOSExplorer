import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKFLOW_ID_PATTERN } from './constants.mjs';
import { invalid, normalizeWorkflow, workflowDefaultObjective } from './graph.mjs';

export const FLOWS_FOLDER = 'flows';
const MAX_FILE_BYTES = 1024 * 1024;
const RESERVED_IDS = new Set(['default', 'code-development']);
const fail = (message, statusCode = 400) => Object.assign(invalid(message), { statusCode });
const skipped = name => name.startsWith('.') || name === 'node_modules';
const toPosix = value => value.split(path.sep).join('/');

async function ordinaryDirectories(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
        throw error;
    });
    return entries.filter(entry => entry.isDirectory() && !skipped(entry.name)).map(entry => entry.name);
}

// Workflow types kept as JSON files in the workspace, in `<repository>/flows/` or
// `<repository>/<folder>/flows/`. The file name is the workflow id. A file holds only
// the definition; its revision is the hash of its content, so a change on disk makes
// a stale editor save fail like a concurrent edit. Skill selections inside the
// workspace are stored relative to it, so a file works in any workspace.
export class WorkflowFiles {
    constructor({ workspaceRoot, folders }) {
        this.workspaceRoot = workspaceRoot;
        this.folders = folders;
    }
    rootSync() { return fsSync.realpathSync(this.workspaceRoot); }
    async flowsDirectories(root) {
        const directories = [];
        for (const repository of await ordinaryDirectories(root)) {
            const base = path.join(root, repository);
            for (const folder of await ordinaryDirectories(base)) {
                if (folder === FLOWS_FOLDER) directories.push(path.join(base, folder));
                else if ((await ordinaryDirectories(path.join(base, folder))).includes(FLOWS_FOLDER)) directories.push(path.join(base, folder, FLOWS_FOLDER));
            }
        }
        return directories;
    }
    // Every *.json file found, valid or not; a broken file reports its error instead of a graph.
    async scan() {
        const root = await fs.realpath(this.workspaceRoot);
        const entries = [];
        for (const directory of await this.flowsDirectories(root)) {
            const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
            for (const file of files) {
                if (!file.isFile() || !file.name.endsWith('.json')) continue;
                entries.push(this.readSync(path.join(directory, file.name), root));
            }
        }
        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }
    readSync(file, root = this.rootSync()) {
        const entry = { id: path.basename(file, '.json'), file, path: toPosix(path.relative(root, file)) };
        try {
            const stat = fsSync.lstatSync(file);
            if (!stat.isFile()) throw new Error('not an ordinary file');
            if (stat.size > MAX_FILE_BYTES) throw new Error('larger than 1 MB');
            const content = fsSync.readFileSync(file, 'utf8');
            entry.revision = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
            if (!WORKFLOW_ID_PATTERN.test(entry.id)) throw new Error('file name is not a valid workflow id (3 to 64 lowercase letters, digits or dashes)');
            if (RESERVED_IDS.has(entry.id)) throw new Error('reserved workflow id');
            let data;
            try { data = JSON.parse(content); } catch { throw new Error('invalid JSON'); }
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the file must hold a JSON object');
            if (data.id !== undefined && data.id !== entry.id) throw new Error(`id "${data.id}" does not match the file name`);
            entry.graph = normalizeWorkflow({ ...data, tasks: this.resolveTasks(data.tasks, root) }, { id: entry.id });
        } catch (error) {
            entry.error = error.message;
        }
        return entry;
    }
    resolveTasks(tasks, root) {
        if (!Array.isArray(tasks)) return tasks;
        return tasks.map(task => !task || !Array.isArray(task.skillsets) ? task : { ...task, skillsets: task.skillsets.map(id =>
            typeof id !== 'string' || id.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(id) ? id : path.join(root, id)) });
    }
    relativeSkillset(id, root) {
        if (!path.isAbsolute(id)) return id;
        const relative = path.relative(root, id);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? toPosix(relative) : id;
    }
    serialize(graph, root) {
        const derived = workflowDefaultObjective({ ...graph, defaultObjective: '' });
        const definition = { schemaVersion: graph.schemaVersion, name: graph.name, description: graph.description, entryTaskId: graph.entryTaskId,
            tasks: graph.tasks.map(task => ({ ...task, skillsets: task.skillsets.map(id => this.relativeSkillset(id, root)) })),
            edges: graph.edges, layout: graph.layout,
            ...(graph.defaultObjective && graph.defaultObjective !== derived ? { defaultObjective: graph.defaultObjective } : {}) };
        return `${JSON.stringify(definition, null, 2)}\n`;
    }
    // A location is a workspace folder: a repository, a folder inside one, or a flows
    // folder at either level; the file goes into its flows folder, which scanning reads.
    async flowsDirectory(location) {
        if (typeof location !== 'string' || !location) throw fail('Choose a repository folder for the workflow file');
        let parts = location.split('/');
        if (parts.at(-1) === FLOWS_FOLDER) parts = parts.slice(0, -1);
        if (parts.length < 1 || parts.length > 2) throw fail('Choose a repository folder or a folder directly inside one');
        const parent = await this.folders.directory(parts.join('/'));
        const directory = path.join(parent, FLOWS_FOLDER);
        try { await fs.mkdir(directory); }
        catch (error) {
            if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw fail('The flows folder cannot be created here', 403);
            if (error.code !== 'EEXIST') throw error;
        }
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('flows must be an ordinary folder');
        return directory;
    }
    async create(location, graph) {
        const root = await fs.realpath(this.workspaceRoot);
        const file = path.join(await this.flowsDirectory(location), `${graph.id}.json`);
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, this.serialize(graph, root), { flag: 'wx' });
        try { await fs.link(temporary, file); }
        catch (error) {
            if (error.code === 'EEXIST') throw fail('A workflow file with this id already exists in that folder', 409);
            throw error;
        } finally { await fs.rm(temporary, { force: true }); }
        return this.readSync(file, root);
    }
    async write(entry, graph) {
        const root = await fs.realpath(this.workspaceRoot);
        const temporary = `${entry.file}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, this.serialize(graph, root), { flag: 'wx' });
        try { await fs.rename(temporary, entry.file); }
        catch (error) { await fs.rm(temporary, { force: true }); throw error; }
        return this.readSync(entry.file, root);
    }
    async remove(entry) {
        try { await fs.unlink(entry.file); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
}
