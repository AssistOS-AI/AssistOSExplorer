import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installRepositoryLinks, removeRepositoryLinks } from '../../../../ploinky/cli/utils/repositoryInstall.mjs';
import { remoteUrlOrEmpty as ploinkyRemoteUrlOrEmpty } from '../../../../ploinky/cli/server/authHandlers/marketplaceProjection.js';
import { createToolHandlers } from '../../utils/server/tool-handlers.mjs';
import { displayRemoteUrl } from '../../utils/server/skills-manifest-projection.mjs';

// Synthetic sentinels only: no real credential or host path is used.
const CRED_URL = 'https://x-access-token:SENTINELTOKEN@github.example/acme/cred-skills.git?access_token=SENTINELQUERY#SENTINELFRAG';
const CRED_DISPLAY = 'https://github.example/acme/cred-skills.git';
const BROKEN_URL = 'https://SENTINELTOKEN@git.example/acme/broken-skills.git';
const TOOLS = ['read_skills_manifest_state', 'add_skills_manifest_repo', 'set_skills_manifest_skill_enabled', 'remove_skills_manifest_repo'];

const userGrant = (id, roles, extra = {}) => ({ invocation: { sub: `user:${id}`, actor: { kind: 'user', id: `user:${id}`, roles }, ...extra } });
const ADMIN = userGrant('ops-1', ['admin']);
const RESTRICTED = {
    namedAdmin: userGrant('admin', ['user']),
    legacyLocalAdminId: { invocation: { actor: { kind: 'user', id: 'local:admin' } } },
    guestAdmin: userGrant('ops-2', ['admin', 'guest']),
    guestActorWithAdminRole: { invocation: { sub: 'user:ops-1', actor: { kind: 'guest', id: 'guest:visitor', roles: ['admin'] } } },
    delegatedNonAdminWithAdminActor: userGrant('ops-1', ['admin'], { usr: { id: 'plain-user', username: 'plain', roles: ['user'] } }),
    backendMachine: { invocation: { sub: 'agent:AchillesIDE/explorer', caller: { kind: 'agent', id: 'agent:AchillesIDE/explorer', roles: ['admin'] } } },
    missingContext: {},
    malformedContext: { invocation: 'admin' },
    plainHeadersAndUser: { headers: { 'x-ploinky-user-roles': 'admin', 'x-ploinky-user': 'admin' }, user: { id: 'admin', roles: ['admin'] }, actor: { roles: ['admin'] } },
};
const FORGED_ARGS = { invocation: ADMIN.invocation, user: { username: 'admin', roles: ['admin'] }, actor: ADMIN.invocation.actor, isAdmin: true };

async function writeFile(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
}

