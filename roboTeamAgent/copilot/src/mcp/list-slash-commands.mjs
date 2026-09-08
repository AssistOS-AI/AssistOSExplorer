#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve, sep } from 'node:path';
import { buildSlashCommandCatalog } from '../repl/SlashCommandHandler.mjs';
import { createAnthropicSkillCatalog } from '../lib/anthropicSkillCatalog.mjs';
import { resolveAlaInstallation } from '../lib/alaInstallation.mjs';
import { resolveSkillCatalogRoots } from '../lib/cliSkillRoots.mjs';
import { createAlaEngine } from '../lib/alaEngine.mjs';
import * as settings from '../lib/achillesSettings.mjs';
import { ConversationSessionStore } from '../lib/conversationSessionStore.mjs';
import { buildTaskCompletions } from '../lib/workspaceTasks.mjs';

const permissionCompletions = [
    { value: 'ask-for-approval', label: 'ask-for-approval', description: 'Forward the native backend approval choices' },
    { value: 'full-access', label: 'full-access', description: 'Native full access inside the ALA sandbox' },
];

async function discoverCatalog(dir, options = {}) {
    if (options.skillCatalog) return options.skillCatalog;
    const workingDir = dir || process.env.WORKSPACE_PATH || process.cwd();
    const installation = options.installation || await resolveAlaInstallation();
    return createAnthropicSkillCatalog({ workingDir,
        roots: resolveSkillCatalogRoots(workingDir), discoverTaskSkills: installation.discoverTaskSkills });
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

export async function buildSkillDirectoryCompletions(dir, options = {}) {
    const root = resolve(dir || process.env.WORKSPACE_PATH || process.cwd());
    const catalog = await discoverCatalog(root, options);
    const directories = new Set();
    for (const skill of catalog.getSkills()) {
        let current = relative(root, skill.skillDir);
        while (current && current !== '..' && !current.startsWith(`..${sep}`)) {
            directories.add(current.split(sep).join('/'));
            const parent = dirname(current);
            if (!parent || parent === '.' || parent === current) break;
            current = parent;
        }
    }
    return [...directories].sort().map((directory) => ({ value: directory, label: directory,
        description: 'Toggle registered skills below this directory' }));
}

export function buildSessionCompletions(dir) {
    if (!dir) return [];
    const payload = new ConversationSessionStore({ workingDir: dir }).listSessions();
    return payload.sessions.map((session) => ({ value: session.sessionId, label: session.preview || 'New session',
        description: [session.sessionId, session.updatedAt].filter(Boolean).join(' · ') }));
}

export function buildTaskActionCompletions(dir, action) {
    return dir ? buildTaskCompletions(dir, action) : [];
}

export async function toAutocompleteCatalog(options = {}) {
    const skillCatalog = await discoverCatalog(options.dir, options);
    const catalogOptions = { ...options, skillCatalog };
    const [skills, allSkills, directories] = await Promise.all([
        buildSkillCompletions(options.dir, catalogOptions),
        buildSkillCompletions(options.dir, { ...catalogOptions, includeDisabled: true }),
        options.skillDirectoryCompletions || buildSkillDirectoryCompletions(options.dir, catalogOptions),
    ]);
    const commands = buildSlashCommandCatalog().map((command) => ({
        name: command.name, usage: command.usage, description: command.description,
        argMatchMode: command.argMatchMode, argSuggestionLimit: command.argSuggestionLimit,
        subCommands: command.subCommands.map((sub) => ({
            name: sub.name, usage: sub.usage, description: sub.description,
            argCompletions: command.name === '/session' && sub.name === 'resume' ? options.sessionCompletions || []
                : command.name === '/task' ? options.taskCompletions?.[sub.name] || []
                : command.name === '/skills' ? directories
                : command.name === '/skill' ? allSkills
                : sub.needsSkillArg ? allSkills : [],
        })),
        argCompletions: command.name === '/model' ? options.modelCompletions || []
            : command.name === '/permissions' ? permissionCompletions
            : command.needsSkillArg ? (command.name === '/exec' ? skills : allSkills) : [],
    }));
    return { type: 'achilles-slash-command-catalog', version: 1, commands };
}

export async function loadAutocompleteCatalog(options = {}) {
    const workingDir = options.dir || process.env.WORKSPACE_PATH || process.cwd();
    const installation = options.installation || await resolveAlaInstallation();
    const skillCatalog = await discoverCatalog(workingDir, { ...options, installation });
    const sessionStore = new ConversationSessionStore({ workingDir });
    const modelCompletions = [{ value: 'default', label: 'default', description: 'Use the native backend default' }];
    let modelError;
    const engine = options.engine || createAlaEngine({ workingDir, sessionStore, skillCatalog, settings, installation });
    try {
        const current = await sessionStore.ensureCurrentSession();
        const { models } = await engine.listModels({ sessionId: current.sessionId, signal: options.signal });
        modelCompletions.push(...models.map((model) => ({
            value: typeof model === 'string' ? model : model.id || model.name || model.key,
            label: typeof model === 'string' ? model : model.label || model.name || model.id || model.key,
            description: model.description || '',
        })));
    } catch (error) {
        modelError = error.message;
    } finally {
        if (!options.engine) await engine.close();
    }
    const result = await toAutocompleteCatalog({ ...options, dir: workingDir, skillCatalog, modelCompletions,
        sessionCompletions: buildSessionCompletions(workingDir),
        taskCompletions: Object.fromEntries(['view', 'continue', 'stop', 'model', 'login'].map((action) =>
            [action, buildTaskActionCompletions(workingDir, action)])),
    });
    return modelError ? { ...result, modelError } : result;
}

async function main() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const input = payload.input || payload.arguments || payload.params?.arguments || {};
    process.stdout.write(`${JSON.stringify(await loadAutocompleteCatalog({ dir: input.dir }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
