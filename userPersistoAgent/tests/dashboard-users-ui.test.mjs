import test from 'node:test';
import assert from 'node:assert/strict';
import { UserpersistoSettings } from '../public/dashboard/management.mjs';

function fixture({ userId = 'member', roles = ['user'], fields = {} } = {}) {
    const panel = new UserpersistoSettings({ querySelectorAll: () => [], getAttribute: () => 'users' }, () => {});
    panel.state.authProfile = { user: { id: 'manager' }, capabilities: ['admin.users.manage'] };
    panel.state.activePanel = 'users';
    panel.usersListEl = { innerHTML: '', querySelectorAll: () => [] };
    const inputs = Object.entries(fields).map(([userField, value]) => ({ dataset: { userField }, value }));
    const buttons = [{ disabled: false }, { disabled: false }];
    const row = {
        dataset: { userId },
        querySelectorAll: (selector) => ({
            '[data-user-field]': inputs,
            '[data-user-role]:checked': roles.map((value) => ({ value })),
            button: buttons,
        })[selector] || [],
    };
    const calls = [];
    panel.callTool = async (name, args) => { calls.push({ name, args }); return { ok: true }; };
    panel.refreshUsers = async () => { calls.push({ refresh: true }); };
    return { panel, row, inputs, buttons, calls };
}

test('user details preserve empty optional fields, trim edits, submit status independently of roles, and never include email', async () => {
    const { panel, row, calls } = fixture({ fields: { username: '', displayName: '', status: 'blocked' } });
    await panel.updateUser(row, 'details');
    assert.deepEqual(calls, [
        { name: 'userpersisto_user_update', args: { userId: 'member', username: '', displayName: '', status: 'blocked' } },
        { refresh: true },
    ]);
    assert.equal(panel.state.status, 'User details saved.');
    assert.ok(!Object.hasOwn(calls[0].args, 'email'), 'details updates never send an email field');
});

test('user editor shows the account email as read-only text, never as an editable field', () => {
    const { panel } = fixture();
    panel.state.users = [{ id: 'member', email: 'member@example.test', roles: ['user'], status: 'active' }];
    panel.renderUsers();
    assert.match(panel.usersListEl.innerHTML, /member@example\.test/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /data-user-field="email"/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /type="email"/);
});

test('user rows show roles, status and mailbox verification without displaying the internal account ID', () => {
    const { panel } = fixture();
    panel.state.users = [
        { id: 'USER.7', email: 'member@example.test', roles: ['admin', 'user'], status: 'active', emailVerifiedAt: '2026-09-18T10:00:00.000Z' },
        { id: 'USER.8', email: 'unverified@example.test', roles: ['user'], status: 'active', emailVerifiedAt: '' },
    ];
    panel.renderUsers();
    assert.match(panel.usersListEl.innerHTML, /<p class="userpersisto-row-meta">Roles: admin, user · Status: active · Email: verified<\/p>/);
    assert.match(panel.usersListEl.innerHTML, /<p class="userpersisto-row-meta">Roles: user · Status: active · Email: unverified<\/p>/);
    assert.match(panel.usersListEl.innerHTML, /data-user-id="USER\.7"/, 'the row still carries the ID for updates');
    assert.doesNotMatch(panel.usersListEl.innerHTML, />[^<]*USER\.7/, 'no visible text shows the ID');
});

test('role editing preserves custom and multiple selected roles and renders them safely', async () => {
    const roles = ['user', 'book-reviewer', '" autofocus onfocus="alert(1)'];
    const { panel, row, calls } = fixture({ roles });
    panel.state.users = [{ id: 'member', email: '<script>email</script>', roles }];
    panel.renderUsers();
    assert.match(panel.usersListEl.innerHTML, /value="book-reviewer" checked/);
    assert.match(panel.usersListEl.innerHTML, /value="user" checked/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /<script>|value="" autofocus/);
    await panel.updateUser(row, 'roles');
    assert.deepEqual(calls[0], { name: 'userpersisto_user_roles_update', args: { userId: 'member', roles } });
});

