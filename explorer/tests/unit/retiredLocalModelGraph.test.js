import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    KNOWN_SIBLINGS,
    MINIMUM_REVISIONS,
    SIBLING_MISSING_CODE,
    gitContainsRevision,
    resolveExplorerGraph as resolveGraph,
    resolveExplorerGraphOrSkip as resolveGraphOrSkip,
} from '../../../tests/smoke/lib/explorer-graph.mjs';

const RETIRED_AGENT = 'default-local-llm';
const RETIRED_REPO = 'proxies';
// The synthetic workspaces use a real known sibling, so the controls exercise
// the production known-sibling list rather than a test-only one.
const SIBLING = 'AchillesCLI';
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function isRetiredLocalModel(ref) {
    const parts = ref.split('/');
    const agent = parts.at(-1);
    return agent === RETIRED_AGENT || (parts.length === 2 && parts[0] === RETIRED_REPO && agent === RETIRED_AGENT);
}

// The walk itself lives in tests/smoke/lib/explorer-graph.mjs, shared with the
// QA workflow tests that derive their counts from the same graph.
function resolveExplorerGraph({ explorerRepo = repoRoot, ...options } = {}) {
    return resolveGraph({ explorerRepo, ...options, isRetired: isRetiredLocalModel });
}

// The real graph crosses into sibling checkouts of this repository. Without
// them there is nothing to assert, so the test is skipped with the helper's
// actionable message instead of failing on an unresolvable environment.
function resolveRealGraphOrSkip(t) {
    return resolveGraphOrSkip(t, { explorerRepo: repoRoot, isRetired: isRetiredLocalModel });
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
    writeManifest(explorerRepo, 'explorer', { enable: ['helper global', `${SIBLING}/relay no-wait`] });
    writeManifest(explorerRepo, 'helper', {});
    writeManifest(root, `${SIBLING}/relay`, { enable: [{ agent: 'nested global' }, ...externalEnable] });
    writeManifest(root, `${SIBLING}/nested`, {});
    writeManifest(root, `${RETIRED_REPO}/${RETIRED_AGENT}`, {});
    return explorerRepo;
}

const neverAsked = () => assert.fail('containment must only be checked for a ref with a recorded minimum revision');

test('the recursive Explorer graph never enables the retired local model runtime', (t) => {
    const graph = resolveRealGraphOrSkip(t);
    if (!graph) return;
    const { runtimes, violations } = graph;
    assert.deepEqual(violations, [], `The retired ${RETIRED_REPO}/${RETIRED_AGENT} runtime is still enabled:\n${violations.join('\n')}`);
    assert.ok(runtimes.has('proxies/soul-gateway'), 'the walk must cross into the sibling proxies repository');
    assert.ok(runtimes.has('AchillesCLI/roboTeamAgent'), 'the walk must cross into the sibling AchillesCLI repository');
    assert.equal([...runtimes.keys()].some((key) => key.endsWith(`/${RETIRED_AGENT}`)), false);
});

test('QA readiness constants match the recursive Explorer graph', (t) => {
    const graph = resolveRealGraphOrSkip(t);
    if (!graph) return;
    const { runtimes } = graph;
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

test('with every known sibling checked out at its minimum revision, the real graph resolves without a skip', (t) => {
    const siblingsRoot = path.dirname(repoRoot);
    const absent = KNOWN_SIBLINGS.filter((repo) => !fs.existsSync(path.join(siblingsRoot, repo)));
    const outdated = Object.entries(MINIMUM_REVISIONS)
        .filter(([ref, { revision }]) => !absent.includes(ref.split('/')[0])
            && gitContainsRevision(path.join(siblingsRoot, ref.split('/')[0]), revision) !== true)
        .map(([ref]) => ref);
    if (absent.length || outdated.length) {
        t.skip(`Skipped: this control needs every known sibling at its minimum revision in ${siblingsRoot} `
            + `(absent: ${absent.join(', ') || 'none'}; not provably at the minimum: ${outdated.join(', ') || 'none'}).`);
        return;
    }
    const skipped = [];
    const graph = resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo: repoRoot, isRetired: isRetiredLocalModel });
    assert.deepEqual(skipped, []);
    assert.ok(graph, 'the helper must return the graph');
    for (const repo of KNOWN_SIBLINGS) {
        assert.ok([...graph.runtimes.keys()].some((key) => key.startsWith(`${repo}/`)), `the walk must reach ${repo}`);
    }
    assert.ok(graph.runtimes.has('proxies/opencode-free'));
});

