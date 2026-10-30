#!/usr/bin/env node
// rwcoord OPERATOR tool (slice P7, PROOF-FIXTURE): renders the Ploinky manifests of the three P7 agents from one rwp7
// image reference (by digest).
//   worker       routerAccess (the coordinator route is `authenticated`, the agent-port relay limited to the front port) and
//                executionProvider with the private provider port, the terminals endpoint and ONE declared coordinator
//                route, `/base-agent-additional-server/<workerRoute>/<frontPort>/v1/target-admissions`, whose only caller
//                is the coordinator principal; its start command is the admission front (front.mjs serve).
//   coordinator  the declared coordinator (idle; the operator runs coordinator.mjs inside it).
//   rogue        an agent that is not a declared coordinator (idle; same CLI, refused by the Router).
//
//   node render-manifests.mjs --image <ref@sha256:...> --repo <repo> --worker-generation <Id> --out <new dir>
//        [--worker <name>] [--coordinator <name>] [--rogue <name>] [--front-port <n>] [--provider-port <n>] [--root <container dir>]
import fs from 'node:fs';
import path from 'node:path';
import { TARGET_ADMISSION_PATH } from './admissionFront.mjs';

const FIXTURE_DIR = '/opt/rwworker/robo-work/tests/g7/fixture/rwcoord';

export function renderManifests({ image, repo, workerGeneration, worker = 'rwworker', coordinator = 'rwcoord', rogue = 'rwrogue', frontPort = 7301, providerPort = 7300, root = '/tmp/p7' }) {
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(String(image))) throw new Error('image must be pinned by digest');
    if (frontPort === providerPort) throw new Error('the coordinator route must not use the private provider port');
    const coordinatorPrincipal = `agent:${repo}/${coordinator}`;
    const front = [
        'node', `${FIXTURE_DIR}/front.mjs`, 'serve', '--port', String(frontPort), '--store-root', `${root}/qualification`, '--facts', `${root}/facts.json`,
        '--state', `${root}/front`, '--coordinator', coordinatorPrincipal, '--worker-generation', workerGeneration
    ].join(' ');
    const routePath = `/base-agent-additional-server/${worker}/${frontPort}${TARGET_ADMISSION_PATH}`;
    const idle = { container: image, entrypoint: '/usr/bin/env', start: 'sleep 2147483647', readiness: { protocol: 'none' } };
    return {
        [`${worker}.manifest.json`]: {
            container: image, entrypoint: '/usr/bin/env', start: front, readiness: { protocol: 'none' },
            // The private listener relays an agent-port request only under an effectively authenticated route policy;
            // the relay is limited to the front's port.
            routerAccess: { agentPorts: [frontPort], httpRoutes: [{ path: routePath, access: 'authenticated' }] },
            executionProvider: {
                version: 1, port: providerPort, terminals: { path: '/terminal-control' },
                coordinatorRoutes: [{ path: routePath, callers: [coordinatorPrincipal] }]
            }
        },
        [`${coordinator}.manifest.json`]: idle,
        [`${rogue}.manifest.json`]: idle
    };
}

function main(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) options[argv[index]] = argv[index + 1];
    for (const required of ['--image', '--repo', '--worker-generation', '--out']) if (typeof options[required] !== 'string') throw new Error(`missing ${required}`);
    const manifests = renderManifests({
        image: options['--image'], repo: options['--repo'], workerGeneration: options['--worker-generation'], worker: options['--worker'], coordinator: options['--coordinator'],
        rogue: options['--rogue'], frontPort: options['--front-port'] ? Number(options['--front-port']) : undefined,
        providerPort: options['--provider-port'] ? Number(options['--provider-port']) : undefined, root: options['--root']
    });
    const out = path.resolve(options['--out']);
    fs.mkdirSync(out);
    for (const [name, value] of Object.entries(manifests)) fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 4)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ out, files: Object.keys(manifests) })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`render-manifests: ${error.message}\n`);
        process.exitCode = 1;
    }
}
