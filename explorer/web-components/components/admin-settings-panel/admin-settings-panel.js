import { parseRoles } from './admin-settings-utils.js';
import { fetchUserAdministrationProof } from '../../../services/infrastructure/authApi.js';

const ADMIN_CSRF_HEADER = 'x-ploinky-csrf-token';
const ADMIN_MUTATION_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

function getCurrentAgentName(win = globalThis.window) {
    try {
        const explicit = win?.ASSISTOS_AGENT_ID || win?.assistOS?.agentId;
        if (explicit) return String(explicit);
        const parts = win.location.pathname.split('/').filter(Boolean);
        return parts[0] || 'explorer';
    } catch (_) {
        return 'explorer';
    }
}

export class AdminSettingsPanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        this.agent = this.element.getAttribute('data-agent') || this.props.agent || getCurrentAgentName();
        this.apiBase = `/api/agents/${encodeURIComponent(this.agent)}/users`;
        this.state = {
            loaded: false,
            loading: false,
            users: [],
            usersStart: 0,
            usersPageSize: 100,
            usersTotal: 0,
            usersHasMore: false,
            usersSearch: '',
            selfRegisteredCount: null,
            availableRoles: [],
        };
        this.usersRequestId = 0;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.pushChildState();
        if (this.element.getAttribute('data-auto-load') !== 'false') {
            this.loadPage().catch((error) => this.setStatus(error.message, 'error'));
        }
    }

    cacheElements() {
        this.statusEl = this.element.querySelector('[data-role="status"]');
        this.usersComponent = this.element.querySelector('admin-users-settings');
    }

    bindEvents() {
        if (this.element.dataset.boundAdminSettingsPanel) return;
        this.element.addEventListener('admin-users-create', (event) => {
            this.createUser(event.detail || {}).catch((error) => this.setStatus(error.message, 'error'));
        });
        this.element.addEventListener('admin-users-save', (event) => {
            this.saveUser(event.detail?.userId, event.detail?.body || {}).catch((error) => this.setStatus(error.message, 'error'));
        });
        this.element.addEventListener('admin-users-delete', (event) => {
            this.deleteUser(event.detail?.userId).catch((error) => this.setStatus(error.message, 'error'));
        });
        this.element.addEventListener('admin-users-page', (event) => {
            this.loadUsersPage(event.detail?.start).catch((error) => this.setStatus(error.message, 'error'));
        });
        this.element.addEventListener('admin-users-search', (event) => {
            this.searchUsers(event.detail?.search).catch((error) => this.setStatus(error.message, 'error'));
        });
        this.element.addEventListener('admin-settings-error', (event) => {
            this.setStatus(event.detail?.message || 'Administration action failed.', 'error');
        });
        this.element.dataset.boundAdminSettingsPanel = 'true';
    }

    async loadPage({ force = false } = {}) {
        if (this.state.loading) return;
        if (this.state.loaded && !force) {
            this.pushChildState();
            return;
        }
        return this.loadUsersPage(this.state.usersStart);
    }

    applyUsersPage(payload) {
        this.state.users = Array.isArray(payload.users) ? payload.users : [];
        this.state.availableRoles = parseRoles(payload.availableRoles);
        this.state.usersStart = payload.start ?? this.state.usersStart;
        this.state.usersTotal = payload.totalCount ?? null;
        this.state.usersHasMore = payload.hasMore === true;
        const selfRegisteredCount = payload.singleRoleCounts?.selfRegistered ?? 0;
        this.state.selfRegisteredCount = payload.singleRoleCounts && Number.isSafeInteger(selfRegisteredCount)
            ? selfRegisteredCount : null;
    }

    async fetchUsersPage(start, search = this.state.usersSearch) {
        const requestPage = (offset) => {
            const params = new URLSearchParams({
                start: offset,
                pageSize: this.state.usersPageSize,
                search,
                excludeOnlyRole: search ? '' : 'selfRegistered',
                includeRoleCounts: 'true',
            });
            return this.request(`${this.apiBase}?${params}`);
        };
        const payload = await requestPage(start);
        if (start > 0 && !payload.users?.length && Number.isSafeInteger(payload.totalCount) && start >= payload.totalCount) {
            const lastPage = Math.max(0, Math.floor((payload.totalCount - 1) / this.state.usersPageSize) * this.state.usersPageSize);
            return requestPage(lastPage);
        }
        return payload;
    }

    async searchUsers(value) {
        const search = String(value || '').trim().slice(0, 200);
        if (search === this.state.usersSearch && this.state.loaded) return;
        this.state.usersSearch = search;
        this.state.loaded = false;
        this.state.users = [];
        this.state.usersStart = 0;
        this.state.usersTotal = 0;
        this.state.usersHasMore = false;
        return this.loadUsersPage(0, { replace: true });
    }

    async loadUsersPage(start, { replace = false } = {}) {
        if ((this.state.loading && !replace) || !Number.isSafeInteger(start) || start < 0) return;
        const requestId = ++this.usersRequestId;
        this.state.loading = true;
        this.pushChildState();
        this.setStatus('Loading users...');
        try {
            const payload = await this.fetchUsersPage(start);
            if (requestId !== this.usersRequestId) return;
            this.applyUsersPage(payload);
            this.state.loaded = true;
            this.setStatus('');
        } catch (error) {
            if (requestId === this.usersRequestId) throw error;
        } finally {
            if (requestId === this.usersRequestId) {
                this.state.loading = false;
                this.pushChildState();
            }
        }
    }

    afterUnload() {
        this.usersRequestId++;
    }

    async pushChildState() {
        await this.setChildState(this.usersComponent, {
            users: this.state.users,
            availableRoles: this.state.availableRoles,
            start: this.state.usersStart,
            pageSize: this.state.usersPageSize,
            totalCount: this.state.usersTotal,
            hasMore: this.state.usersHasMore,
            loading: this.state.loading,
            search: this.state.usersSearch,
            selfRegisteredCount: this.state.selfRegisteredCount,
        });
    }

    async setChildState(component, state) {
        if (!component) return;
        if (component.presenterReadyPromise) {
            await component.presenterReadyPromise.catch(() => {});
        }
        component.webSkelPresenter?.setState?.(state);
    }

    async createUser(detail) {
        this.setStatus('Creating user...');
        await this.request(this.apiBase, {
            method: 'POST',
            body: JSON.stringify({
                username: detail.username,
                email: detail.email,
                password: detail.password,
                name: detail.name,
                roles: parseRoles(detail.roles)
            })
        });
        await this.reloadAfterMutation();
    }

    async saveUser(userId, body) {
        if (!userId) return;
        this.setStatus('Saving user...');
        await this.request(`${this.apiBase}/${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            body: JSON.stringify(body || {})
        });
        await this.reloadAfterMutation();
    }

    async deleteUser(userId) {
        if (!userId) return;
        this.setStatus('Deleting user...');
        await this.request(`${this.apiBase}/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        await this.reloadAfterMutation();
    }

    async reloadAfterMutation() {
        this.state.loaded = false;
        await this.loadUsersPage(this.state.usersStart, { replace: true });
    }

    setStatus(message, kind = '') {
        if (!this.statusEl) return;
        this.statusEl.textContent = message || '';
        this.statusEl.className = `administration-status${kind ? ` ${kind}` : ''}`;
    }

    async request(path, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const requiresProof = ADMIN_MUTATION_METHODS.has(method);
        const sendRequest = async () => {
            const headers = {
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            };
            if (requiresProof) {
                const proof = await fetchUserAdministrationProof({ agentName: this.agent });
                if (proof.mode === 'control') {
                    headers[ADMIN_CSRF_HEADER] = proof.csrfToken;
                }
            }
            const response = await fetch(path, {
                ...options,
                method,
                credentials: 'include',
                headers
            });
            const payload = await response.json().catch(() => ({}));
            return { response, payload };
        };

        let { response, payload } = await sendRequest();
        if (requiresProof && response.status === 403
            && ['csrf_invalid', 'browser_csrf_invalid'].includes(payload?.error)) {
            ({ response, payload } = await sendRequest());
        }
        if (!response.ok || payload.ok === false) {
            throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
        }
        return payload;
    }

}
