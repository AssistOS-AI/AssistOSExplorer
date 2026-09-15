import { callManagementTool, updateAccountNavigation } from './api.mjs';

const BUILTIN_ROLES = new Set(['admin', 'user', 'selfRegistered']);
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAGE_SIZE = 50;

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function isBuiltin(role) {
    return role?.builtin === true || BUILTIN_ROLES.has(role?.name);
}

function authorizationFailure(error) {
    const code = error?.code || error?.payload?.error || error?.message;
    return Number(error?.statusCode || error?.status) === 401
        || ['authentication_required', 'invalid_session', 'admin_required'].includes(code)
        || (Number(error?.statusCode || error?.status) === 403 && code !== 'builtin_role_protected');
}

function errorMessage(error) {
    const messages = {
        role_name_taken: 'A role with this name already exists.',
        role_in_use: 'This role is assigned to users. Remove those assignments before deleting it.',
        builtin_role_protected: 'Built-in roles cannot be changed or deleted.',
        role_not_found: 'This role no longer exists. Refresh the role catalog.',
        invalid_role_name: 'Enter a valid role name using 1–128 characters.',
        invalid_role_description: 'The description must be text with at most 1,000 characters.',
        invalid_role_capabilities: 'Choose permissions from the available catalog.',
        no_changes_requested: 'Choose a description or permissions to save.',
        unknown_capability: 'A selected permission is no longer available. Refresh the role catalog.',
    };
    return messages[error?.code || error?.message] || error?.message || 'Unable to complete this request.';
}

export class RolesPage {
    constructor(document, host, callTool = callManagementTool) {
        this.document = document;
        this.host = host;
        this.callTool = callTool;
        this.state = { profile: null, roles: [], permissions: [], roleId: null, start: 0, busy: false, status: '' };
        this.disposed = false;
        this.generation = 0;
        this.nodes = Object.fromEntries([
            'roles-root', 'roles-controls', 'roles-login', 'roles-status', 'roles-search', 'roles-list',
            'roles-previous', 'roles-next', 'roles-page', 'role-editor', 'role-editor-title', 'role-editor-note',
            'role-form', 'role-name', 'role-description', 'role-permission-picker', 'role-permission-summary',
            'role-permission-search', 'role-permissions', 'role-permissions-empty', 'role-save',
            'role-delete-section', 'role-delete-note', 'role-delete', 'role-delete-confirmation',
            'role-delete-question', 'role-confirm-delete',
        ].map((id) => [id, document.getElementById(id)]));
        this.nodes['roles-login'].href = `/auth/login?${new URLSearchParams({ returnTo: host.location.pathname })}`;
    }

    allowed() {
        return !this.disposed && this.state.profile?.capabilities?.includes('admin.users.manage') === true;
    }

    setStatus(message, error = false) {
        if (this.disposed) return;
        this.state.status = message;
        this.nodes['roles-status'].textContent = message;
        this.nodes['roles-status'].classList.toggle('error', error);
    }

    syncAccess() {
        const allowed = this.allowed();
        updateAccountNavigation(this.document, this.state.profile);
        this.nodes['roles-controls'].hidden = !allowed;
        this.nodes['roles-controls'].disabled = !allowed || this.state.busy;
        this.nodes['roles-login'].hidden = !!this.state.profile;
    }

    clearAccess(profile = null) {
        this.generation++;
        this.state.profile = profile;
        this.state.roles = [];
        this.state.permissions = [];
        this.state.roleId = null;
        this.state.start = 0;
        this.nodes['roles-list'].innerHTML = '';
        this.nodes['role-permissions'].innerHTML = '';
        this.nodes['roles-page'].textContent = '';
        this.nodes['role-name'].value = '';
        this.nodes['role-description'].value = '';
        this.nodes['roles-search'].value = '';
        this.nodes['role-permission-search'].value = '';
        this.nodes['role-permission-summary'].textContent = 'Permissions: none selected';
        this.nodes['role-permission-picker'].open = false;
        this.nodes['role-delete-confirmation'].hidden = true;
        this.nodes['role-delete-question'].textContent = '';
        this.nodes['role-delete-note'].textContent = '';
        this.syncAccess();
    }

