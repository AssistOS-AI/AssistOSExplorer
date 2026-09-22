import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveExplorerGraph as resolveGraph } from '../../../tests/smoke/lib/explorer-graph.mjs';

const RETIRED_AGENT = 'default-local-llm';
const RETIRED_REPO = 'proxies';
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function isRetiredLocalModel(ref) {
    const parts = ref.split('/');
    const agent = parts.at(-1);
    return agent === RETIRED_AGENT || (parts.length === 2 && parts[0] === RETIRED_REPO && agent === RETIRED_AGENT);
}

// The walk itself lives in tests/smoke/lib/explorer-graph.mjs, shared with the
// QA workflow tests that derive their counts from the same graph.
function resolveExplorerGraph({ explorerRepo = repoRoot, siblingsRoot } = {}) {
    return resolveGraph({ explorerRepo, siblingsRoot, isRetired: isRetiredLocalModel });
}

function writeManifest(root, relative, manifest) {
    const file = path.join(root, relative, 'manifest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest));
}

function syntheticWorkspace(t, externalEnable) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-local-model-graph-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const explorerRepo = path.join(root, 'ExplorerCheckout');
    writeManifest(explorerRepo, 'explorer', { enable: ['helper global', 'ExternalRepo/relay no-wait'] });
    writeManifest(explorerRepo, 'helper', {});
    writeManifest(root, 'ExternalRepo/relay', { enable: [{ agent: 'nested global' }, ...externalEnable] });
    writeManifest(root, 'ExternalRepo/nested', {});
    writeManifest(root, `${RETIRED_REPO}/${RETIRED_AGENT}`, {});
    return explorerRepo;
}

test('the recursive Explorer graph never enables the retired local model runtime', () => {
    const { runtimes, violations } = resolveExplorerGraph();
    assert.deepEqual(violations, [], `The retired ${RETIRED_REPO}/${RETIRED_AGENT} runtime is still enabled:\n${violations.join('\n')}`);
    assert.ok(runtimes.has('proxies/soul-gateway'), 'the walk must cross into the sibling proxies repository');
    assert.ok(runtimes.has('AchillesCLI/roboTeamAgent'), 'the walk must cross into the sibling AchillesCLI repository');
    assert.equal([...runtimes.keys()].some((key) => key.endsWith(`/${RETIRED_AGENT}`)), false);
});

test('QA readiness constants match the recursive Explorer graph', () => {
    const { runtimes } = resolveExplorerGraph();
    const noWait = [...runtimes].filter(([, value]) => value.flags.has('no-wait')).map(([key]) => key);
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-explorer-qa.yml'), 'utf8');
    const tracked = workflow.match(/Tracked agents: (\d+)/g).map((value) => Number(value.split(': ')[1]));
    const expectedNoWait = Number(workflow.match(/EXPECTED_NO_WAIT_AGENTS=(\d+)/)[1]);
    assert.deepEqual([...new Set(tracked)], [runtimes.size], `graph runtimes: ${[...runtimes.keys()].join(', ')}`);
    assert.equal(expectedNoWait, noWait.length, `graph no-wait agents: ${noWait.join(', ')}`);
    const verifier = fs.readFileSync(path.join(repoRoot, '.github/scripts/verify-explorer-qa-runtime.mjs'), 'utf8');
    assert.equal(Number(verifier.match(/assert\.equal\(records\.length, (\d+)\)/)[1]), runtimes.size);
    assert.equal(Number(verifier.match(/'\.ploinky\/running\/no-wait'\), '(\d+)'/)[1]), noWait.length);
});

test('negative control: a clean synthetic graph passes', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    const { runtimes, violations } = resolveExplorerGraph({ explorerRepo });
    assert.deepEqual(violations, []);
    assert.deepEqual([...runtimes.keys()].sort(),
        ['AchillesIDE/explorer', 'AchillesIDE/helper', 'ExternalRepo/nested', 'ExternalRepo/relay']);
});

for (const injected of [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`, RETIRED_AGENT, { agent: `${RETIRED_REPO}/${RETIRED_AGENT}` }]) {
    test(`negative control: transitive injection through an external repository is detected (${JSON.stringify(injected)})`, (t) => {
        const explorerRepo = syntheticWorkspace(t, [injected]);
        const { violations } = resolveExplorerGraph({ explorerRepo });
        assert.equal(violations.length, 1);
        assert.match(violations[0], /^ExternalRepo\/relay .* enables (proxies\/)?default-local-llm$/);
    });
}

test('negative control: a retired edge inside a profile enable list is detected', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    writeManifest(path.dirname(explorerRepo), 'ExternalRepo/relay', {
        enable: [{ agent: 'nested global' }],
        profiles: { dev: { enable: [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`] } },
    });
    const { violations } = resolveExplorerGraph({ explorerRepo });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^ExternalRepo\/relay .* enables proxies\/default-local-llm$/);
});

test('negative control: a missing sibling repository fails with a clear message', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    fs.rmSync(path.join(path.dirname(explorerRepo), 'ExternalRepo'), { recursive: true, force: true });
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), /Sibling repository "ExternalRepo" enabled by AchillesIDE\/explorer is missing at /);
});
