#!/usr/bin/env node
import { WORKSPACE_COPILOT_PROMPT } from '../copilot/src/lib/prompts.mjs';
import { prepareCopilotContext } from './copilot-context.mjs';
import path from 'node:path';
import { errorFields, logDiagnostic } from '../copilot/src/lib/storage/copilotDiagnostics.mjs';

let releaseUsage;
let diagnosticsDir = process.cwd();
// Service/container shutdown detaches this controller. Explicit UI Stop and
// Ctrl-C still reach the engine cancellation path.
process.prependOnceListener('SIGTERM', () => process.exit(0));
// Diagnostics only. The monitor observes uncaught exceptions and unhandled rejections without
// handling them, so the process still crashes or exits exactly as it did before.
{
    const argv = process.argv.slice(2);
    const index = argv.findIndex((arg) => arg === '--dir' || arg === '-d' || arg.startsWith('--dir='));
    const dir = index === -1 ? process.cwd()
        : argv[index].startsWith('--dir=') ? argv[index].slice(6) : (argv[index + 1] || process.cwd());
    diagnosticsDir = path.resolve(dir);
    process.on('uncaughtExceptionMonitor', (error, origin) => logDiagnostic(diagnosticsDir, 'process.uncaught',
        { origin, ...errorFields(error) }));
    process.on('exit', (code) => logDiagnostic(diagnosticsDir, 'process.exit', { code, exitCode: process.exitCode ?? null }));
}
try {
    // RoboTeam opens a robot's chat with --robot-id; --robot <name> is for a person in a terminal, and the
    // WebChat link also carries it, as the display label, beside the id.
    let robotId = null;
    let robotName = null;
    const args = [];
    const input = process.argv.slice(2);
    for (let index = 0; index < input.length; index++) {
        const arg = input[index];
        if (arg === '--') { args.push(...input.slice(index)); break; }
        if (arg === '--robot-id') robotId = input[++index] ?? '';
        else if (arg.startsWith('--robot-id=')) robotId = arg.slice(11);
        else if (arg === '--robot') robotName = input[++index] ?? '';
        else if (arg.startsWith('--robot=')) robotName = arg.slice(8);
        else args.push(arg);
    }
    if (robotId === '') throw new Error('--robot-id requires a robot id.');
    if (robotName === '') throw new Error('--robot requires a robot name.');
    const context = await prepareCopilotContext(robotId ? { id: robotId } : { name: robotName }, { holdUsage: true });
    releaseUsage = context.releaseUsage;
    const { setRobotContext } = await import('../copilot/src/lib/execution/robotContext.mjs');
    setRobotContext(context);
    // The copilot publishes its runs to Live Sessions; robot tasks never do.
    process.env.ROBOTEAM_LIVE_PUBLISH = 'copilot';
    const { main } = await import('../copilot/src/index.mjs');
    await main(args, { workflowSkills: true, systemPrompt: WORKSPACE_COPILOT_PROMPT });
} catch (error) {
    logDiagnostic(diagnosticsDir, 'process.robot-cli.failed', errorFields(error));
    console.error('Robot CLI failed:', error.message);
    process.exitCode = error?.exitCode === 130 ? 130 : 1;
} finally {
    await releaseUsage?.();
}
