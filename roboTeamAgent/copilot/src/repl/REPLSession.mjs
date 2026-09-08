import { createTerminalTaskInteractions } from '../ui/terminalTaskInteractions.mjs';
import { randomUUID } from 'node:crypto';
import { buildCommandList, showCommandSelector, showHelpSelector, showModelSelector } from '../ui/CommandSelector.mjs';
import { SlashCommandHandler } from './SlashCommandHandler.mjs';
import { HistoryManager } from './HistoryManager.mjs';
import { QuickCommands } from './QuickCommands.mjs';
import { InteractivePrompt } from './InteractivePrompt.mjs';
import { NaturalLanguageProcessor } from './NaturalLanguageProcessor.mjs';
import { renderMarkdown } from '../ui/MarkdownRenderer.mjs';
import { showHelp, getHelpTopics, getCommandHelp } from '../ui/HelpSystem.mjs';
import { showHistory, searchHistory } from '../ui/HelpPrinter.mjs';
import { UIContext } from '../ui/UIContext.mjs';
import { buildTaskCompletions, formatWorkspaceTaskDetail, formatWorkspaceTaskSummary } from '../lib/workspaceTasks.mjs';
import { createTaskControlCommands } from '../lib/taskControlCommands.mjs';
import { getCodingAgentModels, setCodingAgentModel, getPermissionMode, setPermissionMode } from '../lib/achillesSettings.mjs';
import { createWorkspaceSkillsSnapshot, formatWorkspaceSkills, setWorkspaceDirectoryEnabled, setWorkspaceSkillEnabled } from '../lib/workspaceSkillsState.mjs';

/** A connection owns its selected conversation; ALA owns each executing turn. */
export class REPLSession {
    constructor(engine, options = {}) {
        this.engine = engine;
        this.options = options;
        this.workingDir = options.workingDir;
        this.skillCatalog = options.skillCatalog;
        this.sessionStore = options.sessionStore;
        this.interactions = options.interactions;
        this.taskManager = options.backgroundTasks;
        this.currentConversation = null;
        this.markdownEnabled = options.renderMarkdown !== false;
        this.historyManager = options.historyManager || new HistoryManager({ workingDir: this.workingDir });
        this.controls = null;
        this.taskInteractions = createTerminalTaskInteractions({ getControls: () => this.controls });
        this.taskControls = createTaskControlCommands({
            workingDir: this.workingDir,
            interactions: this.taskInteractions,
            setTaskModelImpl: (_dir, taskId, selection) => this._requireTaskManager().setTaskModel(taskId, selection),
        });
        this.slashHandler = new SlashCommandHandler({
            workingDir: this.workingDir,
            executeSkill: (name, input, opts) => this.processPrompt(input, { ...opts, skillName: name }),
            readSkill: (name) => this.skillCatalog.readSkill(name),
            removeSkill: (name) => this.skillCatalog.removeSkill(name),
            getUserSkills: () => this.getUserSkills(),
            getSkills: () => this.skillCatalog.getSkills(),
            historyManager: this.historyManager,
            loadModels: ({ signal } = {}) => this.engine.listModels({ sessionId: this.currentConversation.sessionId, signal }),
            getPermissions: options.getPermissions || (() => getPermissionMode(this.workingDir)),
            setPermissions: options.setPermissions || ((mode) => setPermissionMode(this.workingDir, mode)),
            getSessions: () => this.sessionStore.listSessions(this.currentConversation?.sessionId),
            createSession: async () => this._activateConversation(await this.sessionStore.createSession()),
            resumeSession: async (id) => this._activateConversation(await this.sessionStore.resumeSession(id)),
            getTaskSummary: (args) => formatWorkspaceTaskSummary(this.workingDir, args),
            viewTask: async (id) => {
                await this.taskManager?.viewTask(id);
                return formatWorkspaceTaskDetail(this.workingDir, id);
            },
            continueTask: (id, prompt, origin) => this._requireTaskManager().continueTask(id, prompt, origin),
            stopTask: (id) => this._requireTaskManager().stopTask(id),
            modelTask: (id, model, opts) => { this._requireTaskManager(); return this._taskModel(id, model, opts); },
            loginTask: (id, provider, method, opts) => { this._requireTaskManager(); return this.taskControls.login(id, provider, method, opts); },
            getTaskCompletions: (action) => buildTaskCompletions(this.workingDir, action),
            getSkillState: () => createWorkspaceSkillsSnapshot(this.skillCatalog, this.workingDir),
            setSkillEnabled: (name, enabled) => setWorkspaceSkillEnabled(this.skillCatalog, this.workingDir, name, enabled),
            setSkillsDirectoryEnabled: (directory, enabled) => setWorkspaceDirectoryEnabled(this.skillCatalog, this.workingDir, directory, enabled),
        });
        this.commandList = buildCommandList(SlashCommandHandler.COMMANDS);
        this.inputPrompt = new InteractivePrompt({
            historyManager: this.historyManager,
            slashHandler: this.slashHandler,
            commandList: this.commandList,
            getUserSkills: () => this.getUserSkills(),
            getAllSkills: () => this.skillCatalog.getSkills(),
            getModelName: () => getCodingAgentModels(this.workingDir)[this.currentConversation?.engine?.backend] || null,
        });
        this.nlProcessor = new NaturalLanguageProcessor({
            processPrompt: (input, opts) => this.processPrompt(input, opts),
            historyManager: this.historyManager,
            isMarkdownEnabled: () => this.markdownEnabled,
            interactions: this.interactions,
        });
        this.quickCommands = new QuickCommands({
            getUserSkills: () => this.getUserSkills(),
            getAllSkills: () => this.skillCatalog.getSkills(),
            reloadSkills: () => this.reloadSkills(),
            historyManager: this.historyManager,
            builtInSkillsDir: options.builtInSkillsDir,
        });
    }

