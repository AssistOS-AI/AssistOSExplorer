/**
 * SlashCommandHandler - Manages slash command definitions and execution.
 *
 * All commands start with /. Commands with subOptions show a sub-menu
 * when selected (e.g., /list → skills, repos). Commands without
 * subOptions complete directly.
 */

import { formatSlashResult } from '../ui/ResultFormatter.mjs';
import { showHelp } from '../ui/HelpSystem.mjs';

/**
 * Slash command definitions.
 *
 * Commands with `subOptions` show a sub-menu when selected.
 * Commands with `skill` execute that skill directly.
 * Commands with neither are handled specially in executeSlashCommand.
 */
export const COMMAND_DEFINITIONS = {
    // Hierarchical commands with sub-options
    'list': {
        subOptions: ['skills', 'repos'],
        description: 'List items',
    },
    'add': {
        subOptions: ['repo'],
        description: 'Add items',
    },
    'remove': {
        subOptions: ['repo', 'skill'],
        description: 'Remove items',
    },

    // Direct skill commands
    'read': {
        skill: null,
        usage: '/read <skill-name>',
        description: 'Read a skill definition file',
        args: 'required',
        needsSkillArg: true,
    },
    'update': {
        subOptions: ['repos'],
        usage: '/update repos',
        description: 'Update cloned repositories',
    },
    'exec': {
        skill: null,
        usage: '/exec <skill-name> [input]',
        description: 'Run an enabled Anthropic skill through ALA',
        args: 'required',
        needsSkillArg: true,
    },
    'model': {
        usage: '/model <model-name>',
        description: 'Select the native coding-backend model',
        args: 'optional',
        needsSkillArg: false,
        argMatchMode: 'fragment',
    },
    'permissions': {
        usage: '/permissions [ask-for-approval|full-access]',
        description: 'Show or change native backend permissions',
        args: 'optional',
        needsSkillArg: false,
    },
    'raw': {
        usage: '/raw',
        description: 'Toggle markdown rendering',
        args: 'optional',
        needsSkillArg: false,
    },
    'help': {
        usage: '/help [topic]',
        description: 'Show help',
        args: 'optional',
        needsSkillArg: false,
    },
    'reload': {
        usage: '/reload',
        description: 'Refresh skills from disk',
        args: 'optional',
        needsSkillArg: false,
    },
    'history': {
        usage: '/history [clear|<n>|<query>]',
        description: 'Show command history',
        args: 'optional',
        needsSkillArg: false,
    },
    'tasks': {
        usage: '/tasks [count|all]',
        description: 'Show background task status and bounded final log tails',
        args: 'optional',
        needsSkillArg: false,
    },
    'skills': {
        usage: '/skills [enable|disable <relative-directory>]',
        description: 'List workspace skills or toggle every skill under a directory',
        args: 'optional',
        needsSkillArg: false,
        subOptions: ['enable', 'disable'],
    },
    'skill': {
        usage: '/skill <enable|disable> <skill-name>',
        description: 'Enable or disable one registered workspace skill',
        args: 'required',
        needsSkillArg: false,
        subOptions: ['enable', 'disable'],
    },
    'task': {
        usage: '/task <view|continue|stop|model|login> <task-id> [arguments]',
        description: 'View, continue, stop, or configure a background task',
        args: 'required',
        needsSkillArg: false,
        subOptions: ['view', 'continue', 'stop', 'model', 'login'],
    },
    'session': {
        usage: '/session [new|resume <session-id>]',
        description: 'Select or create an AchillesCLI conversation session',
        args: 'optional',
        needsSkillArg: false,
        catalogSubOptions: ['new', 'resume'],
    },
    'exit': {
        usage: '/exit',
        description: 'Exit the REPL',
        args: 'optional',
        needsSkillArg: false,
    },
    'quit': {
        usage: '/quit',
        description: 'Exit the REPL',
        args: 'optional',
        needsSkillArg: false,
    },
};

/**
 * Sub-option definitions for hierarchical commands.
 * Each sub-option maps to a handler or skill execution.
 */
