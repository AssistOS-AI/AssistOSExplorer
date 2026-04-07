// ---- Model naming convention ----
const _SLUG_MAP = { axiologic_kiro: 'kiro', search_gateway: 'search' };
function _providerSlug(providerKey) { return _SLUG_MAP[providerKey] || providerKey; }
function _buildModelName(providerKey, providerModel) { return `${_providerSlug(providerKey)}/${providerModel}`; }
function _displayName(name) {
  if (name && typeof name === 'object') name = name.model_key || name.name || name.tier_key || '';
  return typeof name === 'string' && name.startsWith('axl/') ? name.slice(4) : (name || '');
}

// ---- Auth / billing badge helper ----
//
// Single source of truth for how providers AND models render their
// auth-strategy badge in the dashboard. Every table / modal that used
// to inline the same if-ladder reads from this function instead, so
// (a) the label is consistent across pages and (b) the color map
// lives in one place.
//
// Color palette (intentionally distinct):
//   free          → badge-success   (green solid)
//   subscription  → badge-secondary  (purple solid)
//   oauth/managed → badge-warning badge-outline (yellow outline)
//   api_key / ?   → badge-info badge-outline    (blue outline)
//
// Input object can be a provider row (auth_strategy / auth_type) or a
// model row (auth_strategy joined from its provider, or a legacy
// billing_type). `is_free` overrides everything else.
//
// @param {object} obj
// @param {object} [opts]
// @param {boolean} [opts.short]  Use the compact label ("sub", "api")
// @returns {{ label: string, classes: string }}
function sgAuthBadge(obj, { short = false } = {}) {
  if (!obj) return { label: short ? '?' : 'unknown', classes: 'badge-ghost' };
  if (obj.is_free) return { label: 'free', classes: 'badge-success' };
  const strategy = obj.auth_strategy || obj.billing_type || obj.auth_type || null;
  if (strategy === 'subscription') {
    return { label: short ? 'sub' : 'subscription', classes: 'badge-secondary' };
  }
  if (strategy === 'oauth' || strategy === 'managed') {
    return { label: 'oauth', classes: 'badge-warning badge-outline' };
  }
  // api_key or unknown → default "api key" styling
  return { label: short ? 'api' : 'api key', classes: 'badge-info badge-outline' };
}
// Alpine templates resolve free identifiers against the component
// scope and its ancestors; to make sgAuthBadge available everywhere
// without importing it into every component, expose it on `window`.
window.sgAuthBadge = sgAuthBadge;

// ---- Auth token management ----
function getAuthToken() {
  return sessionStorage.getItem('sg_auth_token') || '';
}
function setAuthToken(token) {
  sessionStorage.setItem('sg_auth_token', token);
}
function getCsrfToken() {
  return sessionStorage.getItem('sg_csrf_token') || '';
}
function setCsrfToken(token) {
  sessionStorage.setItem('sg_csrf_token', token);
}
function clearAuth() {
  sessionStorage.removeItem('sg_auth_token');
  sessionStorage.removeItem('sg_csrf_token');
}
function isAuthenticated() {
  return !!getAuthToken();
}

// ---- Helpers ----
const api = {
  _headers() {
    const h = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    const csrf = getCsrfToken();
    if (csrf) h['X-CSRF-Token'] = csrf;
    return h;
  },
  async _handleResponse(res) {
    if (res.status === 401) {
      clearAuth();
      window.dispatchEvent(new CustomEvent('sg-auth-required'));
      throw new Error('Authentication required');
    }
    return res.json();
  },
  async get(path) {
    const res = await fetch(path, { headers: this._headers() });
    return this._handleResponse(res);
  },
  async post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    return this._handleResponse(res);
  },
  async patch(path, body) {
    const res = await fetch(path, { method: 'PATCH', headers: this._headers(), body: JSON.stringify(body) });
    return this._handleResponse(res);
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE', headers: this._headers() });
    return this._handleResponse(res);
  }
};

function unwrapData(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function unwrapArray(payload) {
  const data = unwrapData(payload);
  return Array.isArray(data) ? data : [];
}

function unwrapObject(payload, fallback = {}) {
  const data = unwrapData(payload);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => {
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
    return { role: m.role || 'unknown', raw, html: renderMarkdown(raw), isLong: raw.length > 300, _expanded: false };
  });
}

function renderContent(text) {
  if (!text) return '';
  // If it's valid JSON, pretty-print in a code block
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2);
    return `<pre class="sg-md-code"><code>${pretty.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
  } catch {}
  return renderMarkdown(text);
}

const CHART_COLORS = ['#36a2eb', '#ff6384', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#c9cbcf', '#7bc8a4'];

// ---- Login component ----
function loginForm() {
  return {
    password: '',
    error: '',
    loading: false,

    async login() {
      this.error = '';
      this.loading = true;
      try {
        const res = await fetch('/management/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.password }),
        });
        const data = await res.json();
        if (data.ok && data.token) {
          setAuthToken(data.token);
          if (data.csrfToken) setCsrfToken(data.csrfToken);
          window.dispatchEvent(new CustomEvent('sg-auth-success'));
        } else {
          this.error = (data.error && data.error.message) || data.error || 'Login failed';
        }
      } catch (e) {
        this.error = e.message || 'Login failed';
      }
      this.loading = false;
    },
  };
}

// ---- Main App ----
function app() {
  return {
    page: 'providers',
    pages: [
      { id: 'providers', label: 'Providers' },
      { id: 'models', label: 'Models' },
      { id: 'tiers', label: 'Tiers' },
      { id: 'keys', label: 'Keys' },
      { id: 'logs', label: 'Logs' },
      { id: 'errors', label: 'Errors' },
      { id: 'activity', label: 'Activity' },
      { id: 'costs', label: 'Usage' },
      { id: 'blacklist', label: 'Blacklist' },
      { id: 'middlewares', label: 'Middlewares' },
      { id: 'export', label: 'Export' },
    ],
    wsConnected: false,
    streamMode: '', // 'ws', 'sse', or ''
    ws: null,
    sse: null,
    authenticated: false,

    init() {
      this.authenticated = isAuthenticated();

      window.addEventListener('sg-auth-required', () => {
        this.authenticated = false;
      });
      window.addEventListener('sg-auth-success', () => {
        this.authenticated = true;
        this.connectWs();
      });

      // Read page from URL hash
      const hash = window.location.hash.slice(1);
      const validPages = this.pages.map(p => p.id);
      if (hash && validPages.includes(hash)) this.page = hash;

      if (this.authenticated) {
        this.connectWs();
      }
    },

    navigate(p) {
      this.page = p;
      window.location.hash = p;
      // Notify per-tab Alpine components so they can re-fetch their
      // data. Every data-tab wrapper (providers / models / tiers /
      // keys / blacklist / middlewares) binds
      // @page-change.window="..." to its own init() — without this
      // dispatch the tab stays stuck on whatever state it had on
      // first mount and a user has to hard-refresh the browser to
      // see mutations made from another tab (e.g. a provider created
      // in the Providers tab that auto-provisioned models).
      window.dispatchEvent(new CustomEvent('page-change', { detail: p }));
    },

    logout() {
      clearAuth();
      this.authenticated = false;
      if (this.ws) { this.ws.close(); this.ws = null; }
      if (this.sse) { this.sse.close(); this.sse = null; }
      this.wsConnected = false;
      this.streamMode = '';
    },

    _handleLogMessage(raw) {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'log') {
          window.dispatchEvent(new CustomEvent('soul-log', { detail: msg.data }));
        }
      } catch {}
    },

    connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAuthToken();
      const wsUrl = `${proto}//${location.host}/ws/logs${token ? '?token=' + encodeURIComponent(token) : ''}`;
      const ws = new WebSocket(wsUrl);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.wsConnected = true;
        this.streamMode = 'ws';
      };
      ws.onclose = () => {
        this.ws = null;
        if (!opened) {
          // WebSocket never connected -- fall back to SSE
          this.connectSse();
          return;
        }
        this.wsConnected = false;
        this.streamMode = '';
        setTimeout(() => this.connectWs(), 3000);
      };
      ws.onmessage = (e) => this._handleLogMessage(e.data);
      this.ws = ws;
    },

    connectSse() {
      if (this.sse) { this.sse.close(); this.sse = null; }
      const token = getAuthToken();
      const sseUrl = `/management/logs/stream/sse${token ? '?token=' + encodeURIComponent(token) : ''}`;
      const sse = new EventSource(sseUrl);
      sse.onopen = () => {
        this.wsConnected = true;
        this.streamMode = 'sse';
      };
      sse.onerror = () => {
        this.wsConnected = false;
        this.streamMode = '';
      };
      sse.onmessage = (e) => this._handleLogMessage(e.data);
      this.sse = sse;
    },
  };
}

