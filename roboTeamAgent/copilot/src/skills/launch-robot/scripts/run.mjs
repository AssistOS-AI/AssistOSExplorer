import { parseArgs } from 'node:util';
import { action } from './action.mjs';

let invocation;
try {
    const { values } = parseArgs({
        options: { input: { type: 'string' } },
        strict: true,
        allowPositionals: false,
    });
    if (values.input === undefined) throw new Error('Usage: node scripts/run.mjs --input <string>');
    const { createSkillInvocation } = await import('./ploinkyInvocation.mjs');
    invocation = await createSkillInvocation({ skillName: 'launch-robot', input: values.input });
    const result = await action(invocation);
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
} catch (error) {
    console.error(error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'The Ploinky MCP client is unavailable; execute this script in a Ploinky-enabled environment.'
        : error?.message || 'Skill execution failed.');
    process.exitCode = 1;
} finally {
    if (invocation) await invocation.close();
}