export const SUB_OPTIONS = {
    'skills': {
        'enable': {
            skill: null,
            usage: '/skills enable <relative-directory>',
            description: 'Enable every registered skill under a workspace directory',
            args: 'required',
            needsSkillArg: false,
        },
        'disable': {
            skill: null,
            usage: '/skills disable <relative-directory>',
            description: 'Disable every registered skill under a workspace directory',
            args: 'required',
            needsSkillArg: false,
        },
    },
    'skill': {
        'enable': {
            skill: null,
            usage: '/skill enable <skill-name>',
            description: 'Enable one registered workspace skill',
            args: 'required',
            needsSkillArg: true,
        },
        'disable': {
            skill: null,
            usage: '/skill disable <skill-name>',
            description: 'Disable one registered workspace skill',
            args: 'required',
            needsSkillArg: true,
        },
    },
    'task': {
        'view': {
            skill: null,
            usage: '/task view <task-id>',
            description: 'Show task metadata and its latest stored log lines',
            args: 'required',
            needsSkillArg: false,
        },
        'continue': {
            skill: null,
            usage: '/task continue <task-id> <prompt>',
            description: 'Continue a terminal task',
            args: 'required',
            needsSkillArg: false,
        },
        'stop': {
            skill: null,
            usage: '/task stop <task-id>',
            description: 'Stop a queued or running task',
            args: 'required',
            needsSkillArg: false,
        },
        'model': {
            skill: null,
            usage: '/task model <task-id> [model-key]',
            description: 'Choose or set the execution model for a continuable task',
            args: 'required',
            needsSkillArg: false,
        },
        'login': {
            skill: null,
            usage: '/task login <task-id> [provider] [method]',
            description: 'Connect a provider in the task agent',
            args: 'required',
            needsSkillArg: false,
        },
    },
    'list': {
        'skills': {
            skill: null,
            usage: '/list skills [all]',
            description: 'List skills',
            args: 'optional',
            needsSkillArg: false,
        },
        'repos': {
            skill: null,
            usage: '/list repos',
            description: 'List cloned repositories',
            args: 'optional',
            needsSkillArg: false,
        },
    },
    'add': {
        'repo': {
            skill: null,
            usage: '/add repo <URL> [name]',
            description: 'Clone a repository',
            args: 'required',
            needsSkillArg: false,
        },
    },
    'remove': {
        'repo': {
            skill: null,
            usage: '/remove repo <name>',
            description: 'Remove a cloned repository',
            args: 'required',
            needsSkillArg: false,
        },
        'skill': {
            skill: null,
            usage: '/remove skill <skill-name>',
            description: 'Delete a skill directory',
            args: 'required',
            needsSkillArg: true,
        },
    },
    'update': {
        'repos': {
            skill: null,
            usage: '/update repos',
            description: 'Pull all cloned repositories',
            args: 'optional',
            needsSkillArg: false,
        },
    },
    'session': {
        'new': {
            skill: null,
            usage: '/session new',
            description: 'Create and select a new conversation session',
            args: 'optional',
            needsSkillArg: false,
        },
        'resume': {
            skill: null,
            usage: '/session resume <session-id>',
            description: 'Resume a saved conversation session',
            args: 'required',
            needsSkillArg: false,
        },
    },
};

/**
 * Build a structured slash-command catalog that can be consumed by remote UIs.
 * @returns {Array<Object>}
 */
export function buildSlashCommandCatalog() {
    const catalog = [];

    for (const [name, def] of Object.entries(COMMAND_DEFINITIONS)) {
        const subDefs = SUB_OPTIONS[name] || {};
        const catalogSubOptions = [
            ...(Array.isArray(def.subOptions) ? def.subOptions : []),
            ...(Array.isArray(def.catalogSubOptions) ? def.catalogSubOptions : []),
        ];
        const subCommands = catalogSubOptions.length > 0
            ? catalogSubOptions.map((subName) => {
                const subDef = subDefs[subName] || {};
                return {
                    name: subName,
                    usage: subDef.usage || `/${name} ${subName}`,
                    description: subDef.description || '',
                    args: subDef.args || 'optional',
                    skill: subDef.skill || null,
                    needsSkillArg: Boolean(subDef.needsSkillArg),
                };
            })
            : [];

        catalog.push({
            name: `/${name}`,
            usage: def.usage || `/${name}`,
            description: def.description || '',
            args: def.args || 'optional',
            skill: def.skill || null,
            needsSkillArg: Boolean(def.needsSkillArg),
            argMatchMode: def.argMatchMode || 'prefix',
            argSuggestionLimit: Number.isInteger(def.argSuggestionLimit)
                ? def.argSuggestionLimit
                : null,
            subCommands,
        });
    }

    catalog.sort((a, b) => a.name.localeCompare(b.name));
    return catalog;
}