// ---- Providers Page ----
function providersPage() {
  return {
    providers: [],
    templates: {},
    showCreate: false,
    showEdit: false,
    editing: null,
    testing: null,
    testResult: null,
    discoverProvider: null,
    discoveredModels: [],
    showDiscover: false,

    // Auth management
    authProvider: null,
    authStatus: null,
    showAuthModal: false,
    authFlow: null,
    authPolling: false,
    authPollTimer: null,
    callbackUrl: '',

    form: { template: 'custom', name: '', display_name: '', adapter_key: 'openai', base_url: '', api_key: '', auth_strategy: 'api_key', auth_type: 'api_key', oauth_adapter_key: '', provider_mode: 'external_api' },
    editForm: { display_name: '', adapter_key: '', base_url: '', api_key: '', auth_strategy: 'api_key', enabled: true },

    // Pipeline composer state
    showComposer: false,
    composerProvider: null,
    composerExecutor: '',
    composerPipeline: { request: [], stream: [], response: [] },
    availableExecutors: [],
    availableProviderHooks: [],
    // Per-hook settings editor
    hookSettingsOpen: false,
    hookSettingsPhase: '',
    hookSettingsIndex: -1,
    hookSettingsJson: '',
    hookSettingsError: '',

    /** Derive OAuth adapter options from loaded templates — no hardcoded list. */
    get oauthAdapterOptions() {
      const options = [];
      const seen = new Set();
      if (this.templates && typeof this.templates === 'object') {
        for (const [key, tpl] of Object.entries(this.templates)) {
          const adapterKey = tpl.oauth_adapter_key || tpl.oauthAdapterKey;
          if (adapterKey && !seen.has(adapterKey)) {
            seen.add(adapterKey);
            options.push({ key: adapterKey, label: tpl.display_name || tpl.displayName || adapterKey });
          }
        }
      }
      return options.sort((a, b) => a.label.localeCompare(b.label));
    },

    /** Derive adapter options from loaded templates. */
    get adapterOptions() {
      const options = [];
      const seen = new Set();
      if (this.templates && typeof this.templates === 'object') {
        for (const [, tpl] of Object.entries(this.templates)) {
          const adapterKey = tpl.adapter_key || tpl.adapterKey;
          if (adapterKey && !seen.has(adapterKey)) {
            seen.add(adapterKey);
            options.push({ key: adapterKey, label: tpl.display_name || tpl.displayName || adapterKey });
          }
        }
      }
      return options.sort((a, b) => a.label.localeCompare(b.label));
    },

    async init() {
      const [providers, templates] = await Promise.all([
        api.get('/management/providers'),
        api.get('/management/providers/templates'),
      ]);
      this.providers = unwrapArray(providers);
      this.templates = unwrapObject(templates);
    },

    onTemplateChange() {
      const t = this.templates[this.form.template];
      if (!t) return;

      // Set scalar fields immediately
      this.form.display_name = t.display_name || '';
      this.form.base_url = t.base_url || '';
      this.form.auth_strategy = t.auth_strategy || t.billing_type || 'api_key';
      this.form.auth_type = t.auth_type || (t.auth_strategy === 'oauth' ? 'managed' : 'api_key');
      if (this.form.template !== 'custom') {
        this.form.name = this.form.template;
      }

      // Defer dropdown-bound fields to next tick so x-for options render first
      const adapterKey = t.adapter_key || t.protocol || 'openai';
      const oauthKey = t.oauth_adapter_key || '';
      this.$nextTick(() => {
        this.form.adapter_key = adapterKey;
        this.form.oauth_adapter_key = oauthKey;
      });
    },

    openCreate() {
      this.form = { template: 'custom', name: '', display_name: '', adapter_key: 'openai', base_url: '', api_key: '', auth_strategy: 'api_key', auth_type: 'api_key', oauth_adapter_key: '', provider_mode: 'external_api' };
      this.showCreate = true;
    },

    async create() {
      const payload = { ...this.form };
      delete payload.template;
      if (!payload.oauth_adapter_key) delete payload.oauth_adapter_key;
      const isCustomPipeline = payload.provider_mode === 'custom';
      payload.kind = isCustomPipeline ? 'custom' : 'external_api';
      if (!payload.name) {
        alert('Name is required');
        return;
      }
      if (!isCustomPipeline && !payload.base_url) {
        alert('Base URL is required for External API providers');
        return;
      }
      if (!isCustomPipeline && payload.auth_type !== 'managed' && !payload.api_key) {
        alert('API Key is required for non-OAuth providers');
        return;
      }
      const result = await api.post('/management/providers', payload);
      if (result.error) {
        alert(result.error.message || result.error);
        return;
      }
      this.showCreate = false;
      this.providers = unwrapArray(await api.get('/management/providers'));
    },

    edit(p) {
      this.editing = p;
      this.editForm = {
        display_name: p.display_name || '',
        adapter_key: p.adapter_key || p.protocol || 'openai',
        base_url: p.base_url || '',
        api_key: '',
        auth_strategy: p.auth_strategy || p.billing_type || 'api_key',
        enabled: p.enabled ?? p.is_enabled ?? true,
      };
      this.showEdit = true;
    },

    async saveEdit() {
      const payload = { ...this.editForm };
      if (!payload.api_key) delete payload.api_key;
      await api.patch(`/management/providers/${this.editing.id}`, payload);
      this.showEdit = false;
      this.editing = null;
      this.providers = unwrapArray(await api.get('/management/providers'));
    },

    async remove(p) {
      if (!confirm(`Delete provider "${p.name}"? Models using this provider will lose their provider configuration.`)) return;
      await api.del(`/management/providers/${p.id}`);
      this.providers = unwrapArray(await api.get('/management/providers'));
    },

    async testConnection(p) {
      this.testing = p.id;
      this.testResult = null;
      try {
        this.testResult = await api.post(`/management/providers/${p.id}/test`, {});
      } catch (e) {
        this.testResult = { ok: false, error: e.message };
      }
      this.testing = null;
    },

    async discoverModels(p) {
      this.discoverProvider = p;
      this.discoveredModels = null; // null = loading, [] = loaded empty
      this.showDiscover = true;
      try {
        this.discoveredModels = unwrapArray(
          await api.post(`/management/providers/${p.id}/discover-models`, {}),
        );
      } catch {
        this.discoveredModels = [];
      }
    },

    async addDiscoveredModel(model) {
      if (!this.discoverProvider) return;
      const slug = _providerSlug(this.discoverProvider.name);
      // handleCreateModel requires camelCase fields (modelKey,
      // displayName, providerId, providerModelId) — sending the
      // snake_case shape from older code paths trips a 400 with
      // "Missing required fields".
      await api.post('/management/models', {
        modelKey: `${slug}/${model.id}`,
        displayName: model.display_name || model.id,
        providerId: this.discoverProvider.id,
        providerModelId: model.id,
        inputPricePerMillion: model.input_price || 0,
        outputPricePerMillion: model.output_price || 0,
      });
      model._added = true;
    },

    async viewAuth(p) {
      this.authProvider = p;
      this.showAuthModal = true;
      await this.refreshAuthStatus(p);
    },

    async refreshAuthStatus(p) {
      this.authStatus = await api.get(`/management/providers/${p.id}/accounts`);
    },

    async addAccount() {
      this.authFlow = await api.post(`/management/providers/${this.authProvider.id}/auth/start`, {});
      if (this.authFlow.type === 'device-flow') {
        this.authPolling = true;
        this.pollDeviceFlow();
      } else if (this.authFlow.type === 'pkce') {
        window.open(this.authFlow.authUrl, '_blank', 'width=600,height=700');
        this.authPolling = true;
        this.pollPKCEFlow();
      }
    },

    async pollDeviceFlow() {
      const flowId = this.authFlow?.flowId || this.authFlow?.flow_id || '';
      while (this.authPolling) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const result = await api.get(`/management/providers/${this.authProvider.id}/auth/pending/${flowId}`);
          if (result.status === 'complete') {
            this.authPolling = false;
            this.authFlow = null;
            await this.refreshAuthStatus(this.authProvider);
            break;
          }
          if (result.status === 'error') {
            this.authPolling = false;
            this.authFlow = { ...this.authFlow, error: result.error };
            break;
          }
        } catch { break; }
      }
    },

    async pollPKCEFlow() {
      const flowId = this.authFlow?.flowId || this.authFlow?.flow_id || '';
      let attempts = 0;
      while (this.authPolling && attempts < 60) {
        await new Promise(r => setTimeout(r, 3000));
        attempts++;
        const status = await api.get(`/management/providers/${this.authProvider.id}/accounts`);
        if (status.accounts?.length > (this.authStatus?.accounts?.length || 0)) {
          this.authPolling = false;
          this.authFlow = null;
          this.authStatus = status;
          break;
        }
      }
      this.authPolling = false;
    },

    async removeAuthAccount(account) {
      if (!confirm('Remove this account?')) return;
      const accountId = account.id ?? account.index;
      await api.del(`/management/providers/${this.authProvider.id}/accounts/${accountId}`);
      await this.refreshAuthStatus(this.authProvider);
    },

    async resetAuthQuota(account) {
      const accountId = account?.id ?? account?.index;
      if (accountId == null) return;
      await api.post(`/management/providers/${this.authProvider.id}/accounts/${accountId}/reset-quota`, {});
      await this.refreshAuthStatus(this.authProvider);
    },

    closeAuthModal() {
      this.showAuthModal = false;
      this.authPolling = false;
      this.authFlow = null;
      this.callbackUrl = '';
    },

    async submitCallbackUrl() {
      if (!this.callbackUrl || !this.authProvider) return;
      try {
        const url = new URL(this.callbackUrl);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          this.authFlow = { ...this.authFlow, error: 'URL must contain code and state parameters' };
          return;
        }
        const result = await api.get(`/management/providers/${this.authProvider.id}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
        if (result.status === 'complete') {
          this.authPolling = false;
          this.authFlow = null;
          this.callbackUrl = '';
          await this.refreshAuthStatus(this.authProvider);
        } else {
          this.authFlow = { ...this.authFlow, error: result.error || 'Callback failed' };
        }
      } catch (e) {
        this.authFlow = { ...this.authFlow, error: e.message || 'Failed to process callback URL' };
      }
    },

    // ---- Pipeline Composer methods ----

    async openComposer(provider) {
      this.composerProvider = provider;
      this.composerExecutor = provider.executor_key || '';
      this.composerPipeline = { request: [], stream: [], response: [] };

      // Fetch executors, available hooks, and current assignments in parallel
      const [executorsRes, hooksRes, assignmentsRes] = await Promise.all([
        api.get('/management/executors'),
        api.get('/management/provider-hooks'),
        api.get(`/management/providers/${provider.id}/hooks`),
      ]);

      this.availableExecutors = unwrapArray(executorsRes);
      this.availableProviderHooks = unwrapArray(hooksRes);

      // Assignments come grouped by phase
      const grouped = unwrapObject(assignmentsRes);
      this.composerPipeline = {
        request: (grouped.request || []).map(a => ({ ...a, hookKey: a.hook_key || a.hookKey })),
        stream: (grouped.stream || []).map(a => ({ ...a, hookKey: a.hook_key || a.hookKey })),
        response: (grouped.response || []).map(a => ({ ...a, hookKey: a.hook_key || a.hookKey })),
      };

      this.showComposer = true;
    },

    async saveComposer() {
      if (!this.composerProvider) return;
      const pid = this.composerProvider.id;

      // 1. Update provider mode and executor
      await api.patch(`/management/providers/${pid}`, {
        provider_mode: 'custom',
        executor_key: this.composerExecutor || null,
      });

      // 2. Sync hook assignments: delete old, create new
      // Fetch current assignments to diff
      const currentRes = await api.get(`/management/providers/${pid}/hooks`);
      const current = unwrapObject(currentRes);

      for (const phase of ['request', 'stream', 'response']) {
        const oldAssignments = current[phase] || [];
        const newHooks = this.composerPipeline[phase] || [];

        // Delete assignments that are no longer present
        for (const old of oldAssignments) {
          const stillPresent = newHooks.some(h => h.id === old.id);
          if (!stillPresent) {
            await api.del(`/management/providers/${pid}/hooks/${old.id}`);
          }
        }

        // Create or update assignments
        for (let i = 0; i < newHooks.length; i++) {
          const hook = newHooks[i];
          if (hook.id) {
            // Existing assignment -- update sort order and settings
            await api.patch(`/management/providers/${pid}/hooks/${hook.id}`, {
              sortOrder: i + 1,
              settings: hook.settings || {},
            });
          } else {
            // New assignment
            await api.post(`/management/providers/${pid}/hooks`, {
              hookKey: hook.hookKey,
              phase,
              sortOrder: i + 1,
              enabled: true,
              settings: hook.settings || {},
            });
          }
        }
      }

      this.showComposer = false;
      this.composerProvider = null;
      this.providers = unwrapArray(await api.get('/management/providers'));
    },

    addHookToPhase(phase, hookKey) {
      if (!hookKey) return;
      const meta = this.availableProviderHooks.find(h => h.key === hookKey);
      this.composerPipeline[phase].push({
        hookKey,
        settings: meta?.defaultSettings ? { ...meta.defaultSettings } : {},
      });
    },

    removeHookFromPhase(phase, index) {
      this.composerPipeline[phase].splice(index, 1);
    },

    moveHookUp(phase, index) {
      if (index <= 0) return;
      const arr = this.composerPipeline[phase];
      [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
    },

    moveHookDown(phase, index) {
      const arr = this.composerPipeline[phase];
      if (index >= arr.length - 1) return;
      [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
    },

    openHookSettings(phase, index) {
      const hook = this.composerPipeline[phase][index];
      this.hookSettingsPhase = phase;
      this.hookSettingsIndex = index;
      this.hookSettingsJson = JSON.stringify(hook.settings || {}, null, 2);
      this.hookSettingsError = '';
      this.hookSettingsOpen = true;
    },

    saveHookSettings() {
      try {
        const parsed = JSON.parse(this.hookSettingsJson);
        this.composerPipeline[this.hookSettingsPhase][this.hookSettingsIndex].settings = parsed;
        this.hookSettingsOpen = false;
      } catch (e) {
        this.hookSettingsError = 'Invalid JSON: ' + e.message;
      }
    },

    formatDate,
  };
}

// ---- Time range helper ----
function timeRangeToParams(range, customFrom, customTo) {
  const now = new Date();
  if (range === 'day') return { from: new Date(now - 86400000).toISOString() };
  if (range === 'week') return { from: new Date(now - 7 * 86400000).toISOString() };
  if (range === 'month') return { from: new Date(now - 30 * 86400000).toISOString() };
  if (range === 'custom' && customFrom) {
    const p = { from: new Date(customFrom).toISOString() };
    if (customTo) p.to = new Date(customTo).toISOString();
    return p;
  }
  return { from: new Date(now - 86400000).toISOString() };
}

// ---- Logs Page ----
function logsPage() {
  return {
    keys: [],
    selectedKey: null,
    selectedLogs: [],
    logsTotal: 0,
    logsOffset: 0,
    logsLimit: 50,
    expandedDetail: null,
    sortCol: 'started_at',
    sortDir: 'desc',
    // Filters (clickable cell values)
    filters: {},  // { agent_name: 'claude-code', cache_hit: true, session_id: 'abc...' }
    keyword: '',
    // Time filtering
    timeRange: 'day',
    customFrom: '',
    customTo: '',
    // Column widths (resizable)
    colWidths: { time: 144, model: 128, agent: 96, session: 80, latency: 80, tokens: 80, cost: 80, cache: 56, status: 64 },
    _resizing: null,

    async init() {
      await this.loadTree();

      window.addEventListener('soul-log', (e) => {
        if (this.selectedKey && this.selectedLogs.length > 0) {
          const log = e.detail;
          if (log.api_key_id === this.selectedKey.api_key_id) {
            this.selectedLogs.unshift(log);
            if (this.selectedLogs.length > this.logsLimit) this.selectedLogs.pop();
            this.logsTotal++;
          }
        }
      });
    },

    async loadTree() {
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const params = new URLSearchParams(tp);
      this.keys = await api.get(`/management/agents/tree?${params}`);
    },

    filteredKeys() {
      return this.keys;
    },

    async onTimeChange() {
      await this.loadTree();
      this.logsOffset = 0;
      await this.loadLogs();
    },

    async onSearch() {
      this.logsOffset = 0;
      await this.loadLogs();
    },

    setSort(col) {
      if (this.sortCol === col) {
        this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        this.sortCol = col;
        this.sortDir = 'desc';
      }
      this.logsOffset = 0;
      this.loadLogs();
    },

    addFilter(key, value) {
      this.filters[key] = value;
      this.logsOffset = 0;
      this.loadLogs();
    },

    removeFilter(key) {
      delete this.filters[key];
      this.logsOffset = 0;
      this.loadLogs();
    },

    get activeFilters() {
      return Object.entries(this.filters).map(([key, value]) => {
        let label;
        if (key === 'agent_name') label = `Agent: ${value}`;
        else if (key === 'session_id') label = `Session: ${String(value).slice(0, 8)}`;
        else if (key === 'cache_hit') label = `Cache: ${value ? 'HIT' : 'MISS'}`;
        else label = `${key}: ${value}`;
        return { key, label };
      });
    },

    async selectKey(key) {
      this.selectedKey = key;
      this.logsOffset = 0;
      this.expandedDetail = null;
      this.filters = {};
      this.keyword = '';
      this.sortCol = 'started_at';
      this.sortDir = 'desc';
      await this.loadLogs();
    },

    async loadLogs() {
      this.expandedDetail = null;
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const p = {
        limit: this.logsLimit,
        offset: this.logsOffset,
        sort: this.sortCol,
        order: this.sortDir,
        ...tp,
      };
      if (this.selectedKey) p.api_key_id = this.selectedKey.api_key_id;
      if (this.keyword) p.keyword = this.keyword;
      // Apply cell filters
      if (this.filters.agent_name) p.agent_name = this.filters.agent_name;
      if (this.filters.session_id) p.session_id = this.filters.session_id;
      // cache_hit filter needs backend support -- filter client-side for now
      const params = new URLSearchParams(p);
      const result = await api.get(`/management/logs?${params}`);
      let rows = result.rows || [];
      // Client-side cache filter
      if (this.filters.cache_hit !== undefined) {
        rows = rows.filter(r => !!r.cache_hit === this.filters.cache_hit);
      }
      this.selectedLogs = rows;
      this.logsTotal = result.total || 0;
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) { this.expandedDetail = null; return; }
      if (!log._detail) { log._detail = await api.get(`/management/logs/${log.id}`); }
      this.expandedDetail = log.id;
    },

    // Column resize
    startResize(col, e) {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = this.colWidths[col];
      this._resizing = col;
      const onMove = (ev) => {
        const diff = ev.clientX - startX;
        this.colWidths[col] = Math.max(40, startW + diff);
      };
      const onUp = () => {
        this._resizing = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    cw(col) { return this.colWidths[col] + 'px'; },

    formatTime, formatDate, formatMessages, renderContent,
    formatCost(v) { return v ? '$' + Number(v).toFixed(4) : '-'; },
    formatTokens(v) { return v ? Number(v).toLocaleString() : '-'; },
  };
}

// ---- Costs Page ----
function costsPage() {
  return {
    // Time filtering
    timeRange: 'month',
    customFrom: '',
    customTo: '',
    // Filters
    filterModel: '',
    filterKey: '',
    availableModels: [],
    availableKeys: [],
    // Data
    totalCost: 0,
    totalTokens: 0,
    totalRequests: 0,
    _chart: null,
    _dailyData: [],
    _modelRequests: [],
    expandedModel: null,

    get timeLabel() {
      if (this.timeRange === 'day') return 'Last 24 Hours';
      if (this.timeRange === 'week') return 'Last 7 Days';
      if (this.timeRange === 'month') return 'Last 30 Days';
      if (this.timeRange === 'custom') {
        const f = this.customFrom || '?';
        const t = this.customTo || 'now';
        return `${f} - ${t}`;
      }
      return '';
    },

    async init() {
      this.availableKeys = await api.get('/management/keys');
      await this.load();
    },

    async load() {
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const params = new URLSearchParams(tp);
      if (this.filterModel) params.set('model', this.filterModel);
      if (this.filterKey) params.set('api_key_id', this.filterKey);
      const data = await api.get(`/management/metrics/usage?${params}`);

      this.totalCost = Number(data.total?.total_cost || 0);
      this.totalTokens = Number(data.total?.total_tokens || 0);
      this.totalRequests = Number(data.total?.request_count || 0);
      this.availableModels = data.models || [];
      this._dailyData = data.daily_by_model || [];
      this._modelRequests = data.model_requests || [];
      this.expandedModel = null;

      this.$nextTick(() => this.renderChart());
    },

    onTimeChange() { this.load(); },
    onFilterChange() { this.load(); },

    get modelRequestRows() {
      const byModel = new Map();
      for (const r of this._modelRequests) {
        const m = r.resolved_model;
        if (!byModel.has(m)) byModel.set(m, { model: m, total: 0, cached: 0, nonCached: 0, keys: [] });
        const entry = byModel.get(m);
        const t = Number(r.total || 0);
        const c = Number(r.cached || 0);
        const nc = Number(r.non_cached || 0);
        entry.total += t;
        entry.cached += c;
        entry.nonCached += nc;
        entry.keys.push({ api_key_id: r.api_key_id, key_label: r.key_label, key_hint: r.key_hint, total: t, cached: c, nonCached: nc });
      }
      return [...byModel.values()].sort((a, b) => b.nonCached - a.nonCached);
    },

    renderChart() {
      const canvas = this.$refs.usageChart;
      if (!canvas || canvas.clientWidth === 0) return;

      if (this._chart) { this._chart.destroy(); this._chart = null; }

      const data = this._dailyData;
      if (data.length === 0) return;

      const models = [...new Set(data.map(r => r.resolved_model))].filter(Boolean);

      // Build unique sorted day labels from the data
      const daySet = new Set();
      const dataMap = new Map();
      for (const r of data) {
        const pd = new Date(r.period);
        const dayKey = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth()+1).padStart(2,'0')}-${String(pd.getUTCDate()).padStart(2,'0')}`;
        daySet.add(dayKey);
        dataMap.set(dayKey + '||' + r.resolved_model, Number(r.total_cost || 0));
      }
      const days = [...daySet].sort();

      this._chart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: days.map(d => { const p = d.split('-'); return new Date(p[0], p[1]-1, p[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }),
          datasets: models.map((model, i) => ({
            label: model,
            data: days.map(day => dataMap.get(day + '||' + model) || 0),
            backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
          }))
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: {
            x: { stacked: true },
            y: { stacked: true, ticks: { callback: v => '$' + v.toFixed(4) } },
          },
          plugins: { legend: { position: 'bottom' } },
        }
      });
    },
  };
}

