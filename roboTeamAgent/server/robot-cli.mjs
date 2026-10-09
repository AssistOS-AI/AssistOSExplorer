#!/usr/bin/env node
import { WORKSPACE_COPILOT_PROMPT } from '../copilot/src/lib/prompts.mjs';
import { prepareCopilotContext } from './copilot-context.mjs';
import path from 'node:path';
import { errorFields, logDiagnostic } from '../copilot/src/lib/storage/copilotDiagnostics.mjs';

let releaseUsage;
let diagnosticsDir = process.cwd();
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
    let robotName = 'default';
    const args = [];
    const input = process.argv.slice(2);
    for (let index = 0; index < input.length; index++) {
        const arg = input[index];
        if (arg === '--') { args.push(...input.slice(index)); break; }
        if (arg === '--robot') robotName = input[++index];
        else if (arg.startsWith('--robot=')) robotName = arg.slice(8);
        else args.push(arg);
    }
    if (!robotName) throw new Error('--robot requires a robot name.');
    const context = await prepareCopilotContext(robotName, { holdUsage: true });
    releaseUsage = context.releaseUsage;
    const { setRobotContext } = await import('../copilot/src/lib/execution/robotContext.mjs');
    setRobotContext(context);
    const { main } = await import('../copilot/src/index.mjs');
    await main(args, { workflowSkills: true, systemPrompt: WORKSPACE_COPILOT_PROMPT });
} catch (error) {
    logDiagnostic(diagnosticsDir, 'process.robot-cli.failed', errorFields(error));
    console.error('Robot CLI failed:', error.message);
    process.exitCode = error?.exitCode === 130 ? 130 : 1;
} finally {
    await releaseUsage?.();
}