const parse = (response) => JSON.parse(response.content.find((entry) => entry.type === 'text').text);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function minimalSchemas() {
    const any = { safeParse: (value) => ({ success: true, data: value || {} }) };
    return new Proxy({}, { get: () => any });
}

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-projection-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const credRepo = path.join(root, 'cache', 'cred-skills');
    await writeFile(path.join(credRepo, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\n---\n');
    await writeFile(path.join(credRepo, 'skills', 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\n---\n');
    const localRepo = path.join(root, 'local-skills');
    await writeFile(path.join(localRepo, 'skills', 'gamma-skill', 'SKILL.md'), '---\nname: gamma-skill\n---\n');
    const emptyRepo = path.join(root, 'cache', 'empty-skills');
    await writeFile(path.join(emptyRepo, 'README.md'), 'no skills');
    const project = path.join(root, 'project');
    await fs.mkdir(project, { recursive: true });
    return { root, credRepo, localRepo, emptyRepo, project };
}

// Fake authenticated repository client: it records the internal arguments it
// receives and publishes real links through Ploinky's install helpers.
function createClient(fx) {
    const calls = { list: 0, prepare: [], install: [], remove: [] };
    const registry = new Map([
        ['cred-skills', { name: 'cred-skills', url: CRED_URL, source: CRED_URL, origin: 'remote', kind: 'skills', branch: 'main' }],
        ['local-skills', { name: 'local-skills', url: '', source: fx.localRepo, origin: 'workspace', kind: 'skills' }],
        ['broken-skills', { name: 'broken-skills', url: BROKEN_URL, source: BROKEN_URL, origin: 'remote', kind: 'skills' }],
        ['empty-skills', { name: 'empty-skills', url: 'https://git.example/acme/empty-skills.git', source: fx.emptyRepo, origin: 'workspace', kind: 'skills' }],
    ]);
    const client = {
        async listRepositories() { calls.list += 1; return [...registry.values()].map((repo) => ({ ...repo })); },
        async prepareRepository(input) {
            calls.prepare.push({ ...input });
            if (input.name === 'cred-skills') {
                registry.set('cred-skills', { ...registry.get('cred-skills'), source: fx.credRepo, origin: 'installed' });
                return client.listRepositories();
            }
            throw new Error(`git clone ${input.url} ${fx.root}/.ploinky/repos/${input.name} failed: SENTINELSTDERR`);
        },
        async install(input) {
            calls.install.push(JSON.parse(JSON.stringify(input)));
            return installRepositoryLinks(input, { workspaceRoot: fx.root, resolveRepository: (name) => registry.get(name) });
        },
        async remove(paths) {
            calls.remove.push([...paths]);
            return removeRepositoryLinks(paths, { workspaceRoot: fx.root });
        },
    };
    return { client, calls };
}

function createHandlers(fx, client, getInvocationContext) {
    const noop = () => {};
    return createToolHandlers({
        repositoryClient: client,
        fs,
        path,
        schemas: minimalSchemas(),
        validatePath: async (value) => {
            const raw = String(value || '');
            const resolved = path.resolve(fx.root, raw.startsWith('/') && !raw.startsWith(fx.root) ? raw.slice(1) : raw);
            if (resolved !== fx.root && !resolved.startsWith(`${fx.root}${path.sep}`)) throw new Error(`Access denied: ${resolved}`);
            return resolved;
        },
        workspaceRoot: fx.root,
        invalidateCachesForPath: noop,
        invalidateStructureIndexSubtree: noop,
        directoryTreeCache: new Map(),
        searchFilesCache: new Map(),
        searchTextCache: new Map(),
        getAllowedDirectories: () => [fx.root],
        getInvocationContext,
    });
}

const walk = (value, visit, key = '') => {
    visit(value, key);
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit, key));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, visit, name);
};

function assertRestricted(body, fx, label) {
    const text = JSON.stringify(body);
    assert.equal(/SENTINEL/.test(text), false, `${label}: credential or error sentinel leaked: ${text}`);
    for (const needle of [fx.root, os.tmpdir(), fx.credRepo, fx.localRepo, '..']) {
        assert.equal(text.includes(needle), false, `${label}: leaked ${needle}`);
    }
    walk(body, (value, key) => {
        assert.equal(['repoPath', 'skillSource', 'destination', 'path'].includes(key), false, `${label}: ${key} present`);
        if (key === 'source') assert.equal(typeof value === 'string', false, `${label}: raw source string`);
        if (typeof value === 'string' && ['manifestPath', 'folderPath'].includes(key)) {
            assert.match(value, /^\/[^]*$/, `${label}: ${key} is workspace-relative`);
        }
    });
}

async function seedManifest(fx) {
    const manifest = [
        { url: CRED_URL, name: 'cred-skills', branch: 'main', skills: ['alpha-skill'] },
        { url: BROKEN_URL, name: 'broken-skills', branch: null, skills: ['broken-skill'] },
    ];
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(fx.project, 'ploinky-skills-manifest.json'), bytes);
    return bytes;
}