test('negative control: a clean synthetic graph passes', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    const { runtimes, violations } = resolveExplorerGraph({ explorerRepo });
    assert.deepEqual(violations, []);
    assert.deepEqual([...runtimes.keys()].sort(),
        ['AchillesCLI/nested', 'AchillesCLI/relay', 'AchillesIDE/explorer', 'AchillesIDE/helper']);
});

for (const injected of [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`, RETIRED_AGENT, { agent: `${RETIRED_REPO}/${RETIRED_AGENT}` }]) {
    test(`negative control: transitive injection through an external repository is detected (${JSON.stringify(injected)})`, (t) => {
        const explorerRepo = syntheticWorkspace(t, [injected]);
        const { violations } = resolveExplorerGraph({ explorerRepo });
        assert.equal(violations.length, 1);
        assert.match(violations[0], /^AchillesCLI\/relay .* enables (proxies\/)?default-local-llm$/);
    });
}

test('negative control: a retired edge inside a profile enable list is detected', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    writeManifest(path.dirname(explorerRepo), `${SIBLING}/relay`, {
        enable: [{ agent: 'nested global' }],
        profiles: { dev: { enable: [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`] } },
    });
    const { violations } = resolveExplorerGraph({ explorerRepo });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^AchillesCLI\/relay .* enables proxies\/default-local-llm$/);
});

test('negative control: a missing sibling repository fails with a clear typed message', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    fs.rmSync(path.join(path.dirname(explorerRepo), SIBLING), { recursive: true, force: true });
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), (error) => {
        assert.equal(error.code, SIBLING_MISSING_CODE);
        assert.match(error.message, /Sibling repository "AchillesCLI" enabled by AchillesIDE\/explorer is missing at /);
        assert.match(error.message, /check out "AchillesCLI" next to the Explorer repository \(siblings root /);
        assert.match(error.message, /tests\/smoke\/README\.md/);
        return true;
    });
});

test('negative control (a): an edge to an agent a present sibling does not have, with no recorded minimum, is a hard failure', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    writeManifest(explorerRepo, 'explorer', { enable: ['helper global', 'proxies/soul-gatewy no-wait'] });
    const skipped = [];
    assert.throws(() => resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo, isRetired: isRetiredLocalModel, containsRevision: neverAsked }), (error) => {
        assert.notEqual(error.code, SIBLING_MISSING_CODE);
        assert.match(error.message, /Agent "proxies\/soul-gatewy" enabled by AchillesIDE\/explorer has no manifest at /);
        assert.match(error.message, /no minimum revision is recorded for it, so the enable edge is wrong or the agent was renamed or removed/);
        return true;
    });
    assert.deepEqual(skipped, []);
});

test('negative control (b): a qualified edge to a repository that is not a known sibling is a hard failure', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    // Neither the typo'd repository nor any directory of that name exists.
    writeManifest(explorerRepo, 'explorer', { enable: ['helper global', 'proxy/soul-gateway no-wait'] });
    assert.throws(() => resolveGraphOrSkip({ skip: () => assert.fail('an unknown repository must not be skipped') },
        { explorerRepo, isRetired: isRetiredLocalModel, containsRevision: neverAsked }), (error) => {
        assert.notEqual(error.code, SIBLING_MISSING_CODE);
        assert.match(error.message, /AchillesIDE\/explorer enables "proxy\/soul-gateway", but "proxy" is not a known sibling repository/);
        assert.match(error.message, /known: AchillesCLI, proxies, UmamiAgent; "AchillesIDE" names the Explorer repository itself/);
        return true;
    });
});

function opencodeFreeCase(t, containment) {
    const explorerRepo = syntheticWorkspace(t, ['proxies/opencode-free no-wait']);
    const asked = [];
    const containsRevision = (dir, revision) => {
        asked.push({ dir, revision });
        return containment;
    };
    return { explorerRepo, asked, containsRevision };
}

