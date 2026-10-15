import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(import.meta.dirname, '../../IDE-plugins/edit-skills-manifest');
const modalPath = path.join(pluginRoot, 'components/edit-skills-manifest-modal/edit-skills-manifest-modal.js');

// Load the browser module with its absolute Explorer import replaced by a stub.
async function loadModal() {
    const source = await fs.readFile(modalPath, 'utf8');
    const withoutImports = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*/g, '');
    const utilsUrl = pathToFileURL(path.join(pluginRoot, 'skills-manifest-utils.mjs')).href;
    const dependencies = `
        import * as __utils from '${utilsUrl}';
        const { buildSkillsManifestPath, deriveRepoNameFromUrl, parseToolResult } = __utils;
        const callExplorerTool = (...args) => globalThis.__skillsModalCallTool(...args);
        const ensureSuccess = () => {};
    `;
    const url = `data:text/javascript;base64,${Buffer.from(dependencies + withoutImports).toString('base64')}`;
    return import(url);
}

const { EditSkillsManifestModal } = await loadModal();

function createModal({ tools = {}, marketplace = [] } = {}) {
    const calls = [];
    globalThis.__skillsModalCallTool = async (name, args) => {
        calls.push({ name, args });
        const handler = tools[name];
        if (!handler) throw new Error(`unexpected tool ${name}`);
        // Structured tools are requested raw; read_text_file resolves to plain text.
        return name === 'read_text_file' ? handler(args) : { json: await handler(args) };
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, marketplace: { repositories: marketplace } }) });
    const element = { dataset: { folderPath: '/project' }, getAttribute: () => '' };
    const modal = new EditSkillsManifestModal(element, () => {});
    modal.statusEl = { textContent: '', hidden: true, classList: { toggle() {} } };
    modal.urlInput = { value: '' };
    modal.nameInput = { value: '' };
    modal.branchInput = { value: '' };
    return { modal, calls };
}

const failingState = () => { throw new Error('structured skills state unavailable'); };
const rawReads = (calls) => calls.filter((call) => call.name === 'read_text_file');

test('a structured state failure never falls back to reading the raw manifest', async () => {
    const { modal, calls } = createModal({
        tools: { read_skills_manifest_state: failingState, read_text_file: () => '[{"url":"https://u:SENTINEL@h.example/r.git","name":"r","skills":[]}]' },
    });
    await assert.rejects(modal.readCurrentState(), /structured skills state unavailable/);
    await modal.loadState();
    assert.equal(rawReads(calls).length, 0);
    assert.deepEqual(modal.state.repositories, []);
    assert.match(modal.statusEl.textContent, /structured skills state unavailable/);
    assert.equal(modal.statusEl.textContent.includes('SENTINEL'), false);
});

test('a failed refresh after a mutation reports the error without a raw manifest read', async () => {
    const { modal, calls } = createModal({
        tools: {
            add_skills_manifest_repo: () => ({ ok: true, added: true, message: 'r added.' }),
            read_skills_manifest_state: failingState,
            read_text_file: () => '[]',
        },
    });
    modal.urlInput.value = 'https://github.example/acme/r.git';
    await modal.addRepository();
    assert.equal(rawReads(calls).length, 0);
    assert.match(modal.statusEl.textContent, /structured skills state unavailable/);
});

test('marketplace skill repositories with a blank display URL stay listed by name', async () => {
    const { modal } = createModal({
        marketplace: [
            { name: 'local-skills', kind: 'skills', url: '', description: 'Local skills' },
            { name: 'cred-skills', kind: 'mixed', url: 'https://github.example/acme/cred-skills.git' },
            { name: 'agents-only', kind: 'agents', url: 'https://github.example/acme/agents.git' },
            { name: '', kind: 'skills', url: 'https://github.example/acme/nameless.git' },
        ],
    });
    const repositories = await modal.loadMarketplaceSkillRepositories();
    assert.deepEqual(repositories.map((repo) => [repo.name, repo.url]), [
        ['cred-skills', 'https://github.example/acme/cred-skills.git'],
        ['local-skills', ''],
    ]);
});

test('recommended repositories are added by their known name, never by a display URL', async () => {
    const added = [];
    const { modal } = createModal({
        tools: {
            add_skills_manifest_repo: (args) => { added.push(args); return { ok: true, added: true, message: `${args.name} added.` }; },
            read_skills_manifest_state: () => ({ repositories: [{ name: 'local-skills', url: '', cached: true, skills: [], availableSkills: [] }] }),
        },
    });
    modal.state.skillRepositories = [
        { name: 'local-skills', label: 'local-skills', url: '', branch: '' },
        { name: 'cred-skills', label: 'cred-skills', url: 'https://github.example/acme/cred-skills.git', branch: 'main' },
    ];
    await modal.addPresetRepository('0');
    assert.equal(modal.urlInput.value, '');
    await modal.addPresetRepository('1');
    assert.deepEqual(added, [
        { folderPath: '/project', url: 'local-skills', name: 'local-skills' },
        { folderPath: '/project', url: 'cred-skills', name: 'cred-skills', branch: 'main' },
    ]);
    assert.equal(modal.statusEl.textContent.includes('cred-skills added.'), true);
});

