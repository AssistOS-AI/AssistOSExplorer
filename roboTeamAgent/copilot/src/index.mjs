#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCliOptions, isWebchatRuntime } from './lib/cliOptions.mjs';
import { resolveSkillCatalogRoots, builtInSkillsDir } from './lib/cliSkillRoots.mjs';
import { createAnthropicSkillCatalog } from './lib/anthropicSkillCatalog.mjs';
import { resolveAlaInstallation } from './lib/alaInstallation.mjs';
import { createAlaEngine } from './lib/alaEngine.mjs';
import * as settings from './lib/achillesSettings.mjs';
import { ConversationSessionStore } from './lib/conversationSessionStore.mjs';
import { createWebchatBackgroundTaskManager } from './lib/webchatBackgroundTasks.mjs';
import { createWebchatInteractionController } from './lib/webchatInteractionController.mjs';
import { createNativeInteractions } from './lib/nativeInteractions.mjs';
import { HistoryManager } from './repl/HistoryManager.mjs';
import { REPLSession } from './repl/REPLSession.mjs';
import { createProvider, getProviderNames } from './ui/providers/index.mjs';
import { UIContext } from './ui/UIContext.mjs';
import { executeRuntimeCommand } from './lib/cliRuntimeCommands.mjs';
import { runWebchatInteractive, attachTaskToSession } from './lib/webchatRuntime.mjs';
import { getRobotContext } from './lib/robotContext.mjs';
import { createRobotSkillCatalog } from './lib/robotSkillCatalog.mjs';

export { REPLSession } from './repl/REPLSession.mjs';
export { SlashCommandHandler } from './repl/SlashCommandHandler.mjs';
export { CommandSelector, showCommandSelector, showSkillSelector, buildCommandList } from './ui/CommandSelector.mjs';
export { HistoryManager } from './repl/HistoryManager.mjs';
export { formatSlashResult } from './ui/ResultFormatter.mjs';
export { printHelp as printREPLHelp, showHistory, searchHistory } from './ui/HelpPrinter.mjs';
export { isWebchatEscapeControlChunk, handleWebchatControlChunk } from './lib/webchatControl.mjs';
export { BUILT_IN_SKILLS } from './lib/constants.mjs';
export { builtInSkillsDir, collectPloinkyRepoSkillRoots, resolveSkillCatalogRoots } from './lib/cliSkillRoots.mjs';
export { parseCliOptions } from './lib/cliOptions.mjs';

export async function createCliRuntime(options, { webchat = false } = {}) {
    const { workingDir } = options;
    const installation = await resolveAlaInstallation();
    const sessionStore = new ConversationSessionStore({ workingDir });
    let initialSession;
    if (options.sessionId) {
        if (options.resumeSession) initialSession = sessionStore.loadSession(options.sessionId);
        else initialSession = await sessionStore.createSession({ sessionId: options.sessionId, select: false });
    } else initialSession = await sessionStore.ensureCurrentSession();
    const robotContext = getRobotContext();
    const robotCatalog = robotContext ? createRobotSkillCatalog({ context: robotContext, sessionStore,
        workingDir, initialSessionId: initialSession.sessionId, discoverTaskSkills: installation.discoverTaskSkills }) : null;
    let catalog;
    const refresh = async () => {
        catalog = await createAnthropicSkillCatalog({
            workingDir,
            roots: resolveSkillCatalogRoots(workingDir, { skillRoots: options.skillRoots }),
            discoverTaskSkills: installation.discoverTaskSkills,
        });
        return { skills: catalog.getSkills(), taskRepositories: catalog.getEnabledSkillDirectories() };
    };
    if (options.skillSelection && !initialSession.skillPolicyRef && !initialSession.skillSelection && !options.resumeSession) initialSession = await sessionStore.updateSession(initialSession.sessionId,
        (session) => { session.skillSelection = options.skillSelection; });
    if (robotCatalog) await robotCatalog.refresh(initialSession.sessionId);
    else await refresh();
    // Keep the host reference stable while newly cloned roots are discovered on refresh.
    const skillCatalog = robotCatalog || Object.freeze({
        refresh,
        getSkills: () => catalog.getSkills(),
        getSkill: (name) => catalog.getSkill(name),
        resolveSelectedSkill: (name) => catalog.resolveSelectedSkill(name),
        getEnabledSkillDirectories: () => catalog.getEnabledSkillDirectories(),
        readSkill: (name) => catalog.readSkill(name),
        removeSkill: (name) => catalog.removeSkill(name),
    });
    if (options.requestedPermissionMode) await settings.setPermissionMode(workingDir, options.requestedPermissionMode);
    const webchatController = webchat ? createWebchatInteractionController({ stdout: process.stdout }) : null;
    const interactions = createNativeInteractions({ webchatController });
    let backgroundTasks;
    try {
        backgroundTasks = fs.existsSync('/Agent/client/AgentMcpClient.mjs') ? await createWebchatBackgroundTaskManager({
            workingDir,
            emitProtocol: webchat,
            onTaskStarted: (task, origin) => attachTaskToSession(sessionStore, task, origin, { webchat }),
        }) : null;
        const engine = createAlaEngine({ workingDir, sessionStore, skillCatalog, settings, interactions, backgroundTasks, installation,
            execution: options.execution });
        const historyManager = new HistoryManager({ workingDir });
        return {
            ...options, installation, skillCatalog, sessionStore, initialSession, engine,
            historyManager, settings, interactions, webchatController, backgroundTasks,
            getPermissions: () => settings.getPermissionMode(workingDir),
            setPermissions: (mode) => settings.setPermissionMode(workingDir, mode),
            async close() {
                try { await engine.close(); }
                finally {
                    interactions.dispose();
                    webchatController?.dispose();
                    backgroundTasks?.close();
                }
            },
        };
    } catch (error) {
        interactions.dispose();
        webchatController?.dispose();
        backgroundTasks?.close();
        throw error;
    }
}

