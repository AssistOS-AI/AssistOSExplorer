import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Explorer repository is installed by Ploinky under this alias.
const EXPLORER_REPO_ALIAS = 'AchillesIDE';
const RETIRED_AGENT = 'default-local-llm';
const RETIRED_REPO = 'proxies';
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

const enableTokens = (entry) => (typeof entry === 'string' ? entry : entry?.agent || '').trim().split(/\s+/);

function readManifest(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read manifest for ${label} at ${file}: ${error.message}`);
    }
}

function isRetiredLocalModel(ref) {
    const parts = ref.split('/');
    const agent = parts.at(-1);
    return agent === RETIRED_AGENT || (parts.length === 2 && parts[0] === RETIRED_REPO && agent === RETIRED_AGENT);
}

// Walks every manifest reachable from explorer/manifest.json. Qualified refs
// (`repo/agent`) resolve to a sibling checkout of the Explorer repository,
// except the Explorer alias, which resolves to the Explorer repository itself.
// Bare refs resolve inside the repository of the manifest that enables them.
function resolveExplorerGraph({ explorerRepo = repoRoot, siblingsRoot = path.resolve(explorerRepo, '..') } = {}) {
    const runtimes = new Map();
    const violations = [];
    const repoDir = (repo, enabledBy) => {
        if (repo === EXPLORER_REPO_ALIAS) return explorerRepo;
        const dir = path.join(siblingsRoot, repo);
        if (!fs.existsSync(dir)) {
            throw new Error(`Sibling repository "${repo}" enabled by ${enabledBy} is missing at ${dir}; `
                + 'check it out next to the Explorer repository before running this graph test');
        }
        return dir;
    };
    function visit(ref, fromRepo, fromRepoDir, flags, enabledBy) {
        const parts = ref.split('/');
        assert.ok(parts.length === 1 || parts.length === 2, `${enabledBy} enables unsupported ref "${ref}"`);
        const [repo, agent] = parts.length === 2 ? parts : [fromRepo, parts[0]];
        const dir = parts.length === 2 ? repoDir(repo, enabledBy) : fromRepoDir;
        const key = `${repo === EXPLORER_REPO_ALIAS ? EXPLORER_REPO_ALIAS : repo}/${agent}`;
        const known = runtimes.get(key);
        if (known) {
            flags.forEach((flag) => known.flags.add(flag));
            return;
        }
        const manifestFile = path.join(dir, agent, 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            throw new Error(`Agent "${ref}" enabled by ${enabledBy} has no manifest at ${manifestFile}`);
        }
        const manifest = readManifest(manifestFile, key);
        runtimes.set(key, { flags: new Set(flags), manifestFile });
        for (const entry of manifest.enable || []) {
            const [childRef, ...childFlags] = enableTokens(entry);
            assert.ok(childRef, `${key} has an empty enable entry`);
            if (isRetiredLocalModel(childRef)) {
                violations.push(`${key} (${manifestFile}) enables ${childRef}`);
                continue;
            }
            visit(childRef, repo, dir, childFlags, key);
        }
    }
    visit('explorer', EXPLORER_REPO_ALIAS, explorerRepo, [], 'the Explorer root');
    return { runtimes, violations };
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

test('negative control: a missing sibling repository fails with a clear message', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    fs.rmSync(path.join(path.dirname(explorerRepo), 'ExternalRepo'), { recursive: true, force: true });
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), /Sibling repository "ExternalRepo" enabled by AchillesIDE\/explorer is missing at /);
});
