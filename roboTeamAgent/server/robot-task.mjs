import readline from 'node:readline';
import { prepareCopilotContext } from './copilot-context.mjs';
import { setRobotContext } from '../copilot/src/lib/execution/robotContext.mjs';
import { createCliRuntime } from '../copilot/src/index.mjs';
import { messageForEngine, stopReasonFromRecord, taskExitCode } from './worker-coordinator/task-exit.mjs';
import { workerModeSelected } from '../copilot/src/lib/execution/engineSelection.mjs';
import { detachReason } from '../copilot/src/lib/execution/abortReasons.mjs';

import { pathToFileURL } from 'node:url';

export async function runRobotTask(argv = process.argv.slice(2), contextOptions = {}) {
    const options = {};

    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        options[key] = ['--resume-session', '--control-stdin', '--workflow-execution', '--human-input'].includes(key) ? true : argv[++index];
    }
    const controller = new AbortController();
    // Through the worker a signal only detaches (RoboTeam is shutting down; the worker keeps the
    // execution); a stop is the explicit `stop` record on stdin.
    const workerMode = workerModeSelected();
    const abort = () => controller.abort(workerMode ? detachReason() : undefined);
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
                } else if (message.type === 'message') control?.(messageForEngine(message));
                else if (message.type === 'stop') controller.abort(stopReasonFromRecord(message));
            } catch (error) { console.error(error.message || 'Invalid task control message.'); }
        });
        input.once('close', () => receivePrompt?.(null));
        const task = await promptRecord;
        if (!task) throw new Error('The task prompt was not received.');
        // The one-request owner grant of an `/api/control` task, received over stdin only. It is used at once for
        // admission and is neither logged nor written anywhere.
        const ownerGrant = typeof task.ownerGrant === 'string' && task.ownerGrant ? task.ownerGrant : null;
        delete task.ownerGrant;
        runtime = await createCliRuntime({ workingDir: options['--cwd'], skillRoots: [],
            sessionId: options['--session-id'], resumeSession: Boolean(options['--resume-session']), skillSelection,
            execution: { workflowExecution: options['--workflow-execution'] === true, humanInput: options['--human-input'] === true, captureTurnLogs: false, backend: options['--ca'] === 'auto' ? undefined : options['--ca'],
                model: options['--model'], mcpServers: options['--MCPServers'], permissions: 'full-access',
                ...(options['--worker-origin']
                    ? { worker: { ...(options['--worker-binding'] ? { bindingId: options['--worker-binding'] } : {}), originRequestId: options['--worker-origin'] } } : {}),
                cwdExplicit: true,
                ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}) } }, { reattachExistingTasks: false });
        const result = await runtime.engine.executeTurn({ sessionId: runtime.initialSession.sessionId, prompt: task.prompt,
            signal: controller.signal, context: { workingDir: options['--cwd'], rawText: task.prompt },
            ...(ownerGrant && !options['--worker-binding'] ? { owner: { evidence: { ok: true, grant: ownerGrant } } } : {}),
            onControl: (send) => { control = send; },
            onEvent: (event) => { process.stderr.write('@@ALA_EVENT@@' + JSON.stringify(event) + '\n'); } });
        process.stdout.write(result.outputText);
    } catch (error) {
        console.error(error.message);
        // A stop the worker did not confirm is not an interruption: the execution may still be running there.
        process.exitCode = taskExitCode(error, controller.signal.aborted);
    } finally {
        input?.close();
        process.stdin.pause();
        await runtime?.close();
        await releaseUsage?.();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runRobotTask();
