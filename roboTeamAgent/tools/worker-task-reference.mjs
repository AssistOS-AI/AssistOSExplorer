import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { errorResult, mapHopOutcome } from '../server/worker-coordinator/errors.mjs';
import { admissionBody } from '../server/worker-coordinator/browser-routes.mjs';

// The MCP robot-tool row of the worker coordinator (design S3c §6.7): the program behind a
// `taskReference` tool. Its only evidence is the Router origin token the AgentServer attached to
// this forwarded call (`metadata.taskRefOrigin`) and the declared tool name; it never forwards a
// user grant, whatever the invocation metadata carries. The calling client persists the origin and
// recovers a lost reply through its own `/task-refs` lookup, so this program stores nothing and
// never retries: the origin token is single-use.
//
//   node tools/worker-task-reference.mjs <toolName>   stdin: {input, metadata}
//   input: {originRequestId, robotId, configRevision, task: {type, prompt, cwd?}}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const ORIGIN_TOKEN_LIMIT = 16 * 1024;

const failure = (code) => ({ ok: false, code });

export async function runWorkerTaskReference({ payload, toolName, hop }) {
    if (typeof toolName !== 'string' || !TOOL_NAME.test(toolName)) return failure('invalid_request');
    const origin = payload?.metadata?.taskRefOrigin;
    if (typeof origin !== 'string' || origin.length === 0 || origin.length > ORIGIN_TOKEN_LIMIT) return failure('owner_evidence_unavailable');
    let admission;
    try {
        const input = payload?.input;
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'kind') || Object.hasOwn(input, 'logicalId')) {
            return failure('invalid_request');
        }
        admission = admissionBody({ ...input, kind: 'task' });
    } catch {
        return failure('invalid_request');
    }
    const body = { ...admission, taskRefOrigin: origin, originTool: toolName };
    let outcome;
    try {
        outcome = await hop.call('admissions', body);
    } catch (error) {
        return failure(errorResult(error).body.error);
    }
    const mapped = mapHopOutcome(outcome);
    return mapped.status === 200 ? { ok: true, output: JSON.stringify(mapped.body) } : failure(mapped.body.error);
}

async function readStdin() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw || '{}');
}

async function main() {
    let payload;
    try {
        payload = await readStdin();
    } catch {
        payload = null;
    }
    const result = payload
        ? await runWorkerTaskReference({ payload, toolName: process.argv[2], hop: createWorkerCoordinatorHop({ env: process.env }) })
        : failure('invalid_request');
    if (result.ok) {
        process.stdout.write(result.output);
        return;
    }
    process.stderr.write(`worker admission failed: ${result.code}\n`);
    process.exitCode = 1;
}

function invokedDirectly() {
    try {
        return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (invokedDirectly()) await main();