test('the role dropdown includes catalog roles not yet assigned to the displayed user', async () => {
    const { panel } = fixture();
    panel.callTool = async () => ({
        users: [{ id: 'member', email: 'member@example.test', roles: ['user'] }],
        totalCount: 1,
        availableRoles: ['user', 'book-reviewer', 'book-reviewer', '<editor>'],
    });
    await panel.loadUsersPage();
    assert.deepEqual(panel.state.availableRoles, ['user', 'book-reviewer', '<editor>']);
    assert.match(panel.usersListEl.innerHTML, /<details[^>]+data-role-picker/);
    assert.match(panel.usersListEl.innerHTML, /value="book-reviewer"/);
    assert.match(panel.usersListEl.innerHTML, /value="&lt;editor&gt;"/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /value="admin"|<editor>/);
    panel.clearUsers();
    assert.deepEqual(panel.state.availableRoles, []);
});

test('pressing outside an open role dropdown closes it, and unloading stops listening', () => {
    const { panel } = fixture();
    const listeners = new Map();
    const document = {
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
    };
    const insideMenu = {};
    const pressed = { open: true, contains: (node) => node === insideMenu };
    const other = { open: true, contains: () => false };
    panel.element = { ownerDocument: document, dataset: {}, querySelectorAll: () => [] };
    panel.usersListEl = {
        querySelectorAll: (selector) => selector === '[data-role-picker][open]' ? [pressed, other].filter((picker) => picker.open) : [],
    };
    panel.bindEvents();
    listeners.get('pointerdown')({ target: insideMenu });
    assert.equal(pressed.open, true, 'pressing inside a dropdown keeps it open');
    assert.equal(other.open, false, 'any other open dropdown closes');
    listeners.get('pointerdown')({ target: {} });
    assert.equal(pressed.open, false);
    panel.afterUnload();
    assert.equal(listeners.has('pointerdown'), false);
});

test('filtering many roles retains selections outside the visible results', () => {
    const { panel } = fixture();
    const options = ['user', 'ȘTEFAN-reviewer', ...Array.from({ length: 600 }, (_, index) => `role-${index}`)]
        .map((value) => {
            const label = { hidden: false };
            return { value, checked: value === 'user', closest: () => label };
        });
    const search = { value: ' șTEFAN ' };
    const empty = { hidden: true };
    const picker = {
        querySelector: (selector) => selector === '[data-role-search]' ? search : empty,
        querySelectorAll: () => options,
    };
    panel.filterRoleChoices(picker);
    assert.deepEqual(options.filter((input) => !input.closest().hidden).map((input) => input.value), ['ȘTEFAN-reviewer']);
    assert.equal(options[0].checked, true, 'hiding a selected role never unchecks it');
    search.value = 'absent role';
    panel.filterRoleChoices(picker);
    assert.equal(empty.hidden, false);
    search.value = '';
    panel.filterRoleChoices(picker);
    assert.equal(empty.hidden, true);
    assert.equal(options.filter((input) => !input.closest().hidden).length, 602);
});

test('saving an empty selection reports an error without sending a role update', async () => {
    const { panel, row, calls } = fixture({ roles: [] });
    await panel.updateUser(row, 'roles');
    assert.equal(calls.length, 0);
    assert.equal(panel.state.status, 'Select at least one role.');
});

test('the create-user form and password reset are no longer available from the dashboard', async () => {
    const { panel, row, calls } = fixture({ fields: { username: 'x' } });
    assert.equal(typeof panel.createUser, 'undefined', 'createUser() was removed with the create-user form');
    await panel.updateUser(row, 'password');
    assert.equal(calls.length, 0, 'a retired action performs no update and issues no tool call');
});