test('negative control (c): a proxies checkout that provably predates opencode-free is a gap naming the ref, path and minimum', (t) => {
    const { explorerRepo, asked, containsRevision } = opencodeFreeCase(t, false);
    const proxiesDir = path.join(path.dirname(explorerRepo), 'proxies');
    assert.throws(() => resolveExplorerGraph({ explorerRepo, containsRevision }), (error) => {
        assert.equal(error.code, SIBLING_MISSING_CODE);
        assert.match(error.message, /Agent "proxies\/opencode-free" enabled by AchillesCLI\/relay has no manifest at /);
        assert.ok(error.message.includes(path.join(proxiesDir, 'opencode-free', 'manifest.json')));
        assert.match(error.message, /the sibling repository "proxies" is checked out at .* but does not contain 22dc0cc/);
        assert.match(error.message, /must contain at least 22dc0cc \(first revision with the published opencode-free\/manifest\.json\); 2a95a2e/);
        assert.equal(error.message.includes('\n'), false, 'the gap message must stay a single reporter line');
        return true;
    });
    assert.deepEqual(asked, [{ dir: proxiesDir, revision: MINIMUM_REVISIONS['proxies/opencode-free'].revision }]);
    const skipped = [];
    assert.equal(resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo, isRetired: isRetiredLocalModel, containsRevision }), null);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /22dc0cc/);
});

for (const [label, containment, reason] of [
    ['(d) contains the minimum revision', true, /already contains the minimum revision 22dc0cc, so the agent was renamed or removed there/],
    ['(e) cannot be checked for the minimum revision', null, /cannot be checked for the minimum revision 22dc0cc/],
]) {
    test(`negative control ${label}: a proxies checkout without opencode-free is a hard failure`, (t) => {
        const { explorerRepo, asked, containsRevision } = opencodeFreeCase(t, containment);
        assert.throws(() => resolveGraphOrSkip({ skip: () => assert.fail('this must not be skipped') },
            { explorerRepo, isRetired: isRetiredLocalModel, containsRevision }), (error) => {
            assert.notEqual(error.code, SIBLING_MISSING_CODE);
            assert.match(error.message, /Agent "proxies\/opencode-free" enabled by AchillesCLI\/relay has no manifest at /);
            assert.match(error.message, reason);
            return true;
        });
        assert.equal(asked.length, 1);
    });
}

test('negative control: the default containment check treats a non-git sibling as undetermined', (t) => {
    const explorerRepo = syntheticWorkspace(t, ['proxies/opencode-free no-wait']);
    assert.equal(gitContainsRevision(path.join(path.dirname(explorerRepo), 'proxies'), 'HEAD'), null);
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), (error) => {
        assert.notEqual(error.code, SIBLING_MISSING_CODE);
        assert.match(error.message, /cannot be checked for the minimum revision 22dc0cc/);
        return true;
    });
});

test('negative control: an inherited GIT_DIR never makes another repository answer for a sibling', (t) => {
    const gitDir = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
    if (gitDir.status !== 0) {
        t.skip('Skipped: this checkout is not a git repository, so there is no repository to leak through GIT_DIR.');
        return;
    }
    const explorerRepo = syntheticWorkspace(t, []);
    const saved = process.env.GIT_DIR;
    t.after(() => {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
    });
    // As inside a git hook of this repository.
    process.env.GIT_DIR = gitDir.stdout.trim();
    const revision = MINIMUM_REVISIONS['proxies/opencode-free'].revision;
    assert.equal(gitContainsRevision(path.join(path.dirname(explorerRepo), 'proxies'), revision), null);
});

