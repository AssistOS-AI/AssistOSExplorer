import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { productionAdapters, QA_SCOPE } from './rollback-explorer-qa.mjs';

const expected = JSON.parse(fs.readFileSync(0, 'utf8'));
const verifierRevision = process.argv[2];
assert.match(verifierRevision, /^[a-f0-9]{40}$/);
assert.match(expected.boxId, /^[a-f0-9]{64}$/);
assert.match(expected.imageId, /^[a-f0-9]{64}$/);
assert(Number.isSafeInteger(expected.minimumRunStartedAtMs) && expected.minimumRunStartedAtMs > 0);
const sourcePaths = ['.runtime/ploinky', 'AdvancedLanguageAgent', ...[
    'AchillesIDE', 'AchillesCLI', 'UmamiAgent', 'OnlyOfficeAgent', 'copilot-agents', 'proxies', 'container-image-builds',
].map(name => `.ploinky/repos/${name}`)];
assert.deepEqual(Object.keys(expected.sources).sort(), [...sourcePaths].sort());
const run = (command, args, options = {}) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const adapters = productionAdapters();
adapters.assertHost();
const lock = await adapters.acquireWorkspaceLock(QA_SCOPE.workspace);
try {
    const boxes = adapters.boxes();
    assert.equal(boxes.length, 1);
    const current = boxes[0];
    assert.equal(current.box.name, QA_SCOPE.box);
    assert.equal(current.box.id, expected.boxId);
    assert.equal(current.box.image, expected.imageId);
    assert.equal(current.box.running, true);
    const sources = {};
    for (const relative of sourcePaths) {
        const directory = path.join(QA_SCOPE.workspace, relative);
        const wanted = expected.sources[relative];
        assert.match(wanted.commit, /^[a-f0-9]{40}$/);
        const actual = adapters.sourcePin(directory);
        assert.equal(actual.commit, wanted.commit);
        assert.equal(actual.branch, wanted.branch);
        const upstream = run('git', ['-C', directory, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim();
        assert.equal(upstream, `origin/${wanted.branch}`);
        sources[relative] = { ...actual, upstream };
    }
    const dependencyLock = JSON.parse(fs.readFileSync(path.join(QA_SCOPE.workspace, '.runtime/ploinky/ploinky-box/dependencies.lock.json')));
    const agentLib = await adapters.verifyAgentLib(current, dependencyLock.repositories.achillesAgentLib.commit);
    // The Box sees the host workspace at the same absolute path.
    const prefix = ['container', 'exec', '--user', 'podman', '--workdir', QA_SCOPE.workspace, current.box.id];
    const noWait = run(current.engine, [...prefix, 'node',
        path.join(QA_SCOPE.workspace, '.ploinky/repos/AchillesIDE/.github/scripts/check-no-wait-readiness.mjs'),
        path.join(QA_SCOPE.workspace, '.ploinky/running/no-wait'), '9', String(expected.minimumRunStartedAtMs)]).trim();
    const runtime = JSON.parse(run(current.engine, [...prefix, 'node', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const registry = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(QA_SCOPE.workspace, '.ploinky/agents.json'))}));
        const records = Object.entries(registry).filter(([, value]) => value?.type === 'agent');
        assert.equal(records.length, 15);
        const agents = records.map(([name, value]) => {
            assert.match(value.containerId, /^[a-f0-9]{64}$/);
            const [container] = JSON.parse(execFileSync('podman', ['container', 'inspect', value.containerId], {encoding:'utf8'}));
            assert.equal(container.Id, value.containerId);
            assert.equal(container.State.Running, true);
            return {name, id:container.Id, image:container.Image};
        });
        const selector = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(QA_SCOPE.workspace, '.ploinky/data/edge-routing/active.json'))}));
        assert.equal(selector.state, 'active');
        console.log(JSON.stringify({agents, generation:selector.generation, activationId:selector.activationId}));
    `]));
    // The public health surface requires authentication. Reuse the runtime's
    // probe, which recognizes its login redirect or AUTH_REQUIRED response
    // and rejects inactive generations.
    const { checkBoxHealth } = await import(pathToFileURL(path.join(QA_SCOPE.workspace, '.runtime/ploinky/ploinky-box/supervisor.mjs')).href);
    await checkBoxHealth(8097, { timeoutMs: 5000, readinessTimeoutMs: 0 });
    const final = adapters.boxes();
    assert.equal(final.length, 1);
    assert.equal(final[0].box.id, current.box.id);
    assert.equal(final[0].box.contract, current.box.contract);
    assert.equal(final[0].box.running, true);
    console.log(JSON.stringify({ result: 'passed', checkedAt: new Date().toISOString(), verifierRevision,
        boxId: current.box.id, imageId: current.box.image, imageReference: current.box.imageReference,
        ports: current.box.ports, agentLib, sources, noWait, runtime, loopbackHealth: 'canonical-probe-passed',
    }, null, 2));
} finally { lock.release(); }
