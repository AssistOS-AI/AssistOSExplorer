import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, siblingPath } from '../../../tests/helpers/sibling-roots.mjs';
import { EXPECTED_DEFAULT_GRAPH } from '../../../.github/scripts/rollback-explorer-qa.mjs';

const EXPLORER_ALIAS = 'AchillesIDE';
const ONLY_OFFICE_REPO = {
    name: 'OnlyOfficeAgent',
    url: 'https://github.com/AssistOS-AI/OnlyOfficeAgent.git',
};
const SIBLING_REPOS = {
    webmeet: 'https://github.com/AssistOS-AI/webmeet.git',
};
const LEGACY_REPO = 'legacy-agents';
const localOptionalAgents = ['webmeetAgent', 'liveKitServerAgent', 'webmeetScribeAgent', 'webmeetStt'];
const refOf = (entry) => (typeof entry === 'string' ? entry : entry.agent).split(/\s+/)[0];

// Canonical `repo/agent` identity of an enable ref. A bare ref belongs to the
// repository of the manifest that enables it, as Ploinky qualifies it.
const identityOf = (ref, fromRepo) => {
    if (ref === 'explorer') return `${EXPLORER_ALIAS}/explorer`;
    return ref.includes('/') ? ref : `${fromRepo}/${ref}`;
};

// The manifest of an agent in this repository or in a required sibling
// checkout (a missing sibling throws). Other repositories are resolved by
// Ploinky at startup and return null.
const manifestPathOf = (identity) => {
    const [repo, agent] = identity.split('/');
    if (repo === EXPLORER_ALIAS) return path.join(REPO_ROOT, agent, 'manifest.json');
    if (Object.hasOwn(SIBLING_REPOS, repo)) return siblingPath(repo, agent, 'manifest.json');
    return null;
};
const readManifest = async (identity) => {
    const file = manifestPathOf(identity);
    return file ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
};

test('Explorer local dependency graph excludes optional agents while retaining their Marketplace manifests', async () => {
    const visited = new Set();
    async function visit(identity) {
        if (visited.has(identity)) return;
        visited.add(identity);
        const manifest = await readManifest(identity);
        if (!manifest) return;
        const repo = identity.split('/')[0];
        for (const entry of manifest.enable || []) {
            const ref = refOf(entry);
            const shortName = ref.split('/').at(-1);
            assert.equal(shortName === 'onlyOffice', false, `${identity} must not auto-enable ${ref}; the external OnlyOffice agent stays opt-in`);
            assert.equal(shortName === 'opencode-free', false, `${identity} must not auto-enable ${ref}; the optional legacy-agents/opencode-free agent stays opt-in`);
            assert.equal(shortName === 'umamiAgent', false, `${identity} must not auto-enable ${ref}; the Umami analytics agent stays opt-in`);
            assert.equal(localOptionalAgents.includes(shortName), false, `${identity} must not auto-enable ${ref}`);
            await visit(identityOf(ref, repo));
        }
    }
    await visit(identityOf('explorer'));
    assert.equal(visited.has('webmeet/webmeetAgent'), false, 'WebMeet must stay off the default graph');
    assert.equal(visited.has('webmeet/liveKitServerAgent'), false, 'LiveKit must stay off the default graph');
    assert.ok(visited.has('AchillesIDE/roboTeamAgent'));
    assert.ok(visited.has('AchillesIDE/soul-gateway'));
    for (const agent of localOptionalAgents) {
        const manifest = await readManifest(`webmeet/${agent}`);
        assert.ok(manifest.container, `${agent} must remain discoverable and runnable through Marketplace`);
    }
    const explorer = await readManifest(identityOf('explorer'));
    assert.equal(
        explorer.repos?.[ONLY_OFFICE_REPO.name],
        ONLY_OFFICE_REPO.url,
        'Explorer must install the extracted OnlyOffice repository so Marketplace can offer the agent'
    );
    assert.equal(
        (explorer.enable || []).some((entry) => refOf(entry).endsWith('/onlyOffice')),
        false,
        'OnlyOffice must stay disabled by default'
    );
    assert.equal(explorer.repos?.webmeet, SIBLING_REPOS.webmeet, 'Explorer must install webmeet so Marketplace can offer WebMeet');
    assert.equal(explorer.applicationPlugins?.webmeet, true, 'the WebMeet toolbar plugin stays admitted so it can enable the agent on demand');
    const scribe = await readManifest('webmeet/webmeetScribeAgent');
    assert.ok(scribe.enable.some((entry) => identityOf(refOf(entry), 'webmeet') === 'webmeet/liveKitServerAgent'));
});

