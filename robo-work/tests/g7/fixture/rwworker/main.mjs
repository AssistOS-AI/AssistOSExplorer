#!/usr/bin/env node
// rwworker command line (slice P6b, PROOF-FIXTURE). One step per invocation; the worker's durable state lives in
// --state, so the host can be restarted between steps (as Ploinky may restart an agent at any time). Prints one
// canonical JSON result line; exit 0 when the step succeeded, 3 when it refused, 1 on a usage or internal error.
//
//   node main.mjs --state <dir> --mailbox <socket> --peer <rw-target-helper> --store-root <dir> [--facts <file>] <command>
//     admit --selection <Ref> --operation-id <OperationId>     (facts file: {facts, fixtureDigests})
//     define <label> --resources <n> --seed <text> [--same-operation-as <label>]
//     prepare <label> [--drop] | lookup <label> [--lose-accepted] | commit <label> [--revalidate] | revalidate | state
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalTargetJson } from '../../../../server/executionTarget/contract.mjs';
import { loadFixtureTicketKey } from './fixtureMinter.mjs';
import { createWorkerHost } from './workerHost.mjs';

const VALUED = new Set(['--state', '--mailbox', '--peer', '--store-root', '--facts', '--selection', '--operation-id', '--resources', '--seed', '--same-operation-as']);
const FLAGS = new Set(['--drop', '--revalidate', '--lose-accepted']);

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

function resourcesFor(count, seed) {
    const id = (label) => crypto.createHash('sha256').update(`rwworker-resource:${seed}:${label}`).digest().subarray(0, 16).toString('base64url');
    return Array.from({ length: count }, (_, index) => ({
        resourceId: id(index), kind: index === 0 ? 'keeper' : 'gate',
        locatorDigest: crypto.createHash('sha256').update(`rwworker-locator:${seed}:${index}`).digest('hex')
    }));
}

function emit(result) {
    const text = canonicalTargetJson(result, { maxBytes: 1 << 20 });
    process.stdout.write(`${text.ok ? text.value : JSON.stringify(result)}\n`);
}

async function main(argv) {
    const { options, positional } = parse(argv);
    const [command, label] = positional;
    const facts = options['--facts'] ? JSON.parse(fs.readFileSync(options['--facts'], 'utf8')) : null;
    const host = createWorkerHost({
        stateDir: path.resolve(options['--state']), mailbox: options['--mailbox'], peerCommand: options['--peer'], ticketKey: loadFixtureTicketKey(),
        qualification: { root: path.resolve(options['--store-root']), uid: process.getuid(), forbiddenRoots: [] }
    });
    let result;
    switch (command) {
    case 'admit':
        result = host.admit({ selection: options['--selection'], facts: facts.facts, operationId: options['--operation-id'], fixtureDigests: facts.fixtureDigests });
        break;
    case 'define':
        result = { ok: true, ...host.defineOperation(label, { resources: resourcesFor(Number(options['--resources'] ?? 1), options['--seed'] ?? label), sameOperationAs: options['--same-operation-as'] ?? null }) };
        break;
    case 'prepare':
        result = await host.prepare(label, { drop: options['--drop'] === true });
        break;
    case 'lookup':
        result = await host.lookup(label, { loseAccepted: options['--lose-accepted'] === true });
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
