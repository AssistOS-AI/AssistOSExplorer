import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { availableSkillsets, copilotSkillsRoot } from './copilot-skillset.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[a-f0-9-]{36}$/;
const exec = promisify(execFile);
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function selectionNames(value, qualified = false) {
    if (value === undefined || value === null) return [];
    const values = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(values) || values.length > 100) throw invalid('skills must be a string or an array of at most 100 names');
    return [...new Set(values.map((item) => {
        if (typeof item !== 'string') throw invalid('invalid skill name');
        const name = item.trim();
        const parts = name.split('/');
        if (parts.length !== (qualified ? 2 : 1) || parts.some((part) => !NAME.test(part) || part.length > 100)) {
            throw invalid(qualified ? 'skills must use skillset/skill names' : 'invalid skillset name');
        }
        return name;
    }))];
}

// Copy only regular files and directories. Never follow a repository's symbolic links.
async function copyTree(source, target, budget = { bytes: 0, files: 0 }, depth = 0) {
    if (depth > 32) throw invalid('skillset directory nesting is too deep');
    const entry = await fs.lstat(source);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw invalid('skillsets cannot contain symbolic links or special files');
    if (entry.isDirectory()) {
        await fs.mkdir(target, { mode: 0o700 });
        for (const name of (await fs.readdir(source)).sort()) {
            if (name === '.git' || name === 'node_modules') continue;
            await copyTree(path.join(source, name), path.join(target, name), budget, depth + 1);
        }
    } else {
        budget.bytes += entry.size;
        budget.files += 1;
        if (budget.bytes > 64 * 1024 * 1024 || budget.files > 5000) throw invalid('skillset exceeds 64 MiB or 5000 files');
        const input = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = await input.stat();
            if (!stat.isFile() || stat.size !== entry.size) throw invalid('skillset changed during import');
            await fs.writeFile(target, await input.readFile(), { flag: 'wx', mode: entry.mode & 0o111 ? 0o500 : 0o400 });
        } finally { await input.close(); }
    }
}

async function treeDigest(root) {
    const hash = crypto.createHash('sha256');
    async function visit(directory) {
        for (const name of (await fs.readdir(directory)).sort()) {
            const file = path.join(directory, name);
            const stat = await fs.lstat(file);
            if (stat.isSymbolicLink()) throw invalid('skill catalog contains a symbolic link');
            hash.update(JSON.stringify([path.relative(root, file), stat.isDirectory() ? 'dir' : 'file', stat.mode & 0o111]));
            if (stat.isDirectory()) await visit(file);
            else if (stat.isFile()) hash.update(await fs.readFile(file));
            else throw invalid('skill catalog contains a special file');
        }
    }
    await visit(root);
    return hash.digest('hex');
}

export class RobotSkillsets {
    constructor({ robotStore, workspaceRoot = '/workspace', alaCommand = '/workspace/AdvancedLanguageAgent/bin/ala.mjs', discoverSkills, execImpl = exec }) {
        Object.assign(this, { robotStore, workspaceRoot, alaCommand, discoverSkills, execImpl });
    }

    async discover(directory) {
        if (!this.discoverSkills) {
            const entry = await fs.realpath(this.alaCommand);
            this.discoverSkills = (await import(pathToFileURL(path.resolve(path.dirname(entry), '../src/repositories.mjs')).href)).discoverTaskSkills;
        }
        try { return await this.discoverSkills([directory]); }
        catch { throw invalid('skillset must contain valid, uniquely named Anthropic SKILL.md descriptors'); }
    }

    async add(robotId, input) {
        const [name] = selectionNames([input.name]);
        if (name === 'copilot') throw invalid('copilot is a bundled read-only skillset');
        const description = String(input.description || '').trim();
        const source = String(input.source || '').trim();
        if (!source || source.length > 2048 || description.length > 1000) throw invalid('invalid skillset source or description');
        const stagingRoot = path.join(this.robotStore.dataDir, 'skillset-imports');
        await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const stage = await fs.mkdtemp(path.join(stagingRoot, 'import-'));
        let revision = null;
        try {
            let local;
            if (source.startsWith('https://')) {
                const url = new URL(source);
                if (url.username || url.password || url.hash || url.search) throw invalid('use a credential-free HTTPS Git URL');
                local = path.join(stage, 'clone');
                const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
                delete env.NODE_OPTIONS;
                try {
                    await this.execImpl('git', ['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null', 'clone', '--depth=1', '--', source, local], { env, timeout: 120000, maxBuffer: 1024 * 1024 });
                    revision = (await this.execImpl('git', ['-C', local, 'rev-parse', 'HEAD'], { env, timeout: 10000 })).stdout.trim();
                } catch { throw invalid('could not clone skillset repository'); }
            } else {
                if (!path.isAbsolute(source)) throw invalid('source must be an HTTPS Git URL or an absolute workspace directory');
                local = await fs.realpath(source);
                const workspace = await fs.realpath(this.workspaceRoot);
                if (!local.startsWith(`${workspace}${path.sep}`)) throw invalid('skillset source must be inside the workspace');
                const dataRoot = await fs.realpath(this.robotStore.dataDir);
                if (local === dataRoot || local.startsWith(`${dataRoot}${path.sep}`) || dataRoot.startsWith(`${local}${path.sep}`)) {
                    throw invalid('skillset source cannot contain robot private data');
                }
            }
            const imported = path.join(stage, 'source');
            await copyTree(local, imported);
            const records = await this.discover(imported);
            if (!records.length || records.length > 100) throw invalid('skillset must contain 1 to 100 skills');
            const skills = records.map((skill) => ({ name: skill.name, description: skill.description,
                directory: path.relative(imported, skill.directoryPath) }));
            const digest = await treeDigest(imported);
            return await this.robotStore.withRobot(robotId, async (robot, save) => {
                const available = robot.skillsets || [];
                if (available.some((set) => set.name === name)) throw invalid('skillset name already exists');
                if (available.length >= 32) throw invalid('robot allows at most 32 skillsets');
                const generation = crypto.randomUUID();
                const parent = path.join(this.robotStore.robotPath(robotId), 'skillsets');
                await fs.mkdir(parent, { recursive: true, mode: 0o700 });
                await fs.rename(imported, path.join(parent, generation));
                const record = { name, description, source, revision, digest, generation, skills };
                await save({ ...robot, skillsets: [...available, record] });
                return record;
            });
        } finally { await fs.rm(stage, { recursive: true, force: true }); }
    }