    handleError(error) {
        if (authorizationFailure(error)) {
            this.clearAccess();
            this.setStatus('Your session or management access has changed. Sign in again to continue.', true);
        } else {
            this.setStatus(errorMessage(error), true);
        }
    }

    async checkAccess(generation) {
        const profile = await this.callTool('userpersisto_profile_get');
        if (this.disposed || generation !== this.generation) return false;
        this.state.profile = profile;
        if (!this.allowed()) {
            this.clearAccess(profile);
            this.setStatus('You do not have permission to manage roles.', true);
            return false;
        }
        this.syncAccess();
        return true;
    }

    async initialize() {
        const generation = this.generation;
        this.state.busy = true;
        this.syncAccess();
        try {
            if (!await this.checkAccess(generation)) return;
            if (await this.loadCatalog(generation)) {
                this.editRole(null);
                this.setStatus('');
            }
        } catch (error) {
            if (!this.disposed && generation === this.generation) this.handleError(error);
        } finally {
            this.state.busy = false;
            this.syncAccess();
        }
    }

    async loadCatalog(generation) {
        const result = await this.callTool('userpersisto_roles_list', {});
        if (!this.allowed() || generation !== this.generation) return false;
        this.state.roles = Array.isArray(result.roles) ? result.roles : [];
        this.state.permissions = Array.isArray(result.permissions) ? result.permissions : [];
        this.renderRoles();
        return true;
    }

    filteredRoles() {
        const search = this.nodes['roles-search'].value.trim().toLocaleLowerCase();
        return this.state.roles.filter((role) => [role.name, role.description, ...(role.capabilities || [])]
            .some((value) => String(value || '').toLocaleLowerCase().includes(search)));
    }

    renderRoles() {
        const roles = this.filteredRoles();
        const lastStart = Math.max(0, Math.floor((roles.length - 1) / PAGE_SIZE) * PAGE_SIZE);
        this.state.start = Math.min(this.state.start, lastStart);
        const page = roles.slice(this.state.start, this.state.start + PAGE_SIZE);
        this.nodes['roles-list'].innerHTML = page.map((role) => {
            const builtin = isBuiltin(role);
            const capabilities = role.capabilities || [];
            return `<article class="role-card"${role.id === this.state.roleId ? ' aria-current="true"' : ''}>
                <div class="card-heading"><h2>${escapeHtml(role.name)}</h2>${builtin ? '<span class="pill">Built-in</span>' : ''}</div>
                <p class="card-description">${escapeHtml(role.description || 'No description.')}</p>
                <p class="card-description">${escapeHtml(role.userCount || 0)} users · ${capabilities.length} permissions</p>
                <button type="button" class="gray-button" data-role-action="edit" data-role-id="${escapeHtml(role.id)}">${builtin ? 'View permissions' : 'Edit role'}</button>
            </article>`;
        }).join('') || '<p class="card-description">No matching roles.</p>';
        this.nodes['roles-page'].textContent = roles.length
            ? `${this.state.start + 1}–${Math.min(this.state.start + PAGE_SIZE, roles.length)} of ${roles.length} roles`
            : '0 roles';
        this.nodes['roles-previous'].disabled = this.state.start === 0;
        this.nodes['roles-next'].disabled = this.state.start + PAGE_SIZE >= roles.length;
    }