// ---- Activity Page (Per-Key) ----
function activityPage() {
  return {
    keyData: [],
    expandedKey: null,
    keyLogs: [],
    keyLogsTotal: 0,
    keyLogsOffset: 0,
    keyLogsLimit: 50,
    expandedDetail: null,
    sortCol: 'started_at',
    sortDir: 'desc',
    timeRange: 'month',
    customFrom: '',
    customTo: '',

    async init() {
      await this.loadActivity();
    },

    async loadActivity() {
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const params = new URLSearchParams(tp);
      const data = await api.get(`/management/metrics/activity?${params}`);
      this.keyData = (data.by_key || []).map(k => ({
        ...k,
        total_cost: Number(k.total_cost || 0),
        input_cost: Number(k.input_cost || 0),
        output_cost: Number(k.output_cost || 0),
        total_tokens: Number(k.total_tokens || 0),
        prompt_tokens: Number(k.prompt_tokens || 0),
        completion_tokens: Number(k.completion_tokens || 0),
        request_count: Number(k.request_count || 0),
        error_count: Number(k.error_count || 0),
        key_budget: k.key_budget != null ? Number(k.key_budget) : null,
      }));
    },

    async onTimeChange() {
      await this.loadActivity();
    },

    budgetPct(row) {
      const budget = row.key_budget;
      if (budget == null || budget === 0) return null;
      return Math.min(100, (row.total_cost / budget) * 100);
    },

    setSort(col) {
      if (this.sortCol === col) {
        this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        this.sortCol = col;
        this.sortDir = 'desc';
      }
      this.keyLogsOffset = 0;
      this.loadKeyLogs();
    },

    async toggleKey(k) {
      if (this.expandedKey === k.api_key_id) {
        this.expandedKey = null;
        this.keyLogs = [];
        return;
      }
      this.expandedKey = k.api_key_id;
      this.keyLogsOffset = 0;
      this.expandedDetail = null;
      this.sortCol = 'started_at';
      this.sortDir = 'desc';
      await this.loadKeyLogs();
    },

    async loadKeyLogs() {
      const params = new URLSearchParams({ api_key_id: this.expandedKey, limit: this.keyLogsLimit, offset: this.keyLogsOffset, sort: this.sortCol, order: this.sortDir });
      const result = await api.get(`/management/logs?${params}`);
      this.keyLogs = result.rows || [];
      this.keyLogsTotal = result.total || 0;
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) { this.expandedDetail = null; return; }
      if (!log._detail) { log._detail = await api.get(`/management/logs/${log.id}`); }
      this.expandedDetail = log.id;
    },

    formatTime, formatDate, formatMessages, renderContent,
    formatCost(v) { return v ? '$' + Number(v).toFixed(4) : '-'; },
    formatTokens(v) { return v ? Number(v).toLocaleString() : '-'; },
  };
}

