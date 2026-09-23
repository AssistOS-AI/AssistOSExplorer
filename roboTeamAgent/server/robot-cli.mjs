#!/usr/bin/env node
import { prepareCopilotContext } from './copilot-context.mjs';

let releaseUsage;
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
    const { setRobotContext } = await import('../copilot/src/lib/robotContext.mjs');
    setRobotContext(context);
    const { main } = await import('../copilot/src/index.mjs');
    await main(args, { workflowCatalog: true, systemPrompt: "You are the workspace copilot. Choose and start one workflow for the user's request using launch-workflow. Only when choosing workflow default, also select executionType terminal, desktop or browser. For other workflows their task definitions determine execution modes; do not override them. Do not launch individual robots or control graph traversal. Use the supplied workflow catalog and never invent workflow IDs." });
} catch (error) {
    console.error('Robot CLI failed:', error.message);
    process.exitCode = error?.exitCode === 130 ? 130 : 1;
} finally {
    await releaseUsage?.();
}
