import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RolesPage } from '../public/dashboard/roles.mjs';
import { callManagementTool } from '../public/dashboard/api.mjs';

const manager = { user: { id: 'manager' }, capabilities: ['admin.users.manage'] };
const role = { id: 'role-1', name: 'reviewer', description: 'Review documents', builtin: false, capabilities: ['documents.read'], userCount: 0 };
const permissions = [
    { capability: 'documents.read', description: 'Read documents', scope: 'documents' },
    { capability: 'admin.users.manage', description: 'Manage users and roles', scope: 'administration' },
];

function fixture({ roles = [role], profile = manager } = {}) {
    const nodes = new Map();
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, {
            value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, open: false,
            classList: { toggle() {} }, handlers: {}, inputs: [], labels: [],
            addEventListener(name, callback) { this.handlers[name] = callback; },
            focus() { this.focused = true; }, contains() { return true; },
            querySelectorAll(selector) { return selector === '[data-permission-choice]' ? this.labels : this.inputs.filter((input) => input.checked); },
        });
        return nodes.get(id);
    }
    const links = ['admin.users.manage', 'admin.agentSettings.manage'].map((capability) => ({ dataset: { capability }, hidden: false }));
    const document = { getElementById: node, querySelectorAll: () => links };
    const host = { handlers: {}, location: { pathname: '/service/dashboard/roles.html', reload() { host.reloaded = true; } }, addEventListener(name, callback) { this.handlers[name] = callback; } };
    const calls = [];
    const page = new RolesPage(document, host, async (name, args) => {
        calls.push({ name, args });
        return name === 'userpersisto_profile_get' ? profile
            : name === 'userpersisto_roles_list' ? { roles, permissions, totalCount: roles.length } : role;
    });
    page.state.profile = profile;
    page.state.roles = roles;
    page.state.permissions = permissions;
    page.syncAccess();
    return { page, node, nodes, links, host, calls };
}

test('role catalog pages beyond 500 roles and searches across the complete catalog safely', () => {
    const roles = Array.from({ length: 603 }, (_, index) => ({ ...role, id: `role-${index}`, name: `role-${index}` }));
    roles[602] = { ...roles[602], name: '<script>custom</script>', description: 'Description " onfocus="bad()' };
    const { page, node } = fixture({ roles });
    page.renderRoles();
    assert.equal((node('roles-list').innerHTML.match(/<article/g) || []).length, 50);
    assert.equal(node('roles-page').textContent, '1–50 of 603 roles');
    page.state.start = 600;
    page.renderRoles();
    assert.equal(node('roles-page').textContent, '601–603 of 603 roles');
    assert.match(node('roles-list').innerHTML, /&lt;script&gt;custom&lt;\/script&gt;/);
    assert.doesNotMatch(node('roles-list').innerHTML, /<script>|" onfocus="bad/);
    node('roles-search').value = 'CUSTOM';
    page.renderRoles();
    assert.equal(node('roles-page').textContent, '1–1 of 1 roles');
    assert.equal(node('roles-next').disabled, true);
});

test('built-in roles are inspectable but cannot be saved or deleted even if a caller invokes the methods', async () => {
    for (const name of ['admin', 'user', 'selfRegistered']) {
        const builtin = { ...role, name, builtin: false };
        const { page, node, calls } = fixture({ roles: [builtin] });
        page.editRole(builtin);
        assert.equal(node('role-name').readOnly, true);
        assert.equal(node('role-description').disabled, true);
        assert.equal(node('role-save').hidden, true);
        assert.equal(node('role-delete-section').hidden, true);
        assert.match(node('role-permissions').innerHTML, /value="documents.read" checked disabled/);
        assert.match(node('roles-list').innerHTML, /View permissions/);
        await page.save();
        page.requestDelete();
        await page.confirmDelete();
        assert.equal(calls.length, 0);
    }
});