    getUserSkills() {
        return this.skillCatalog.getSkills().filter((skill) => !skill.builtIn);
    }
    _requireTaskManager() {
        if (!this.taskManager) throw new Error('Remote task controls require the Ploinky agent runtime.');
        return this.taskManager;
    }


    async reloadSkills() {
        await this.skillCatalog.refresh();
        return this.skillCatalog.getSkills().length;
    }

    async processPrompt(prompt, { onEvent, ...options } = {}) {
        const sessionId = this.currentConversation.sessionId;
        const result = await this.engine.executeTurn({
            ...options,
            sessionId,
            prompt,
            context: { ...options.context, workingDir: this.workingDir },
            onEvent: async (event) => {
                if (event.type === 'turn-started' && this.currentConversation.sessionId === sessionId) {
                    this.currentConversation = event.session;
                }
                await onEvent?.(event);
            },
        });
        if (this.currentConversation.sessionId === sessionId) this.currentConversation = result.session;
        return result.outputText;
    }

    _activateConversation(session) {
        this.currentConversation = session;
        return session;
    }

    _printConversation(session) {
        for (const message of session?.messages || []) {
            if (message.type === 'task') {
                console.log(`[task] ${message.taskId}`);
            } else if (message.text) {
                console.log(`${message.role === 'user' ? 'you' : 'assistant'}> ${message.text}`);
            }
        }
    }

    async start() {
        this.currentConversation = this.options.initialSession || await this.sessionStore.ensureCurrentSession();
        console.log(`\nAchilles CLI — ALA\n  cwd: ${this.workingDir}\n  session: ${this.currentConversation.sessionId}\n  ${this.skillCatalog.getSkills().length} Anthropic skills\nType / for commands, or describe what you need.\n`);
        this._printConversation(this.currentConversation);
        while (true) {
            const input = (await this.inputPrompt.prompt()).trim();
            if (!input) continue;
            if (['quit', 'exit', 'q'].includes(input.toLowerCase())) break;
            if (this.slashHandler.isSlashCommand(input)) {
                if (await this._handleSlashCommand(input)) break;
            } else if (this.quickCommands.isQuickCommand(input)) {
                await this.quickCommands.execute(input);
            } else {
                await this.nlProcessor.process(input);
            }
        }
    }