/**
 * SlashCommandHandler class for managing slash commands in the CLI.
 */
export class SlashCommandHandler {
    /**
     * Backwards-compatible COMMANDS alias (points to COMMAND_DEFINITIONS).
     */
    static COMMANDS = COMMAND_DEFINITIONS;

    /**
     * Static helper for callers that only need command metadata.
     * @returns {Array<Object>}
     */
    static getCommandCatalog() {
        return buildSlashCommandCatalog();
    }

    /**
     * Create a new SlashCommandHandler.
     *
     * @param {Object} options
     * @param {Function} options.executeSkill - Function to execute a skill: (skillName, input, options) => Promise
     * @param {Function} options.getUserSkills - Function to get user skills: () => Array
     * @param {Function} options.getSkills - Function to get all skills: () => Array
     * @param {HistoryManager} [options.historyManager] - Command history manager
     * @param {Function} [options.getTaskSummary] - Read and format workspace task status
     * @param {Function} [options.loadModels] - Load {backend,models} from ALA
     * @param {Function} [options.getPermissions] - Read the native permission mode
     * @param {Function} [options.setPermissions] - Change the requested native permission mode
     * @param {Function} [options.getSessions] - List conversation sessions
     * @param {Function} [options.createSession] - Create a conversation session
     * @param {Function} [options.resumeSession] - Resume a conversation session
     */
    constructor({
        workingDir = process.cwd(),
        executeSkill,
        readSkill,
        removeSkill,
        getUserSkills,
        getSkills,
        historyManager,
        getTaskSummary,
        loadModels,
        getPermissions,
        setPermissions,
        getSessions,
        createSession,
        resumeSession,
        viewTask,
        continueTask,
        stopTask,
        modelTask,
        loginTask,
        getTaskCompletions,
        getSkillState,
        setSkillEnabled,
        setSkillsDirectoryEnabled,
    }) {
        this.workingDir = workingDir;
        this.executeSkill = executeSkill;
        this.readSkill = readSkill;
        this.removeSkill = removeSkill;
        this.getUserSkills = getUserSkills;
        this.getSkills = getSkills;
        this.historyManager = historyManager;
        this.getTaskSummary = getTaskSummary;
        this.loadModels = loadModels;
        this.getPermissions = getPermissions;
        this.setPermissions = setPermissions;
        this.getSessions = getSessions;
        this.createSession = createSession;
        this.resumeSession = resumeSession;
        this.viewTask = viewTask;
        this.continueTask = continueTask;
        this.stopTask = stopTask;
        this.modelTask = modelTask;
        this.loginTask = loginTask;
        this.getTaskCompletions = getTaskCompletions;
        this.getSkillState = getSkillState;
        this.setSkillEnabled = setSkillEnabled;
        this.setSkillsDirectoryEnabled = setSkillsDirectoryEnabled;
        this.availableModels = [];
    }

    /**
     * Check if input is a slash command.
     * @param {string} input - User input
     * @returns {boolean}
     */
    isSlashCommand(input) {
        return input.startsWith('/');
    }

    /**
     * Parse a slash command into parts.
     * Returns { command, subOption, args, rawArgs }
     * - command: the top-level command (e.g., 'list')
     * - subOption: the sub-option if any (e.g., 'skills')
     * - args: remaining arguments after command and sub-option
     * - rawArgs: everything after the command name
     * @param {string} input - User input starting with /
     * @returns {{command: string, subOption: string|null, args: string, rawArgs: string}|null}
     */
    parseSlashCommand(input) {
        const match = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
        if (!match) return null;

        const command = match[1].toLowerCase();
        const rawArgs = match[2]?.trim() || '';

        const cmdDef = COMMAND_DEFINITIONS[command];
        if (cmdDef && cmdDef.subOptions && rawArgs) {
            const parts = rawArgs.split(/\s+/);
            const firstWord = parts[0].toLowerCase();
            if (cmdDef.subOptions.includes(firstWord)) {
                return {
                    command,
                    subOption: firstWord,
                    args: rawArgs.slice(parts[0].length).trim(),
                    rawArgs,
                };
            }
        }
        if (cmdDef && cmdDef.catalogSubOptions && rawArgs) {
            const parts = rawArgs.split(/\s+/);
            const firstWord = parts[0].toLowerCase();
            if (cmdDef.catalogSubOptions.includes(firstWord)) {
                return {
                    command,
                    subOption: firstWord,
                    args: rawArgs.slice(parts[0].length).trim(),
                    rawArgs,
                };
            }
        }

        return {
            command,
            subOption: null,
            args: rawArgs,
            rawArgs,
        };
    }

