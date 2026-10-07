import readline from 'node:readline';
import { prepareCopilotContext } from './copilot-context.mjs';
import { setRobotContext } from '../copilot/src/lib/execution/robotContext.mjs';
import { createCliRuntime } from '../copilot/src/index.mjs';

import { pathToFileURL } from 'node:url';

export async function runRobotTask(argv = process.argv.slice(2), contextOptions = {}) {
    const options = {};

    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        options[key] = ['--resume-session', '--control-stdin', '--workflow-execution'].includes(key) ? true : argv[++index];
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    let runtime;
    let input;
    let releaseUsage;
    try {
        const context = await prepareCopilotContext(options['--robot'], { ...contextOptions, prepareTools: false, holdUsage: true });
        setRobotContext(context);
        releaseUsage = context.releaseUsage;
        const skillSelection = process.env.ROBOTEAM_TASK_SKILL_SELECTION
            ? JSON.parse(process.env.ROBOTEAM_TASK_SKILL_SELECTION) : undefined;
        delete process.env.ROBOTEAM_TASK_SKILL_SELECTION;
        // The first stdin line is the task prompt; the following lines are live
        // control messages for the running turn.
        input = readline.createInterface({ input: process.stdin });
        let control;
        let receivePrompt;
        const promptRecord = new Promise((resolve) => { receivePrompt = resolve; });
        input.on('line', (line) => {
            try {
                const message = JSON.parse(line);
                if (receivePrompt) {
                    if (message.type !== 'prompt' || typeof message.prompt !== 'string' || !message.prompt.trim()) throw new Error('The first task record must be the prompt.');
                    receivePrompt(message); receivePrompt = null;
                } else if (message.type === 'message') control?.(message);
            } catch (error) { console.error(error.message || 'Invalid task control message.'); }
        });
        input.once('close', () => receivePrompt?.(null));
        const task = await promptRecord;
        if (!task) throw new Error('The task prompt was not received.');
        runtime = await createCliRuntime({ workingDir: options['--cwd'], skillRoots: [],
            sessionId: options['--session-id'], resumeSession: Boolean(options['--resume-session']), skillSelection,
            execution: { workflowExecution: options['--workflow-execution'] === true, captureTurnLogs: false, backend: options['--ca'] === 'auto' ? undefined : options['--ca'],
                model: options['--model'], mcpServers: options['--MCPServers'], permissions: 'full-access',
                ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}) } }, { reattachExistingTasks: false });
        const result = await runtime.engine.executeTurn({ sessionId: runtime.initialSession.sessionId, prompt: task.prompt,
            signal: controller.signal, context: { workingDir: options['--cwd'], rawText: task.prompt },
            onControl: (send) => { control = send; },
            onEvent: (event) => { process.stderr.write('@@ALA_EVENT@@' + JSON.stringify(event) + '\n'); } });
        process.stdout.write(result.outputText);
    } catch (error) {
        console.error(error.message);
        process.exitCode = controller.signal.aborted ? 130 : 1;
    } finally {
        input?.close();
        process.stdin.pause();
        await runtime?.close();
        await releaseUsage?.();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runRobotTask();