    async remove(robotId, name) {
        if (name === 'copilot') throw invalid('copilot is a bundled read-only skillset');
        selectionNames([name]);
        return this.robotStore.withRobot(robotId, async (robot, save) => {
            const record = (robot.skillsets || []).find((set) => set.name === name);
            if (!record) throw invalid('skillset not found');
            await save({ ...robot, skillsets: robot.skillsets.filter((set) => set.name !== name) });
            // Task catalogs are independent copies. Remove only this exact imported generation.
            if (UUID.test(record.generation)) await fs.rm(path.join(this.robotStore.robotPath(robotId), 'skillsets', record.generation), { recursive: true, force: true });
        });
    }

    async start(robot, input, enqueue) {
        const sets = [...new Set([...selectionNames(input.skillSets), ...selectionNames(input.skillset)])];
        const names = selectionNames(input.skills, true);
        if (robot.name === 'default' && input.skillSets === undefined && input.skillset === undefined && input.skills === undefined) sets.push('copilot');
        return this.robotStore.withRobot(robot.id, async (current) => {
            const selected = new Map();
            const available = availableSkillsets(current);
            const add = (set, skill) => {
                const key = `${set.name}/${skill.name}`;
                if ([...selected.values()].some((entry) => entry.skill.name === skill.name && entry.key !== key)) {
                    throw invalid(`selected skills have duplicate native name: ${skill.name}`);
                }
                selected.set(key, { key, set, skill });
            };
            for (const name of sets) {
                const set = available.find((entry) => entry.name === name);
                if (!set) throw invalid(`skillset is not available for this robot: ${name}`);
                for (const skill of set.skills) add(set, skill);
            }
            for (const name of names) {
                const [setName, skillName] = name.split('/');
                const set = available.find((entry) => entry.name === setName);
                const skill = set?.skills.find((entry) => entry.name === skillName);
                if (!skill) throw invalid(`skill is not available for this robot: ${name}`);
                add(set, skill);
            }
            const parent = path.join(this.robotStore.robotPath(robot.id), 'runtime', 'skill-catalogs');
            await fs.mkdir(parent, { recursive: true, mode: 0o700 });
            const catalogId = crypto.randomUUID();
            const directory = path.join(parent, catalogId);
            await fs.mkdir(directory, { mode: 0o700 });
            try {
                const budget = { bytes: 0, files: 0 };
                for (const { set, skill } of selected.values()) {
                    if ((!set.builtin && !UUID.test(set.generation)) || !NAME.test(skill.name)) throw invalid('invalid stored skillset');
                    const root = set.builtin ? copilotSkillsRoot : path.join(this.robotStore.robotPath(robot.id), 'skillsets', set.generation);
                    const source = path.resolve(root, skill.directory);
                    if (source !== root && !source.startsWith(`${root}${path.sep}`)) throw invalid('invalid stored skill path');
                    await copyTree(source, path.join(directory, skill.name), budget);
                }
                if (selected.size) {
                    const records = await this.discover(directory);
                    if (records.length !== selected.size) throw invalid('selected skill folders contain nested skill descriptors');
                }
                const selection = { catalogId, digest: await treeDigest(directory), skillSets: sets, skills: names,
                    resolvedSkills: [...selected.keys()], revisions: Object.fromEntries([...selected.values()].map(({ set }) => [set.name, set.revision || set.digest])) };
                return await enqueue(current, selection);
            } catch (error) {
                await fs.rm(directory, { recursive: true, force: true });
                throw error;
            }
        });
    }

    async catalogPath(robotId, selection) {
        if (!selection || !UUID.test(selection.catalogId)) throw invalid('task has no saved skill catalog');
        const directory = path.join(this.robotStore.robotPath(robotId), 'runtime', 'skill-catalogs', selection.catalogId);
        if (await treeDigest(directory) !== selection.digest) throw invalid('saved task skill catalog changed');
        return directory;
    }
}

export function publicSkillsets(robot) {
    return availableSkillsets(robot).map(({ name, description, source, revision, digest, builtin, skills }) => ({
        builtin: Boolean(builtin),
        name, description, source, revision: revision || digest,
        skills: skills.map((skill) => ({ name: skill.name, id: `${name}/${skill.name}`, description: skill.description })),
    }));
}
