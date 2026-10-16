import { parseArgs } from 'node:util';
import { action } from './action.mjs';

let invocation;
try {
    const { values } = parseArgs({
        options: { input: { type: 'string' } },
        strict: true,
        allowPositionals: false,
    });
    const { createSkillInvocation } = await import('./ploinkyInvocation.mjs');
    invocation = await createSkillInvocation({ skillName: 'list-workflows', input: values.input ?? '' });
    console.log(await action(invocation));
} catch (error) {
    console.error(error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'The Ploinky MCP client is unavailable; execute this script in a Ploinky-enabled environment.'
        : error?.message || 'Skill execution failed.');
    process.exitCode = 1;
} finally {
    if (invocation) await invocation.close();
}
