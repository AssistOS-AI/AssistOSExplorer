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
    await main(args);
} catch (error) {
    console.error('Robot CLI failed:', error.message);
    process.exitCode = error?.exitCode === 130 ? 130 : 1;
} finally {
    await releaseUsage?.();
}