test('the user editor never renders a password field or a password reset action', () => {
    const { panel } = fixture();
    panel.state.users = [{ id: 'member', email: 'member@example.test', roles: ['user'], status: 'active' }];
    panel.renderUsers();
    assert.doesNotMatch(panel.usersListEl.innerHTML, /data-user-password/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /data-user-action="password"/);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /Reset password/);
});

test('validation failures retain edited fields and restore row controls for retry', async () => {
    const { panel, row, inputs, buttons, calls } = fixture({ fields: { username: 'edited', displayName: 'Edited Name' } });
    panel.callTool = async () => { throw new Error('username_already_exists'); };
    await panel.updateUser(row, 'details');
    assert.deepEqual(inputs.map((input) => input.value), ['edited', 'Edited Name']);
    assert.equal(panel.state.status, 'username_already_exists');
    assert.equal(panel.state.userBusy, false);
    assert.deepEqual(buttons.map((button) => button.disabled), [false, false]);
    assert.equal(calls.length, 0, 'failed writes do not refresh and discard edits');
    panel.callTool = async () => { calls.push('unexpected'); };
    inputs[0].reportValidity = () => false;
    await panel.updateUser(row, 'details');
    assert.equal(calls.length, 0, 'invalid browser fields never submit');
});

test('one in-flight user write blocks repeated and competing actions', async () => {
    const { panel, row, buttons, calls } = fixture({ fields: { username: 'member' } });
    let complete;
    panel.callTool = (name, args) => { calls.push({ name, args }); return new Promise((resolve) => { complete = resolve; }); };
    const pending = panel.updateUser(row, 'details');
    assert.deepEqual(buttons.map((button) => button.disabled), [true, true]);
    await panel.updateUser(row, 'details');
    await panel.updateUser(row, 'roles');
    assert.equal(calls.length, 1);
    complete({ ok: true });
    await pending;
    assert.equal(panel.state.userBusy, false);
    assert.deepEqual(buttons.map((button) => button.disabled), [false, false]);
});

test('authorization errors clear stale user rows and stop subsequent mutations', async () => {
    const { panel, row } = fixture({ fields: { username: 'member' } });
    panel.state.users = [{ id: 'private-account' }];
    panel.state.usersTotal = 1;
    panel.state.selfRegisteredCount = 8;
    let requests = 0;
    panel.callTool = async () => { requests++; throw Object.assign(new Error('admin_required'), { code: 'admin_required', statusCode: 403 }); };
    await panel.updateUser(row, 'details');
    assert.equal(panel.state.authProfile, null);
    assert.deepEqual(panel.state.users, []);
    assert.equal(panel.state.selfRegisteredCount, 0);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /private-account/);
    await panel.updateUser(row, 'roles');
    assert.equal(requests, 1);
});

test('editing the current account rechecks authority before another write', async () => {
    const { panel, row, calls } = fixture({ userId: 'manager', roles: ['selfRegistered'] });
    panel.state.users = [{ id: 'private-account', email: 'private@example.test' }];
    panel.state.usersTotal = 1;
    panel.state.selfRegisteredCount = 8;
    panel.renderUsers();
    panel.callTool = async (name, args) => {
        calls.push({ name, args });
        return name === 'userpersisto_profile_get' ? { user: { id: 'manager' }, capabilities: [] } : { ok: true };
    };
    await panel.updateUser(row, 'roles');
    assert.deepEqual(calls.map((call) => call.name), ['userpersisto_user_roles_update', 'userpersisto_profile_get']);
    assert.deepEqual(panel.state.users, []);
    assert.equal(panel.state.usersTotal, 0);
    assert.equal(panel.state.selfRegisteredCount, 0);
    assert.doesNotMatch(panel.usersListEl.innerHTML, /private-account|private@example/);
    await panel.updateUser(row, 'details');
    assert.equal(calls.length, 2, 'authority is rechecked, so a further write after demotion is blocked');
});