    editRole(role) {
        this.state.roleId = role?.id || null;
        const builtin = isBuiltin(role);
        this.nodes['role-editor-title'].textContent = builtin ? 'Built-in role' : role ? 'Edit role' : 'Create role';
        this.nodes['role-editor-note'].textContent = builtin
            ? 'Built-in roles and their permissions are protected. Create a custom role for different access.'
            : role ? 'Saving permission changes affects everyone assigned this role.' : 'Create a role, then assign it to accounts on the Users page.';
        this.nodes['role-name'].value = role?.name || '';
        this.nodes['role-name'].readOnly = !!role;
        this.nodes['role-description'].value = role?.description || '';
        this.nodes['role-description'].disabled = builtin;
        this.nodes['role-save'].hidden = builtin;
        this.nodes['role-save'].textContent = role ? 'Save role' : 'Create role';
        this.nodes['role-permission-search'].value = '';
        this.nodes['role-permission-picker'].open = false;
        this.renderPermissions(role?.capabilities || [], builtin);
        this.nodes['role-delete-section'].hidden = !role || builtin;
        this.nodes['role-delete'].disabled = !role || Number(role.userCount) !== 0 || builtin;
        this.nodes['role-delete-note'].textContent = role && Number(role.userCount) > 0
            ? `Assigned to ${role.userCount} users. Remove its assignments on the Users page before deleting it.`
            : 'This role has no assigned users and can be deleted.';
        this.nodes['role-delete-confirmation'].hidden = true;
        this.nodes['role-delete-question'].textContent = '';
        this.renderRoles();
    }

    renderPermissions(capabilities, readonly = false) {
        const selected = new Set(capabilities);
        this.nodes['role-permissions'].innerHTML = '<legend class="visually-hidden">Select permissions</legend>'
            + this.state.permissions.map((permission) => `<label data-permission-choice>
                <input type="checkbox" data-permission value="${escapeHtml(permission.capability)}"${selected.has(permission.capability) ? ' checked' : ''}${readonly ? ' disabled' : ''}>
                <span><strong>${escapeHtml(permission.capability)}</strong><small>${escapeHtml(permission.description || 'No description.')}</small><small>Scope: ${escapeHtml(permission.scope || 'workspace')}</small></span>
            </label>`).join('');
        this.nodes['role-permissions-empty'].hidden = this.state.permissions.length > 0;
        this.updatePermissionSummary(capabilities.length);
    }

    selectedPermissions() {
        return Array.from(this.nodes['role-permissions'].querySelectorAll('[data-permission]:checked'), (input) => input.value);
    }

    updatePermissionSummary(count = this.selectedPermissions().length) {
        this.nodes['role-permission-summary'].textContent = count ? `Permissions: ${count} selected` : 'Permissions: none selected';
    }

    filterPermissions() {
        const search = this.nodes['role-permission-search'].value.trim().toLocaleLowerCase();
        let visible = 0;
        this.nodes['role-permissions'].querySelectorAll('[data-permission-choice]').forEach((label) => {
            label.hidden = !label.textContent.toLocaleLowerCase().includes(search);
            if (!label.hidden) visible++;
        });
        this.nodes['role-permissions-empty'].hidden = visible > 0;
    }

    async mutate(name, args, success) {
        if (!this.allowed() || this.state.busy) return;
        const generation = this.generation;
        this.state.busy = true;
        this.syncAccess();
        this.setStatus('Saving…');
        try {
            await this.callTool(name, args);
            if (!this.allowed() || generation !== this.generation || !await this.checkAccess(generation)) return;
            if (await this.loadCatalog(generation)) {
                this.editRole(null);
                this.setStatus(success);
            }
        } catch (error) {
            if (!this.disposed && generation === this.generation) this.handleError(error);
        } finally {
            this.state.busy = false;
            this.syncAccess();
        }
    }

    async save() {
        if (!this.allowed() || this.state.busy) return;
        const role = this.state.roles.find((item) => item.id === this.state.roleId);
        if (isBuiltin(role)) return;
        if (this.state.roleId && !role) return this.setStatus('This role no longer exists. Refresh the role catalog.', true);
        const name = this.nodes['role-name'].value.trim();
        const description = this.nodes['role-description'].value.trim();
        if (!role && !ROLE_NAME.test(name)) return this.setStatus('Start the role name with a letter or number and use at most 128 letters, numbers, periods, underscores, colons or hyphens.', true);
        if (description.length > 1000) return this.setStatus('The description must be at most 1,000 characters.', true);
        const capabilities = this.selectedPermissions();
        await this.mutate(role ? 'userpersisto_role_update' : 'userpersisto_role_create', {
            ...(role ? { roleId: role.id } : { name }), description, capabilities,
        }, role ? 'Role saved.' : 'Role created. Assign it to accounts on the Users page.');
    }

