import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertSafeAchillesPrivatePath, ensureSafeAchillesPrivateDirectory } from '../copilot/src/lib/privateDataRoot.mjs';

// This registry contains project locations only. History and execution records
// have one owner: the project's .achilles-cli directory.
function registry({ dataDir }, create = false) {
    const directory = path.join(dataDir, 'projects');
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe project registry');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return directory;
}

export function projectOptions({ workspaceRoot }) {
    return { env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot } };
}

export function registerProject(options, cwd) {
    cwd = fs.realpathSync(cwd);
    ensureSafeAchillesPrivateDirectory(cwd, 'tasks', projectOptions(options));
    const directory = registry(options, true);
    const id = crypto.createHash('sha256').update(cwd).digest('hex');
    const file = path.join(directory, `${id}.json`);
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, JSON.stringify({ cwd }), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return cwd;
}

export function projectDirectories(options) {
    const directory = registry(options);
    let files;
    try { files = fs.readdirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let cwd;
        try { ({ cwd } = JSON.parse(fs.readFileSync(fd, 'utf8'))); }
        finally { fs.closeSync(fd); }
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Invalid registered project');
        try {
            assertSafeAchillesPrivatePath(cwd, 'sessions', projectOptions(options));
            return [cwd];
        } catch (error) {
            if (error.code === 'ENOENT' || error.message === 'Selected AchillesCLI directory does not exist.') return [];
            throw error;
        }
    });
}

const TASK_ID = /^[a-f0-9-]{36}$/;

export function executionDirectory(options, cwd, taskId) {
    if (!TASK_ID.test(taskId)) throw new Error('Invalid logical task id');
    return ensureSafeAchillesPrivateDirectory(cwd, `tasks/${taskId}/executions`, projectOptions(options));
}

function atomicWrite(file, text) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
}

export function saveTaskExecution(options, task) {
    const cwd = task.request.cwd;
    const id = task.alaSessionId || task.taskId;
    if (!TASK_ID.test(task.taskId)) throw new Error('Invalid execution id');
    executionDirectory(options, cwd, id);
    const record = { taskId: task.taskId, robotId: task.robotId, type: task.type,
        state: task.state, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt,
        logTail: task.logTail, result: task.result, error: task.error, request: task.request,
        alaSessionId: task.alaSessionId, skillExecution: task.skillExecution, legacySkillSelection: task.legacySkillSelection };
    const metadata = assertSafeAchillesPrivatePath(cwd, `tasks/${id}/task.json`, { ...projectOptions(options), type: 'file' });
    if (!fs.existsSync(metadata)) {
        atomicWrite(metadata, JSON.stringify({ version: 1, id, robotId: task.robotId, type: task.type,
            createdAt: task.createdAt, request: task.request, alaSessionId: task.alaSessionId }));
    } else {
        const existing = JSON.parse(fs.readFileSync(metadata, 'utf8'));
        if (existing.id !== id || existing.robotId !== task.robotId) throw new Error('Task definition identity mismatch');
    }
    const file = assertSafeAchillesPrivatePath(cwd, `tasks/${id}/executions/${task.taskId}.json`,
        { ...projectOptions(options), type: 'file' });
    atomicWrite(file, JSON.stringify(record));
    ensureSafeAchillesPrivateDirectory(cwd, `tasks/${id}/logs`, projectOptions(options));
    const log = assertSafeAchillesPrivatePath(cwd, `tasks/${id}/logs/${task.taskId}.log`,
        { ...projectOptions(options), type: 'file' });
    atomicWrite(log, task.logTail || '');
}

export function findProjectRecord(options, kind, id) {
    if (!TASK_ID.test(id)) throw new Error('Invalid project record id');
    if (!['session', 'task'].includes(kind)) throw new Error('Invalid project record kind');
    const matches = projectDirectories(options).flatMap(cwd => {
        let children = [`sessions/${id}.json`];
        if (kind === 'task') {
            const root = assertSafeAchillesPrivatePath(cwd, 'tasks', { ...projectOptions(options), type: 'directory' });
            const tasks = fs.existsSync(root) ? fs.readdirSync(root).filter(name => TASK_ID.test(name)) : [];
            children = tasks.map(taskId => `tasks/${taskId}/executions/${id}.json`);
        }
        const found = children.map(child => assertSafeAchillesPrivatePath(cwd, child,
            { ...projectOptions(options), type: 'file' })).filter(file => fs.existsSync(file));
        return found;
    });
    if (matches.length > 1) throw new Error('Project record exists in multiple folders; resolve the duplicate before continuing');
    return matches[0] || null;
}