export async function main(args = process.argv.slice(2)) {
    const options = parseCliOptions(args);
    if (options.help) { printHelp(); return; }
    if (options.version) { console.log('RoboTeam copilot v3.0.0'); return; }
    fs.mkdirSync(options.workingDir, { recursive: true });
    options.workingDir = fs.realpathSync(options.workingDir);
    process.chdir(options.workingDir);
    if (!getProviderNames().includes(options.uiStyle)) throw new Error(`Invalid UI style '${options.uiStyle}'. Available: ${getProviderNames().join(', ')}`);
    UIContext.setProvider(createProvider(options.uiStyle));
    const webchat = !options.singleShot && isWebchatRuntime(args);
    const runtime = await createCliRuntime(options, { webchat });
    try {
        if (webchat) await runWebchatInteractive(runtime);
        else if (options.singleShot) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            process.once('SIGINT', abort);
            process.once('SIGTERM', abort);
            try {
                const connection = { sessionId: runtime.initialSession.sessionId, markdownEnabled: options.renderMarkdown };
                const context = { workingDir: options.workingDir, rawText: options.prompt };
                const onEvent = (event) => {
                    if (event.type === 'diagnostic' && (event.category === 'skill-catalog' || options.debug || options.verbose)) console.error(event.message);
                };
                const result = options.prompt.startsWith('/')
                    ? await executeRuntimeCommand({ runtime, connection, input: options.prompt, context, signal: controller.signal, onEvent })
                    : await runtime.engine.executeTurn({ sessionId: connection.sessionId, prompt: options.prompt, context, signal: controller.signal, onEvent });
                if (!options.prompt.startsWith('/')) await runtime.historyManager.add(options.prompt);
                const text = result.outputText ?? result.output ?? '';
                if (text) console.log(text);
            } finally {
                process.removeListener('SIGINT', abort);
                process.removeListener('SIGTERM', abort);
            }
        } else {
            const session = new REPLSession(runtime.engine, { ...runtime, builtInSkillsDir });
            await session.start();
        }
    } finally { await runtime.close(); }
}

function printHelp() {
    console.log(`RoboTeam copilot v3.0

USAGE: ploinky cli roboTeamAgent --robot <name> [options] [prompt or /command]

  -d, --dir <path>          Workspace (default: current directory)
  -v, --verbose            Verbose diagnostics
  --debug                  Native execution diagnostics
  --raw, --no-markdown      Disable Markdown rendering
  --permissions <mode>     ask-for-approval or full-access
  --skip-permissions       Alias for --permissions full-access
  --ui <style>             claude-code or minimal
  --ui-minimal             Minimal terminal interface
  --ui-claude-code         Claude Code terminal interface
  -h, --help               Show help
  --version                Show version

Run without a prompt for the terminal REPL. WebChat is selected by the
Ploinky SSO runtime. /help lists retained commands; /list skills lists the
selected Anthropic catalog; /session manages robot conversations.
/skills lists allowed sets; /skills use copilot,set/skill selects session skills.
/model selects a native backend model; /permissions controls native policy.

RoboTeam supplies the ALA entrypoint, robot home and cached coding agents.
Configure the robot's accounts through its Desktop. Independent CLI sessions
can run concurrently; Desktop and Browser share one GUI container per robot.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error('Fatal error:', error.message);
        process.exitCode = error?.name === 'AbortError' || error?.exitCode === 130 ? 130 : 1;
    });
}
