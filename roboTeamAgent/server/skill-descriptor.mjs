import fs from 'node:fs/promises';
import path from 'node:path';

// RoboTeam owns Anthropic SKILL.md discovery. ALA no longer manages task skills,
// so the descriptor parser lives with the repository and marketplace catalog.
const ignoredDirectories = new Set(['.git', 'node_modules']);
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function scalarValue(value) {
    const trimmed = String(value || '').trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function frontmatterFields(source) {
    const match = String(source).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
    if (!match) return null;
    const lines = match[1].split(/\r?\n/u);
    const fields = new Map();
    for (let index = 0; index < lines.length; index += 1) {
        const field = lines[index].match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
        if (!field) continue;
        let value = field[2] || '';
        if (value === '>' || value === '|') {
            const continuation = [];
            while (index + 1 < lines.length && /^\s+/u.test(lines[index + 1])) {
                continuation.push(lines[index + 1].trim());
                index += 1;
            }
            value = continuation.join(value === '>' ? ' ' : '\n');
        }
        fields.set(field[1].toLowerCase(), scalarValue(value));
    }
    return fields;
}

async function skillRecord(filePath, repositoryPath, { validate = true } = {}) {
    const fields = frontmatterFields(await fs.readFile(filePath, 'utf8'));
    const declaredName = fields?.get('name') || '';
    const description = fields?.get('description') || '';
    if (validate && (!skillNamePattern.test(declaredName) || !description)) {
        throw new Error(`Anthropic skill descriptor must define a lowercase hyphenated name and description: ${filePath}`);
    }
    const name = declaredName || path.basename(path.dirname(filePath));
    return {
        name,
        shortName: name,
        description,
        filePath,
        directoryPath: path.dirname(filePath),
        repositoryPath
    };
}

// Decision M-60: the repository path is a skill source that can reach a worker admission field, so it is never resolved. The
// caller has validated it below the workspace root without following links; here the repository itself must not be a link and
// the records keep the declared path. Discovery follows no link below it (a Dirent of a link is neither a file nor a directory).
async function declaredRepository(repositoryPath) {
    const root = path.resolve(repositoryPath);
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error(`Skill repository must not be a symbolic link: ${root}`);
    return root;
}

export async function discoverAnthropicSkills(repositoryPath, options = {}) {
    const root = await declaredRepository(repositoryPath);
    const queue = [root];
    const records = [];
    while (queue.length > 0) {
        const current = queue.shift();
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isFile() && entry.name === 'SKILL.md') records.push(await skillRecord(entryPath, root, options));
            else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) queue.push(entryPath);
        }
    }
    return records;
}

export async function validateTaskRepository(repositoryPath) {
    const declaredPath = await declaredRepository(repositoryPath);
    const skills = await discoverAnthropicSkills(declaredPath);
    if (skills.length === 0) {
        throw new Error(`Task repository contains no Anthropic SKILL.md descriptors: ${declaredPath}`);
    }
    return { repositoryPath: declaredPath, skills, descriptorCount: skills.length };
}

export async function discoverTaskSkills(repositoryPaths) {
    const records = [];
    for (const repositoryPath of repositoryPaths) {
        const validation = await validateTaskRepository(repositoryPath);
        records.push(...validation.skills);
    }
    const names = new Map();
    for (const record of records) {
        if (names.has(record.name)) {
            throw new Error(`Duplicate skill name "${record.name}" in ${names.get(record.name)} and ${record.repositoryPath}.`);
        }
        names.set(record.name, record.repositoryPath);
    }
    if (names.has('coding-agent')) {
        throw new Error('Skill name is reserved by ALA: coding-agent');
    }
    return records;
}