    requestDelete() {
        if (!this.allowed() || this.state.busy) return;
        const role = this.state.roles.find((item) => item.id === this.state.roleId);
        if (!role || isBuiltin(role) || Number(role.userCount) !== 0) return;
        this.nodes['role-delete-question'].textContent = `Delete “${role.name}”? This removes the role and its permission assignments.`;
        this.nodes['role-delete-confirmation'].hidden = false;
        this.nodes['role-confirm-delete'].focus();
    }

    async confirmDelete() {
        if (!this.allowed() || this.state.busy || this.nodes['role-delete-confirmation'].hidden) return;
        const role = this.state.roles.find((item) => item.id === this.state.roleId);
        if (!role || isBuiltin(role) || Number(role.userCount) !== 0) return;
        await this.mutate('userpersisto_role_delete', { roleId: role.id }, 'Role deleted.');
    }

    async refresh() {
        if (!this.allowed() || this.state.busy) return;
        const generation = this.generation;
        this.state.busy = true;
        this.syncAccess();
        try {
            if (await this.checkAccess(generation) && await this.loadCatalog(generation)) {
                this.editRole(null);
                this.setStatus('Roles refreshed.');
            }
        } catch (error) {
            if (!this.disposed && generation === this.generation) this.handleError(error);
        } finally {
            this.state.busy = false;
            this.syncAccess();
        }
    }

    bind() {
        this.nodes['role-form'].addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
        this.nodes['roles-search'].addEventListener('input', () => { this.state.start = 0; this.renderRoles(); });
        this.nodes['role-permission-search'].addEventListener('input', () => this.filterPermissions());
        this.nodes['role-permissions'].addEventListener('change', () => this.updatePermissionSummary());
        this.nodes['role-permission-picker'].addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            this.nodes['role-permission-picker'].open = false;
            this.nodes['role-permission-summary'].focus();
        });
        this.nodes['roles-root'].addEventListener('click', (event) => {
            const button = event.target.closest('button[data-role-action]');
            if (!button || !this.nodes['roles-root'].contains(button) || button.disabled || !this.allowed() || this.state.busy) return;
            const action = button.dataset.roleAction;
            if (action === 'new') { this.editRole(null); this.nodes['role-name'].focus(); }
            if (action === 'edit') {
                const role = this.state.roles.find((item) => item.id === button.dataset.roleId);
                if (role) { this.editRole(role); this.nodes['role-name'].focus(); }
            }
            if (action === 'previous') { this.state.start = Math.max(0, this.state.start - PAGE_SIZE); this.renderRoles(); }
            if (action === 'next') { this.state.start += PAGE_SIZE; this.renderRoles(); }
            if (action === 'refresh') void this.refresh();
            if (action === 'request-delete') this.requestDelete();
            if (action === 'confirm-delete') void this.confirmDelete();
            if (action === 'cancel-delete') { this.nodes['role-delete-confirmation'].hidden = true; this.nodes['role-delete'].focus(); }
        });
        this.host.addEventListener('pagehide', () => this.dispose(), { once: true });
        this.host.addEventListener('pageshow', (event) => { if (event.persisted) this.host.location.reload(); });
    }

    dispose() {
        this.disposed = true;
        this.clearAccess();
        this.nodes['roles-status'].textContent = '';
    }
}

export function mountRoles(document, host = window) {
    const page = new RolesPage(document, host);
    page.bind();
    void page.initialize();
    return page;
}

if (typeof document !== 'undefined') mountRoles(document);
