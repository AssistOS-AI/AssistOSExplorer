import test from 'node:test';
import assert from 'node:assert/strict';
import { UserpersistoSettings } from '../public/dashboard/management.mjs';

function fixture({ userId = 'member', roles = ['user'], fields = {}, password = '' } = {}) {
    const panel = new UserpersistoSettings({ querySelectorAll: () => [], getAttribute: () => 'users' }, () => {});
    panel.state.authProfile = { user: { id: 'manager' }, capabilities: ['admin.users.manage'] };
    panel.state.activePanel = 'users';
    panel.usersListEl = { innerHTML: '', querySelectorAll: () => [] };
    const inputs = Object.entries(fields).map(([userField, value]) => ({ dataset: { userField }, value }));
    const passwordInput = { value: password };
    const buttons = [{ disabled: false }, { disabled: false }];
    const row = {
        dataset: { userId },
        querySelectorAll: (selector) => ({
            '[data-user-field]': inputs,
            '[data-user-role]:checked': roles.map((value) => ({ value })),
            button: buttons,
        })[selector] || [],
        querySelector: () => passwordInput,
    };
    const calls = [];
    panel.callTool = async (name, args) => { calls.push({ name, args }); return { ok: true }; };
    panel.refreshUsers = async () => { calls.push({ refresh: true }); };
    return { panel, row, inputs, passwordInput, buttons, calls };
}

test('user details preserve empty optional fields, trim edits and submit status independently of roles', async () => {
    const { panel, row, calls } = fixture({ fields: { email: ' member@example.test ', username: '', displayName: '', status: 'blocked' } });
    await panel.updateUser(row, 'details');
    assert.deepEqual(calls, [
        { name: 'userpersisto_user_update', args: { userId: 'member', email: 'member@example.test', username: '', displayName: '', status: 'blocked' } },
        { refresh: true },
    ]);
    assert.equal(panel.state.status, 'User details saved.');
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

test('password reset retains whitespace, clears its field on success and does not retain it in state', async () => {
    const { panel, row, passwordInput, calls } = fixture({ password: '  local-test-password  ' });
    await panel.updateUser(row, 'password');
    assert.deepEqual(calls[0], { name: 'userpersisto_auth_password_set', args: { userId: 'member', newPassword: '  local-test-password  ' } });
    assert.equal(passwordInput.value, '');
    assert.doesNotMatch(JSON.stringify(panel.state), /local-test-password/);
    calls.length = 0;
    await panel.updateUser(row, 'password');
    assert.equal(calls.length, 0);
    assert.match(panel.state.status, /Enter a new password/);
});

test('validation failures retain edited fields and restore row controls for retry', async () => {
    const { panel, row, inputs, buttons, calls } = fixture({ fields: { email: 'new@example.test', username: 'edited' } });
    panel.callTool = async () => { throw new Error('email_already_exists'); };
    await panel.updateUser(row, 'details');
    assert.deepEqual(inputs.map((input) => input.value), ['new@example.test', 'edited']);
    assert.equal(panel.state.status, 'email_already_exists');
    assert.equal(panel.state.userBusy, false);
    assert.deepEqual(buttons.map((button) => button.disabled), [false, false]);
    assert.equal(calls.length, 0, 'failed writes do not refresh and discard edits');
    panel.callTool = async () => { calls.push('unexpected'); };
    inputs[0].reportValidity = () => false;
    await panel.updateUser(row, 'details');
    assert.equal(calls.length, 0, 'invalid browser fields never submit');
});

test('one in-flight user write blocks repeated and competing actions', async () => {
    const { panel, row, buttons, calls } = fixture({ fields: { email: 'member@example.test' }, password: 'test-password' });
    let complete;
    panel.callTool = (name, args) => { calls.push({ name, args }); return new Promise((resolve) => { complete = resolve; }); };
    const pending = panel.updateUser(row, 'details');
    assert.deepEqual(buttons.map((button) => button.disabled), [true, true]);
    await panel.updateUser(row, 'details');
    await panel.updateUser(row, 'password');
    await panel.createUser();
    assert.equal(calls.length, 1);
    complete({ ok: true });
    await pending;
    assert.equal(panel.state.userBusy, false);
    assert.deepEqual(buttons.map((button) => button.disabled), [false, false]);
});

test('authorization errors clear stale user rows and stop subsequent mutations', async () => {
    const { panel, row } = fixture({ fields: { email: 'member@example.test' } });
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
    await panel.updateUser(row, 'password');
    assert.equal(calls.length, 2);
});

test('user creation submits an optional username and clears credentials only after acceptance', async () => {
    const { panel, calls } = fixture();
    panel.createUserUsernameInput = { value: '' };
    panel.createUserEmailInput = { value: 'created@example.test' };
    panel.createUserDisplayNameInput = { value: '' };
    panel.createUserPasswordInput = { value: 'local-create-password' };
    panel.createUserRoleInput = { value: 'user' };
    panel.loadUsersPage = async () => {};
    await panel.createUser();
    assert.deepEqual(calls[0], { name: 'userpersisto_user_create', args: { username: '', email: 'created@example.test', displayName: '', password: 'local-create-password', roles: ['user'] } });
    assert.equal(panel.createUserPasswordInput.value, '');
    assert.equal(panel.createUserEmailInput.value, '');
});
