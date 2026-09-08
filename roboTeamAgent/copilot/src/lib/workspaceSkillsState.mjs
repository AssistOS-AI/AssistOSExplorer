import path from 'node:path';

import { getDisabledSkills, setDisabledSkills } from './achillesSettings.mjs';
import { withWorkspaceMutation } from './workspaceStateLock.mjs';

function isInside(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toRelativePath(candidate, workingDir) {
    return path.relative(path.resolve(workingDir), path.resolve(candidate)).split(path.sep).join('/');
}

export function getWorkspaceSkillRecords(catalog, workingDir) {
    const root = path.resolve(workingDir);
    return catalog.getSkills()
        .filter((skill) => skill?.skillDir)
        .sort((left, right) => {
            const pathOrder = toRelativePath(left.skillDir, root).localeCompare(toRelativePath(right.skillDir, root));
            return pathOrder || left.name.localeCompare(right.name);
        });
}

export function createWorkspaceSkillsSnapshot(catalog, workingDir) {
    return getWorkspaceSkillRecords(catalog, workingDir).map((skill) => ({
        name: skill.name,
        displayName: skill.shortName || path.basename(skill.skillDir),
        relativePath: toRelativePath(skill.skillDir, workingDir),
        type: skill.type,
        enabled: skill.enabled !== false,
    }));
}

export async function applyPersistedWorkspaceSkillState(catalog, workingDir) {
    await catalog.refresh();
    return createWorkspaceSkillsSnapshot(catalog, workingDir);
}

export async function setWorkspaceSkillEnabled(catalog, workingDir, identifier, enabled) {
    const record = catalog.getSkill(String(identifier || '').trim());
    const workspaceNames = new Set(getWorkspaceSkillRecords(catalog, workingDir).map((skill) => skill.name));
    if (!record || !workspaceNames.has(record.name)) {
        throw new Error(`Workspace skill "${identifier}" not found.`);
    }
    return setWorkspaceSkillNamesEnabled(catalog, workingDir, [record.name], enabled);
}

export async function setWorkspaceDirectoryEnabled(catalog, workingDir, relativeDirectory, enabled) {
    const raw = String(relativeDirectory || '').trim();
    if (!raw || raw.includes('\0') || path.isAbsolute(raw)) {
        throw new Error('A relative workspace directory is required.');
    }
    const root = path.resolve(workingDir);
    const directory = path.resolve(root, raw);
    if (!isInside(directory, root)) {
        throw new Error('Skill directory must stay inside the working directory.');
    }
    const names = getWorkspaceSkillRecords(catalog, root)
        .filter((skill) => isInside(skill.skillDir, directory))
        .map((skill) => skill.name);
    if (!names.length) {
        throw new Error(`No registered skills found under "${raw}".`);
    }
    return setWorkspaceSkillNamesEnabled(catalog, root, names, enabled);
}

async function setWorkspaceSkillNamesEnabled(catalog, workingDir, names, enabled) {
    await withWorkspaceMutation(workingDir, async () => {
        const next = new Set(getDisabledSkills(workingDir));
        for (const name of names) {
            if (enabled) next.delete(name);
            else next.add(name);
        }
        await setDisabledSkills(workingDir, [...next].sort());
    });
    await catalog.refresh();
    return createWorkspaceSkillsSnapshot(catalog, workingDir);
}

export function createWebchatSkillsEnvelope(skills, { event = 'list', operation = null, error = '' } = {}) {
    return {
        __webchatSkills: 1,
        version: 1,
        event,
        skills,
        ...(operation ? { operation } : {}),
        ...(error ? { error: String(error) } : {}),
    };
}

export function emitWebchatSkillsEnvelope(envelope, { write } = {}) {
    const output = typeof write === 'function' ? write : (value) => process.stdout.write(value);
    output(`${JSON.stringify(envelope)}\n`);
    return envelope;
}

export function formatWorkspaceSkills(skills) {
    if (!skills.length) return 'No registered workspace skills.';
    return skills.map((skill) => {
        const marker = skill.enabled ? 'enabled' : 'disabled';
        return `${skill.relativePath} (${skill.type}) [${marker}]`;
    }).join('\n');
}