    /**
     * Get sub-options for a command.
     * @param {string} command - Command name
     * @returns {string[]|null}
     */
    getSubOptions(command) {
        const cmdDef = COMMAND_DEFINITIONS[command];
        if (!cmdDef) return null;
        const subOptions = [
            ...(Array.isArray(cmdDef.subOptions) ? cmdDef.subOptions : []),
            ...(Array.isArray(cmdDef.catalogSubOptions) ? cmdDef.catalogSubOptions : []),
        ];
        return subOptions.length > 0 ? subOptions : null;
    }

    /**
     * Build picker/autocomplete entries for persisted conversation sessions.
     * @returns {Array<{value: string, label: string, description: string}>}
     */
    getSessionCompletions() {
        if (typeof this.getSessions !== 'function') return [];
        const payload = this.getSessions();
        return (payload?.sessions || []).map((session) => ({
            value: session.sessionId,
            label: session.preview || 'New session',
            description: [
                session.sessionId === payload.currentSessionId ? 'Current session' : '',
                session.sessionId,
                session.updatedAt,
            ].filter(Boolean).join(' · '),
        }));
    }

    /**
     * Get the definition for a sub-option.
     * @param {string} command - Command name
     * @param {string} subOption - Sub-option name
     * @returns {Object|null}
     */
    getSubOptionDef(command, subOption) {
        return SUB_OPTIONS[command]?.[subOption] || null;
    }