test('Explorer installs the webmeet repository and keeps Umami installed but disabled', async () => {
    const explorer = await readManifest(identityOf('explorer'));
    for (const [name, url] of Object.entries(SIBLING_REPOS)) {
        assert.equal(explorer.repos?.[name], url, `${name} must be a plain URL entry so --branch still applies`);
    }
    assert.equal(explorer.repos?.UmamiAgent, 'https://github.com/AssistOS-AI/UmamiAgent.git',
        'Umami must stay installed so Marketplace can offer it');
    const enabled = explorer.enable.map(refOf);
    assert.equal(enabled.some((ref) => ref.split('/').at(-1) === 'umamiAgent'), false, 'umamiAgent must not be enabled by default');
    assert.deepEqual(
        enabled.filter((ref) => ref.startsWith('AchillesCLI/') || ref.startsWith('proxies/') || ref.startsWith('AchillesIDE/')),
        [],
        'the moved agents are enabled by their current repository, never by a former one'
    );
});

test('Explorer neither installs nor enables the legacy-agents repository', async () => {
    const explorer = await readManifest(identityOf('explorer'));
    assert.deepEqual(
        (explorer.enable || []).map(refOf).filter((ref) => ref.startsWith(`${LEGACY_REPO}/`)),
        [],
        'no legacy-agents agent may be enabled by default'
    );
    assert.equal(Object.hasOwn(explorer.repos || {}, LEGACY_REPO), false,
        'legacy-agents must not be installed by default; an administrator installs it explicitly');
    for (const key of ['soplang-builder', 'tasks']) {
        assert.equal(Object.hasOwn(explorer.applicationPlugins || {}, key), false, `applicationPlugins must not list the legacy "${key}" plugin`);
    }
    for (const relative of ['.github/workflows/deploy-explorer-qa.yml', '.github/scripts/verify-explorer-qa-runtime.mjs']) {
        const text = await fs.readFile(path.join(REPO_ROOT, relative), 'utf8');
        assert.equal(text.includes(LEGACY_REPO), false, `${relative} must not pin or verify the legacy-agents repository`);
    }
    assert.deepEqual(EXPECTED_DEFAULT_GRAPH.filter((ref) => ref.startsWith(`${LEGACY_REPO}/`)), [],
        'the QA rollback prediction must not expect a legacy-agents runtime');
});

test('WebMeet and Scribe share the local LiveKit runtime, Explorer has no LiveKit edge, and retired stack repositories are not installed', async () => {
    const livekit = 'webmeet/liveKitServerAgent';
    const edges = {
        [identityOf('explorer')]: null,
        'webmeet/webmeetAgent': `${livekit} no-wait`,
        'webmeet/webmeetScribeAgent': livekit,
    };
    for (const [identity, expected] of Object.entries(edges)) {
        const manifest = await readManifest(identity);
        const repo = identity.split('/')[0];
        const livekitEdges = manifest.enable
            .map((entry) => (typeof entry === 'string' ? entry : entry.agent).trim())
            .filter((entry) => identityOf(entry.split(/\s+/)[0], repo) === livekit)
            .map((entry) => [identityOf(entry.split(/\s+/)[0], repo), ...entry.split(/\s+/).slice(1)].join(' '));
        assert.deepEqual(livekitEdges, expected ? [expected] : [], identity);
        for (const retired of ['basic', ['webmeet', 'Infra'].join('')]) {
            assert.equal(Object.hasOwn(manifest.repos || {}, retired), false);
            assert.equal(manifest.enable.some((entry) => refOf(entry).startsWith(`${retired}/`)), false);
        }
    }
    const runtime = await readManifest(livekit);
    assert.equal(runtime.container, 'docker.io/assistos/livekit-server-agent@sha256:fc05e4349bc1eab5a1f28ad4bd8a7ec3324867bdaf526eb55c4cdb7031b46eea');
    assert.deepEqual(runtime.network, { mode: 'host' });
    assert.equal(runtime.start, 'sh /code/scripts/start-livekit-server-agent.sh');
    assert.equal(runtime.health.readiness.script, 'healthcheck.sh');
});

test('Explorer enables the default robot owner from this repository without requiring the retired CLI agent', async () => {
    const manifest = await readManifest(identityOf('explorer'));
    const enabled = manifest.enable.map((entry) => typeof entry === 'string' ? entry : entry.agent);
    assert.deepEqual(enabled.filter((entry) => entry.split(/\s+/)[0] === 'roboTeamAgent'),
        ['roboTeamAgent global no-wait']);
    assert.equal(enabled.some((entry) => entry.split(/\s+/)[0] === 'AchillesCLI/achilles-cli'), false);
});