test('the Explorer URL redactor matches the Ploinky Marketplace redactor on every vector', () => {
    const vectors = [
        ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
        ['https://user:SENTINELPW@github.com/o/r.git', 'https://github.com/o/r.git'],
        ['https://SENTINELTOKEN@github.com/o/r.git', 'https://github.com/o/r.git'],
        ['https://SENTINEL%40TOKEN:SENTINEL%3APW@github.com/o/r.git', 'https://github.com/o/r.git'],
        ['https://github.com/o/r.git?access_token=SENTINELQUERY#SENTINELFRAG', 'https://github.com/o/r.git'],
        ['ssh://git@host.example:2222/o/r.git', 'ssh://host.example:2222/o/r.git'],
        ['git@github.com:o/r.git', 'github.com:o/r.git'],
        ['SENTINELTOKEN@github.com:o/r.git', 'github.com:o/r.git'],
        ['SENTINELUSER:SENTINELPW@github.com:o/r.git', ''],
        ['https://host.example/user:SENTINELPW@evil.example/r.git', ''],
        ['https://host.example/SENTINEL%40TOKEN/r.git', ''],
        ['git+ssh://git@host.example/r.git', ''],
        ['file:///Users/x/repo', ''],
        ['/Users/x/work/repo', ''],
        ['./repo', ''],
        ['~/repo', ''],
        ['C:\\repo', ''],
        ['user@localhost:repo', ''],
        ['local-skills', ''],
        ['', ''],
        [null, ''],
    ];
    for (const [input, expected] of vectors) {
        assert.equal(displayRemoteUrl(input), expected, `explorer ${input}`);
        assert.equal(ploinkyRemoteUrlOrEmpty(input), expected, `ploinky ${input}`);
    }
});

test('a genuine administrator with another username keeps raw sources, paths and errors', async (t) => {
    const fx = await fixture(t);
    await seedManifest(fx);
    const { client } = createClient(fx);
    const handlers = createHandlers(fx, client, () => ADMIN);
    const state = parse(await handlers.read_skills_manifest_state({ folderPath: '/project' }));
    assert.equal(state.manifestPath, path.join(fx.project, 'ploinky-skills-manifest.json'));
    const cred = state.repositories.find((repo) => repo.name === 'cred-skills');
    assert.equal(cred.url, CRED_URL);
    assert.equal(cred.repoPath, fx.credRepo);
    assert.match(state.repositories.find((repo) => repo.name === 'broken-skills').cacheError, /SENTINELSTDERR/);
    assert.equal(state.skillRepositories.find((repo) => repo.name === 'local-skills').url, fx.localRepo);
    await fs.writeFile(path.join(fx.project, 'ploinky-skills-manifest.json'), '{not json');
    await assert.rejects(handlers.read_skills_manifest_state({ folderPath: '/project' }), (error) => error.message.includes(fx.project));
});