test('creating a role allows no permissions and uses trimmed fields with no implicit role rights', async () => {
    const { page, node, calls } = fixture();
    page.editRole(null);
    node('role-name').value = ' new-reviewer ';
    node('role-description').value = '  Custom role  ';
    await page.save();
    assert.deepEqual(calls[0], { name: 'userpersisto_role_create', args: { name: 'new-reviewer', description: 'Custom role', capabilities: [] } });
    assert.deepEqual(calls.map((call) => call.name), ['userpersisto_role_create', 'userpersisto_profile_get', 'userpersisto_roles_list']);
    assert.match(page.state.status, /Role created/);
});

test('permission rendering escapes names and descriptions and search never discards a hidden selection', async () => {
    const { page, node, calls } = fixture();
    page.state.permissions.push({ capability: '" onclick="bad', description: '<img onerror=bad>', scope: '<scope>' });
    page.editRole(role);
    assert.match(node('role-permissions').innerHTML, /value="&quot; onclick=&quot;bad"/);
    assert.doesNotMatch(node('role-permissions').innerHTML, /<img|<scope>|value="" onclick/);
    const selected = { value: 'documents.read', checked: true };
    node('role-permissions').inputs = [selected, { value: 'admin.users.manage', checked: false }];
    node('role-permissions').labels = [{ textContent: 'documents.read Read documents', hidden: false }, { textContent: 'admin.users.manage', hidden: false }];
    node('role-permission-search').value = 'admin';
    page.filterPermissions();
    assert.deepEqual(node('role-permissions').labels.map((label) => label.hidden), [true, false]);
    assert.equal(selected.checked, true);
    node('role-name').value = 'attempted-rename';
    await page.save();
    assert.deepEqual(calls[0], { name: 'userpersisto_role_update', args: { roleId: role.id, description: role.description, capabilities: ['documents.read'] } });
    assert.ok(!Object.hasOwn(calls[0].args, 'name'), 'an edit never sends an immutable role name');
});

test('invalid creation data never issues a write', async () => {
    const { page, node, calls } = fixture();
    page.editRole(null);
    for (const name of ['', '-bad', 'spaces forbidden', 'ș', 'a'.repeat(129)]) {
        node('role-name').value = name;
        await page.save();
        assert.equal(calls.length, 0, name);
    }
    node('role-name').value = 'valid';
    node('role-description').value = 'x'.repeat(1001);
    await page.save();
    assert.equal(calls.length, 0);
});

test('deletion requires an unused custom role and an explicit in-page confirmation', async () => {
    const { page, node, calls } = fixture();
    page.editRole(role);
    await page.confirmDelete();
    assert.equal(calls.length, 0);
    page.requestDelete();
    assert.equal(node('role-delete-confirmation').hidden, false);
    assert.equal(node('role-confirm-delete').focused, true);
    await page.confirmDelete();
    assert.deepEqual(calls[0], { name: 'userpersisto_role_delete', args: { roleId: role.id } });
    assert.equal(page.state.status, 'Role deleted.');
    const used = { ...role, userCount: 1 };
    page.state.roles = [used];
    page.editRole(used);
    assert.equal(node('role-delete').disabled, true);
    page.requestDelete();
    await page.confirmDelete();
    assert.equal(calls.length, 3, 'assigned roles cannot reach the deletion endpoint');
});

test('failed writes retain edits, domain protection errors retain access, and duplicate writes are blocked', async () => {
    const { page, node } = fixture();
    page.editRole(role);
    node('role-description').value = 'Unsaved description';
    let reject;
    let calls = 0;
    page.callTool = async () => { calls++; return new Promise((resolve, fail) => { reject = fail; }); };
    const pending = page.save();
    await page.save();
    assert.equal(calls, 1);
    assert.equal(node('roles-controls').disabled, true);
    reject(Object.assign(new Error('builtin_role_protected'), { code: 'builtin_role_protected', statusCode: 403 }));
    await pending;
    assert.equal(page.allowed(), true);
    assert.equal(node('role-description').value, 'Unsaved description');
    assert.equal(node('roles-controls').disabled, false);
    assert.match(page.state.status, /Built-in roles cannot/);
});