// ---- Errors Page ----
function errorsPage() {
  return {
    summary: {},
    breakdown: [],
    errorModels: [],
    rates: [],
    errorLogs: [],
    logsTotal: 0,
    logsOffset: 0,
    logsLimit: 50,
    filterType: '',
    filterModel: '',
    expandedDetail: null,
    showChart: false,
    _chart: null,
    timeRange: 'day',
    customFrom: '',
    customTo: '',

    async init() {
      await this.loadErrors();
    },

    async loadErrors() {
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const params = new URLSearchParams(tp);
      const data = await api.get(`/management/metrics/errors?${params}`);
      this.summary = data.summary || {};
      this.breakdown = data.breakdown || [];
      this.errorModels = data.models || [];
      this.rates = data.rates || [];
      await this.loadErrorLogs();
    },

    async loadErrorLogs() {
      const tp = timeRangeToParams(this.timeRange, this.customFrom, this.customTo);
      const params = new URLSearchParams({ status: 'error', limit: this.logsLimit, offset: this.logsOffset, ...tp });
      if (this.filterType) params.set('error_type', this.filterType);
      if (this.filterModel) params.set('model', this.filterModel);
      const result = await api.get(`/management/logs?${params}`);
      this.errorLogs = result.rows || [];
      this.logsTotal = result.total || 0;
    },

    async onTimeChange() {
      this.logsOffset = 0;
      await this.loadErrors();
    },

    async applyFilter(type) {
      this.filterType = this.filterType === type ? '' : type;
      this.logsOffset = 0;
      await this.loadErrorLogs();
    },

    async onFilterChange() {
      this.logsOffset = 0;
      await this.loadErrorLogs();
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) {
        this.expandedDetail = null;
        return;
      }
      if (!log._detail) {
        log._detail = await api.get(`/management/logs/${log.id}`);
      }
      this.expandedDetail = log.id;
    },

    openChart() {
      this.showChart = true;
      this.$nextTick(() => {
        const ctx = this.$refs.errorChart;
        if (!ctx) return;
        if (this._chart) this._chart.destroy();

        const rates = this.rates;
        const models = [...new Set(rates.map(r => r.resolved_model))];
        const periods = [...new Set(rates.map(r => r.period))].sort();

        this._chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: periods.map(p => new Date(p).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })),
            datasets: models.map((m, i) => ({
              label: m || 'unknown',
              data: periods.map(p => {
                const row = rates.find(r => r.period === p && r.resolved_model === m);
                return row ? Number(row.error_count) : 0;
              }),
              borderColor: CHART_COLORS[i % CHART_COLORS.length],
              fill: false,
              tension: 0.3,
            }))
          },
          options: { responsive: true }
        });
      });
    },

    closeChart() {
      if (this._chart) { this._chart.destroy(); this._chart = null; }
      this.showChart = false;
    },

    formatTime, formatDate,
    formatCost(v) { return v ? '$' + Number(v).toFixed(4) : '-'; },
    formatTokens(v) { return v ? Number(v).toLocaleString() : '-'; },
  };
}

