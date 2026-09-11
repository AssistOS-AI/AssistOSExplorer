import {
    encodeOptions,
    escapeAttr,
    escapeHtml,
    parseRoles
} from '../admin-settings-panel/admin-settings-utils.js';

export class AdminUsersSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            users: [],
            availableRoles: [],
            start: 0,
            pageSize: 100,
            totalCount: 0,
            hasMore: false,
            loading: false,
            search: '',
            selfRegisteredCount: null,
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.tableHost = this.element.querySelector('[data-role="tableHost"]');
        this.pageLabel = this.element.querySelector('[data-role="pageLabel"]');
        this.previousButton = this.element.querySelector('[data-role="previousPage"]');
        this.nextButton = this.element.querySelector('[data-role="nextPage"]');
        this.searchForm = this.element.querySelector('[data-role="searchForm"]');
        this.searchInput = this.element.querySelector('[data-role="userSearch"]');
        this.selfRegisteredCountEl = this.element.querySelector('[data-role="selfRegisteredCount"]');
        if (this.searchInput) this.searchInput.value = this.state.search;
        this.bindEvents();
        this.render();
    }

    bindEvents() {
        if (this.element.dataset.boundAdminUsersSettings) return;
        this.searchForm?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.submitSearch();
        });
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.submitSearch(), 250);
        });
        this.element.dataset.boundAdminUsersSettings = 'true';
    }

    submitSearch() {
        clearTimeout(this.searchTimer);
        this.dispatch('admin-users-search', { search: this.searchInput?.value || '' });
    }

    clearSearch() {
        if (this.searchInput) this.searchInput.value = '';
        this.submitSearch();
        this.searchInput?.focus();
    }

    afterUnload() {
        clearTimeout(this.searchTimer);
    }

    setState(next = {}) {
        if (Array.isArray(next.users)) {
            this.state.users = next.users;
        }
        if (Array.isArray(next.availableRoles)) {
            this.state.availableRoles = next.availableRoles;
        }
        for (const key of ['start', 'pageSize', 'totalCount', 'hasMore', 'loading', 'search', 'selfRegisteredCount']) {
            if (Object.prototype.hasOwnProperty.call(next, key)) this.state[key] = next[key];
        }
        this.render();
    }

    render() {
        this.renderUsers();
        this.renderPagination();
        if (this.selfRegisteredCountEl) {
            this.selfRegisteredCountEl.textContent = this.state.selfRegisteredCount === null
                ? this.state.loading ? 'Loading self-registered user count…' : 'Self-registered user count unavailable.'
                : `Self-registered users: ${this.state.selfRegisteredCount}`;
        }
    }

    renderPagination() {
        const { start, users, totalCount, hasMore, loading } = this.state;
        if (this.previousButton) this.previousButton.disabled = loading || start === 0;
        if (this.nextButton) this.nextButton.disabled = loading || !hasMore;
        if (this.pageLabel) this.pageLabel.textContent = loading
            ? 'Loading users…'
            : `${users.length ? start + 1 : 0}–${start + users.length}${totalCount === null ? '' : ` of ${totalCount}`} users`;
    }

    previousPage() {
        if (!this.state.loading && this.state.start > 0) {
            this.dispatch('admin-users-page', { start: Math.max(0, this.state.start - this.state.pageSize) });
        }
    }

    nextPage() {
        if (!this.state.loading && this.state.hasMore) {
            this.dispatch('admin-users-page', { start: this.state.start + this.state.pageSize });
        }
    }

    renderUsers() {
        if (!this.tableHost) return;
        const fragment = document.createDocumentFragment();
        const header = document.createElement('div');
        header.className = 'section-heading user-section-heading';
        header.innerHTML = '<h2>Manage users</h2>';
        fragment.appendChild(header);

        if (!this.state.users.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = this.state.loading ? 'Loading users…'
                : this.state.search ? 'No matching users.' : 'No users to display.';
            fragment.appendChild(empty);
            this.tableHost.replaceChildren(fragment);
            return;
        }

        const table = document.createElement('table');
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Roles</th>
                    <th></th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        for (const user of this.state.users) {
            const rowForm = document.createElement('form');
            rowForm.id = this.getUserFormId(user);
            rowForm.className = 'admin-user-row-form';
            rowForm.autocomplete = 'off';
            fragment.appendChild(rowForm);
            tbody.appendChild(this.createUserRow(user));
        }
        fragment.appendChild(table);
        this.tableHost.replaceChildren(fragment);
        this.tableHost.querySelectorAll('custom-select[data-field="roles"]').forEach((select) => {
            const row = select.closest('tr[data-user-id]');
            const user = this.state.users.find((entry) => String(entry.id) === String(row?.dataset.userId));
            this.configureRoleSelect(select, user?.roles || []);
        });
    }

    createUserRow(user) {
        const tr = document.createElement('tr');
        tr.dataset.userId = user.id;
        const formId = escapeAttr(this.getUserFormId(user));
        tr.innerHTML = `
            <td data-label="Username"><input class="form-input" form="${formId}" data-field="username" value="${escapeAttr(user.username || '')}" placeholder="Optional"></td>
            <td data-label="Email">${escapeHtml(user.email || '')}</td>
            <td data-label="Name"><input class="form-input" form="${formId}" data-field="name" value="${escapeAttr(user.name || user.displayName || '')}"></td>
            <td data-label="Roles">
                <custom-select data-presenter="custom-select" data-field="roles"></custom-select>
            </td>
            <td data-label="Actions"><div class="actions">
                <button type="button" class="general-button" data-local-action="saveUserRow">Save</button>
                <button type="button" class="gray-button danger" data-local-action="deleteUserRow">Delete</button>
            </div></td>
        `;
        return tr;
    }

    getUserFormId(user) {
        return `admin-user-row-form-${String(user.id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    }

    configureRoleSelect(select, selectedRoles = []) {
        if (!select) return;
        const options = this.state.availableRoles.map((role) => ({ value: role, label: role }));
        const selectedRole = this.getEffectiveRole(selectedRoles);
        select.setAttribute('data-options', encodeOptions(options));
        select.setAttribute('data-selected', selectedRole);
        if (select.webSkelPresenter?.setOptions) {
            select.webSkelPresenter.setOptions(options, selectedRole);
        } else if (select.presenterReadyPromise) {
            select.presenterReadyPromise.then(() => {
                select.webSkelPresenter?.setOptions?.(options, selectedRole);
            }).catch(() => {});
        }
    }

    getEffectiveRole(roles = []) {
        const selectedRoles = parseRoles(roles);
        const elevatedRole = [...selectedRoles].reverse().find((role) => role !== 'user' && this.state.availableRoles.includes(role));
        if (elevatedRole) return elevatedRole;
        if (selectedRoles.includes('user') && this.state.availableRoles.includes('user')) return 'user';
        return selectedRoles.find((role) => this.state.availableRoles.includes(role)) || this.state.availableRoles[0] || '';
    }

    async getCustomSelectValue(select) {
        if (!select) return '';
        if (select.presenterReadyPromise) {
            await select.presenterReadyPromise.catch(() => {});
        }
        return String(select.value || select.getAttribute('data-selected') || '');
    }

    async getSelectedRoles(select) {
        return parseRoles(await this.getCustomSelectValue(select));
    }

    saveUserRow(button) {
        this.submitUserRowButton(button, 'save').catch((error) => this.emitError(error));
    }

    deleteUserRow(button) {
        this.submitUserRowButton(button, 'delete').catch((error) => this.emitError(error));
    }

    async submitUserRowButton(button, action) {
        const row = button?.closest?.('tr[data-user-id]');
        if (!row) return;
        await this.submitUserRowAction(row, action);
    }

    async submitUserRowAction(row, action) {
        const userId = row.dataset.userId;
        if (!userId) return;
        if (action === 'delete') {
            this.dispatch('admin-users-delete', { userId });
            return;
        }
        if (action !== 'save') return;
        const body = {};
        for (const input of row.querySelectorAll('input[data-field], custom-select[data-field]')) {
            if (input.dataset.field === 'roles') {
                body.roles = await this.getSelectedRoles(input);
            } else {
                body[input.dataset.field] = input.value;
            }
        }
        this.dispatch('admin-users-save', { userId, body });
    }

    emitError(error) {
        this.dispatch('admin-settings-error', { message: error?.message || 'Users settings failed.' });
    }

    dispatch(type, detail = {}) {
        this.element.dispatchEvent(new CustomEvent(type, {
            bubbles: true,
            detail
        }));
    }
}