// Git for the synthetic repositories only: no inherited location variables
// (which could point it at this checkout) and no user or system configuration.
function syntheticGit(dir, args) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
    const result = spawnSync('git', ['-c', 'user.name=Graph Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-C', dir, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

test('negative control: a shallow sibling cannot prove that it lacks a revision, so its missing manifest is a hard failure', (t) => {
    if (spawnSync('git', ['--version']).error) {
        t.skip('Skipped: git is not available, so no shallow checkout can be built.');
        return;
    }
    const explorerRepo = syntheticWorkspace(t, ['proxies/opencode-free no-wait']);
    const siblingsRoot = path.dirname(explorerRepo);
    // A synthetic upstream that once had the agent and then removed it.
    const upstream = path.join(siblingsRoot, 'upstream-proxies');
    fs.mkdirSync(upstream);
    syntheticGit(upstream, ['init', '--quiet']);
    writeManifest(upstream, 'opencode-free', {});
    writeManifest(upstream, RETIRED_AGENT, {});
    syntheticGit(upstream, ['add', '--all']);
    syntheticGit(upstream, ['commit', '--quiet', '--message', 'Add the agents']);
    const withAgent = syntheticGit(upstream, ['rev-parse', 'HEAD']);
    fs.rmSync(path.join(upstream, 'opencode-free'), { recursive: true, force: true });
    syntheticGit(upstream, ['add', '--all']);
    syntheticGit(upstream, ['commit', '--quiet', '--message', 'Remove opencode-free']);
    const proxiesDir = path.join(siblingsRoot, 'proxies');
    fs.rmSync(proxiesDir, { recursive: true, force: true });
    syntheticGit(siblingsRoot, ['clone', '--quiet', '--depth', '1', pathToFileURL(upstream).href, proxiesDir]);

    const minimum = MINIMUM_REVISIONS['proxies/opencode-free'].revision;
    assert.equal(syntheticGit(proxiesDir, ['rev-parse', '--is-shallow-repository']), 'true');
    assert.equal(syntheticGit(upstream, ['rev-parse', '--is-shallow-repository']), 'false');
    // The complete upstream history answers both ways.
    assert.equal(gitContainsRevision(upstream, withAgent), true);
    assert.equal(gitContainsRevision(upstream, minimum), false);
    // The shallow clone proves what it has, but never an absence.
    assert.equal(gitContainsRevision(proxiesDir, 'HEAD'), true);
    assert.equal(gitContainsRevision(proxiesDir, withAgent), null);
    assert.equal(gitContainsRevision(proxiesDir, minimum), null);
    assert.equal(fs.existsSync(path.join(proxiesDir, 'opencode-free', 'manifest.json')), false);

    const skipped = [];
    assert.throws(() => resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo, isRetired: isRetiredLocalModel }), (error) => {
        assert.equal(error.code, undefined, 'a shallow sibling must never be skipped as an outdated checkout');
        assert.deepEqual(error.gaps, []);
        assert.equal(error.defects.length, 1);
        assert.match(error.defects[0], /^Agent "proxies\/opencode-free" enabled by AchillesCLI\/relay has no manifest at /);
        assert.match(error.defects[0], /cannot be checked for the minimum revision 22dc0cc \(not a git checkout, a shallow checkout that cannot prove the revision is absent, or git failed\)/);
        return true;
    });
    assert.deepEqual(skipped, []);
});

test('negative control: a manifest missing inside the Explorer repository stays a hard failure', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    fs.rmSync(path.join(explorerRepo, 'helper'), { recursive: true, force: true });
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), (error) => {
        assert.equal(error.code, undefined, 'an Explorer-owned gap must never be skippable');
        assert.match(error.message, /^The Explorer graph has 1 defect\(s\):\n- Agent "helper" enabled by AchillesIDE\/explorer has no manifest at /);
        return true;
    });
});

test('negative control (g): an Explorer-internal defect after an absent sibling is still a hard failure', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    const siblingsRoot = path.dirname(explorerRepo);
    // The absent sibling is reached first, as in the reproduced case.
    writeManifest(explorerRepo, 'explorer', { enable: [`${SIBLING}/relay no-wait`, 'helper global'] });
    fs.rmSync(path.join(siblingsRoot, SIBLING), { recursive: true, force: true });
    fs.rmSync(path.join(explorerRepo, 'helper'), { recursive: true, force: true });
    assert.throws(() => resolveGraphOrSkip({ skip: () => assert.fail('a broken graph must not be skipped') },
        { explorerRepo, isRetired: isRetiredLocalModel }), (error) => {
        assert.equal(error.code, undefined);
        assert.deepEqual(error.defects.length, 1);
        assert.match(error.defects[0], /^Agent "helper" enabled by AchillesIDE\/explorer has no manifest at /);
        assert.equal(error.gaps.length, 1);
        assert.match(error.gaps[0], /^Sibling repository "AchillesCLI" enabled by AchillesIDE\/explorer is missing at /);
        assert.match(error.message, /Environment gaps also found:/);
        return true;
    });
});

