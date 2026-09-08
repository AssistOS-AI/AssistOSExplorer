import fs from 'node:fs/promises';
import readline from 'node:readline';
import { prepareCopilotContext } from './copilot-context.mjs';
import { setRobotContext } from '../copilot/src/lib/robotContext.mjs';
import { createCliRuntime } from '../copilot/src/index.mjs';

const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    options[key] = ['--resume-session', '--control-stdin'].includes(key) ? true : argv[++index];
}
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGTERM', abort);
process.once('SIGINT', abort);
let runtime;
let input;
let releaseUsage;
try {
    const context = await prepareCopilotContext(options['--robot'], { prepareTools: false, holdUsage: true });
    setRobotContext(context);
    releaseUsage = context.releaseUsage;
    const skillSelection = process.env.ROBOTEAM_TASK_SKILL_SELECTION
        ? JSON.parse(process.env.ROBOTEAM_TASK_SKILL_SELECTION) : undefined;
    delete process.env.ROBOTEAM_TASK_SKILL_SELECTION;
    runtime = await createCliRuntime({ workingDir: options['--cwd'], skillRoots: [],
        sessionId: options['--session-id'], resumeSession: Boolean(options['--resume-session']), skillSelection,
        execution: { backend: options['--ca'] === 'auto' ? undefined : options['--ca'],
            model: options['--model'], mcpServers: options['--MCPServers'], permissions: 'full-access' } });
    let control;
    input = readline.createInterface({ input: process.stdin });
    input.on('line', (line) => {
        try { const message = JSON.parse(line); if (message.type === 'message') control?.(message); }
        catch { console.error('Invalid task control message.'); }
    });
    const prompt = await fs.readFile(options['--taskFile'], 'utf8');
    const result = await runtime.engine.executeTurn({ sessionId: runtime.initialSession.sessionId, prompt,
        signal: controller.signal, context: { workingDir: options['--cwd'], rawText: prompt },
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
