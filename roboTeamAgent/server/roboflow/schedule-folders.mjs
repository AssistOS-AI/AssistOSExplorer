import fs from 'node:fs/promises';
import path from 'node:path';
import { invalid } from './graph.mjs';

const DEFAULT_FOLDER = 'cron-jobs-results';
const fail = (message, statusCode = 400) => Object.assign(invalid(message), { statusCode });
function segments(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value) || path.isAbsolute(value)) throw fail('Choose a folder inside the workspace');
    if (!value) return [];
    const parts = value.split('/');
    if (parts.some(part => !part || part.startsWith('.'))) throw fail('Hidden folders and relative traversal are not available');
    return parts;
}

// The browser sends workspace-relative navigation keys, never arbitrary host paths.
export class ScheduleFolders {
    constructor(workspaceRoot) { this.workspaceRoot = workspaceRoot; }
    async root() { return fs.realpath(this.workspaceRoot); }
    async directory(key = '') {
        const parts = segments(key), root = await this.root();
        let directory = root;
        for (const part of parts) {
            directory = path.join(directory, part);
            let stat;
            try { stat = await fs.lstat(directory); }
            catch (error) { if (error.code === 'ENOENT') throw fail('Folder not found', 404); throw error; }
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Choose an ordinary workspace folder');
        }
        const canonical = await fs.realpath(directory);
        if (canonical !== root && !canonical.startsWith(root + path.sep)) throw fail('Folder is outside the workspace', 403);
        return canonical;
    }
    async list(key = '') {
        const folder = await this.directory(key), root = await this.root();
        const folders = (await fs.readdir(folder, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => ({ name: entry.name, path: key ? `${key}/${entry.name}` : entry.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return { path: key, folder, folders, defaultPath: DEFAULT_FOLDER, defaultFolder: path.join(root, DEFAULT_FOLDER) };
    }
    async create({ parent = '', name } = {}) {
        if (typeof name !== 'string' || name !== name.trim() || name.length > 255 || segments(name).length !== 1) throw fail('Enter one folder name without slashes');
        const directory = await this.directory(parent), key = parent ? `${parent}/${name}` : name;
        try { await fs.mkdir(path.join(directory, name)); }
        catch (error) {
            if (error.code === 'EEXIST') throw fail('A folder or file with that name already exists', 409);
            if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw fail('This folder cannot be created here', 403);
            throw error;
        }
        return this.list(key);
    }
    async defaultFolder() {
        const root = await this.directory('');
        try { await fs.mkdir(path.join(root, DEFAULT_FOLDER)); }
        catch (error) {
            if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw fail('The default results folder cannot be created in this workspace', 403);
            if (error.code !== 'EEXIST') throw error;
        }
        return this.directory(DEFAULT_FOLDER);
    }
    label(folder, root) {
        const relative = path.relative(root, folder).split(path.sep).join('/');
        return !relative ? 'Workspace' : !relative.startsWith('../') && !path.isAbsolute(relative) ? `Workspace / ${relative}` : 'Previously selected folder';
    }
}
