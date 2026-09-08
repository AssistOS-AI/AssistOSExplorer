import fs from 'node:fs';
import path from 'node:path';

import { getDisabledSkills } from './achillesSettings.mjs';
import {
    assertSafeAchillesPrivatePath,
    resolveAchillesPrivateDataRoot,
    resolveAchillesWorkspaceRoot,
} from './privateDataRoot.mjs';

function isInside(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertRealPath(candidate, root, type) {
    if (!isInside(candidate, root)) throw new Error(`Skill path escapes its approved root: ${candidate}`);
    let cursor = root;
    const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
    for (const segment of ['', ...segments]) {
        if (segment) cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        const last = cursor === candidate;
        if (stat.isSymbolicLink() || (last && type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
            throw new Error(`Skill path must be a real ${last ? type : 'directory'} without symbolic links: ${cursor}`);
        }
    }
    const canonical = fs.realpathSync(candidate);
    if (!isInside(canonical, fs.realpathSync(root))) throw new Error(`Skill path escapes its approved root: ${candidate}`);
    return canonical;
}

/** The caller supplies ALA's discoverTaskSkills from its resolved installation. */
export async function createAnthropicSkillCatalog({ workingDir, roots, discoverTaskSkills } = {}) {
    if (typeof discoverTaskSkills !== 'function') {
        throw new TypeError('ALA discoverTaskSkills is required; resolve the ALA installation before creating the catalog.');
    }
    if (!Array.isArray(roots)) throw new TypeError('Ordered skill roots must be an array.');
    const workspaceRoot = resolveAchillesWorkspaceRoot(workingDir);
    const selectedWorkingDir = fs.realpathSync(workingDir || process.cwd());
    const privateRoot = resolveAchillesPrivateDataRoot(selectedWorkingDir);
    let configuredRoots = roots.map((value) => {
        const root = typeof value === 'string' ? { path: value } : value;
        if (!root || typeof root.path !== 'string' || !root.path.trim() || root.path.includes('\0')) {
            throw new TypeError('Each skill root requires a nonempty directory path.');
        }
        return { path: path.resolve(selectedWorkingDir, root.path), builtIn: root.builtIn === true };
    });
    let records = new Map();

    function safeRoot(rootPath) {
        if (isInside(rootPath, privateRoot)) {
            assertSafeAchillesPrivatePath(selectedWorkingDir, path.relative(privateRoot, rootPath), {
                label: 'Skill repository', type: 'directory',
            });
        }
        return assertRealPath(rootPath, isInside(rootPath, workspaceRoot) ? workspaceRoot : rootPath, 'directory');
    }

    function safeRecord(record) {
        const rootPath = safeRoot(record.rootPath);
        if (rootPath !== record.rootPath) throw new Error(`Skill root changed since discovery: ${record.rootPath}`);
        assertRealPath(record.skillDir, rootPath, 'directory');
        assertRealPath(record.filePath, record.skillDir, 'file');
    }

    function getSkills() {
        return [...records.values()];
    }

    function getSkill(name) {
        return records.get(String(name || '').trim()) || null;
    }

    function requireSkill(name) {
        const record = getSkill(name);
        if (!record) throw new Error(`Skill "${name}" not found.`);
        return record;
    }

    function getEnabledSkillDirectories() {
        return Object.freeze(getSkills().filter((skill) => skill.enabled).map((skill) => skill.skillDir));
    }

    async function refresh() {
        const selected = new Map();
        const descriptorPaths = new Set();
        for (const configured of configuredRoots) {
            const rootPath = safeRoot(configured.path);
            let discovered;
            try {
                // Per-root discovery enforces ALA's descriptor, duplicate and reserved-name rules.
                discovered = await discoverTaskSkills([rootPath]);
            } catch (error) {
                throw new Error(`Cannot load skill root "${rootPath}": ${error.message}`, { cause: error });
            }
            for (const skill of discovered) {
                const skillDir = assertRealPath(path.resolve(skill.directoryPath), rootPath, 'directory');
                const filePath = assertRealPath(path.resolve(skill.filePath), skillDir, 'file');
                if (path.basename(filePath) !== 'SKILL.md' || path.dirname(filePath) !== skillDir) {
                    throw new Error(`Invalid Anthropic descriptor path: ${filePath}`);
                }
                descriptorPaths.add(filePath);
                selected.set(skill.name, { ...skill, type: 'anthropic', skillDir, filePath, rootPath, builtIn: configured.builtIn });
            }
        }
        const disabled = new Set(getDisabledSkills(selectedWorkingDir));
        const enabledDirectories = new Map([...selected.values()]
            .filter((skill) => !disabled.has(skill.name))
            .map((skill) => [skill.skillDir, skill.name]));
        for (const filePath of descriptorPaths) {
            let directory = path.dirname(path.dirname(filePath));
            while (true) {
                const owner = enabledDirectories.get(directory);
                if (owner) {
                    throw new Error(`Enabled skill "${owner}" contains nested descriptor "${filePath}". Move nested skills into sibling folders before enabling the parent skill.`);
                }
                const parent = path.dirname(directory);
                if (parent === directory) break;
                directory = parent;
            }
        }
        records = new Map([...selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([name, record]) => [name, Object.freeze({ ...record, enabled: !disabled.has(name) })]));
        return Object.freeze({ skills: Object.freeze(getSkills()), taskRepositories: getEnabledSkillDirectories() });
    }

    function resolveSelectedSkill(name) {
        const record = requireSkill(name);
        if (!record.enabled) throw new Error(`Skill "${record.name}" is disabled. Enable it before execution.`);
        safeRecord(record);
        return record;
    }

    async function readSkill(name) {
        const record = requireSkill(name);
        safeRecord(record);
        return fs.readFileSync(record.filePath, 'utf8');
    }

    async function removeSkill(name) {
        const record = requireSkill(name);
        if (record.builtIn) throw new Error(`Built-in skill "${record.name}" cannot be removed; disable it instead.`);
        safeRecord(record);
        if (isInside(selectedWorkingDir, record.skillDir) || isInside(privateRoot, record.skillDir)
            || configuredRoots.some((root) => root.path !== record.skillDir && isInside(root.path, record.skillDir))
            || getSkills().some((skill) => skill.name !== record.name && isInside(skill.skillDir, record.skillDir))) {
            throw new Error(`Cannot remove skill "${record.name}": its directory contains workspace data or another skill root.`);
        }
        fs.rmSync(record.skillDir, { recursive: true });
        configuredRoots = configuredRoots.filter((root) => root.path !== record.skillDir);
        records.delete(record.name);
        // A removed override may reveal an earlier definition. Refresh is explicit because
        // its parent repository may now be empty, which ALA reports as a repository error.
        return record;
    }

    const catalog = Object.freeze({ refresh, getSkills, getSkill, getEnabledSkillDirectories, resolveSelectedSkill, readSkill, removeSkill });
    await refresh();
    return catalog;
}