for (const [label, context] of Object.entries(RESTRICTED)) {
    test(`restricted invocation (${label}) receives projected results from all four tools and their errors`, async (t) => {
        const fx = await fixture(t);
        const manifestBytes = await seedManifest(fx);
        const manifestFile = path.join(fx.project, 'ploinky-skills-manifest.json');
        // A pre-existing user file produces a preserved-output conflict with physical paths.
        await writeFile(path.join(fx.project, '.agents', 'skills', 'beta-skill', 'SKILL.md'), 'local beta');
        const { client, calls } = createClient(fx);
        const handlers = createHandlers(fx, client, () => context);

        const read = parse(await handlers.read_skills_manifest_state({ folderPath: '/project', ...FORGED_ARGS }));
        assertRestricted(read, fx, `${label} read`);
        assert.equal(read.manifestPath, '/project/ploinky-skills-manifest.json');
        assert.equal(read.folderPath, '/project');
        const cred = read.repositories.find((repo) => repo.name === 'cred-skills');
        assert.deepEqual({ url: cred.url, branch: cred.branch, cached: cred.cached, skills: cred.skills, availableSkills: cred.availableSkills, cacheError: cred.cacheError },
            { url: CRED_DISPLAY, branch: 'main', cached: true, skills: ['alpha-skill'], availableSkills: ['alpha-skill', 'beta-skill'], cacheError: '' });
        const broken = read.repositories.find((repo) => repo.name === 'broken-skills');
        assert.equal(broken.cached, false);
        assert.ok(broken.cacheError.length > 0, 'cache failure stays visible as a safe status');
        assert.equal(broken.url, 'https://git.example/acme/broken-skills.git');
        const local = read.skillRepositories.find((repo) => repo.name === 'local-skills');
        assert.deepEqual({ url: local.url, label: local.label, installed: local.installed }, { url: '', label: 'local-skills', installed: true });
        assert.equal(read.skillRepositories.find((repo) => repo.name === 'cred-skills').url, CRED_DISPLAY);
        // The internal manifest URL reached the repository client unchanged; stored bytes are untouched.
        assert.equal(calls.prepare.find((call) => call.name === 'cred-skills').url, CRED_URL);
        assert.equal(sha(await fs.readFile(manifestFile)), sha(manifestBytes));

        const withoutBroken = parse(await handlers.remove_skills_manifest_repo({ folderPath: '/project', repoName: 'broken-skills', ...FORGED_ARGS }));
        assertRestricted(withoutBroken, fx, `${label} remove broken`);
        assert.deepEqual(withoutBroken.repositories.map((repo) => repo.name), ['cred-skills']);

        // Enable beta-skill: the conflict diagnostic keeps only safe fields.
        const enabled = parse(await handlers.set_skills_manifest_skill_enabled({ folderPath: '/project', repoName: 'cred-skills', skill: 'beta-skill', enabled: true, ...FORGED_ARGS }));
        assertRestricted(enabled, fx, `${label} set`);
        assert.deepEqual(enabled.exportResult.diagnostics.find((item) => item.name === 'beta-skill'), { name: 'beta-skill', reason: 'existing-output-preserved', status: 'conflict' });
        const alphaOutput = enabled.skillOutputs.find((item) => item.name === 'alpha-skill');
        assert.deepEqual(alphaOutput.source, { name: 'cred-skills', url: CRED_DISPLAY, branch: 'main' });
        assert.equal(alphaOutput.state, 'managed');
        assert.ok(enabled.diagnostics.some((item) => item.name === 'beta-skill' && item.reason === 'local-output-preserved'));
        // The real export is in place and the stored manifest keeps the raw URL.
        assert.equal((await fs.lstat(path.join(fx.project, '.agents', 'skills', 'alpha-skill'))).isSymbolicLink(), true);
        assert.equal(await fs.realpath(path.join(fx.project, '.agents', 'skills', 'alpha-skill')), path.join(fx.credRepo, 'skills', 'alpha-skill'));
        assert.equal(JSON.parse(await fs.readFile(manifestFile, 'utf8'))[0].url, CRED_URL);

        // Remove, then add again by URL: both stay projected while the real links follow.
        const removed = parse(await handlers.remove_skills_manifest_repo({ folderPath: '/project', repoName: 'cred-skills', ...FORGED_ARGS }));
        assertRestricted(removed, fx, `${label} remove`);
        assert.deepEqual(removed.exportResult.removed, ['alpha-skill']);
        await assert.rejects(fs.lstat(path.join(fx.project, '.agents', 'skills', 'alpha-skill')), { code: 'ENOENT' });
        assert.ok(calls.remove.flat().every((entry) => entry.startsWith(fx.project)), 'removal used internal paths');

        const added = parse(await handlers.add_skills_manifest_repo({ folderPath: '/project', url: CRED_URL, name: 'cred-skills', ...FORGED_ARGS }));
        assertRestricted(added, fx, `${label} add`);
        assert.deepEqual({ ok: added.ok, added: added.added, message: added.message }, { ok: true, added: true, message: 'cred-skills added.' });
        assert.equal(added.repositories.find((repo) => repo.name === 'cred-skills').url, CRED_DISPLAY);
        assert.equal(JSON.parse(await fs.readFile(manifestFile, 'utf8')).find((entry) => entry.name === 'cred-skills').url, CRED_URL);
        assert.equal((await fs.lstat(path.join(fx.project, '.agents', 'skills', 'alpha-skill'))).isSymbolicLink(), true);
        assert.ok(calls.install.every((input) => input.skillRepos.every((entry) => entry.destination === fx.project)), 'install used the internal destination');

        // The no-skills add result is projected too.
        const empty = parse(await handlers.add_skills_manifest_repo({ folderPath: '/project', url: 'empty-skills', ...FORGED_ARGS }));
        assertRestricted(empty, fx, `${label} add without skills`);
        assert.deepEqual(Object.keys(empty).sort(), ['added', 'cached', 'message', 'ok']);
        assert.equal(empty.added, false);

        // Thrown errors: validated-name messages survive, everything else is generic.
        const rejectsSafely = async (promise, expected, what) => {
            await assert.rejects(promise, (error) => {
                assert.equal(/SENTINEL/.test(error.message) || error.message.includes(fx.root), false, `${label} ${what}: ${error.message}`);
                if (expected) assert.match(error.message, expected);
                return true;
            });
        };
        await rejectsSafely(handlers.add_skills_manifest_repo({ folderPath: '/project', url: BROKEN_URL, name: 'broken-skills' }), /operation failed/i, 'clone failure');
        await rejectsSafely(handlers.set_skills_manifest_skill_enabled({ folderPath: '/project', repoName: 'missing-repo', skill: 'x', enabled: true }), /'missing-repo' is not in the skills manifest/, 'unknown repo');
        await rejectsSafely(handlers.remove_skills_manifest_repo({ folderPath: '/project', repoName: 'missing-repo' }), /'missing-repo' is not in the skills manifest/, 'remove unknown');
        await rejectsSafely(handlers.read_skills_manifest_state({ folderPath: '/project/absent-folder' }), /operation failed/i, 'missing folder');
        await fs.writeFile(manifestFile, '{not json');
        for (const tool of TOOLS) {
            await rejectsSafely(handlers[tool]({ folderPath: '/project', repoName: 'cred-skills', url: 'cred-skills', skill: 'alpha-skill', enabled: true }), /Invalid JSON in skills manifest\.$/, `${tool} invalid manifest`);
        }
    });
}

