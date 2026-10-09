#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createWebAssistAgent } from './WebAssistAgent.mjs';
import {
    LOCAL_OPERATOR_ACCESS,
    callerAccessFromEnvelope,
    formatToolError,
    generateSessionId,
    publicError,
} from './runtime/sessionAccess.mjs';

function printUsage() {
    process.stdout.write(`Usage:\n  webAssist/src/index.mjs --site-id <site-id> "message"\n  webAssist/src/index.mjs -mcp --site-id <site-id> "message"\n\nOptions:\n  -mcp                         Run a single request and exit\n  --site-id <id>               Website scope id\n  --session-id <id>            Reuse a specific session id\n  --json                       Print JSON output from runtime\n  -h, --help                   Show this help\n`);
}

function parseArguments(argv) {
    const positionals = [];
    const options = {
        mode: 'interactive',
        siteId: '',
        sessionId: '',
        json: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];

        if (token === '--') {
            for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
                positionals.push(argv[cursor]);
            }
            break;
        }

        if (token === '-mcp') {
            options.mode = 'mcp';
            continue;
        }

        if (token === '--json') {
            options.json = true;
            continue;
        }

        if (token === '-h' || token === '--help') {
            options.help = true;
            continue;
        }

        if (token.startsWith('--site-id=')) {
            options.siteId = token.slice('--site-id='.length);
            continue;
        }

        if (token === '--site-id') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --site-id');
            }
            options.siteId = value;
            index += 1;
            continue;
        }

        if (token.startsWith('--session-id=')) {
            options.sessionId = token.slice('--session-id='.length);
            continue;
        }

        if (token === '--session-id') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --session-id');
            }
            options.sessionId = value;
            index += 1;
            continue;
        }

        if (token.startsWith('-')) {
            throw new Error(`Unknown option: ${token}`);
        }

        positionals.push(token);
    }

    return {
        ...options,
        message: positionals.join(' ').trim(),
    };
}

function parseMcpEnvelope(rawInput) {
    const trimmed = String(rawInput ?? '').trim();
    if (!trimmed) {
        return null;
    }
    try {
        const envelope = JSON.parse(trimmed);
        return envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : null;
    } catch {
        return null;
    }
}

function parseMcpPayload(envelope) {
    try {
        if (!envelope || typeof envelope !== 'object') {
            return null;
        }

        const input = envelope.input && typeof envelope.input === 'object'
            ? envelope.input
            : envelope;

        const messageCandidates = [
            input.message,
            input.prompt,
            input.promptText,
            input.text,
            input.query,
        ];

        const message = messageCandidates
            .find((value) => typeof value === 'string' && value.trim())
            ?.trim() || '';

        return {
            isEnvelope: Boolean(envelope.input),
            message,
            sessionId: typeof input.sessionId === 'string' ? input.sessionId.trim() : '',
            // Used only to decide session reuse; never logged or echoed.
            sessionSecret: typeof input.sessionSecret === 'string' ? input.sessionSecret : '',
            json: input.json === true,
            siteId: typeof input.siteId === 'string' ? input.siteId.trim() : '',
        };
    } catch {
        return null;
    }
}

async function readStdin() {
    if (process.stdin.isTTY) {
        return '';
    }

    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data;
}

async function runTurn(agent, {
    sessionId,
    siteId,
    message,
    jsonOutput,
}) {
    const result = await agent.handleMessage({ siteId, sessionId, message, access: LOCAL_OPERATOR_ACCESS });
    if (jsonOutput) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${result.response}\n`);
}

// One `web_cli_chat` MCP call. The caller is decided only from the verified
// grant in the AgentServer envelope; the effective session comes back from
// `handleMessage`, with `sessionSecret` present only when a new owned session
// was created. Returns the process output instead of writing it, so `main` is
// the only writer.
export async function handleMcpRequest(stdinRaw, { createAgent = createWebAssistAgent, cli = {} } = {}) {
    let access = null;
    try {
        const envelope = parseMcpEnvelope(stdinRaw);
        access = await callerAccessFromEnvelope(envelope || {});
        if (!access) {
            throw publicError('Access denied: a verified visitor or user is required.');
        }
        const payload = parseMcpPayload(envelope) || {};
        const siteId = cli.siteId || payload.siteId || '';
        const message = cli.message || payload.message || '';
        if (!siteId) {
            throw publicError('webAssist requires --site-id.');
        }
        if (!message) {
            throw publicError('MCP mode requires a message.');
        }

        const agent = await createAgent();
        const result = await agent.handleMessage({
            siteId,
            sessionId: cli.sessionId || payload.sessionId || '',
            sessionSecret: payload.sessionSecret || '',
            message,
            access,
        });
        const output = {
            siteId: String(result.siteId ?? siteId ?? '').trim(),
            sessionId: String(result.sessionId ?? '').trim(),
            message: String(result.response ?? '').trim(),
        };
        if (result.sessionSecret) {
            output.sessionSecret = result.sessionSecret;
        }
        return { exitCode: 0, stdout: `${JSON.stringify(output, null, 2)}\n`, stderr: '' };
    } catch (error) {
        return { exitCode: 1, stdout: '', stderr: `${formatToolError(error, access)}\n` };
    }
}

async function runInteractive(agent, state) {
    if (!state.json) {
        process.stdout.write(`Site ID: ${state.siteId}\n`);
        process.stdout.write(`Session ID: ${state.sessionId}\n`);
        process.stdout.write('Type exit to leave\n');
    }

    if (state.message) {
        await runTurn(agent, {
            siteId: state.siteId,
            sessionId: state.sessionId,
            message: state.message,
            jsonOutput: state.json,
        });
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'you> ',
    });

    rl.on('SIGINT', () => {
        process.stdout.write('\n');
        rl.close();
        process.exit(130);
    });

    rl.prompt();
    for await (const line of rl) {
        const text = line.trim();
        if (!text) {
            rl.prompt();
            continue;
        }

        if (text === 'exit' || text === 'quit' || text === ':q') {
            rl.close();
            break;
        }

        await runTurn(agent, {
            siteId: state.siteId,
            sessionId: state.sessionId,
            message: text,
            jsonOutput: state.json,
        });
        rl.prompt();
    }
}

async function main() {
    const cli = parseArguments(process.argv.slice(2));
    if (cli.help) {
        printUsage();
        return;
    }

    const stdinRaw = await readStdin();

    if (cli.mode === 'mcp') {
        const result = await handleMcpRequest(stdinRaw, { cli });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.exitCode;
        return;
    }

    const effective = {
        siteId: cli.siteId,
        sessionId: cli.sessionId || generateSessionId(),
        json: cli.json,
        message: cli.message,
    };
    if (!effective.siteId) {
        throw new Error('webAssist requires --site-id.');
    }

    const agent = await createWebAssistAgent();
    await runInteractive(agent, effective);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

export { createWebAssistAgent } from './WebAssistAgent.mjs';