    /**
     * Execute a slash command.
     * @param {string} command - Command name (without /)
     * @param {string} args - Command arguments
     * @param {Object} options - Execution options
     * @returns {Promise<{handled: boolean, result?: string, error?: string}>}
     */
    async executeSlashCommand(command, args, options = {}) {
        // Parse to check for sub-options
        const parsed = this.parseSlashCommand(`/${command} ${args}`.trim());
        const subOption = parsed?.subOption;

        // Handle sub-option commands
        if (subOption) {
            return this._executeSubOption(command, subOption, parsed.args, options);
        }

        // Handle built-in commands
        if (command === 'help' || command === '?') {
            if (!args) {
                return { handled: true, showHelpPicker: true };
            }
            return { handled: true, result: showHelp(args) };
        }

        if (command === 'raw') {
            return { handled: true, toggleMarkdown: true };
        }

        if (command === 'model') {
            return this._handleModelCommand(args, options);
        }

        if (command === 'permissions') {
            if (typeof this.getPermissions !== 'function' || typeof this.setPermissions !== 'function') {
                return { handled: true, error: 'Permission controls are unavailable in this session.' };
            }
            if (!args) {
                return { handled: true, result: `Native permissions: ${await this.getPermissions()}` };
            }
            const requested = args.trim().toLowerCase();
            if (!['ask-for-approval', 'full-access'].includes(requested)) {
                return { handled: true, error: 'Usage: /permissions [ask-for-approval|full-access]' };
            }
            try {
                const mode = await this.setPermissions(requested);
                return { handled: true, result: `Native permissions requested: ${mode}. Applies on the next turn; backend constraints remain authoritative.` };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        if (command === 'quit' || command === 'exit' || command === 'q') {
            return { handled: true, exitRepl: true };
        }

        if (command === 'reload') {
            return this._handleReload();
        }

        if (command === 'history') {
            return this._handleHistory(args);
        }

        if (command === 'tasks') {
            if (typeof this.getTaskSummary !== 'function') {
                return { handled: true, error: 'Task history is unavailable in this session.' };
            }
            try {
                return { handled: true, result: await this.getTaskSummary(args, options) };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        if (command === 'skills') {
            if (args) return { handled: true, error: 'Usage: /skills [enable|disable <relative-directory>]' };
            if (typeof this.getSkillState !== 'function') {
                return { handled: true, error: 'Workspace skill controls are unavailable.' };
            }
            return { handled: true, skillState: this.getSkillState(), skillStateEvent: 'list' };
        }

        if (command === 'session') {
            if (args) return { handled: true, error: 'Usage: /session [new|resume <session-id>]' };
            if (typeof this.getSessions !== 'function') {
                return { handled: true, error: 'Conversation sessions are unavailable.' };
            }
            return {
                handled: true,
                showSessionPicker: true,
                sessionList: this.getSessions(),
            };
        }

        // Handle direct skill commands
        const cmdDef = COMMAND_DEFINITIONS[command];
        if (!cmdDef) {
            return {
                handled: false,
                error: `Unknown command: /${command}. Type /help for available commands.`,
            };
        }

        // Check required args
        if (cmdDef.args === 'required' && !args) {
            return {
                handled: true,
                error: `Usage: ${cmdDef.usage}\n  ${cmdDef.description}`,
            };
        }

        // Handle /exec specially
        if (command === 'exec') {
            const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
            const skillName = match?.[1];
            const skillInput = match?.[2]?.trim() || skillName;
            try {
                const result = await this.executeSkill(skillName, skillInput, options);
                return { handled: true, result: formatSlashResult(result) };
            } catch (error) {
                return { handled: true, error: error.message, executionError: error };
            }
        }

        if (command === 'read') {
            try {
                return { handled: true, result: await this.readSkill(args.trim()) };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        return { handled: false, error: `Unknown command: /${command}` };
    }


    /**
     * Execute a sub-option command (e.g., /list repos, /add repo).
     * @private
     */
    async _executeSubOption(command, subOption, args, options) {
        const subDef = this.getSubOptionDef(command, subOption);
        if (!subDef) {
            return { handled: false, error: `Unknown sub-command: /${command} ${subOption}` };
        }

        // Check required args
        if (subDef.args === 'required' && !args) {
            return {
                handled: true,
                error: `Usage: ${subDef.usage}\n  ${subDef.description}`,
            };
        }

        if (command === 'list' && subOption === 'skills') {
            if (args && args !== 'all') return { handled: true, error: 'Usage: /list skills [all]' };
            const skills = this.getSkills();
            return { handled: true, result: skills.map((skill) =>
                `${skill.name} [anthropic]${skill.enabled === false ? ' (disabled)' : ''}${skill.builtIn ? ' (built-in)' : ''} — ${skill.description || ''}`
            ).join('\n') || 'No skills found.' };
        }
        if (command === 'remove' && subOption === 'skill') {
            try {
                await this.removeSkill(args.trim());
                return { handled: true, result: `Skill '${args.trim()}' removed.` };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        if (command === 'skill' && (subOption === 'enable' || subOption === 'disable')) {
            if (typeof this.setSkillEnabled !== 'function' || typeof this.getSkillState !== 'function') {
                return { handled: true, error: 'Workspace skill controls are unavailable.' };
            }
            try {
                return {
                    handled: true,
                    skillState: await this.setSkillEnabled(args.trim(), subOption === 'enable'),
                    skillStateEvent: 'changed',
                    skillOperation: { scope: 'skill', action: subOption, target: args.trim() },
                };
            } catch (error) {
                return {
                    handled: true,
                    error: error.message,
                    skillState: this.getSkillState(),
                    skillStateEvent: 'error',
                    skillOperation: { scope: 'skill', action: subOption, target: args.trim() },
                };
            }
        }

        if (command === 'skills' && (subOption === 'enable' || subOption === 'disable')) {
            if (typeof this.setSkillsDirectoryEnabled !== 'function' || typeof this.getSkillState !== 'function') {
                return { handled: true, error: 'Workspace skill controls are unavailable.' };
            }
            try {
                return {
                    handled: true,
                    skillState: await this.setSkillsDirectoryEnabled(args.trim(), subOption === 'enable'),
                    skillStateEvent: 'changed',
                    skillOperation: { scope: 'directory', action: subOption, target: args.trim() },
                };
            } catch (error) {
                return {
                    handled: true,
                    error: error.message,
                    skillState: this.getSkillState(),
                    skillStateEvent: 'error',
                    skillOperation: { scope: 'directory', action: subOption, target: args.trim() },
                };
            }
        }

        if (command === 'session' && subOption === 'new') {
            if (typeof this.createSession !== 'function') {
                return { handled: true, error: 'Conversation sessions are unavailable.' };
            }
            return { handled: true, sessionChanged: await this.createSession() };
        }

        if (command === 'session' && subOption === 'resume') {
            if (typeof this.resumeSession !== 'function') {
                return { handled: true, error: 'Conversation sessions are unavailable.' };
            }
            try {
                return { handled: true, sessionChanged: await this.resumeSession(args.trim()) };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        if (command === 'task' && subOption === 'view') {
            if (typeof this.viewTask !== 'function') return { handled: true, error: 'Task management is unavailable.' };
            try { return { handled: true, result: await this.viewTask(args.trim()) }; }
            catch (error) { return { handled: true, error: error.message }; }
        }

        if (command === 'task' && subOption === 'stop') {
            if (typeof this.stopTask !== 'function') return { handled: true, error: 'Task management is unavailable.' };
            try {
                const task = await this.stopTask(args.trim());
                return { handled: true, result: `Stop requested for ${task.id}.` };
            } catch (error) { return { handled: true, error: error.message }; }
        }

        if (command === 'task' && subOption === 'continue') {
            if (typeof this.continueTask !== 'function') return { handled: true, error: 'Task management is unavailable.' };
            const match = args.match(/^(task_[0-9a-f]{24})(?:\s+([\s\S]+))?$/);
            if (!match?.[2]?.trim()) return { handled: true, error: 'Usage: /task continue <task-id> <prompt>' };
            try {
                const task = await this.continueTask(match[1], match[2].trim(), options.context);
                return { handled: true, result: `Continued ${task.id}.` };
            } catch (error) { return { handled: true, error: error.message }; }
        }

        if (command === 'task' && subOption === 'model') {
            if (typeof this.modelTask !== 'function') return { handled: true, error: 'Task model control is unavailable.' };
            const match = args.match(/^(task_[0-9a-f]{24})(?:\s+(\S+))?$/);
            if (!match) return { handled: true, error: 'Usage: /task model <task-id> [model-key]' };
            try {
                const result = await this.modelTask(match[1], match[2] || '', options);
                if (result?.type === 'task-model-catalog') {
                    return { handled: true, result: `Loaded ${result.models?.length || 0} task models.` };
                }
                return { handled: true, result: `Task model set to ${result.model?.label || result.model?.key || result.model?.model}.` };
            } catch (error) { return { handled: true, error: error.message }; }
        }

        if (command === 'task' && subOption === 'login') {
            if (typeof this.loginTask !== 'function') return { handled: true, error: 'Task provider login is unavailable.' };
            const match = args.match(/^(task_[0-9a-f]{24})(?:\s+(\S+))?(?:\s+(\S+))?$/);
            if (!match) return { handled: true, error: 'Usage: /task login <task-id> [provider] [method]' };
            try {
                const result = await this.loginTask(match[1], match[2] || '', match[3] || '', options);
                return { handled: true, result: `Provider connected${result.provider ? `: ${result.provider}` : ''}.` };
            } catch (error) { return { handled: true, error: error.message }; }
        }

        // /update repos
        if (command === 'update' && subOption === 'repos') {
            const { updateRepos } = await import('../lib/repoManager.mjs');
            try {
                const result = updateRepos(this.workingDir);
                if (result.updated.length === 0) {
                    return { handled: true, result: 'No repositories in .data/achilles-cli/repos/.' };
                }
                const lines = [`Updated repositories (${result.updated.length}):`];
                for (const repo of result.updated) {
                    lines.push(`  ${repo.name}`);
                }
                return { handled: true, result: lines.join('\n') };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        // /list repos
        if (command === 'list' && subOption === 'repos') {
            const { listRepos } = await import('../lib/repoManager.mjs');
            try {
                const repos = listRepos(this.workingDir);
                if (repos.length === 0) {
                    return { handled: true, result: 'No repositories in .data/achilles-cli/repos/.' };
                }
                const lines = [`Repositories (${repos.length}):`, ''];
                for (const repo of repos) {
                    const url = repo.url || '(no remote)';
                    lines.push(`  ${repo.name}`);
                    lines.push(`    URL: ${url}`);
                    lines.push(`    Path: ${repo.path}`);
                    lines.push('');
                }
                return { handled: true, result: lines.join('\n') };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        // /add repo
        if (command === 'add' && subOption === 'repo') {
            const { addRepo } = await import('../lib/repoManager.mjs');
            const parts = args.split(/\s+/);
            const url = parts[0];
            const name = parts[1];
            if (!url) {
                return { handled: true, error: `Usage: /add repo <URL> [name]\n  Clone a repository into .data/achilles-cli/repos/` };
            }
            try {
                const result = addRepo(url, name, this.workingDir);
                return { handled: true, result: `Repository '${result.name}' ${result.status}.\n  Path: ${result.path}` };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }

        // /remove repo
        if (command === 'remove' && subOption === 'repo') {
            const { removeRepo } = await import('../lib/repoManager.mjs');
            const name = args.trim();
            if (!name) {
                return { handled: true, error: `Usage: /remove repo <name>\n  Remove a cloned repository from .data/achilles-cli/repos/` };
            }
            try {
                removeRepo(name, this.workingDir);
                return { handled: true, result: `Repository '${name}' removed.` };
            } catch (error) {
                return { handled: true, error: error.message };
            }
        }


        return { handled: false, error: `Unhandled sub-command: /${command} ${subOption}` };
    }

    /**
     * Handle /reload command.
     * @private
     */
    _handleReload() {
        // Reload is handled by REPLSession
        return { handled: true, reloadSkills: true };
    }

    /**
     * Handle /history command.
     * @private
     */
    async _handleHistory(args) {
        if (!this.historyManager) {
            return { handled: true, error: 'History manager not available.' };
        }

        if (!args) {
            return { handled: true, showHistory: true };
        }

        if (args === 'clear') {
            await this.historyManager.clear();
            return { handled: true, result: 'History cleared.' };
        }

        if (/^\d+$/.test(args)) {
            return { handled: true, showHistoryCount: parseInt(args, 10) };
        }

        return { handled: true, searchHistory: args };
    }

    async getAvailableModels() {
        try {
            const { models } = await this.loadModels();
            this.availableModels = ['default', ...models.map((model) => (typeof model === 'string' ? model : model.id || model.name || model.key))];
            return this.availableModels.slice();
        } catch {
            return [];
        }
    }


    /**
     * Handle /model command.
     * @private
     */
    async _handleModelCommand(args, options = {}) {
        if (!args) {
            return { handled: true, showModelPicker: true };
        }
        const requested = args.trim();
        let catalog;
        try {
            catalog = await this.loadModels(options);
        } catch (error) {
            return { handled: true, error: error.message };
        }
        const { backend, models } = catalog;
        this.availableModels = ['default', ...models.map((model) => (typeof model === 'string' ? model : model.id || model.name || model.key))];
        if (requested === 'default') return { handled: true, modelChange: null, backend };
        const exactModel = models.find((model) => ((typeof model === 'string' ? model : model.id || model.name || model.key)) === requested);
        if (!exactModel) {
            return { handled: true, error: `Unknown model "${requested}". Use /model to select a native model.` };
        }
        return { handled: true, modelChange: typeof exactModel === 'string' ? exactModel : exactModel.id || exactModel.name || exactModel.key, backend };
    }

    /**
     * Get autocomplete suggestions for slash commands.
     * @param {string} line - Current input line
     * @returns {[string[], string]} - [completions, original line]
     */
    getCompletions(line) {
        if (!line.startsWith('/')) {
            return [[], line];
        }

        const parsed = this.parseSlashCommand(line);
        if (!parsed) {
            const allCmds = Object.keys(COMMAND_DEFINITIONS).map(cmd => `/${cmd}`);
            return [allCmds, line];
        }

        const { command, subOption, args } = parsed;

        // If just the command name (no sub-option yet), suggest sub-options
        if (subOption === null && !args && line.endsWith(' ')) {
            const subOpts = this.getSubOptions(command);
            if (subOpts) {
                return [subOpts.map(s => `/${command} ${s}`), line];
            }
        }

        // Completing command name
        if (!args && !line.includes(' ')) {
            const cmdPrefix = command.toLowerCase();
            const matchingCmds = Object.keys(COMMAND_DEFINITIONS)
                .filter(cmd => cmd.startsWith(cmdPrefix))
                .map(cmd => `/${cmd}`);
            return [matchingCmds, line];
        }

        // Completing sub-option
        const subOpts = this.getSubOptions(command);
        if (subOpts && !subOption && args) {
            const prefix = args.toLowerCase();
            const matching = subOpts
                .filter(s => s.startsWith(prefix))
                .map(s => `/${command} ${s}`);
            return [matching, line];
        }

        // Command-specific completions
        if (subOption) {
            if (command === 'task' && typeof this.getTaskCompletions === 'function') {
                const prefix = args.toLowerCase();
                const matching = this.getTaskCompletions(subOption)
                    .filter((task) => [task.value, task.label, task.description]
                        .some((value) => String(value || '').toLowerCase().includes(prefix)))
                    .map((task) => `/${command} ${subOption} ${task.value}`);
                return [matching, line];
            }
            if (command === 'session' && subOption === 'resume') {
                const prefix = args.toLowerCase();
                const matching = this.getSessionCompletions()
                    .filter((session) => [session.value, session.label, session.description]
                        .some((value) => String(value || '').toLowerCase().includes(prefix)))
                    .map((session) => `/${command} ${subOption} ${session.value}`);
                return [matching, line];
            }
            if (command === 'list' && subOption === 'skills') {
                return ['all'.startsWith(args.toLowerCase()) ? ['/list skills all'] : [], line];
            }
            if (command === 'skill') {
                return [this.getSkills()
                    .map((skill) => skill.name)
                    .filter((name) => name.toLowerCase().startsWith(args.toLowerCase()))
                    .map((name) => `/${command} ${subOption} ${name}`), line];
            }
            if (command === 'skills' && this.getSkillState) {
                const directories = new Set();
                for (const skill of this.getSkillState()) {
                    const parts = String(skill.relativePath || '').split('/');
                    if (parts[0] === '..') continue;
                    for (let count = 1; count <= parts.length; count += 1) directories.add(parts.slice(0, count).join('/'));
                }
                return [[...directories].filter((directory) => directory.startsWith(args))
                    .map((directory) => `/${command} ${subOption} ${directory}`), line];
            }
            // /remove skill - suggest skill names
            if (command === 'remove' && subOption === 'skill') {
                const skills = this.getUserSkills();
                const matching = skills
                    .map(s => s.shortName || s.name)
                    .filter(name => name.toLowerCase().startsWith(args.toLowerCase()))
                    .map(name => `/${command} ${subOption} ${name}`);
                return [matching, line];
            }
        }

        // Direct command completions
        const cmdDef = COMMAND_DEFINITIONS[command];
        if (cmdDef) {
            const argPrefix = (args || '').toLowerCase();

            if (command === 'read') {
                const skills = this.getSkills();
                const matching = skills
                    .map(s => s.shortName || s.name)
                    .filter(name => name.toLowerCase().startsWith(argPrefix))
                    .map(name => `/${command} ${name}`);
                return [matching, line];
            }


            if (command === 'exec') {
                const skills = this.getSkills().filter((skill) => skill.enabled !== false);
                const matching = skills
                    .map(s => s.shortName || s.name)
                    .filter(name => name.toLowerCase().startsWith(argPrefix))
                    .map(name => `/${command} ${name}`);
                return [matching, line];
            }


            if (command === 'model') {
                const matching = this.availableModels
                    .filter(m => m.toLowerCase().includes(argPrefix))
                    .map(m => `/${command} ${m}`);
                return [matching, line];
            }
        }

        return [[], line];
    }

    /**
     * Get hint text for current input.
     * @param {string} line - Current input line
     * @returns {string|null}
     */
    getInputHint(line) {
        if (!line.startsWith('/')) return null;

        const parsed = this.parseSlashCommand(line);
        if (!parsed) {
            return 'Type a command name (Tab to complete)';
        }

        const { command, subOption, args } = parsed;

        // Show sub-option hint
        if (!subOption && !args && line.endsWith(' ')) {
            const subOpts = this.getSubOptions(command);
            if (subOpts) {
                return `Select: ${subOpts.join(', ')}`;
            }
        }

        const cmdDef = COMMAND_DEFINITIONS[command];
        if (!cmdDef) {
            const partialMatches = Object.keys(COMMAND_DEFINITIONS)
                .filter(cmd => cmd.startsWith(command));
            if (partialMatches.length > 0) {
                return `Did you mean: ${partialMatches.map(c => '/' + c).join(', ')}?`;
            }
            return 'Unknown command. Type /help for available commands.';
        }

        if (subOption) {
            const subDef = this.getSubOptionDef(command, subOption);
            if (subDef && subDef.args === 'required' && !args) {
                return `${subDef.description} — ${subDef.usage}`;
            }
            if (subDef) return subDef.description;
        }

        if (cmdDef.args === 'required' && !args) {
            return `${cmdDef.description} — ${cmdDef.usage}`;
        }

        return cmdDef.description;
    }

    /**
     * Print slash command help.
     */
    printHelp() {
        const helpText = showHelp('commands');
        console.log(helpText);
    }
}

export default SlashCommandHandler;
