#!/usr/bin/env node
// rwworker command line (slice P6b, PROOF-FIXTURE). One step per invocation; the worker's durable state lives in
// --state, so the host can be restarted between steps (as Ploinky may restart an agent at any time). Prints one
// canonical JSON result line; exit 0 when the step succeeded, 3 when it refused, 1 on a usage or internal error.
//
//   node main.mjs --state <dir> --mailbox <socket> --peer <rw-target-helper> --store-root <dir> [--facts <file>]
//                 [--router-tickets [--agent-lib <dir>]] <command>
//     admit --selection <Ref> --operation-id <OperationId>     (facts file: {facts, fixtureDigests})
//     define <label> --resources <n> --seed <text> [--same-operation-as <label>] [--kinds <k1,k2,..>] [--workload <json>]
//     prepare <label> [--drop] | lookup <label> [--lose-accepted] [--needle-fd <n>] | commit <label> [--revalidate]
//     revalidate | state | stop <label> | release <label> | rebind   (slice P8; rebind reads the facts file)
//     advance [--prior-generation <Id>]                        (--router-tickets only: register a new worker generation;
//                                                              the prior one for a state directory that has none yet)
//
// --router-tickets: tickets and session keys come from Ploinky's private helper-ticket operation (mint route spec
// 2026-10-30) through `server/helperTicketClient.mjs` over the agent transport `<agent-lib>/helperTicketTransport.mjs`
// (default /Agent/lib, the Ploinky Agent tree mounted in every agent container; the signed private agent assertion uses
// the identity Ploinky put in this container's environment). No fixture key is loaded. `advance` registers the worker
// generation in Ploinky's source-protection store over `<agent-lib>/sourceProtectionTransport.mjs` (Q3).
// --needle-fd <n> (U7/R3 scan, --router-tickets lookup only): the needles of that live session are written to fd n,
// which must be a pipe to the operator's scanner; nothing else ever receives them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalTargetJson } from '../../../../server/executionTarget/contract.mjs';
import { createHelperTicketClient } from '../../../../server/helperTicketClient.mjs';
import { createSourceProtectionClient } from '../../../../server/sourceProtectionClient.mjs';
import { loadFixtureTicketKey } from './fixtureMinter.mjs';
import { ROUTER_TIMEOUT_MS, createWorkerHost } from './workerHost.mjs';

const VALUED = new Set(['--state', '--mailbox', '--peer', '--store-root', '--facts', '--selection', '--operation-id', '--resources', '--seed', '--same-operation-as', '--kinds', '--workload', '--agent-lib', '--needle-fd', '--prior-generation']);
const FLAGS = new Set(['--drop', '--revalidate', '--lose-accepted', '--router-tickets']);
// The Router answers within its own bounds (`ROUTER_TIMEOUT_MS`, which the mint retry budget of workerHost.mjs reserves for
// every request); a slower answer is an unknown outcome (terminal for this attempt).

function parse(argv) {
    const options = {};
    const positional = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (VALUED.has(arg) && index + 1 < argv.length && options[arg] === undefined) options[arg] = argv[++index];
        else if (FLAGS.has(arg) && options[arg] === undefined) options[arg] = true;
        else if (!arg.startsWith('--')) positional.push(arg);
        else throw new Error(`unexpected argument ${arg}`);
    }
    for (const required of ['--state', '--mailbox', '--peer', '--store-root']) if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    return { options, positional };
}

// `kinds` (slice P8): explicit resource kinds, one resource each (the keeper supervisor needs one keeper and at most one
// of each other kind); otherwise `count` resources: a keeper, then gates.
function resourcesFor(count, seed, kinds = null) {
    const id = (label) => crypto.createHash('sha256').update(`rwworker-resource:${seed}:${label}`).digest().subarray(0, 16).toString('base64url');
    const list = kinds ?? Array.from({ length: count }, (_, index) => (index === 0 ? 'keeper' : 'gate'));
    return list.map((kind, index) => ({
        resourceId: id(index), kind,
        locatorDigest: crypto.createHash('sha256').update(`rwworker-locator:${seed}:${index}`).digest('hex')
    }));
}

