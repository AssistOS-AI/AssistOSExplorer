#!/usr/bin/env node
// rwcoord: the coordinator side of the authenticated target admission (slice P7, PROOF-FIXTURE). Runs inside the rwcoord
// agent container, which Ploinky started with its own identity. One request per invocation; prints one JSON line
// {status, answer}; exit 0 when the front admitted, 3 when anything refused (Router or front), 1 on a usage or transport
// error.
//
//   node coordinator.mjs admit --provider <routeKey> --port <n> --selection <text> --origin-request-id <Id>
//        [--surface terminal|browser|desktop] [--agent-lib <dir>]           (live: Ploinky private Router listener)
//        [--local-router <url> --local-caller <agent:...>]                   (LOCAL stand-in, localRouter.mjs)
//   node coordinator.mjs operation-id --coordinator <agent:...> --origin-request-id <Id> [--owner-user <id>]
//   node coordinator.mjs origin-id --seed <text>
//
// Live transport: the request goes to `<internalRouterUrl>/base-agent-additional-server/<routeKey>/<port>/v1/target-admissions`
// from the signed generated Router descriptor, with a private agent assertion over the exact method, path, query and
// body, both from Ploinky's own Agent tree (`<agent-lib>/client/generatedRouterDescriptor.mjs`,
// `<agent-lib>/lib/agentAssertion.mjs`; default /Agent, mounted in every agent container). Nothing here names the caller:
// the Router derives it from the assertion. No token, assertion or secret is printed.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { canonicalJson } from '../../../../server/stateProtocol.mjs';
import { TARGET_ADMISSION_PATH, deriveTargetOperationId } from './admissionFront.mjs';

export const AGENT_PORT_PREFIX = '/base-agent-additional-server';
// The LOCAL stand-in's caller header (localRouter.mjs, self-tests only); the live transport never sends it.
export const LOCAL_CALLER_HEADER = 'x-rwcoord-local-caller';
const ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

export function admissionRequestPath(providerRoute, port) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(providerRoute)) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new TypeError('admissionRequestPath: provider route key and port are required');
    }
    return `${AGENT_PORT_PREFIX}/${providerRoute}/${port}${TARGET_ADMISSION_PATH}`;
}

// The exact request body (canonical JSON); the Router's rch binds these bytes.
export function admissionBody({ originRequestId, selection, surface = 'terminal' }) {
    return Buffer.from(canonicalJson({ version: 1, originRequestId, selection, surface }), 'utf8');
}

// A deterministic origin request ID (16 bytes, base64url) for fixture runs.
export function originIdFor(seed) {
    return crypto.createHash('sha256').update(`rwcoord-origin:${seed}`).digest().subarray(0, 16).toString('base64url');
}

function post(url, headers, body) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), Accept: 'application/json', ...headers } }, (response) => {
            const chunks = [];
            let total = 0;
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > RESPONSE_BYTES) response.destroy(new Error('response too large'));
                else chunks.push(chunk);
            });
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
            response.on('error', reject);
        });
        request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('request timed out')));
        request.on('error', reject);
        request.end(body);
    });
}

async function liveTransport(agentLib) {
    const root = path.resolve(agentLib);
    const descriptorModule = await import(path.join(root, 'client', 'generatedRouterDescriptor.mjs'));
    const assertionModule = await import(path.join(root, 'lib', 'agentAssertion.mjs'));
    return async (requestPath, body) => {
        const descriptor = descriptorModule.loadVerifiedGeneratedRouterDescriptor({ env: process.env });
        const url = new URL(requestPath, descriptor.payload.internalRouterUrl);
        if (url.protocol !== 'http:' || url.pathname !== requestPath || url.search) throw new Error('generated private Router location is invalid');
        const assertion = assertionModule.signPrivateRouterAssertion({ method: 'POST', path: requestPath, query: '', body, env: process.env });
        return post(url, { [ASSERTION_HEADER]: assertion }, body);
    };
}

function localTransport(routerUrl, caller) {
    return async (requestPath, body) => post(new URL(requestPath, routerUrl), { [LOCAL_CALLER_HEADER]: caller }, body);
}

function parse(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index];
        if (!flag.startsWith('--') || index + 1 >= rest.length || options[flag] !== undefined) throw new Error(`unexpected argument ${flag}`);
        options[flag] = rest[index + 1];
    }
    return { command, options };
}

function interpret(answer) {
    let parsed = null;
    try {
        parsed = JSON.parse(answer.body.toString('utf8'));
    } catch {
        parsed = null;
    }
    // A Router refusal carries {error: CODE}; a front answer {ok, ...}.
    return { status: answer.status, answer: parsed };
}

async function main(argv) {
    const { command, options } = parse(argv);
    if (command === 'operation-id') {
        const value = deriveTargetOperationId({ coordinator: options['--coordinator'], ownerUserId: options['--owner-user'] ?? null, originRequestId: options['--origin-request-id'] });
        process.stdout.write(`${JSON.stringify({ operationId: value })}\n`);
        return 0;
    }
    if (command === 'origin-id') {
        if (typeof options['--seed'] !== 'string') throw new Error('missing --seed');
        process.stdout.write(`${JSON.stringify({ originRequestId: originIdFor(options['--seed']) })}\n`);
        return 0;
    }
    if (command !== 'admit') throw new Error(`unknown command ${command}`);
    for (const required of ['--provider', '--port', '--selection', '--origin-request-id']) {
        if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    }
    const local = options['--local-router'] !== undefined;
    if (local !== (options['--local-caller'] !== undefined) || (local && options['--agent-lib'] !== undefined)) {
        throw new Error('--local-router and --local-caller go together and exclude --agent-lib');
    }
    const transport = local ? localTransport(options['--local-router'], options['--local-caller']) : await liveTransport(options['--agent-lib'] ?? '/Agent');
    const requestPath = admissionRequestPath(options['--provider'], Number(options['--port']));
    const body = admissionBody({ originRequestId: options['--origin-request-id'], selection: options['--selection'], surface: options['--surface'] ?? 'terminal' });
    const result = interpret(await transport(requestPath, body));
    process.stdout.write(`${JSON.stringify({ ...result, transport: local ? 'local-stand-in' : 'ploinky-private-router' })}\n`);
    return result.status === 200 && result.answer?.ok === true ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`rwcoord: ${String(error.message).slice(0, 200)}\n`);
        process.exitCode = 1;
    });
}
