const API_BASE = '/services/soul-gateway/management';

async function apiFetch(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = { ...options.headers };
    if (options.body && typeof options.body === 'object') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers, credentials: 'include' });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message;
        try {
            message = JSON.parse(text).error || text;
        } catch {
            message = text || res.statusText;
        }
        throw new Error(message);
    }
    return res.json();
}

class SoulGatewaySettingsPresenter {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.activeTab = 'providers';
        this.providers = [];
        this.models = [];
        this.keys = [];
        this.templates = [];
        this.editingProviderId = null;
        this.createdKeyPlaintext = null;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.bindTabs();
        this.loadActiveTab();
    }

    closeModal() {
        if (typeof assistOS !== 'undefined' && assistOS.UI) {
            assistOS.UI.closeModal(this.element, null);
        }
    }

    bindTabs() {
        const tabs = this.element.querySelectorAll('.sg-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                if (tabName === this.activeTab) return;
                this.activeTab = tabName;
                tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
                this.element.querySelectorAll('.sg-tab-content').forEach(c => {
                    c.classList.toggle('active', c.id === `tab-${tabName}`);
                });
                this.loadActiveTab();
            });
        });
    }

    loadActiveTab() {
        if (this.activeTab === 'providers') this.loadProviders();
        else if (this.activeTab === 'models') this.loadModels();
        else if (this.activeTab === 'keys') this.loadKeys();
    }

    setStatus(elementId, text, type) {
        const el = this.element.querySelector(`#${elementId}`);
        if (!el) return;
        el.textContent = text;
        el.className = `sg-status-bar ${type || ''}`;
    }

    async loadProviders() {
        this.setStatus('providers-status', 'Loading...', 'loading');
        try {
            const [providersRes, templatesRes] = await Promise.all([
                apiFetch('/providers'),
                apiFetch('/providers/templates'),
            ]);
            this.providers = providersRes.data || [];
            this.templates = templatesRes.data || [];
            this.renderProviders();
            this.setStatus('providers-status', '', '');
        } catch (err) {
            this.setStatus('providers-status', err.message, 'error');
        }
    }

    renderProviders() {
        const list = this.element.querySelector('#providers-list');
        if (!list) return;
        list.replaceChildren();

        if (this.providers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sg-empty';
            empty.textContent = 'No providers configured.';
            list.appendChild(empty);
            return;
        }

        for (const p of this.providers) {
            const item = document.createElement('div');
            item.className = 'sg-list-item';

            const info = document.createElement('div');
            info.className = 'sg-item-info';
            const name = document.createElement('div');
            name.className = 'sg-item-name';
            name.textContent = p.display_name || p.provider_key;
            const detail = document.createElement('div');
            detail.className = 'sg-item-detail';
            detail.textContent = [p.adapter_key, p.auth_strategy, p.base_url].filter(Boolean).join(' · ');
            info.append(name, detail);

            const actions = document.createElement('div');
            actions.className = 'sg-item-actions';

            const badge = document.createElement('span');
            badge.className = `sg-badge ${p.enabled ? 'sg-badge-active' : 'sg-badge-disabled'}`;
            badge.textContent = p.enabled ? 'active' : 'off';
            actions.appendChild(badge);

            for (const [label, handler] of [
                ['Test', () => this.testProvider(p.id)],
                ['Discover', () => this.discoverModels(p.id)],
                ['Edit', () => this.editProvider(p.id)],
            ]) {
                const btn = document.createElement('button');
                btn.className = 'sg-btn sg-btn-sm';
                btn.textContent = label;
                btn.addEventListener('click', handler);
                actions.appendChild(btn);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'sg-btn sg-btn-sm sg-btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => this.deleteProvider(p.id));
            actions.appendChild(delBtn);

            item.append(info, actions);
            list.appendChild(item);
        }
    }

    showAddProvider() {
        this.editingProviderId = null;
        const form = this.element.querySelector('#provider-form');
        if (!form) return;
        form.style.display = 'block';
        this.element.querySelector('#provider-form-title').textContent = 'Add Provider';
        this.element.querySelector('#provider-key').value = '';
        this.element.querySelector('#provider-key').disabled = false;
        this.element.querySelector('#provider-name').value = '';
        this.element.querySelector('#provider-baseurl').value = '';
        this.element.querySelector('#provider-apikey').value = '';
        this.populateTemplateSelect();
    }

    populateTemplateSelect() {
        const select = this.element.querySelector('#provider-template');
        if (!select) return;
        select.replaceChildren();
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Custom...';
        select.appendChild(defaultOpt);

        for (const t of this.templates) {
            const opt = document.createElement('option');
            opt.value = t.providerKey || t.provider_key || '';
            opt.textContent = t.displayName || t.display_name || opt.value;
            select.appendChild(opt);
        }

        select.onchange = () => {
            const key = select.value;
            if (!key) return;
            const tpl = this.templates.find(t => (t.providerKey || t.provider_key) === key);
            if (!tpl) return;
            this.element.querySelector('#provider-key').value = tpl.providerKey || tpl.provider_key || '';
            this.element.querySelector('#provider-name').value = tpl.displayName || tpl.display_name || '';
            this.element.querySelector('#provider-baseurl').value = tpl.baseUrl || tpl.base_url || '';
            const adapterSel = this.element.querySelector('#provider-adapter');
            const adapterVal = tpl.adapterKey || tpl.adapter_key || '';
            if (adapterSel.querySelector(`option[value="${CSS.escape(adapterVal)}"]`)) {
                adapterSel.value = adapterVal;
            }
            const authSel = this.element.querySelector('#provider-auth');
            const authVal = tpl.authStrategy || tpl.auth_strategy || 'api_key';
            if (authSel.querySelector(`option[value="${CSS.escape(authVal)}"]`)) {
                authSel.value = authVal;
            }
        };
    }

    editProvider(id) {
        const p = this.providers.find(x => x.id === id);
        if (!p) return;
        this.editingProviderId = id;
        const form = this.element.querySelector('#provider-form');
        if (!form) return;
        form.style.display = 'block';
        this.element.querySelector('#provider-form-title').textContent = 'Edit Provider';
        this.element.querySelector('#provider-key').value = p.provider_key || '';
        this.element.querySelector('#provider-key').disabled = true;
        this.element.querySelector('#provider-name').value = p.display_name || '';
        this.element.querySelector('#provider-baseurl').value = p.base_url || '';
        this.element.querySelector('#provider-apikey').value = '';
        const adapterSel = this.element.querySelector('#provider-adapter');
        if (adapterSel.querySelector(`option[value="${CSS.escape(p.adapter_key)}"]`)) {
            adapterSel.value = p.adapter_key;
        }
        const authSel = this.element.querySelector('#provider-auth');
        if (authSel.querySelector(`option[value="${CSS.escape(p.auth_strategy)}"]`)) {
            authSel.value = p.auth_strategy;
        }
    }

    cancelProviderForm() {
        const form = this.element.querySelector('#provider-form');
        if (form) form.style.display = 'none';
        this.editingProviderId = null;
    }

    async submitProvider() {
        const key = this.element.querySelector('#provider-key').value.trim();
        const name = this.element.querySelector('#provider-name').value.trim();
        const adapter = this.element.querySelector('#provider-adapter').value;
        const auth = this.element.querySelector('#provider-auth').value;
        const baseUrl = this.element.querySelector('#provider-baseurl').value.trim();
        const apiKey = this.element.querySelector('#provider-apikey').value.trim();

        if (!key || !name) {
            this.setStatus('providers-status', 'Provider key and name are required.', 'error');
            return;
        }

        const body = {
            providerKey: key,
            displayName: name,
            adapterKey: adapter,
            authStrategy: auth,
        };
        if (baseUrl) body.baseUrl = baseUrl;
        if (apiKey) body.apiKey = apiKey;

        try {
            if (this.editingProviderId) {
                await apiFetch(`/providers/${encodeURIComponent(this.editingProviderId)}`, { method: 'PATCH', body });
                this.setStatus('providers-status', 'Provider updated.', 'success');
            } else {
                await apiFetch('/providers', { method: 'POST', body });
                this.setStatus('providers-status', 'Provider created.', 'success');
            }
            this.cancelProviderForm();
            await this.loadProviders();
        } catch (err) {
            this.setStatus('providers-status', err.message, 'error');
        }
    }

    async testProvider(id) {
        this.setStatus('providers-status', 'Testing...', 'loading');
        try {
            const res = await apiFetch(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
            const msg = res.ok
                ? `Connection OK (${res.latencyMs}ms)`
                : `Connection failed: ${res.detail || 'unknown error'}`;
            this.setStatus('providers-status', msg, res.ok ? 'success' : 'error');
        } catch (err) {
            this.setStatus('providers-status', err.message, 'error');
        }
    }

    async discoverModels(id) {
        this.setStatus('providers-status', 'Discovering models...', 'loading');
        try {
            const res = await apiFetch(`/providers/${encodeURIComponent(id)}/sync-models`, { method: 'POST' });
            this.setStatus('providers-status', `Synced ${res.synced || 0} models (${res.created || 0} new, ${res.updated || 0} updated).`, 'success');
        } catch (err) {
            this.setStatus('providers-status', err.message, 'error');
        }
    }

    async deleteProvider(id) {
        const p = this.providers.find(x => x.id === id);
        if (!p) return;
        if (!confirm(`Delete provider "${p.display_name || p.provider_key}"?`)) return;
        try {
            await apiFetch(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            this.setStatus('providers-status', 'Provider deleted.', 'success');
            await this.loadProviders();
        } catch (err) {
            this.setStatus('providers-status', err.message, 'error');
        }
    }

    async loadModels() {
        this.setStatus('models-status', 'Loading...', 'loading');
        try {
            const res = await apiFetch('/models');
            this.models = res.data || [];
            this.renderModels();
            this.setStatus('models-status', '', '');
        } catch (err) {
            this.setStatus('models-status', err.message, 'error');
        }
    }

    renderModels() {
        const list = this.element.querySelector('#models-list');
        if (!list) return;
        list.replaceChildren();

        if (this.models.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sg-empty';
            empty.textContent = 'No models. Add a provider and discover models.';
            list.appendChild(empty);
            return;
        }

        for (const m of this.models) {
            const item = document.createElement('div');
            item.className = 'sg-list-item';

            const info = document.createElement('div');
            info.className = 'sg-item-info';
            const name = document.createElement('div');
            name.className = 'sg-item-name';
            name.textContent = m.model_key || m.display_name;
            const detail = document.createElement('div');
            detail.className = 'sg-item-detail';
            detail.textContent = [m.provider_display_name || m.provider_key, m.provider_model_id].filter(Boolean).join(' · ');
            info.append(name, detail);

            const actions = document.createElement('div');
            actions.className = 'sg-item-actions';

            const badge = document.createElement('span');
            badge.className = `sg-badge ${m.enabled ? 'sg-badge-active' : 'sg-badge-disabled'}`;
            badge.textContent = m.enabled ? 'active' : 'off';
            actions.appendChild(badge);

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'sg-btn sg-btn-sm';
            toggleBtn.textContent = m.enabled ? 'Disable' : 'Enable';
            toggleBtn.addEventListener('click', async () => {
                try {
                    const action = m.enabled ? 'disable' : 'enable';
                    await apiFetch(`/models/${encodeURIComponent(m.id)}/${action}`, { method: 'POST' });
                    await this.loadModels();
                } catch (err) {
                    this.setStatus('models-status', err.message, 'error');
                }
            });
            actions.appendChild(toggleBtn);

            item.append(info, actions);
            list.appendChild(item);
        }
    }

    async loadKeys() {
        this.setStatus('keys-status', 'Loading...', 'loading');
        try {
            const res = await apiFetch('/keys');
            this.keys = (res.data || []).filter(k => k.label !== 'workspace-default');
            this.renderKeys();
            this.setStatus('keys-status', '', '');
        } catch (err) {
            this.setStatus('keys-status', err.message, 'error');
        }
    }

    renderKeys() {
        const list = this.element.querySelector('#keys-list');
        if (!list) return;
        list.replaceChildren();

        if (this.keys.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sg-empty';
            empty.textContent = 'No API keys. Generate one to get started.';
            list.appendChild(empty);
            return;
        }

        for (const k of this.keys) {
            const statusClass = k.status === 'active' ? 'sg-badge-active' : k.status === 'revoked' ? 'sg-badge-revoked' : 'sg-badge-disabled';

            const item = document.createElement('div');
            item.className = 'sg-list-item';

            const info = document.createElement('div');
            info.className = 'sg-item-info';
            const name = document.createElement('div');
            name.className = 'sg-item-name';
            name.textContent = k.label || 'Unnamed';
            const detail = document.createElement('div');
            detail.className = 'sg-item-detail';
            detail.textContent = `${k.keyHint || k.key_hint || ''} · RPM: ${k.rpmLimit ?? k.rpm_limit ?? '-'} · TPM: ${k.tpmLimit ?? k.tpm_limit ?? '-'}`;
            info.append(name, detail);

            const actions = document.createElement('div');
            actions.className = 'sg-item-actions';

            const badge = document.createElement('span');
            badge.className = `sg-badge ${statusClass}`;
            badge.textContent = k.status;
            actions.appendChild(badge);

            if (k.status === 'active') {
                const revokeBtn = document.createElement('button');
                revokeBtn.className = 'sg-btn sg-btn-sm sg-btn-danger';
                revokeBtn.textContent = 'Revoke';
                revokeBtn.addEventListener('click', async () => {
                    if (!confirm('Revoke this API key?')) return;
                    try {
                        await apiFetch(`/keys/${encodeURIComponent(k.id)}/revoke`, { method: 'POST' });
                        this.setStatus('keys-status', 'Key revoked.', 'success');
                        await this.loadKeys();
                    } catch (err) {
                        this.setStatus('keys-status', err.message, 'error');
                    }
                });
                actions.appendChild(revokeBtn);
            }

            item.append(info, actions);
            list.appendChild(item);
        }
    }

    showCreateKey() {
        const form = this.element.querySelector('#key-form');
        if (form) {
            form.style.display = 'block';
            this.element.querySelector('#key-label').value = '';
            this.element.querySelector('#key-rpm').value = '60';
            this.element.querySelector('#key-tpm').value = '100000';
        }
    }

    cancelKeyForm() {
        const form = this.element.querySelector('#key-form');
        if (form) form.style.display = 'none';
    }

    async submitKey() {
        const label = this.element.querySelector('#key-label').value.trim();
        const rpmLimit = parseInt(this.element.querySelector('#key-rpm').value, 10) || 60;
        const tpmLimit = parseInt(this.element.querySelector('#key-tpm').value, 10) || 100000;

        if (!label) {
            this.setStatus('keys-status', 'Label is required.', 'error');
            return;
        }

        try {
            const res = await apiFetch('/keys', {
                method: 'POST',
                body: { label, rpmLimit, tpmLimit },
            });
            this.cancelKeyForm();
            this.createdKeyPlaintext = res.plaintextKey;
            const reveal = this.element.querySelector('#key-reveal');
            const valueEl = this.element.querySelector('#key-reveal-value');
            if (reveal && valueEl) {
                valueEl.textContent = res.plaintextKey;
                reveal.style.display = 'block';
            }
            await this.loadKeys();
        } catch (err) {
            this.setStatus('keys-status', err.message, 'error');
        }
    }

    copyKey() {
        if (this.createdKeyPlaintext && navigator.clipboard) {
            navigator.clipboard.writeText(this.createdKeyPlaintext).catch(() => {});
        }
    }

    dismissKeyReveal() {
        const reveal = this.element.querySelector('#key-reveal');
        if (reveal) reveal.style.display = 'none';
        this.createdKeyPlaintext = null;
    }

    switchTab() {}
}

export class SoulGatewaySettingsSettings {
    constructor(...args) {
        return new SoulGatewaySettingsPresenter(...args);
    }
}

export class SoulGatewaySettings {
    constructor(...args) {
        return new SoulGatewaySettingsPresenter(...args);
    }
}
