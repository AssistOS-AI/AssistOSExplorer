import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizePermissionMode, PERMISSION_MODES } from '../permissions/protocol.mjs';
import {
    assertSafeAchillesPrivatePath,
    ensureAchillesPrivateDataRoot,
} from './privateDataRoot.mjs';
import { withWorkspaceMutation } from './workspaceStateLock.mjs';

const SETTINGS_FILE_NAME = 'settings.json';

export function getAchillesSettingsPath(workingDir = process.cwd(), options = {}) {
    return assertSafeAchillesPrivatePath(workingDir, SETTINGS_FILE_NAME, {
        ...options,
        label: 'AchillesCLI settings file',
        type: 'file',
    });
}

export function readAchillesSettings(workingDir = process.cwd()) {
    const settingsPath = getAchillesSettingsPath(workingDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const { version: _legacyVersion, ...settings } = parsed;
        return settings;
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
            return {};
        }
        throw error;
    }
}

export function getSelectedModel(workingDir = process.cwd()) {
    const model = readAchillesSettings(workingDir).model;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
}

export function getPermissionMode(workingDir = process.cwd()) {
    return normalizePermissionMode(readAchillesSettings(workingDir).permissions)
        || PERMISSION_MODES.ASK;
}

export function getCurrentSessionId(workingDir = process.cwd()) {
    const sessionId = readAchillesSettings(workingDir).currentSessionId;
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

export function getDisabledSkills(workingDir = process.cwd()) {
    const disabledSkills = readAchillesSettings(workingDir).disabledSkills;
    if (!Array.isArray(disabledSkills)) return [];
    return [...new Set(disabledSkills
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim()))];
}

function writeAchillesSettings(workingDir, settings) {
    ensureAchillesPrivateDataRoot(workingDir);
    const settingsPath = getAchillesSettingsPath(workingDir);
    const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        getAchillesSettingsPath(workingDir);
        fs.renameSync(temporaryPath, settingsPath);
    } finally {
        try {
            fs.unlinkSync(temporaryPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function mutateSettings(workingDir, callback) {
    return withWorkspaceMutation(workingDir, () => {
        const settings = readAchillesSettings(workingDir);
        const result = callback(settings);
        writeAchillesSettings(workingDir, settings);
        return result;
    });
}

export async function setSelectedModel(workingDir, modelName) {
    const model = String(modelName || '').trim();
    if (!model) throw new Error('A model name is required.');
    return mutateSettings(workingDir, (settings) => {
        settings.model = model;
        return model;
    });
}

export async function clearSelectedModel(workingDir) {
    return mutateSettings(workingDir, (settings) => { delete settings.model; });
}

export async function setPermissionMode(workingDir, mode) {
    const permissions = normalizePermissionMode(mode);
    if (!permissions) throw new Error(`Use ${PERMISSION_MODES.ASK} or ${PERMISSION_MODES.FULL}.`);
    return mutateSettings(workingDir, (settings) => {
        settings.permissions = permissions;
        return permissions;
    });
}

export async function setCurrentSessionId(workingDir, sessionId) {
    const currentSessionId = String(sessionId || '').trim();
    if (!currentSessionId) throw new Error('A session id is required.');
    return mutateSettings(workingDir, (settings) => {
        settings.currentSessionId = currentSessionId;
        return currentSessionId;
    });
}

export async function setDisabledSkills(workingDir, skillNames) {
    if (!Array.isArray(skillNames)) throw new TypeError('Disabled skill names must be an array.');
    const disabledSkills = [...new Set(skillNames
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim()))].sort();
    return mutateSettings(workingDir, (settings) => {
        if (disabledSkills.length) settings.disabledSkills = disabledSkills;
        else delete settings.disabledSkills;
        return disabledSkills;
    });
}

export function getCodingAgentModels(workingDir = process.cwd()) {
    const models = readAchillesSettings(workingDir).codingAgents?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
    return Object.fromEntries(Object.entries(models)
        .filter(([, model]) => typeof model === 'string' && model.trim())
        .map(([backend, model]) => [backend, model.trim()]));
}

export async function setCodingAgentModel(workingDir, backend, modelOrNull) {
    if (!['codex', 'opencode', 'pi'].includes(backend)) {
        throw new Error('Select a supported coding backend: codex, opencode, or pi.');
    }
    if (modelOrNull !== null && (typeof modelOrNull !== 'string' || !modelOrNull.trim())) {
        throw new Error('A native model name or null is required.');
    }
    const model = modelOrNull === null ? null : modelOrNull.trim();
    return mutateSettings(workingDir, (settings) => {
        const codingAgents = settings.codingAgents && typeof settings.codingAgents === 'object'
            && !Array.isArray(settings.codingAgents) ? settings.codingAgents : {};
        const models = codingAgents.models && typeof codingAgents.models === 'object'
            && !Array.isArray(codingAgents.models) ? { ...codingAgents.models } : {};
        if (model === null) delete models[backend];
        else models[backend] = model;
        settings.codingAgents = { ...codingAgents, models };
        return model;
    });
}
