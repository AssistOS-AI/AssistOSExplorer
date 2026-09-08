import fs from 'node:fs';
import path from 'node:path';

const DATA_DIRECTORY_NAME = '.data';
const ACHILLES_PRIVATE_DIRECTORY_NAME = 'achilles-cli';

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realDirectory(directory, label) {
    const resolved = path.resolve(directory);
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        const error = new Error(`${label} must be a real directory.`);
        error.code = 'ACHILLES_PRIVATE_PATH_UNSAFE';
        throw error;
    }
    return fs.realpathSync(resolved);
}

function unsafePrivatePath(label) {
    const error = new Error(`${label} must not be a symbolic link and must remain inside AchillesCLI private storage.`);
    error.code = 'ACHILLES_PRIVATE_PATH_UNSAFE';
    return error;
}

export function resolveAchillesWorkspaceRoot(workingDir = process.cwd(), env = process.env) {
    const selectedPath = path.resolve(workingDir);
    const selectedWorkspace = realDirectory(selectedPath, 'Selected AchillesCLI workspace') ?? selectedPath;
    const configuredRoot = String(env?.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (!configuredRoot) return selectedWorkspace;
    if (!path.isAbsolute(configuredRoot)) {
        throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute directory.');
    }
    const workspaceRoot = fs.realpathSync(configuredRoot);
    if (!isInside(workspaceRoot, selectedWorkspace)) {
        throw new Error('The selected AchillesCLI directory is outside PLOINKY_WORKSPACE_ROOT.');
    }
    return workspaceRoot;
}

export function resolveAchillesPrivateDataRoot(workingDir = process.cwd(), options = {}) {
    const robotRoot = (options.env ?? process.env).ROBOTEAM_COPILOT_ROOT;
    if (robotRoot) {
        if (!path.isAbsolute(robotRoot)) throw new Error('Robot copilot root must be absolute.');
        const expected = realDirectory(robotRoot, 'Robot copilot root');
        if (!expected || expected !== path.resolve(robotRoot)) throw unsafePrivatePath('Robot copilot root');
        if (options.privateDataRoot && path.resolve(options.privateDataRoot) !== expected) throw unsafePrivatePath('Robot copilot root');
        resolveAchillesWorkspaceRoot(workingDir, options.env ?? process.env);
        return expected;
    }
    const workspaceRoot = resolveAchillesWorkspaceRoot(workingDir, options.env ?? process.env);
    const expectedRoot = path.join(workspaceRoot, DATA_DIRECTORY_NAME, ACHILLES_PRIVATE_DIRECTORY_NAME);
    const privateDataRoot = options.privateDataRoot
        ? path.resolve(options.privateDataRoot)
        : expectedRoot;
    if (privateDataRoot !== expectedRoot) {
        throw new Error(`AchillesCLI private data root must be ${expectedRoot}.`);
    }
    const dataRoot = path.dirname(privateDataRoot);
    const realDataRoot = realDirectory(dataRoot, 'Workspace .data root');
    if (realDataRoot && !isInside(workspaceRoot, realDataRoot)) {
        throw new Error('Workspace .data root escapes the selected workspace.');
    }
    const realPrivateRoot = realDirectory(privateDataRoot, 'AchillesCLI private data root');
    if (realPrivateRoot && !isInside(realDataRoot ?? dataRoot, realPrivateRoot)) {
        throw new Error('AchillesCLI private data root escapes the workspace .data root.');
    }
    return privateDataRoot;
}

export function ensureAchillesPrivateDataRoot(workingDir = process.cwd(), options = {}) {
    const privateDataRoot = resolveAchillesPrivateDataRoot(workingDir, options);
    const dataRoot = path.dirname(privateDataRoot);
    for (const directory of [dataRoot, privateDataRoot]) {
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
    }
    return resolveAchillesPrivateDataRoot(workingDir, {
        ...options,
        privateDataRoot,
    });
}

export function resolveAchillesPrivatePath(workingDir, childPath, options = {}) {
    const privateDataRoot = resolveAchillesPrivateDataRoot(workingDir, options);
    const candidate = path.resolve(privateDataRoot, childPath);
    if (!isInside(privateDataRoot, candidate)) {
        throw new Error('AchillesCLI private path escapes its data root.');
    }
    return candidate;
}

export function assertSafeAchillesPrivatePath(workingDir, childPath, options = {}) {
    const privateDataRoot = resolveAchillesPrivateDataRoot(workingDir, options);
    const candidate = resolveAchillesPrivatePath(workingDir, childPath, options);
    const relative = path.relative(privateDataRoot, candidate);
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = privateDataRoot;
    for (let index = 0; index < segments.length; index += 1) {
        cursor = path.join(cursor, segments[index]);
        let stat;
        try {
            stat = fs.lstatSync(cursor);
        } catch (error) {
            if (error?.code === 'ENOENT') return candidate;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw unsafePrivatePath(options.label || 'AchillesCLI private path');
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
            throw unsafePrivatePath(options.label || 'AchillesCLI private path');
        }
        if (index === segments.length - 1 && options.type === 'directory' && !stat.isDirectory()) {
            throw unsafePrivatePath(options.label || 'AchillesCLI private directory');
        }
        if (index === segments.length - 1 && options.type === 'file' && !stat.isFile()) {
            throw unsafePrivatePath(options.label || 'AchillesCLI private file');
        }
    }
    return candidate;
}

export function ensureSafeAchillesPrivateDirectory(workingDir, childPath, options = {}) {
    const privateDataRoot = ensureAchillesPrivateDataRoot(workingDir, options);
    const candidate = assertSafeAchillesPrivatePath(workingDir, childPath, {
        ...options,
        type: 'directory',
    });
    if (!fs.existsSync(candidate)) {
        fs.mkdirSync(candidate, { recursive: true, mode: options.mode ?? 0o700 });
    }
    assertSafeAchillesPrivatePath(workingDir, childPath, {
        ...options,
        type: 'directory',
    });
    return candidate;
}

export const __testables = {
    isInside,
};