test('a typed repository URL or name is still submitted as entered', async () => {
    const added = [];
    const { modal } = createModal({
        tools: {
            add_skills_manifest_repo: (args) => { added.push(args); return { ok: true, added: true }; },
            read_skills_manifest_state: () => ({ repositories: [] }),
        },
    });
    modal.urlInput.value = 'https://github.example/acme/typed-skills.git';
    await modal.addRepository();
    modal.urlInput.value = 'local-skills';
    await modal.addRepository();
    modal.urlInput.value = '';
    await modal.addRepository();
    assert.deepEqual(added, [
        { folderPath: '/project', url: 'https://github.example/acme/typed-skills.git', name: 'typed-skills' },
        { folderPath: '/project', url: 'local-skills', name: 'local-skills' },
    ]);
    assert.match(modal.statusEl.textContent, /required/);
});

test('repository rows are labelled by name when no path or display URL is available', () => {
    const { modal } = createModal();
    modal.listEl = { innerHTML: '' };
    modal.state.repositories = [{ name: 'local-skills', url: '', cached: true, repoPath: '', skills: [], availableSkills: [], skillsets: [], cacheError: '' }];
    modal.renderList();
    assert.match(modal.listEl.innerHTML, /data-repo-select="local-skills"[^>]*aria-pressed="true"[^>]*><span>local-skills<\/span>/);
});

function repository(name, extra = {}) {
    return { name, url: '', cached: true, repoPath: '', skills: [], availableSkills: [], skillsets: [], cacheError: '', ...extra };
}

test('recommended rows do not repeat the name as their description', () => {
    const { modal } = createModal();
    modal.presetListEl = { innerHTML: '' };
    modal.state.skillRepositories = [{ name: 'docs', label: 'docs' }, { name: 'review', label: 'Review project documentation' }];
    modal.renderPresets();
    assert.doesNotMatch(modal.presetListEl.innerHTML, /class="muted">docs</);
    assert.match(modal.presetListEl.innerHTML, /class="muted">Review project documentation</);
});

test('repository selection shows only that source and survives skill mutations', async () => {
    const { modal, calls } = createModal({ tools: {
        set_skills_manifest_skill_enabled: () => ({ repositories: [repository('one'), repository('two', { skills: ['alpha'], availableSkills: ['alpha'] })] }),
    } });
    modal.listEl = { innerHTML: '' };
    modal.detailEl = { innerHTML: '' };
    modal.state.repositories = [repository('one'), repository('two', { availableSkills: ['alpha'] })];
    modal.selectRepository('two');
    assert.equal(modal.selectedRepository, 'two');
    assert.match(modal.detailEl.innerHTML, /<h3[^>]*>two<\/h3>/);
    assert.doesNotMatch(modal.detailEl.innerHTML, /<h3[^>]*>one<\/h3>/);
    await modal.setSkillEnabled('two', 'alpha', true);
    assert.equal(modal.selectedRepository, 'two');
    assert.deepEqual(calls[0], { name: 'set_skills_manifest_skill_enabled', args: { folderPath: '/project', repoName: 'two', skill: 'alpha', enabled: true } });
    assert.match(modal.detailEl.innerHTML, /data-skill-name="alpha"[^>]*checked/);
    modal.selectRepository('missing');
    assert.equal(modal.selectedRepository, 'two');
    modal.state.repositories = [repository('one')];
    modal.renderList();
    assert.equal(modal.selectedRepository, 'one');
});

test('skillset members are compactly nested, overlapping partial selections stay visible and individual toggles are absent', () => {
    const { modal } = createModal();
    const checkbox = { indeterminate: false };
    modal.detailEl = { innerHTML: '', querySelectorAll: () => [checkbox] };
    modal.renderRepository(repository('docs', {
        availableSkills: ['alpha', 'beta', 'outside'], skills: ['alpha'],
        skillsets: [{ name: 'Reports', description: 'Write reports', skills: ['alpha', 'beta'], enabled: false, partial: true }],
    }));
    assert.match(modal.detailEl.innerHTML, /<article[^>]*>[\s\S]*data-skillset-name="Reports"[\s\S]*<ul class="skill-members"><li>alpha<\/li><li>beta<\/li><\/ul><\/article>/);
    assert.match(modal.detailEl.innerHTML, /aria-checked="mixed"/);
    assert.match(modal.detailEl.innerHTML, /Partially enabled/);
    assert.equal(checkbox.indeterminate, true);
    assert.doesNotMatch(modal.detailEl.innerHTML, /data-skill-name=/);
    assert.match(modal.detailEl.innerHTML, /Other skills[\s\S]*<li>outside<\/li>/);
    assert.equal((modal.detailEl.innerHTML.match(/<li>alpha<\/li>/g) || []).length, 1);
});