// ---- Models Page ----
function modelsPage() {
  return {
    models: [],
    providers: [],
    predefinedTags: [],
    // Models table state
    modelFilter: '',
    modelEnabledOnly: false,
    freeOnly: false,
    billingFilter: '',
    tagFilter: '',
    // Model edit state
    showModelEdit: false,
    editingModel: null,
    modelForm: { model_key: '', display_name: '', provider_key: '', provider_model_id: '', provider_id: '', input_price: 0, output_price: 0, pricing_type: 'token', request_cost: 0, is_free: false, max_concurrency: 3, sort_order: 100, context_window: '', tags: [], execution_kind: 'provider_model', pricing_mode: 'external_directory' },
    customTagInput: '',
    // Model create state
    showModelCreate: false,
    createProvider: '',
    createProviderModels: [],
    loadingCreateModels: false,
    createModelsError: '',
    createModel: '',
    createName: '',

    async init() {
      const [models, providers, predefinedTags] = await Promise.all([
        api.get('/management/models'),
        api.get('/management/models/providers'),
        api.get('/management/models/tags'),
      ]);
      this.models = unwrapArray(models);
      this.providers = unwrapArray(providers);
      this.predefinedTags = unwrapArray(predefinedTags);
    },

    get allTags() {
      const tags = new Set(this.predefinedTags || []);
      for (const m of this.models) {
        for (const t of (m.tags || [])) tags.add(t);
      }
      return [...tags].sort();
    },

    get filteredModels() {
      let list = this.models;
      if (!Array.isArray(list)) return [];
      if (this.modelEnabledOnly) list = list.filter(m => m.enabled ?? m.is_enabled);
      if (this.freeOnly) list = list.filter(m => m.is_free);
      if (this.billingFilter) list = list.filter(m => (m.auth_strategy || m.billing_type || 'api_key') === this.billingFilter);
      if (this.tagFilter) list = list.filter(m => (m.tags || []).includes(this.tagFilter));
      const q = this.modelFilter.trim().toLowerCase();
      if (q) list = list.filter(m => (m.model_key || m.name || '').toLowerCase().includes(q) || (m.provider_key || '').toLowerCase().includes(q));
      return list;
    },

    async toggleModel(m) {
      const isEnabled = m.enabled ?? m.is_enabled;
      if (isEnabled) {
        await api.post(`/management/models/${m.id}/disable`, {});
      } else {
        await api.post(`/management/models/${m.id}/enable`, {});
      }
      this.models = unwrapArray(await api.get('/management/models'));
    },

    async toggleFree(m) {
      await api.patch(`/management/models/${m.id}`, { is_free: !m.is_free });
      this.models = unwrapArray(await api.get('/management/models'));
    },

    // ---- Create model flow ----
    openCreate() {
      this.createProvider = '';
      this.createProviderModels = [];
      this.createModelsError = '';
      this.createModel = '';
      this.createName = '';
      this.showModelCreate = true;
    },

    async onCreateProviderChange() {
      const key = this.createProvider;
      if (!key) { this.createProviderModels = []; return; }
      this.loadingCreateModels = true;
      this.createModelsError = '';
      this.createProviderModels = [];
      this.createModel = '';
      this.createName = '';
      try {
        const models = unwrapArray(
          await api.get(`/management/models/providers/${encodeURIComponent(key)}/models`),
        );
        if (models.length > 0) {
          this.createProviderModels = models;
        } else if (models?.error) {
          this.createModelsError = models.error.message || 'Failed to load models';
        }
      } catch {
        this.createModelsError = 'Failed to fetch models';
      }
      this.loadingCreateModels = false;
    },

    onCreateModelChange() {
      if (this.createModel && this.createProvider) {
        this.createName = _buildModelName(this.createProvider, this.createModel);
      }
    },

    get groupedCreateModels() {
      const groups = {};
      for (const m of this.createProviderModels) {
        const key = m.owned_by || 'other';
        (groups[key] ||= []).push(m);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    },

    async createNewModel() {
      if (!this.createProvider || !this.createModel) return;
      const name = this.createName || this.createModel;
      const selected = this.createProviderModels.find(m => m.id === this.createModel);
      const providerInfo = this.providers.find(p => p.key === this.createProvider);
      const payload = {
        model_key: name,
        provider_key: this.createProvider,
        provider_model_id: this.createModel,
        upstream_source: selected?.owned_by || '',
        input_price: selected?.input_price || 0,
        output_price: selected?.output_price || 0,
      };
      if (providerInfo?.source === 'database') {
        payload.provider_id = providerInfo.id;
      }
      const result = await api.post('/management/models', payload);
      if (result?.error) {
        alert(result.error.message || result.error);
        return;
      }
      this.showModelCreate = false;
      this.models = unwrapArray(await api.get('/management/models'));
    },

    // ---- Edit model flow ----
    editModel(m) {
      this.editingModel = m;
      this.modelForm = {
        model_key: m.model_key || m.name || '',
        display_name: m.display_name || '',
        provider_key: m.provider_key || '',
        provider_model_id: m.provider_model_id || m.provider_model || '',
        provider_id: m.provider_id || m.provider_config_id || '',
        input_price: parseFloat(m.input_price) || 0,
        output_price: parseFloat(m.output_price) || 0,
        pricing_type: m.pricing_type || 'token',
        request_cost: parseFloat(m.request_cost) || 0,
        is_free: !!m.is_free,
        max_concurrency: m.max_concurrency ?? 3,
        sort_order: m.sort_order ?? 100,
        context_window: m.context_window || '',
        tags: [...(m.tags || [])],
        execution_kind: m.execution_kind || 'provider_model',
        pricing_mode: m.pricing_mode || (m.pricing_type === 'request' ? 'request' : m.is_free ? 'free' : 'external_directory'),
      };
      this.customTagInput = '';
      this.showModelEdit = true;
    },

    toggleTag(tag) {
      const idx = this.modelForm.tags.indexOf(tag);
      if (idx >= 0) this.modelForm.tags.splice(idx, 1);
      else this.modelForm.tags.push(tag);
    },

    addCustomTag() {
      const tag = this.customTagInput.trim().toLowerCase().replace(/\s+/g, '-');
      if (tag && !this.modelForm.tags.includes(tag)) {
        this.modelForm.tags.push(tag);
      }
      this.customTagInput = '';
    },

    onProviderChange() {
      const p = this.providers.find(pr => pr.key === this.modelForm.provider_key);
      if (p?.source === 'database') {
        this.modelForm.provider_id = p.id;
      } else {
        this.modelForm.provider_id = '';
      }
    },

    async saveModel() {
      if (!this.editingModel) return;
      const payload = { ...this.modelForm };
      if (!payload.provider_id) payload.provider_id = null;
      // Map pricing_mode back to legacy fields
      if (payload.pricing_mode === 'free') {
        payload.is_free = true;
        payload.pricing_type = 'token';
      } else if (payload.pricing_mode === 'request') {
        payload.pricing_type = 'request';
      } else if (payload.pricing_mode === 'token') {
        payload.pricing_type = 'token';
      } else {
        payload.pricing_type = 'token';
      }
      await api.patch(`/management/models/${this.editingModel.id}`, payload);
      this.showModelEdit = false;
      this.editingModel = null;
      this.models = unwrapArray(await api.get('/management/models'));
    },

    async deleteModel(m) {
      if (!confirm(`Delete model "${m.model_key || m.name}"?`)) return;
      await api.del(`/management/models/${m.id}`);
      this.showModelEdit = false;
      this.editingModel = null;
      this.models = unwrapArray(await api.get('/management/models'));
    },
  };
}

// ---- Tiers Page ----
function tiersPage() {
  return {
    tiers: [],
    models: [],
    showTierCreate: false,
    editingTier: null,
    tierForm: { name: '', display_name: '', models: [], fallback_tier_id: '' },

    // Drag reorder state
    dragIdx: null,
    dropIdx: null,

    onDragStart(idx) {
      this.dragIdx = idx;
    },
    onDragOver(evt, idx) {
      evt.preventDefault();
      this.dropIdx = idx;
    },
    onDrop(idx) {
      if (this.dragIdx === null || this.dragIdx === idx) return;
      const item = this.tierForm.models.splice(this.dragIdx, 1)[0];
      this.tierForm.models.splice(idx, 0, item);
      this.dragIdx = null;
      this.dropIdx = null;
    },
    onDragEnd() {
      this.dragIdx = null;
      this.dropIdx = null;
    },

    // Model picker state
    showModelPicker: false,
    pickerSearch: '',
    pickerBilling: '',
    pickerSelected: [],

    get filteredPickerModels() {
      let list = this.models.filter(m => !this.tierForm.models.includes(m.model_key || m.name));
      const q = this.pickerSearch.trim().toLowerCase();
      if (q) {
        list = list.filter(m =>
          (m.model_key || m.name || '').toLowerCase().includes(q) ||
          (m.provider_key || '').toLowerCase().includes(q) ||
          (m.tags || []).some(t => t.toLowerCase().includes(q))
        );
      }
      if (this.pickerBilling === 'free') {
        list = list.filter(m => m.is_free);
      } else if (this.pickerBilling === 'subscription') {
        list = list.filter(m => (m.auth_strategy || m.billing_type) === 'subscription');
      } else if (this.pickerBilling === 'api_key') {
        list = list.filter(m => !m.is_free && (m.auth_strategy || m.billing_type) !== 'subscription');
      }
      return list;
    },

    openModelPicker() {
      this.pickerSearch = '';
      this.pickerBilling = '';
      this.pickerSelected = [];
      this.showModelPicker = true;
    },

    togglePickerModel(name) {
      const idx = this.pickerSelected.indexOf(name);
      if (idx >= 0) this.pickerSelected.splice(idx, 1);
      else this.pickerSelected.push(name);
    },

    addPickerModels() {
      for (const name of this.pickerSelected) {
        if (!this.tierForm.models.includes(name)) {
          this.tierForm.models.push(name);
        }
      }
      this.showModelPicker = false;
    },

    async init() {
      const [tiers, models] = await Promise.all([
        api.get('/management/tiers'),
        api.get('/management/models'),
      ]);
      this.tiers = unwrapArray(tiers);
      this.models = unwrapArray(models);
    },

    editTier(t) {
      this.editingTier = t;
      this.tierForm = {
        name: t.name,
        display_name: t.display_name || '',
        models: [...(t.models || t.model_refs || [])],
        fallback_tier_id: t.fallback_tier_id || t.fallback_model || '',
      };
      this.showTierCreate = true;
    },

    async saveTier() {
      const payload = { ...this.tierForm };
      if (!payload.fallback_tier_id) payload.fallback_tier_id = null;
      if (this.editingTier) {
        await api.patch(`/management/tiers/${this.editingTier.id}`, payload);
      } else {
        await api.post('/management/tiers', payload);
      }
      this.showTierCreate = false;
      this.editingTier = null;
      this.tiers = unwrapArray(await api.get('/management/tiers'));
    },

    async removeTier(t) {
      if (!confirm(`Delete tier "${t.name}"?`)) return;
      await api.del(`/management/tiers/${t.id}`);
      this.tiers = unwrapArray(await api.get('/management/tiers'));
    },

    async toggleTier(t) {
      const isEnabled = t.enabled ?? t.is_enabled;
      if (isEnabled) {
        await api.post(`/management/tiers/${t.id}/disable`, {});
      } else {
        await api.post(`/management/tiers/${t.id}/enable`, {});
      }
      this.tiers = unwrapArray(await api.get('/management/tiers'));
    },
  };
}

// ---- Keys Page ----
function keysPage() {
  return {
    keys: [],
    showCreate: false,
    showEdit: false,
    editing: null,
    newKey: '',
    form: { label: '', key: '', daily_budget_usd: '2' },
    editForm: { label: '', daily_budget_usd: '' },

    async init() {
      const raw = unwrapArray(await api.get('/management/keys'));
      this.keys = raw.map(k => ({ ...k, daily_spent: Number(k.daily_spent || 0) }));
    },

    budgetPct(k) {
      const budget = k.daily_budget_usd != null ? Number(k.daily_budget_usd) : (k.daily_budget != null ? Number(k.daily_budget) : null);
      if (budget == null || budget === 0) return null;
      return Math.min(100, (k.daily_spent / budget) * 100);
    },

    remaining(k) {
      const budget = k.daily_budget_usd != null ? Number(k.daily_budget_usd) : (k.daily_budget != null ? Number(k.daily_budget) : null);
      if (budget == null) return null;
      return Math.max(0, budget - k.daily_spent);
    },

    _budget(k) {
      return k.daily_budget_usd ?? k.daily_budget;
    },

    generate() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      this.form.key = 'sk-soul-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    },

    async create() {
      const payload = { ...this.form };
      if (!payload.key) delete payload.key;
      payload.daily_budget_usd = payload.daily_budget_usd === '' ? null : Number(payload.daily_budget_usd);
      const result = await api.post('/management/keys', payload);
      this.newKey = result.key || '';
      this.showCreate = false;
      this.form.key = '';
      this.form.daily_budget_usd = '';
      this.keys = unwrapArray(await api.get('/management/keys'));
    },

    edit(k) {
      this.editing = k;
      this.editForm = { label: k.label || '', daily_budget_usd: k.daily_budget_usd ?? k.daily_budget ?? '' };
      this.showEdit = true;
    },

    async saveEdit() {
      const payload = { ...this.editForm };
      payload.daily_budget_usd = payload.daily_budget_usd === '' ? null : Number(payload.daily_budget_usd);
      await api.patch(`/management/keys/${this.editing.id}`, payload);
      this.showEdit = false;
      this.editing = null;
      this.keys = unwrapArray(await api.get('/management/keys'));
    },

    async revoke(k) {
      if (!confirm('Revoke this API key?')) return;
      await api.post(`/management/keys/${k.id}/revoke`, {});
      this.keys = unwrapArray(await api.get('/management/keys'));
    },

    async resetBudget(k) {
      if (!confirm('Reset budget for this key? This starts a new billing period from now.')) return;
      await api.post(`/management/keys/${k.id}/reset-daily-budget`, {});
      this.keys = unwrapArray(await api.get('/management/keys'));
    },

    formatDate,
  };
}

// ---- Blacklist Page ----
function blacklistPage() {
  return {
    rules: [],
    showCreate: false,
    editing: null,
    form: { pattern: '', match_type: 'substring', description: '' },

    async init() {
      this.rules = unwrapArray(await api.get('/management/blacklist/rules'));
    },

    edit(r) {
      this.editing = r;
      this.form = { pattern: r.pattern, match_type: r.match_type, description: r.description || '' };
      this.showCreate = true;
    },

    async save() {
      const body = { ...this.form };
      if (this.editing) {
        await api.patch(`/management/blacklist/rules/${this.editing.id}`, body);
      } else {
        await api.post('/management/blacklist/rules', body);
      }
      this.showCreate = false;
      this.editing = null;
      this.form = { pattern: '', match_type: 'substring', description: '' };
      this.rules = unwrapArray(await api.get('/management/blacklist/rules'));
    },

    async toggleEnabled(r) {
      await api.patch(`/management/blacklist/rules/${r.id}`, { enabled: !(r.enabled ?? r.is_enabled) });
      this.rules = unwrapArray(await api.get('/management/blacklist/rules'));
    },

    async remove(r) {
      if (!confirm('Delete this blacklist rule?')) return;
      await api.del(`/management/blacklist/rules/${r.id}`);
      this.rules = unwrapArray(await api.get('/management/blacklist/rules'));
    },

    formatDate,
  };
}

// ---- Middlewares Page ----
function middlewaresPage() {
  return {
    middlewares: [],
    models: [],
    selectedMw: null,
    modelAssignments: [],
    showSettings: false,
    editingAssignment: null,
    settingsJson: '{}',
    settingsError: '',

    async init() {
      const [middlewares, models] = await Promise.all([
        api.get('/management/middlewares'),
        api.get('/management/models'),
      ]);
      this.middlewares = unwrapArray(middlewares.catalog ?? middlewares);
      this.models = unwrapArray(models);
    },

    async selectMw(mw) {
      this.selectedMw = mw;
      this.showSettings = false;
      await this.loadAssignments();
    },

    async loadAssignments() {
      if (!this.selectedMw) return;
      const modelAssignments = [];
      for (const model of this.models) {
        const modelMws = unwrapArray(await api.get(`/management/models/${model.id}/middlewares`));
        const match = modelMws.find(mm => mm.middleware_id === this.selectedMw.id);
        modelAssignments.push({
          model,
          assigned: !!match,
          enabled: match?.enabled ?? match?.is_enabled ?? false,
          sort_order: match?.sort_order ?? 100,
          settings: match?.settings || {},
          assignment_id: match?.id,
        });
      }
      this.modelAssignments = modelAssignments;
    },

    async toggleModelAssignment(a) {
      if (a.assigned) {
        await api.del(`/management/models/${a.model.id}/middlewares/${a.assignment_id}`);
      } else {
        await api.post(`/management/models/${a.model.id}/middlewares`, {
          middleware_id: this.selectedMw.id,
          enabled: true,
          sort_order: 100,
          settings: {},
        });
      }
      await this.loadAssignments();
    },

    async toggleModelEnabled(a) {
      if (!a.assignment_id) return;
      await api.patch(`/management/models/${a.model.id}/middlewares/${a.assignment_id}`, {
        enabled: !a.enabled,
      });
      await this.loadAssignments();
    },

    async updateModelSortOrder(a) {
      if (!a.assignment_id) return;
      await api.patch(`/management/models/${a.model.id}/middlewares/${a.assignment_id}`, {
        sort_order: parseInt(a.sort_order) || 100,
      });
    },

    openSettings(a) {
      this.editingAssignment = a;
      const merged = { ...(this.selectedMw.default_settings || {}), ...(a.settings || {}) };
      this.settingsJson = JSON.stringify(merged, null, 2);
      this.settingsError = '';
      this.showSettings = true;
    },

    async saveSettings() {
      try {
        const parsed = JSON.parse(this.settingsJson);
        this.settingsError = '';
        await api.patch(
          `/management/models/${this.editingAssignment.model.id}/middlewares/${this.editingAssignment.assignment_id}`,
          { settings: parsed }
        );
        this.showSettings = false;
        await this.loadAssignments();
      } catch (e) {
        this.settingsError = 'Invalid JSON: ' + e.message;
      }
    },

    async rescan() {
      await api.post('/management/middlewares/rescan');
      const middlewares = await api.get('/management/middlewares');
      this.middlewares = unwrapArray(middlewares.catalog ?? middlewares);
      if (this.selectedMw) {
        this.selectedMw = this.middlewares.find(m => m.id === this.selectedMw.id) || null;
      }
    },

    typeBadge(type) {
      const hookMode = type || '';
      if (hookMode === 'pre') return 'badge-info';
      if (hookMode === 'post') return 'badge-warning';
      return 'badge-success';
    },
  };
}
function exportPage() {
  return {
    format: 'opencode',
    formats: ['opencode', 'claude-code', 'codex'],
    models: [],
    keys: [],
    selectedModels: [],
    defaultModel: '',
    apiKey: '',
    search: '',
    tagFilter: '',
    billingFilter: '',
    freeOnly: false,
    enabledOnly: true,
    copied: false,
    gatewayUrl: '',

    async init() {
      const [models, keys] = await Promise.all([
        api.get('/management/models'),
        api.get('/management/keys'),
      ]);
      this.models = unwrapArray(models);
      this.keys = unwrapArray(keys);
      this.gatewayUrl = `${location.protocol}//${location.host}/v1`;
    },

    get allTags() {
      const tags = new Set();
      for (const m of this.models) {
        for (const t of (m.tags || [])) tags.add(t);
      }
      return [...tags].sort();
    },

    get filteredModels() {
      let list = this.models;
      if (!Array.isArray(list)) return [];
      if (this.enabledOnly) list = list.filter(m => m.enabled ?? m.is_enabled);
      if (this.freeOnly) list = list.filter(m => m.is_free);
      if (this.billingFilter) list = list.filter(m => (m.auth_strategy || m.billing_type || 'api_key') === this.billingFilter);
      if (this.tagFilter) list = list.filter(m => (m.tags || []).includes(this.tagFilter));
      const q = this.search.trim().toLowerCase();
      if (q) list = list.filter(m =>
        (m.model_key || m.name || '').toLowerCase().includes(q) ||
        (m.provider_key || '').toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.toLowerCase().includes(q))
      );
      return list;
    },

    get selectedCount() { return this.selectedModels.length; },

    isSelected(name) { return this.selectedModels.includes(name); },

    toggleModel(name) {
      const idx = this.selectedModels.indexOf(name);
      if (idx >= 0) {
        this.selectedModels.splice(idx, 1);
        if (this.defaultModel === name) this.defaultModel = this.selectedModels[0] || '';
      } else {
        this.selectedModels.push(name);
        if (!this.defaultModel) this.defaultModel = name;
      }
    },

    selectAllVisible() {
      for (const m of this.filteredModels) {
        const key = m.model_key || m.name;
        if (!this.selectedModels.includes(key)) this.selectedModels.push(key);
      }
      if (!this.defaultModel && this.selectedModels.length) this.defaultModel = this.selectedModels[0];
    },

    clearAll() {
      this.selectedModels = [];
      this.defaultModel = '';
    },

    _parseContext(cw) {
      if (!cw) return 200000;
      const s = String(cw).toLowerCase().replace(/,/g, '');
      if (s.endsWith('m') || s.endsWith('mil')) return parseFloat(s) * 1000000;
      if (s.endsWith('k')) return parseFloat(s) * 1000;
      const n = parseInt(s);
      return isNaN(n) ? 200000 : n;
    },

    _getSelectedModelObjects() {
      return this.selectedModels.map(name => this.models.find(m => (m.model_key || m.name) === name)).filter(Boolean);
    },

    get configOutput() {
      if (this.format === 'opencode') return this._genOpenCode();
      if (this.format === 'claude-code') return this._genClaudeCode();
      if (this.format === 'codex') return this._genCodex();
      return '';
    },

    get configFileName() {
      if (this.format === 'opencode') return 'opencode.json';
      if (this.format === 'claude-code') return 'settings.json';
      if (this.format === 'codex') return 'config.toml';
      return 'config.txt';
    },

    _modelName(m) {
      return m.model_key || m.name;
    },

    _genOpenCode() {
      const models = {};
      for (const m of this._getSelectedModelObjects()) {
        const key = this._modelName(m);
        models[key] = {
          name: m.display_name || key,
          limit: { context: this._parseContext(m.context_window), output: 32768 },
        };
      }
      const config = {
        '$schema': 'https://opencode.ai/config.json',
        model: this.defaultModel ? `soul-gateway/${this.defaultModel}` : '',
        provider: {
          'soul-gateway': {
            npm: '@ai-sdk/openai-compatible',
            name: 'Soul Gateway',
            options: {
              baseURL: this.gatewayUrl,
              apiKey: this.apiKey || '<your-api-key>',
              headers: { 'X-Soul-Agent': 'opencode' },
            },
            models,
          },
        },
      };
      return JSON.stringify(config, null, 2);
    },

    _genClaudeCode() {
      const selected = this._getSelectedModelObjects();
      const overrides = {};
      const sonnet = selected.find(m => (this._modelName(m)).toLowerCase().includes('sonnet'));
      const opus = selected.find(m => (this._modelName(m)).toLowerCase().includes('opus'));
      const haiku = selected.find(m => (this._modelName(m)).toLowerCase().includes('haiku'));
      if (sonnet) overrides.sonnet = this._modelName(sonnet);
      if (opus) overrides.opus = this._modelName(opus);
      if (haiku) overrides.haiku = this._modelName(haiku);
      for (const m of selected) {
        if (m !== sonnet && m !== opus && m !== haiku) {
          const shortName = (this._modelName(m)).split('/').pop();
          overrides[shortName] = this._modelName(m);
        }
      }
      const config = {
        env: {
          ANTHROPIC_BASE_URL: this.gatewayUrl,
          ANTHROPIC_AUTH_TOKEN: this.apiKey || '<your-api-key>',
        },
        modelOverrides: overrides,
      };
      return JSON.stringify(config, null, 2);
    },

    _genCodex() {
      const lines = [];
      lines.push(`model = "${this.defaultModel || '<model>'}"`);
      lines.push('model_provider = "soul-gateway"');
      lines.push('');
      lines.push('[model_providers.soul-gateway]');
      lines.push('name = "Soul Gateway"');
      lines.push(`base_url = "${this.gatewayUrl}"`);
      lines.push('env_key = "SOUL_GATEWAY_API_KEY"');
      if (this.apiKey) {
        lines.push('');
        lines.push('# Set this environment variable:');
        lines.push(`# export SOUL_GATEWAY_API_KEY="${this.apiKey}"`);
      }
      return lines.join('\n');
    },

    async copyConfig() {
      try {
        await navigator.clipboard.writeText(this.configOutput);
        this.copied = true;
        setTimeout(() => this.copied = false, 2000);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = this.configOutput;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.copied = true;
        setTimeout(() => this.copied = false, 2000);
      }
    },

    downloadConfig() {
      const blob = new Blob([this.configOutput], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.configFileName;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
