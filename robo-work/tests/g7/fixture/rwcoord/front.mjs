#!/usr/bin/env node
// rwcoord front process (slice P7, PROOF-FIXTURE): serves the authenticated target-admission front inside the worker
// container, as the provider of the worker's declared coordinator route. It reads the worker identity Ploinky put in
// the container (PLOINKY_AGENT_ID, PLOINKY_AGENT_INSTANCE_ID, PLOINKY_AGENT_ENABLE_GENERATION) and the worker's own
// per-agent secret (PLOINKY_AGENT_SECRET, the key the Router signs this worker's Router Requests with); the secret is
// never printed, logged or written. One JSON event line per request goes to stdout (no tokens, bodies or secrets).
//
//   node front.mjs serve --port <n> --store-root <dir> --facts <file> --state <dir> --coordinator <agent:...>
//        [--coordinator <agent:...>]... --worker-generation <Id> [--mode proof-fixture|production] [--agent-lib <dir>]
//   node front.mjs observe --store-root <dir> --state <dir> --ref <Repo/agent>
//
// Base facts file (operator, re-read for every request): {live, entries, sourceState, home, current: {limitsDigest,
// journalStoreIdentity}, excluded: {principals, aliases, runtimeInstanceIds}}. `sourceState` is either the FIXTURE
// object, or {provider: "ploinky", supplement: {...}}: then the record comes from Ploinky's source-protection `state`
// operation (server/sourceProtectionClient.mjs over `<agent-lib>/lib/sourceProtectionTransport.mjs`, the worker's private
// agent assertion) and only the remaining facts come from `supplement`; an error, a missing record or a pending
// transition leaves the record absent, so the decision is source_unavailable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReplayCache, createVerifierConfig } from '../../../../server/coordinatorAuth.mjs';
import { createSourceProtectionClient } from '../../../../server/sourceProtectionClient.mjs';
import { createQualificationStore } from '../../../../server/executionTarget/qualificationStore.mjs';
import { createAdmissionFront, serveAdmissionFront } from './admissionFront.mjs';

const FACTS_BYTES = 4 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 5000;

function parse(argv) {
    const [command, ...rest] = argv;
    const options = { '--coordinator': [] };
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index];
        if (!flag.startsWith('--') || index + 1 >= rest.length) throw new Error(`unexpected argument ${flag}`);
        if (flag === '--coordinator') options[flag].push(rest[index + 1]);
        else if (options[flag] !== undefined) throw new Error(`repeated ${flag}`);
        else options[flag] = rest[index + 1];
    }
    return { command, options };
}

function readFacts(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > FACTS_BYTES) throw new Error('facts file is unsafe');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The {provider: "ploinky"} source-state provider; any other value is passed through (FIXTURE object).
function sourceStateProvider(agentLib) {
    let client = null;
    return async (value) => {
        if (!isPlainObject(value) || !Object.hasOwn(value, 'provider')) return value;
        if (value.provider !== 'ploinky' || !isPlainObject(value.supplement)) return null;
        if (client === null) {
            const transport = await import(path.join(path.resolve(agentLib), 'lib', 'sourceProtectionTransport.mjs'));
            client = createSourceProtectionClient({ transport: (bytes) => transport.postSourceProtection(bytes, { timeoutMs: SOURCE_TIMEOUT_MS }) });
        }
        const answer = await client.readSourceState();
        if (!answer || answer.ok !== true || !isPlainObject(answer.value) || answer.value.transition !== null || !isPlainObject(answer.value.record)) return null;
        return { ...value.supplement, record: answer.value.record };
    };
}

function workerIdentity(generation) {
    const principal = String(process.env.PLOINKY_AGENT_ID || '').trim();
    const runtimeInstanceId = String(process.env.PLOINKY_AGENT_INSTANCE_ID || '').trim();
    const enableGeneration = String(process.env.PLOINKY_AGENT_ENABLE_GENERATION || '').trim();
    const hex = String(process.env.PLOINKY_AGENT_SECRET || '').trim();
    if (!principal || !runtimeInstanceId || !enableGeneration || !/^[0-9a-f]{64,}$/i.test(hex)) throw new Error('the worker identity Ploinky provides is unavailable');
    return { worker: { principal, runtimeInstanceId, enableGeneration, generation }, secret: Buffer.from(hex, 'hex') };
}

async function serve(options) {
    for (const required of ['--port', '--store-root', '--facts', '--state', '--worker-generation']) {
        if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    }
    if (options['--coordinator'].length < 1) throw new Error('at least one --coordinator is required');
    const { worker, secret } = workerIdentity(options['--worker-generation']);
    const verifier = createVerifierConfig({ secret, audience: worker.principal, coordinators: options['--coordinator'], replayCache: createReplayCache() });
    secret.fill(0);
    const factsFile = path.resolve(options['--facts']);
    const front = createAdmissionFront({
        verifier, worker, mode: options['--mode'] ?? 'proof-fixture',
        store: { fs, root: path.resolve(options['--store-root']), uid: process.getuid(), forbiddenRoots: [] },
        loadBaseFacts: () => readFacts(factsFile), sourceState: sourceStateProvider(options['--agent-lib'] ?? '/Agent'),
        stateDir: path.resolve(options['--state']),
        log: (event) => process.stdout.write(`${JSON.stringify({ event: 'request', ...event })}\n`)
    });
    const server = await serveAdmissionFront(front, { port: Number(options['--port']) });
    process.stdout.write(`${JSON.stringify({ event: 'listening', port: server.address().port, worker: worker.principal, coordinators: options['--coordinator'], mode: options['--mode'] ?? 'proof-fixture' })}\n`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

// Read-only observation for the driver: the execution count of one record and the recorded admissions.
function observe(options) {
    for (const required of ['--store-root', '--state', '--ref']) if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    const opened = createQualificationStore({ fs, root: path.resolve(options['--store-root']), uid: process.getuid(), forbiddenRoots: [] });
    const facts = opened.ok ? opened.value.facts() : null;
    const found = opened.ok ? opened.value.get(options['--ref']) : null;
    const admissionsDir = path.join(path.resolve(options['--state']), 'admissions');
    const admissions = fs.existsSync(admissionsDir) ? fs.readdirSync(admissionsDir).filter((name) => /^[A-Za-z0-9_-]{22}\.json$/.test(name)).map((name) => name.slice(0, 22)).sort() : [];
    const result = {
        ref: options['--ref'], storeOpen: opened.ok, recordDigest: found && found.ok ? found.value.recordDigest : null,
        executionsUsed: facts && facts.ok && Object.hasOwn(facts.value.executionsUsed, options['--ref']) ? facts.value.executionsUsed[options['--ref']] : null,
        admissions, admissionsDigest: crypto.createHash('sha256').update(admissions.join(',')).digest('hex')
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(argv) {
    const { command, options } = parse(argv);
    if (command === 'serve') return serve(options);
    if (command === 'observe') return observe(options);
    throw new Error(`unknown command ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`rwcoord front: ${String(error.message).slice(0, 200)}\n`);
    process.exitCode = 1;
});