test('rendering escapes repository names, descriptions, skills, paths and cache errors', () => {
    const { modal } = createModal();
    const unsafe = '<img src=x onerror=alert(1)>';
    modal.detailEl = { innerHTML: '' };
    modal.renderRepository(repository(unsafe, { repoPath: unsafe, skills: [unsafe], cacheError: unsafe,
        skillsets: [{ name: unsafe, description: unsafe, skills: [unsafe], enabled: true }] }));
    assert.doesNotMatch(modal.detailEl.innerHTML, /<img/);
    assert.match(modal.detailEl.innerHTML, /&lt;img/);
});

test('adding selects the new repository and removing it selects the remaining source', async () => {
    let removed = false;
    const { modal } = createModal({ tools: {
        add_skills_manifest_repo: () => ({ added: true }),
        remove_skills_manifest_repo: () => { removed = true; return {}; },
        read_skills_manifest_state: () => ({ repositories: removed ? [repository('old')] : [repository('old'), repository('new')] }),
    } });
    modal.listEl = { innerHTML: '' };
    modal.state.repositories = [repository('old')];
    modal.selectedRepository = 'old';
    modal.urlInput.value = 'new';
    await modal.addRepository();
    assert.equal(modal.selectedRepository, 'new');
    await modal.removeRepository('new');
    assert.equal(modal.selectedRepository, 'old');
});

function addPopup(modal) {
    let focuses = 0;
    modal.addTrigger = { setAttribute() {}, focus() { focuses++; } };
    modal.addStatusEl = { textContent: '', hidden: true, classList: { toggle() {} } };
    modal.addDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, contains: () => true };
    return () => focuses;
}

test('the add popup preserves the draft and selection, blocks dismissal while busy and contains errors', () => {
    const { modal } = createModal();
    const focuses = addPopup(modal);
    modal.selectedRepository = 'selected';
    modal.urlInput.value = 'draft';
    modal.urlInput.focus = () => {};
    modal.openAddRepository();
    assert.equal(modal.addDialog.open, true);
    modal.setStatus('Popup failure', 'error');
    assert.equal(modal.addStatusEl.textContent, 'Popup failure');
    assert.equal(modal.statusEl.textContent, '');
    modal.busy = true;
    modal.closeAddRepository();
    assert.equal(modal.addDialog.open, true);
    modal.busy = false;
    modal.boundAddCancel({ preventDefault() {}, stopPropagation() {} });
    assert.equal(modal.addDialog.open, false);
    assert.equal(modal.selectedRepository, 'selected');
    assert.equal(modal.urlInput.value, 'draft');
    assert.equal(focuses(), 1);
});

test('Escape on the add popup is not intercepted by the WebSkel parent and change events use the checkbox state', async () => {
    const { modal } = createModal();
    addPopup(modal);
    modal.addDialog.open = true;
    let stopped = 0, prevented = 0, request;
    const event = { key: 'Escape', target: {}, stopPropagation() { stopped++; }, preventDefault() { prevented++; } };
    modal.handleKeydown(event);
    assert.equal(stopped, 1);
    assert.equal(prevented, 0);
    modal.busy = true;
    modal.handleKeydown(event);
    assert.equal(prevented, 1);
    modal.element.contains = () => true;
    modal.setSkillEnabled = async (...args) => { request = args; };
    const input = { disabled: false, checked: true, dataset: { repoName: 'docs', skillsetName: 'Reports' }, hasAttribute: () => true };
    modal.handleChange({ target: { closest: () => input } });
    assert.deepEqual(request, ['docs', 'Reports', true, true]);
});

test('the WebSkel template separates navigation, detail, popup and local status; layout reuses theme tokens', async () => {
    const root = path.dirname(modalPath);
    const html = await fs.readFile(path.join(root, 'edit-skills-manifest-modal.html'), 'utf8');
    const css = await fs.readFile(path.join(root, 'edit-skills-manifest-modal.css'), 'utf8');
    assert.match(html, /<nav class="skills-repository-nav"[\s\S]*data-add-repository[\s\S]*data-repository-list[\s\S]*<\/nav>/);
    assert.match(html, /<dialog[^>]*data-add-dialog[\s\S]*data-add-form[\s\S]*data-add-status[\s\S]*<\/dialog>/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.equal((html.match(/data-add-close/g) || []).length, 1);
    assert.match(html, /data-add-close>Close<\/button>/);
    assert.doesNotMatch(html, />Cancel<\/button>/);
    assert.match(html, /data-status role="status" aria-live="polite"/);
    assert.match(css, /grid-template-columns: minmax\(180px, 26%\) minmax\(0, 1fr\)/);
    assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\)/);
    assert.match(css, /accent-color: var\(--accent\)/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});