test('duplicate role names show a helpful error while preserving the draft for correction', async () => {
    const { page, node } = fixture();
    page.editRole(null);
    node('role-name').value = 'reviewer';
    page.callTool = async () => { throw Object.assign(new Error('role_name_taken'), { code: 'role_name_taken', statusCode: 409 }); };
    await page.save();
    assert.equal(page.state.status, 'A role with this name already exists.');
    assert.equal(node('role-name').value, 'reviewer');
    assert.equal(page.allowed(), true);
});

test('authorization loss clears role data and prevents further changes', async () => {
    for (const statusCode of [401, 403]) {
        const { page, node, links } = fixture();
        page.editRole(role);
        let calls = 0;
        page.callTool = async () => { calls++; throw Object.assign(new Error('admin_required'), { statusCode, code: 'admin_required' }); };
        await page.save();
        assert.deepEqual(page.state.roles, []);
        assert.deepEqual(page.state.permissions, []);
        assert.equal(node('roles-list').innerHTML, '');
        assert.equal(node('role-name').value, '');
        assert.equal(node('roles-controls').hidden, true);
        assert.equal(node('roles-login').hidden, false);
        assert.ok(links.every((link) => link.hidden));
        await page.save();
        assert.equal(calls, 1);
    }
});

test('saving a role rechecks the actor so removing their management permission clears the page', async () => {
    const { page, node } = fixture();
    page.editRole(role);
    const calls = [];
    page.callTool = async (name) => { calls.push(name); return name === 'userpersisto_profile_get' ? { user: { id: 'manager' }, capabilities: [] } : role; };
    await page.save();
    assert.deepEqual(calls, ['userpersisto_role_update', 'userpersisto_profile_get']);
    assert.deepEqual(page.state.roles, []);
    assert.equal(node('roles-controls').hidden, true);
    assert.equal(node('roles-login').hidden, true, 'authenticated users without authority retain only permitted navigation');
    assert.equal(page.state.status, 'You do not have permission to manage roles.');
});

test('non-managers never load the catalog; pagehide clears data and ignores late results; bfcache forces reload', async () => {
    const denied = fixture({ profile: { user: { id: 'member' }, capabilities: [] } });
    await denied.page.initialize();
    assert.deepEqual(denied.calls.map((call) => call.name), ['userpersisto_profile_get']);
    const { page, node, host } = fixture();
    page.bind();
    page.editRole(role);
    let complete;
    page.callTool = () => new Promise((resolve) => { complete = resolve; });
    const pending = page.loadCatalog(page.generation);
    host.handlers.pagehide();
    complete({ roles: [role], permissions });
    await pending;
    assert.equal(page.disposed, true);
    assert.deepEqual(page.state.roles, []);
    assert.equal(node('roles-list').innerHTML, '');
    host.handlers.pageshow({ persisted: true });
    assert.equal(host.reloaded, true);
});

test('Escape closes the permission picker and restores keyboard focus', () => {
    const { page, node } = fixture();
    page.bind();
    node('role-permission-picker').open = true;
    let prevented = false;
    node('role-permission-picker').handlers.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(node('role-permission-picker').open, false);
    assert.equal(node('role-permission-summary').focused, true);
    assert.equal(prevented, true);
});

test('role actions use fixed POST endpoints and every account page has capability-gated Roles navigation', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { roles: [] } }) };
    });
    for (const [name, action] of [['userpersisto_roles_list', 'list'], ['userpersisto_role_create', 'create'], ['userpersisto_role_update', 'update'], ['userpersisto_role_delete', 'delete']]) {
        await callManagementTool(name, { roleId: '../users/delete' });
        const call = calls.at(-1);
        assert.ok(call.url.pathname.endsWith(`/api/admin/roles/${action}`));
        assert.equal(call.options.method, 'POST');
        assert.equal(call.options.credentials, 'same-origin');
        assert.deepEqual(JSON.parse(call.options.body), { roleId: '../users/delete' });
    }
    for (const name of ['index', 'users', 'roles', 'applications', 'authentication']) {
        const html = await readFile(new URL(`../public/dashboard/${name}.html`, import.meta.url), 'utf8');
        assert.match(html, /href="roles.html" data-capability="admin.users.manage"(?: aria-current="page")? hidden>Roles<\/a>/, name);
    }
});
