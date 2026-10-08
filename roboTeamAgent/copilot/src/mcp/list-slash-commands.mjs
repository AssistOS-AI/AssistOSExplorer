#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildSlashCommandCatalog } from '../repl/SlashCommandHandler.mjs';
import { createAnthropicSkillCatalog } from '../lib/skills/anthropicSkillCatalog.mjs';
import { resolveAlaInstallation } from '../lib/execution/alaInstallation.mjs';
import { resolveSkillCatalogRoots } from '../lib/skills/cliSkillRoots.mjs';
import { discoverTaskSkills } from '../../../server/skill-descriptor.mjs';
import { createAlaEngine } from '../lib/execution/alaEngine.mjs';
import * as settings from '../lib/config/achillesSettings.mjs';
import { ConversationSessionStore } from '../lib/storage/conversationSessionStore.mjs';
import { buildTaskCompletions, readWorkspaceTasks } from '../lib/tasks/workspaceTasks.mjs';

const permissionCompletions = [
    { value: 'ask-for-approval', label: 'ask-for-approval', description: 'Forward the native backend approval choices' },
    { value: 'full-access', label: 'full-access', description: 'Native full access inside the ALA sandbox' },
];

async function discoverCatalog(dir, options = {}) {
    if (options.skillCatalog) return options.skillCatalog;
    const workingDir = dir || process.env.WORKSPACE_PATH || process.cwd();
    return createAnthropicSkillCatalog({ workingDir,
        roots: await resolveSkillCatalogRoots(workingDir, { skillRoots: options.skillRoots || [] }), discoverTaskSkills });
}

export async function buildAchillesSkillCatalog(dir, options = {}) {
    const catalog = await discoverCatalog(dir, options);
    return { skills: catalog.getSkills().map((skill) => ({
        key: skill.name.toLowerCase(), name: skill.name, type: 'anthropic',
        isInternal: Boolean(skill.builtIn), enabled: skill.enabled,
    })).sort((left, right) => left.name.localeCompare(right.name)) };
}

export async function buildSkillCompletions(dir, options = {}) {
    const catalog = await discoverCatalog(dir, options);
    return catalog.getSkills().filter((skill) => options.includeDisabled || skill.enabled).map((skill) => ({
        value: skill.name, label: skill.name, description: skill.description || '',
    })).sort((left, right) => left.label.localeCompare(right.label));
}

const TASK_COMPLETION_ACTIONS = ['view', 'continue', 'pause', 'model', 'login'];

export function buildSessionCompletions(dir, store = null) {
    if (!dir) return [];
    const payload = (store || new ConversationSessionStore({ workingDir: dir })).listSessions(null);
    return payload.sessions.map((session) => ({ value: session.sessionId, label: session.preview || 'New session',
        description: [session.sessionId, session.updatedAt].filter(Boolean).join(' · ') }));
}

export function buildTaskActionCompletions(dir, action, snapshot = null) {
    return dir ? buildTaskCompletions(dir, action, snapshot) : [];
}

// Request-local: reads task history once for every action that the caller did not already supply.
export function buildTaskActionCompletionMap(dir, supplied = {}) {
    const missing = TASK_COMPLETION_ACTIONS.filter((action) => !supplied?.[action]);
    const snapshot = dir && missing.length ? readWorkspaceTasks(dir) : null;
    return Object.fromEntries(TASK_COMPLETION_ACTIONS.map((action) =>
        [action, supplied?.[action] || buildTaskActionCompletions(dir, action, snapshot)]));
}

export async function toAutocompleteCatalog(options = {}) {
    const skillCatalog = await discoverCatalog(options.dir, options);
    const catalogOptions = { ...options, skillCatalog };
    const skills = await buildSkillCompletions(options.dir, catalogOptions);
    const commands = buildSlashCommandCatalog().map((command) => ({
        name: command.name, usage: command.usage, description: command.description,
        argMatchMode: command.argMatchMode, argSuggestionLimit: command.argSuggestionLimit,
        subCommands: command.name === '/model' ? options.modelSubCommands || [] : command.subCommands.map((sub) => ({
            name: sub.name, usage: sub.usage, description: sub.description,
            argCompletions: command.name === '/session' && sub.name === 'resume' ? options.sessionCompletions || []
                : command.name === '/task' ? options.taskCompletions?.[sub.name] || []
                : sub.needsSkillArg ? skills : [],
        })),
        argCompletions: command.name === '/permissions' ? permissionCompletions
            : command.needsSkillArg ? skills : [],
    }));
    return { type: 'achilles-slash-command-catalog', version: 1, commands };
}

export async function loadAutocompleteCatalog(options = {}) {
    const workingDir = options.dir || process.env.WORKSPACE_PATH || process.cwd();
    const installation = options.installation || await resolveAlaInstallation();
    const skillCatalog = await discoverCatalog(workingDir, { ...options, installation });
    const storedSessions = new ConversationSessionStore({ workingDir });
    const preview = options.freshSession && !options.sessionId
        ? { sessionId: randomUUID(), cwd: workingDir, messages: [] } : null;
    const sessionStore = preview ? { loadSession: () => preview } : storedSessions;
    const modelSubCommands = [{ name: 'default', description: 'Use the native backend default', argCompletions: [] }];
    let modelError;
    const execution = options.execution || (options.robotId ? { robotId: options.robotId } : {});
    const engine = options.engine || createAlaEngine({ workingDir, sessionStore, skillCatalog, settings, installation, execution });
    try {
        const current = options.sessionId ? storedSessions.loadSession(options.sessionId)
            : preview || await storedSessions.ensureCurrentSession();
        const { models } = await engine.listModels({ sessionId: current.sessionId, signal: options.signal });
        modelSubCommands.push(...models.map((model) => ({
            name: typeof model === 'string' ? model : model.id || model.name || model.key,
            description: model.description || '',
            argCompletions: model.efforts?.length ? [
                { value: 'default', label: 'default', description: 'Use the native default effort' },
                ...model.efforts.filter((effort) => effort !== 'default').map((effort) => ({
                    value: effort, label: effort, description: `Effort: ${effort}`,
                })),
            ] : [],
        })));
    } catch (error) {
        modelError = error.message;
    } finally {
        if (!options.engine) await engine.close();
    }
    const result = await toAutocompleteCatalog({ ...options, dir: workingDir, skillCatalog, modelSubCommands,
        sessionCompletions: options.sessionCompletions || buildSessionCompletions(workingDir, storedSessions),
        taskCompletions: { ...options.taskCompletions, ...buildTaskActionCompletionMap(workingDir, options.taskCompletions) },
    });
    return modelError ? { ...result, modelError } : result;
}

async function main() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const input = payload.input || payload.arguments || payload.params?.arguments || {};
    const robotId = typeof input.robotId === 'string' && input.robotId.trim() ? input.robotId.trim() : undefined;
    process.stdout.write(`${JSON.stringify(await loadAutocompleteCatalog({ dir: input.dir, robotId }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