test('negative control (h): a retired edge found next to an absent sibling is a hard failure, never a skip', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    // UmamiAgent is a known sibling the synthetic workspace never creates.
    writeManifest(explorerRepo, 'explorer', {
        enable: [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`, 'UmamiAgent/umamiAgent no-wait'],
    });
    const check = (error) => {
        assert.equal(error.code, undefined, 'a retired-runtime violation must never be skippable');
        assert.deepEqual(error.defects, []);
        assert.equal(error.violations.length, 1);
        assert.match(error.violations[0], /^AchillesIDE\/explorer .* enables proxies\/default-local-llm$/);
        assert.equal(error.gaps.length, 1);
        assert.match(error.gaps[0], /^Sibling repository "UmamiAgent" enabled by AchillesIDE\/explorer is missing at /);
        assert.match(error.message, /^The Explorer graph enables 1 retired runtime\(s\):\n- AchillesIDE\/explorer .* enables proxies\/default-local-llm\n/);
        assert.match(error.message, /Environment gaps also found:\n- Sibling repository "UmamiAgent"/);
        return true;
    };
    assert.throws(() => resolveExplorerGraph({ explorerRepo, containsRevision: neverAsked }), check);
    const skipped = [];
    assert.throws(() => resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo, isRetired: isRetiredLocalModel, containsRevision: neverAsked }), check);
    assert.deepEqual(skipped, []);
});

test('negative control: a defect error also lists the retired edges the walk found', (t) => {
    const explorerRepo = syntheticWorkspace(t, [`${RETIRED_REPO}/${RETIRED_AGENT} no-wait`]);
    fs.rmSync(path.join(explorerRepo, 'helper'), { recursive: true, force: true });
    assert.throws(() => resolveExplorerGraph({ explorerRepo }), (error) => {
        assert.equal(error.code, undefined);
        assert.equal(error.defects.length, 1);
        assert.equal(error.violations.length, 1);
        assert.deepEqual(error.gaps, []);
        assert.match(error.message, /^The Explorer graph has 1 defect\(s\):\n- Agent "helper" .*\nThe Explorer graph enables 1 retired runtime\(s\):\n- AchillesCLI\/relay .* enables proxies\/default-local-llm$/);
        return true;
    });
});

test('negative control: every gap is listed, and a gap stops only the branch below it', (t) => {
    const explorerRepo = syntheticWorkspace(t, ['proxies/opencode-free no-wait']);
    const siblingsRoot = path.dirname(explorerRepo);
    writeManifest(explorerRepo, 'explorer', { enable: ['UmamiAgent/umamiAgent no-wait', 'helper global', `${SIBLING}/relay no-wait`] });
    assert.throws(() => resolveExplorerGraph({ explorerRepo, containsRevision: () => false }), (error) => {
        assert.equal(error.code, SIBLING_MISSING_CODE);
        assert.equal(error.gaps.length, 2);
        assert.match(error.gaps[0], /^Sibling repository "UmamiAgent" enabled by AchillesIDE\/explorer is missing at /);
        assert.match(error.gaps[1], /^Agent "proxies\/opencode-free" enabled by AchillesCLI\/relay has no manifest at /);
        assert.ok(error.message.includes(path.join(siblingsRoot, 'UmamiAgent')));
        return true;
    });
});

test('the skip wrapper converts only the sibling gap into a skip and passes other failures through', (t) => {
    const explorerRepo = syntheticWorkspace(t, []);
    const siblingsRoot = path.dirname(explorerRepo);
    fs.rmSync(path.join(siblingsRoot, SIBLING), { recursive: true, force: true });
    const skipped = [];
    const result = resolveGraphOrSkip({ skip: (message) => skipped.push(message) },
        { explorerRepo, isRetired: isRetiredLocalModel });
    assert.equal(result, null);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /^Skipped: the Explorer graph cannot be resolved in this checkout\. Sibling repository "AchillesCLI" enabled by AchillesIDE\/explorer is missing at /);
    assert.equal(skipped[0].includes('\n'), false, 'the skip message must stay a single reporter line');
    assert.ok(skipped[0].includes(path.join(siblingsRoot, SIBLING)), 'the skip message must name the expected path');
    fs.rmSync(path.join(explorerRepo, 'helper'), { recursive: true, force: true });
    fs.mkdirSync(path.join(siblingsRoot, SIBLING), { recursive: true });
    assert.throws(() => resolveGraphOrSkip({ skip: () => assert.fail('a broken graph must not be skipped') },
        { explorerRepo, isRetired: isRetiredLocalModel }));
});
