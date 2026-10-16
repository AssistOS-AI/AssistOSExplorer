/** Execute a parsed command through the SDK inside ALA's native sandbox. */
import { parseCommandLine } from './parser.mjs';
import { expandGlobsInArgs } from './globExpander.mjs';

function parsePrompt(prompt) {
    if (typeof prompt !== 'string') {
        return prompt?.command || '';
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
        return '';
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
            return parsed.command;
        }
    } catch {
        // Plain command text.
    }
    return prompt;
}

export async function action(invocation = {}) {
    const prompt = parsePrompt(invocation.promptText);
    const { command, args, raw } = parseCommandLine(prompt);

    if (!command) {
        return 'Error: No command provided. Usage: bash <command> [args...]';
    }
    const expandedArgs = expandGlobsInArgs(args, invocation.workingDir);

    if (typeof invocation.bashExecutor !== 'function') {
        return 'Execution denied: the sandboxed Bash executor is unavailable.';
    }

    const result = await invocation.bashExecutor({
        command,
        args: expandedArgs,
        raw,
    });

    if (result.pending) {
        return `Execution pending: ${result.error}`;
    }
    if (result.denied) {
        return `Execution denied: ${result.error}`;
    }

    if (!result.success) {
        const details = [result.error, result.output, result.stderr].filter(Boolean).join('\n');
        return `Error: ${details || 'Command failed.'}`;
    }

    return result.output || '(no output)';
}

export default action;