test('privilege is captured at tool entry: a later context change never re-projects an in-flight call', async (t) => {
    const fx = await fixture(t);
    await seedManifest(fx);
    const { client } = createClient(fx);
    let current = RESTRICTED.namedAdmin;
    const gate = { release: null };
    const list = client.listRepositories;
    client.listRepositories = async () => {
        await new Promise((resolve) => { gate.release = resolve; });
        return list();
    };
    const handlers = createHandlers(fx, client, () => current);
    const restrictedCall = handlers.read_skills_manifest_state({ folderPath: '/project' });
    current = ADMIN;
    while (!gate.release) await new Promise((resolve) => setImmediate(resolve));
    gate.release();
    gate.release = null;
    client.listRepositories = list;
    assertRestricted(parse(await restrictedCall), fx, 'restricted call after context switched to admin');

    client.listRepositories = async () => {
        await new Promise((resolve) => { gate.release = resolve; });
        return list();
    };
    current = ADMIN;
    const adminCall = handlers.read_skills_manifest_state({ folderPath: '/project' });
    current = {};
    while (!gate.release) await new Promise((resolve) => setImmediate(resolve));
    gate.release();
    client.listRepositories = list;
    const adminState = parse(await adminCall);
    assert.equal(adminState.repositories.find((repo) => repo.name === 'cred-skills').url, CRED_URL);
    assert.equal(adminState.repositories.find((repo) => repo.name === 'cred-skills').repoPath, fx.credRepo);
});

test('a known repository with a blank display URL is still selectable by name', async (t) => {
    const fx = await fixture(t);
    const { client, calls } = createClient(fx);
    const handlers = createHandlers(fx, client, () => RESTRICTED.namedAdmin);
    const state = parse(await handlers.read_skills_manifest_state({ folderPath: '/project' }));
    const preset = state.skillRepositories.find((repo) => repo.name === 'local-skills');
    assert.equal(preset.url, '');
    const added = parse(await handlers.add_skills_manifest_repo({ folderPath: '/project', url: preset.name, name: preset.name }));
    assertRestricted(added, fx, 'name-based add');
    assert.equal(added.added, true);
    assert.deepEqual(added.installedSkills, ['gamma-skill']);
    // The server resolved the name to the internal source, not a display value.
    const manifest = JSON.parse(await fs.readFile(path.join(fx.project, 'ploinky-skills-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.map((entry) => [entry.name, entry.url]), [['local-skills', fx.localRepo]]);
    assert.equal(await fs.realpath(path.join(fx.project, '.agents', 'skills', 'gamma-skill')), path.join(fx.localRepo, 'skills', 'gamma-skill'));
    assert.equal(calls.install.at(-1).skillRepos[0].repoName, 'local-skills');
    assert.equal(fsSync.existsSync(path.join(fx.project, '.claude')), true);
});