    async _handleSlashCommand(input) {
        const parsed = this.slashHandler.parseSlashCommand(input);
        if (!parsed) { console.error('Unknown command. Type /help.'); return false; }
        let commandTurn = null;
        let commandOrigin = null;
        try {
            return await this.nlProcessor.run(async ({ signal, controls, spinner, onEvent }) => {
                this.controls = controls;
                // /exec is a native turn. All other persisted commands are non-context UI history.
                if (parsed.command !== 'exec' && !['session', 'exit', 'quit', 'q'].includes(parsed.command)) {
                    const turnId = randomUUID();
                    commandTurn = await this.sessionStore.beginCommand({
                        sessionId: this.currentConversation.sessionId, text: input, turnId,
                    });
                    commandOrigin = Object.freeze({
                        sessionId: commandTurn.session.sessionId,
                        assistantMessageId: commandTurn.assistantMessageId, turnId,
                    });
                }
                const result = await this.slashHandler.executeSlashCommand(parsed.command, parsed.rawArgs, {
                    signal, onEvent, context: { ...commandOrigin, workingDir: this.workingDir, rawText: input },
                });
                spinner.stop();
                controls.suspendInput();
                if (result.exitRepl) return true;
                let text = result.error || result.result || '';
                if (result.reloadSkills) text = `Indexed ${await this.reloadSkills()} skill(s).`;
                else if (result.showHistory) showHistory(this.historyManager);
                else if (result.showHistoryCount) showHistory(this.historyManager, result.showHistoryCount);
                else if (result.searchHistory) searchHistory(this.historyManager, result.searchHistory);
                else if (result.showModelPicker) text = await this._handleModelPicker(signal);
                else if (Object.hasOwn(result, 'modelChange')) {
                    await setCodingAgentModel(this.workingDir, result.backend, result.modelChange);
                    text = `Native model (${result.backend}): ${result.modelChange || 'default'}`;
                } else if (result.toggleMarkdown) {
                    this.markdownEnabled = !this.markdownEnabled;
                    text = `Markdown rendering ${this.markdownEnabled ? 'enabled' : 'disabled'}.`;
                } else if (result.showHelpPicker) text = await this._handleHelpPicker(signal);
                else if (result.skillState) text = [result.error, formatWorkspaceSkills(result.skillState)].filter(Boolean).join('\n');
                else if (result.showSessionPicker) {
                    const session = await this._handleSessionPicker(signal);
                    if (session) this._printConversation(session);
                } else if (result.sessionChanged) this._printConversation(result.sessionChanged);
                if (text) console.log(this.markdownEnabled && !result.error ? renderMarkdown(text) : text);
                if (commandTurn) {
                    await this.sessionStore.completeTurn(commandTurn.session.sessionId, commandTurn.assistantMessageId, text,
                        { status: result.error ? 'failed' : 'completed' });
                }
                if (!result.error) await this.historyManager.add(input);
                return false;
            });
        } catch (error) {
            const interrupted = error.name === 'AbortError';
            if (commandTurn) await this.sessionStore.completeTurn(commandTurn.session.sessionId, commandTurn.assistantMessageId,
                interrupted ? '[cancelled]' : error.message, { status: interrupted ? 'interrupted' : 'failed' });
            console.error(interrupted ? 'Operation cancelled.' : error.message);
            return false;
        } finally {
            this.controls = null;
        }
    }

    async _handleSessionPicker(signal) {
        const payload = this.sessionStore.listSessions(this.currentConversation.sessionId);
        const selected = await showCommandSelector([
            { name: 'New', description: 'Create a conversation' },
            ...payload.sessions.map((session) => ({ name: session.sessionId, description: `${session.preview || 'New session'} · ${session.updatedAt}` })),
        ], { prompt: 'Session> ', signal, theme: UIContext.getTheme() });
        if (!selected) return null;
        return this._activateConversation(selected.name === 'New'
            ? await this.sessionStore.createSession() : await this.sessionStore.resumeSession(selected.name));
    }

    async _handleHelpPicker(signal) {
        const topics = [...getHelpTopics(), ...getCommandHelp()].map((item) => ({ name: item.name, description: item.title }));
        const selected = await showHelpSelector(topics, { signal, theme: UIContext.getTheme() });
        return selected ? showHelp(selected.name) : '';
    }

    async _handleModelPicker(signal) {
        const { backend, models } = await this.engine.listModels({ sessionId: this.currentConversation.sessionId, signal });
        const selected = await showModelSelector([
            { name: 'default', description: 'Use the backend default model' },
            ...models.map((model) => ({ name: (typeof model === 'string' ? model : model.id || model.name || model.key), description: model.label || model.description || model.name || '' })),
        ], { signal, theme: UIContext.getTheme() });
        if (!selected) return '';
        await setCodingAgentModel(this.workingDir, backend, selected.name === 'default' ? null : selected.name);
        return `Native model (${backend}): ${selected.name}`;
    }

    async _taskModel(id, model, options) {
        const result = await this.taskControls.model(id, model, options);
        if (model || !result.models) return result;
        const selected = await this.taskInteractions.select({ title: 'Task model', options: result.models.map((entry) => ({ value: entry.key, label: entry.label || entry.key, description: entry.description })) }, options);
        if (!selected) throw new Error('interaction_cancelled');
        return this.taskControls.model(id, selected, options);
    }

}

export default REPLSession;