// The Router-mode seams: the helper-ticket client and the source-protection client over the Ploinky agent transports.
async function routerSeams(agentLib) {
    const dir = path.resolve(agentLib);
    for (const name of ['helperTicketTransport.mjs', 'sourceProtectionTransport.mjs']) {
        if (!fs.existsSync(path.join(dir, name))) throw new Error(`agent transport ${name} is unavailable`);
    }
    const tickets = await import(path.join(dir, 'helperTicketTransport.mjs'));
    const source = await import(path.join(dir, 'sourceProtectionTransport.mjs'));
    const client = createHelperTicketClient({ transport: (bytes) => tickets.postHelperTicketRequest(bytes, { timeoutMs: ROUTER_TIMEOUT_MS }) });
    const self = {
        principal: String(process.env.PLOINKY_AGENT_ID || ''), runtimeInstanceId: String(process.env.PLOINKY_AGENT_INSTANCE_ID || ''),
        enableGeneration: String(process.env.PLOINKY_AGENT_ENABLE_GENERATION || '')
    };
    return {
        mintTicket: client.mintTicket, self,
        sourceProtection: createSourceProtectionClient({ transport: (bytes) => source.postSourceProtection(bytes) })
    };
}

// The scan sink: fd `fd` must be a pipe; the needles go there once and the fd is closed.
function needleSink(fd) {
    if (!Number.isSafeInteger(fd) || fd < 3 || !fs.fstatSync(fd).isFIFO()) throw new Error('--needle-fd must name an inherited pipe');
    return (needles) => {
        fs.writeSync(fd, `${JSON.stringify({ needles })}\n`);
        fs.closeSync(fd);
    };
}

function emit(result) {
    const text = canonicalTargetJson(result, { maxBytes: 1 << 20 });
    process.stdout.write(`${text.ok ? text.value : JSON.stringify(result)}\n`);
}

async function main(argv) {
    const { options, positional } = parse(argv);
    const [command, label] = positional;
    const facts = options['--facts'] ? JSON.parse(fs.readFileSync(options['--facts'], 'utf8')) : null;
    const router = options['--router-tickets'] === true;
    if (!router && (command === 'advance' || options['--needle-fd'] !== undefined || options['--agent-lib'] !== undefined)) throw new Error(`${command === 'advance' ? 'advance' : 'this option'} needs --router-tickets`);
    if (options['--needle-fd'] !== undefined && command !== 'lookup') throw new Error('--needle-fd applies to lookup only');
    const sink = options['--needle-fd'] === undefined ? null : needleSink(Number(options['--needle-fd']));
    const seams = router ? await routerSeams(options['--agent-lib'] ?? '/Agent/lib') : { ticketKey: loadFixtureTicketKey() };
    const host = createWorkerHost({
        stateDir: path.resolve(options['--state']), mailbox: options['--mailbox'], peerCommand: options['--peer'], ...seams,
        qualification: { root: path.resolve(options['--store-root']), uid: process.getuid(), forbiddenRoots: [] }
    });
    let result;
    switch (command) {
    case 'admit':
        result = host.admit({ selection: options['--selection'], facts: facts.facts, operationId: options['--operation-id'], fixtureDigests: facts.fixtureDigests });
        break;
    case 'define':
        result = {
            ok: true,
            ...host.defineOperation(label, {
                resources: resourcesFor(Number(options['--resources'] ?? 1), options['--seed'] ?? label, options['--kinds'] ? options['--kinds'].split(',') : null),
                sameOperationAs: options['--same-operation-as'] ?? null,
                workload: options['--workload'] ? JSON.parse(options['--workload']) : null
            })
        };
        break;
    case 'prepare':
        result = await host.prepare(label, { drop: options['--drop'] === true });
        break;
    case 'lookup':
        result = await host.lookup(label, { loseAccepted: options['--lose-accepted'] === true, scan: sink ? { sink } : null });
        break;
    case 'commit':
        result = await host.commit(label, { facts: options['--revalidate'] ? facts.facts : null });
        break;
    case 'revalidate':
        result = host.revalidate(facts.facts);
        break;
    case 'state':
        result = { ok: true, state: host.state() };
        break;
    case 'stop':
        result = await host.stop(label);
        break;
    case 'release':
        result = await host.release(label);
        break;
    case 'advance':
        result = await host.advanceGeneration({ priorGeneration: options['--prior-generation'] ?? null });
        break;
    case 'rebind':
        result = host.rebind({ facts: facts.facts, fixtureDigests: facts.fixtureDigests });
        break;
    default:
        throw new Error(`unknown command ${command}`);
    }
    emit(result);
    return result.ok === true ? 0 : 3;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`rwworker: ${error.message}\n`);
    process.exitCode = 1;
});
