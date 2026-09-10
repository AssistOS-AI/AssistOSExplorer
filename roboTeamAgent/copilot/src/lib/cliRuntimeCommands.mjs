import { createTerminalTaskInteractions } from '../ui/terminalTaskInteractions.mjs';
import { SlashCommandHandler } from '../repl/SlashCommandHandler.mjs';
import { getQuickReference } from '../ui/HelpSystem.mjs';
import { createTaskControlCommands } from './taskControlCommands.mjs';
import { buildTaskCompletions, formatWorkspaceTaskDetail, formatWorkspaceTaskSummary } from './workspaceTasks.mjs';
import { createWorkspaceSkillsSnapshot, setWorkspaceDirectoryEnabled, setWorkspaceSkillEnabled } from './workspaceSkillsState.mjs';
import { selectWebchatRuntimeModel } from './webchatRuntimeState.mjs';

function formatHistory(entries = []) {
    return entries.length ? entries.map((entry) => `${entry.index}. ${entry.command}`).join('\n') : 'No history entries.';
}

export async function executeRuntimeCommand({ runtime, connection, input, context = {}, signal, onEvent, emit = null }) {
    const { workingDir, engine, sessionStore, historyManager, backgroundTasks } = runtime;
    const skillCatalog = runtime.skillCatalog.forSession?.(connection.sessionId) || runtime.skillCatalog;
    if (/^\/skills(?:\s|$)/.test(input) && skillCatalog.command) {
        return skillCatalog.command(connection.sessionId, input.slice(7));
    }
    if (skillCatalog.command && /^\/skill\s+(?:enable|disable)\b/.test(input)) {
        throw new Error('Use /skills use <skillsets or set/skill> to change this session\'s selection.');
    }
    if (skillCatalog.command) await skillCatalog.refresh(connection.sessionId);
    const taskControls = () => createTaskControlCommands({
        workingDir,
        interactions: runtime.webchatController || createTerminalTaskInteractions(),
        setTaskModelImpl: (_directory, id, selection) => backgroundTasks.setTaskModel(id, selection),
        onLoginCompleted: (id) => backgroundTasks.appendTaskLog(id, 'Authentication successful', 'login'),
    });
    const taskAction = async (action, id, callback) => {
        if (!backgroundTasks) throw new Error('Delegated task control requires the Ploinky AgentMcpClient runtime.');
        try { return await callback(); }
        catch (error) { await backgroundTasks.reportActionError(action, id, error); throw error; }
    };
    const selectSession = async (session) => {
        connection.sessionId = session.sessionId;
        if (skillCatalog.command) await skillCatalog.refresh(session.sessionId);
        emit?.('selected', session);
        return session;
    };
    const loadModels = () => engine.listModels({ sessionId: connection.sessionId, signal });
    const handler = new SlashCommandHandler({
        workingDir,
        executeSkill: async (skillName, prompt) => (await engine.executeTurn({
            sessionId: connection.sessionId, prompt, skillName, context, signal, onEvent,
        })).outputText,
        getSkills: () => skillCatalog.getSkills(),
        getUserSkills: () => skillCatalog.getSkills().filter((skill) => !skill.isInternal),
        readSkill: (name) => skillCatalog.readSkill(name),
        removeSkill: (name) => skillCatalog.removeSkill(name),
        historyManager, loadModels,
        getPermissions: runtime.getPermissions,
        setPermissions: runtime.setPermissions,
        getSessions: () => sessionStore.listSessions(connection.sessionId),
        createSession: async () => selectSession(await sessionStore.createSession()),
        resumeSession: async (id) => selectSession(await sessionStore.resumeSession(id)),
        getSkillState: () => createWorkspaceSkillsSnapshot(skillCatalog, workingDir),
        setSkillEnabled: (name, enabled) => setWorkspaceSkillEnabled(skillCatalog, workingDir, name, enabled),
        setSkillsDirectoryEnabled: (directory, enabled) => setWorkspaceDirectoryEnabled(skillCatalog, workingDir, directory, enabled),
        getTaskSummary: async (args) => { await backgroundTasks?.listTasks(); return formatWorkspaceTaskSummary(workingDir, args); },
        viewTask: async (id) => { await backgroundTasks?.viewTask(id); return formatWorkspaceTaskDetail(workingDir, id); },
        continueTask: (id, prompt) => taskAction('continue', id, () => backgroundTasks.continueTask(id, prompt, context)),
        stopTask: (id) => taskAction('stop', id, () => backgroundTasks.stopTask(id)),
        modelTask: (id, model, options) => taskAction('model', id, async () => {
            const result = await taskControls().model(id, model, options);
            if (result?.type === 'task-model-catalog') await backgroundTasks.setTaskModelCatalog(id, result.models);
            return result;
        }),
        loginTask: (id, provider, method, options) => taskAction('login', id, () => taskControls().login(id, provider, method, options)),
        getTaskCompletions: (action) => buildTaskCompletions(workingDir, action),
    });
    const parsed = handler.parseSlashCommand(input);
    if (!parsed) return { output: `Unknown command: ${input}` };
    const args = parsed.subOption ? `${parsed.subOption} ${parsed.args}`.trim() : parsed.args;
    const result = await handler.executeSlashCommand(parsed.command, args, { context, signal });
    if (result?.executionError) throw result.executionError;
    if (!result?.handled) return { output: result?.error || `Unknown command: ${input}` };
    await historyManager.add(input);
    if (result.reloadSkills) {
        await skillCatalog.refresh(connection.sessionId);
        return { output: `Indexed ${skillCatalog.getSkills().length} skill(s).` };
    }
    if (result.exitRepl) return { exit: true, output: 'Close the tab to end the WebChat session.' };
    if (result.showHistory) return { output: formatHistory(historyManager.getRecent(10)) };
    if (result.showHistoryCount) return { output: formatHistory(historyManager.getRecent(result.showHistoryCount)) };
    if (result.searchHistory) return { output: formatHistory(historyManager.search(result.searchHistory)) };
    if (result.modelChange !== undefined) {
        await selectWebchatRuntimeModel({
            workingDir, backend: result.backend, model: result.modelChange, slashState: connection,
            emitRuntimeState: (model, { backend }) => emit?.('runtime', { model, backend }),
        });
        return { output: `Model selected: ${connection.pinnedModel || 'default'} (${result.backend})` };
    }
    if (result.showModelPicker) {
        const { backend, models } = await loadModels();
        emit?.('runtime', { backend, model: runtime.settings.getCodingAgentModels(workingDir)[backend] || null });
        return { output: `Native models (${backend}):\n${models.map((model) => typeof model === 'string' ? model : model.id || model.name || model.key).join('\n')}\nUse /model <model> or /model default.` };
    }
    if (result.toggleMarkdown) {
        connection.markdownEnabled = !connection.markdownEnabled;
        return { output: `Markdown rendering ${connection.markdownEnabled ? 'enabled' : 'disabled'}.` };
    }
    if (result.showHelpPicker) return { output: getQuickReference() };
    if (result.skillState) {
        if (emit) { emit('skills', result); return { output: '' }; }
        return { output: result.skillState.map((skill) => `${skill.enabled ? 'enabled' : 'disabled'} ${skill.name}`).join('\n') };
    }
    if (result.sessionList) {
        if (emit) { emit('list', result.sessionList); return { output: '' }; }
        return { output: result.sessionList.sessions.map((session) => `${session.sessionId === connection.sessionId ? '*' : ' '} ${session.sessionId} ${session.title || ''}`).join('\n') };
    }
    if (result.sessionChanged) return { output: emit ? '' : `Session: ${result.sessionChanged.sessionId}` };
    if (result.showSessionPicker) return { output: 'Usage: /session new or /session resume <session-id>.' };
    return { output: result.error || result.result || '' };
}
