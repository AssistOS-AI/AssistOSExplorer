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
    assert.match(modal.listEl.innerHTML, /data-repo-toggle="local-skills">local-skills<\/summary>/);
});