// Modal-to-handler regressions: a recommendation is submitted by name and the
// server must resolve an exact registered name (including one ending in .git)
// to its configured URL before any URL heuristic.
const { createToolHandlers } = await import('../../utils/server/tool-handlers.mjs');
const CONFIGURED_URL = 'https://example.test/real-skills.git';

async function modalAgainstHandlers(t, { name, origin, typedUrl = '' }) {
    const os = await import('node:os');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-modal-name-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'cached', name);
    await fs.mkdir(path.join(root, 'project', '.agents'), { recursive: true });
    await fs.mkdir(path.join(source, 'skills', 'alpha-skill'), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\n---\n');
    const registered = { name, url: CONFIGURED_URL, source: origin === 'remote' ? CONFIGURED_URL : source, origin, kind: 'skills', branch: 'main' };
    const calls = { prepare: [], add: [] };
    const client = {
        async listRepositories() { return [{ ...registered }]; },
        async prepareRepository(input) {
            calls.prepare.push({ ...input });
            if (input.url !== CONFIGURED_URL && input.name !== registered.name) throw new Error('unknown source');
            Object.assign(registered, { source, origin: 'installed' });
            return client.listRepositories();
        },
        async install() { return { results: [], conflicts: [] }; },
        async remove() { return { results: [], conflicts: [] }; },
    };
    const any = { safeParse: (value) => ({ success: true, data: value || {} }) };
    const handlers = createToolHandlers({
        repositoryClient: client, fs, path, schemas: new Proxy({}, { get: () => any }),
        validatePath: async (value) => path.resolve(root, String(value).replace(/^\//, '')),
        workspaceRoot: root,
        invalidateCachesForPath() {}, invalidateStructureIndexSubtree() {},
        getAllowedDirectories: () => [root], getInvocationContext: () => ({}),
    });
    const { modal } = createModal();
    globalThis.__skillsModalCallTool = async (tool, args) => {
        if (tool === 'add_skills_manifest_repo') calls.add.push({ ...args });
        return handlers[tool](args);
    };
    if (typedUrl) {
        modal.urlInput.value = typedUrl;
        await modal.addRepository();
    } else {
        modal.state.skillRepositories = [{ name, label: name, url: '', branch: 'main' }];
        await modal.addPresetRepository('0');
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'project', 'ploinky-skills-manifest.json'), 'utf8'));
    return { calls, manifest, modal };
}

test('a remote registered repository named *.git is prepared and saved with its configured URL', async (t) => {
    const { calls, manifest, modal } = await modalAgainstHandlers(t, { name: 'custom.git', origin: 'remote' });
    assert.equal(calls.add[0].url, 'custom.git');
    assert.deepEqual(calls.prepare.map((call) => call.url), [CONFIGURED_URL]);
    assert.deepEqual(manifest.map((entry) => [entry.name, entry.url, entry.branch]), [['custom.git', CONFIGURED_URL, 'main']]);
    assert.equal(modal.changed, true);
});

test('an installed registered repository named *.git is saved with its configured URL without preparation', async (t) => {
    const { calls, manifest } = await modalAgainstHandlers(t, { name: 'custom.git', origin: 'installed' });
    assert.deepEqual(calls.prepare, []);
    assert.deepEqual(manifest.map((entry) => [entry.name, entry.url]), [['custom.git', CONFIGURED_URL]]);
});

test('an ordinary registered name keeps its configured URL', async (t) => {
    const { calls, manifest } = await modalAgainstHandlers(t, { name: 'custom', origin: 'remote' });
    assert.deepEqual(calls.prepare.map((call) => call.url), [CONFIGURED_URL]);
    assert.equal(manifest[0].url, CONFIGURED_URL);
});

test('a manually entered URL is still prepared and saved as entered', async (t) => {
    const { calls, manifest } = await modalAgainstHandlers(t, { name: 'real-skills', origin: 'remote', typedUrl: CONFIGURED_URL });
    assert.equal(calls.add[0].url, CONFIGURED_URL);
    assert.deepEqual(calls.prepare.map((call) => call.url), [CONFIGURED_URL]);
    assert.deepEqual(manifest.map((entry) => [entry.name, entry.url]), [['real-skills', CONFIGURED_URL]]);
});
