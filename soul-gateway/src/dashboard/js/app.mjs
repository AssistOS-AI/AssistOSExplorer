// ---- Model naming convention ----
const _SLUG_MAP = { axiologic_kiro: 'kiro', search_gateway: 'search' };
function _providerSlug(providerKey) {
    return _SLUG_MAP[providerKey] || providerKey;
}
function _buildModelName(providerKey, providerModel) {
    return `${_providerSlug(providerKey)}/${providerModel}`;
}
function _displayName(name) {
    if (name && typeof name === 'object') name = name.model_key || '';
    return typeof name === 'string' && name.startsWith('axl/')
        ? name.slice(4)
        : name || '';
}

function parseNumeric(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function getModelContextWindow(model) {
    return (
        model?.capabilities?.contextWindow ??
        model?.capabilities?.limits?.max_prompt_tokens ??
        null
    );
}

function formatModelContextWindow(model) {
    const contextWindow = getModelContextWindow(model);
    if (contextWindow == null || contextWindow === '') return '-';

    const numeric = Number(contextWindow);
    if (!Number.isFinite(numeric)) return String(contextWindow);
    if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
    if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(0)}k`;
    return String(Math.trunc(numeric));
}

function getModelPricingView(model) {
    const requestPriceUsd = parseNumeric(model?.request_price_usd);
    if (requestPriceUsd !== null) {
        return {
            classes: 'badge badge-info badge-xs',
            text: `$${requestPriceUsd.toFixed(3)}/req`,
        };
    }

    const inputPricePerMillion = parseNumeric(model?.input_price_per_million);
    const outputPricePerMillion = parseNumeric(model?.output_price_per_million);
    if (inputPricePerMillion !== null || outputPricePerMillion !== null) {
        return {
            classes: 'text-xs opacity-50',
            text: `$${inputPricePerMillion ?? 0}/${outputPricePerMillion ?? 0}`,
        };
    }

    if (model?.is_free === true || model?.pricing_mode === 'free') {
        return {
            classes: 'text-xs opacity-50',
            text: '$0/0',
        };
    }

    return {
        classes: 'opacity-30',
        text: '-',
    };
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
// Input object can be a provider row or a model row. `is_free`
// overrides everything else.
//
// @param {object} obj
// @param {object} [opts]
// @param {boolean} [opts.short]  Use the compact label ("sub", "api")
// @returns {{ label: string, classes: string }}
function sgAuthBadge(obj, { short = false } = {}) {
    if (!obj) return { label: short ? '?' : 'unknown', classes: 'badge-ghost' };
    if (obj.is_free) return { label: 'free', classes: 'badge-success' };
    const strategy = obj.auth_strategy || null;
    if (strategy === 'subscription') {
        return {
            label: short ? 'sub' : 'subscription',
            classes: 'badge-secondary',
        };
    }
    if (strategy === 'oauth') {
        return { label: 'oauth', classes: 'badge-warning badge-outline' };
    }
    if (strategy === 'none') {
        return {
            label: short ? 'none' : 'no auth',
            classes: 'badge-success badge-outline',
        };
    }
    // api_key or unknown → default "api key" styling
    return {
        label: short ? 'api' : 'api key',
        classes: 'badge-info badge-outline',
    };
}
// Alpine templates resolve free identifiers against the component
// scope and its ancestors; to make sgAuthBadge available everywhere
// without importing it into every component, expose it on `window`.
window.sgAuthBadge = sgAuthBadge;
window.formatModelContextWindow = formatModelContextWindow;
window.getModelPricingView = getModelPricingView;

// ---- Ploinky-routed management helpers ----
function resolveManagementBasePath() {
    const marker = '/services/soul-gateway/management';
    const pathname = window.location.pathname || '/management/';
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex >= 0) {
        return pathname.slice(0, markerIndex + marker.length);
    }
    return '/management';
}

const MANAGEMENT_BASE_PATH = resolveManagementBasePath().replace(/\/+$/, '');

function managementUrl(path) {
    const suffix = String(path || '')
        .replace(/^\/management\/?/, '')
        .replace(/^\/+/, '');
    return suffix ? `${MANAGEMENT_BASE_PATH}/${suffix}` : MANAGEMENT_BASE_PATH;
}

function redirectToPloinkyLogin() {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

// ---- Helpers ----
const api = {
    _headers() {
        return { 'Content-Type': 'application/json' };
    },
    async _handleResponse(res) {
        const redirectedToLogin =
            res.redirected &&
            new URL(res.url, window.location.origin).pathname.startsWith(
                '/auth/login'
            );
        if (res.status === 401 || res.status === 403 || redirectedToLogin) {
            window.dispatchEvent(new CustomEvent('sg-auth-required'));
            redirectToPloinkyLogin();
            throw new Error('Ploinky admin session required');
        }
        return res.json();
    },
    async get(path) {
        const res = await fetch(managementUrl(path), {
            headers: this._headers(),
            credentials: 'include',
        });
        return this._handleResponse(res);
    },
    async post(path, body) {
        const res = await fetch(managementUrl(path), {
            method: 'POST',
            headers: this._headers(),
            credentials: 'include',
            body: JSON.stringify(body),
        });
        return this._handleResponse(res);
    },
    async patch(path, body) {
        const res = await fetch(managementUrl(path), {
            method: 'PATCH',
            headers: this._headers(),
            credentials: 'include',
            body: JSON.stringify(body),
        });
        return this._handleResponse(res);
    },
    async del(path) {
        const res = await fetch(managementUrl(path), {
            method: 'DELETE',
            headers: this._headers(),
            credentials: 'include',
        });
        return this._handleResponse(res);
    },
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
    return data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : fallback;
}

function toLogSortColumn(sortCol) {
    if (sortCol === 'total_cost') return 'total_cost_usd';
    return sortCol;
}

function stringifyLogResponseContent(log) {
    if (typeof log?.response_content === 'string' && log.response_content) {
        return log.response_content;
    }
    if (typeof log?.response_excerpt === 'string' && log.response_excerpt) {
        return log.response_excerpt;
    }
    if (typeof log?.response_payload === 'string' && log.response_payload) {
        return log.response_payload;
    }
    if (log?.response_payload != null) {
        try {
            return JSON.stringify(log.response_payload, null, 2);
        } catch {
            return String(log.response_payload);
        }
    }
    return '';
}

function stringifyLogRequestContent(log, requestPayload) {
    if (typeof log?.request_content === 'string' && log.request_content) {
        return log.request_content;
    }
    if (typeof log?.request_payload === 'string' && log.request_payload) {
        return log.request_payload;
    }
    if (requestPayload && Object.keys(requestPayload).length > 0) {
        try {
            return JSON.stringify(requestPayload, null, 2);
        } catch {
            return String(requestPayload);
        }
    }
    if (Array.isArray(log?.request_messages)) {
        try {
            return JSON.stringify(log.request_messages, null, 2);
        } catch {
            return String(log.request_messages);
        }
    }
    return '';
}

function normalizeAuditRequestMessages(requestPayload, requestMessages) {
    if (Array.isArray(requestMessages)) {
        return requestMessages;
    }

    if (!requestPayload || typeof requestPayload !== 'object') {
        return [];
    }

    if (Array.isArray(requestPayload.messages)) {
        return requestPayload.messages;
    }

    const normalized = [];

    appendRequestMessage(normalized, 'system', requestPayload.instructions);
    appendRequestMessage(normalized, 'system', requestPayload.system);
    appendRequestMessage(normalized, 'user', requestPayload.prompt);

    if (typeof requestPayload.input === 'string') {
        appendRequestMessage(normalized, 'user', requestPayload.input);
    } else if (Array.isArray(requestPayload.input)) {
        for (const item of requestPayload.input) {
            appendRequestInputItem(normalized, item);
        }
    }

    return normalized;
}

function appendRequestInputItem(target, item) {
    if (typeof item === 'string') {
        appendRequestMessage(target, 'user', item);
        return;
    }

    if (!item || typeof item !== 'object') {
        appendRequestMessage(target, 'user', item);
        return;
    }

    if (item.type === 'message') {
        appendRequestMessage(
            target,
            item.role || 'user',
            normalizeRequestMessageContent(item.content)
        );
        return;
    }

    if (item.type === 'item_reference') {
        appendRequestMessage(target, 'user', item.text || item.id || item);
        return;
    }

    appendRequestMessage(
        target,
        item.role || 'user',
        normalizeRequestMessageContent(item.content ?? item.text ?? item)
    );
}

function appendRequestMessage(target, role, content) {
    if (content == null) {
        return;
    }

    if (typeof content === 'string' && content.length === 0) {
        return;
    }

    target.push({ role, content });
}

function normalizeRequestMessageContent(content) {
    if (typeof content === 'string' || content == null) {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((part) => normalizeRequestContentPart(part));
    }

    return content;
}

function normalizeRequestContentPart(part) {
    if (typeof part === 'string' || part == null) {
        return part;
    }

    if (typeof part !== 'object') {
        return String(part);
    }

    switch (part.type) {
        case 'input_text':
            return { type: 'text', text: part.text || '' };
        case 'input_image':
            return {
                type: 'image_url',
                image_url: {
                    url: part.image_url || part.url || '',
                    ...(part.detail ? { detail: part.detail } : {}),
                },
            };
        default:
            return part;
    }
}

function normalizeAuditLog(log) {
    if (!log || typeof log !== 'object') return null;

    const requestPayload =
        log.request_payload && typeof log.request_payload === 'object'
            ? log.request_payload
            : {};
    const metadata =
        log.metadata && typeof log.metadata === 'object' ? log.metadata : {};
    const responsePayload =
        log.response_payload && typeof log.response_payload === 'object'
            ? log.response_payload
            : null;
    const requestMessages = normalizeAuditRequestMessages(
        requestPayload,
        log.request_messages
    );
    const finishReason =
        metadata.finishReason ??
        responsePayload?.choices?.[0]?.finish_reason ??
        responsePayload?.stop_reason ??
        null;
    const actualModel =
        log.model ??
        log.resolved_model ??
        metadata.sourceResolvedModel ??
        null;

    return {
        ...log,
        id: log.id || log.log_id || log.request_id,
        tier: log.tier ?? log.requested_model ?? null,
        model: actualModel,
        resolved_model: actualModel,
        total_cost:
            log.total_cost ??
            log.total_cost_usd ??
            metadata.totalCostUsd ??
            0,
        status_code:
            log.status_code ??
            log.http_status ??
            (log.status === 'success' ? 200 : null),
        prompt_tokens: log.prompt_tokens ?? log.input_tokens ?? 0,
        completion_tokens: log.completion_tokens ?? log.output_tokens ?? 0,
        retry_count:
            log.retry_count ??
            Math.max(0, Number(log.attempt_count || 0) - 1),
        request_messages: requestMessages,
        request_content: stringifyLogRequestContent(log, requestPayload),
        response_content: stringifyLogResponseContent(log),
        stop_reason: log.stop_reason ?? finishReason,
    };
}

function normalizeAuditLogs(payload) {
    return unwrapArray(payload)
        .map((log) => normalizeAuditLog(log))
        .filter(Boolean);
}

function normalizeAuditLogDetail(payload) {
    const raw =
        payload &&
        typeof payload === 'object' &&
        payload.log &&
        typeof payload.log === 'object'
            ? payload.log
            : payload;
    return normalizeAuditLog(raw);
}

function normalizeLogKeySummaries(payload) {
    return unwrapArray(payload).map((entry) => ({
        ...entry,
        list_id: entry?.api_key_id || '__unknown__',
        key_label:
            entry?.key_label || entry?.label || entry?.key_hint || 'Unknown key',
        key_hint: entry?.key_hint || '',
        request_count: Number(entry?.request_count || 0),
        error_count: Number(entry?.error_count || 0),
        total_cost: Number(entry?.total_cost || 0),
    }));
}

function compareLogKeySummaries(left, right) {
    const leftLastActivity = left?.last_activity
        ? new Date(left.last_activity).getTime()
        : Number.NEGATIVE_INFINITY;
    const rightLastActivity = right?.last_activity
        ? new Date(right.last_activity).getTime()
        : Number.NEGATIVE_INFINITY;
    if (leftLastActivity !== rightLastActivity) {
        return rightLastActivity - leftLastActivity;
    }

    const requestCountDiff =
        Number(right?.request_count || 0) - Number(left?.request_count || 0);
    if (requestCountDiff !== 0) {
        return requestCountDiff;
    }

    return String(left?.key_label || '').localeCompare(
        String(right?.key_label || '')
    );
}

function sortLogKeySummaries(list) {
    return [...list].sort(compareLogKeySummaries);
}

function normalizeProviderMiddlewareBindings(payload) {
    const data = unwrapData(payload);
    const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.bindings)
          ? data.bindings
          : [];
    return [...list].sort(
        (left, right) => (left?.sortOrder ?? 0) - (right?.sortOrder ?? 0)
    );
}

function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}
function formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

function formatMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => {
        const raw =
            typeof m.content === 'string'
                ? m.content
                : m.content == null
                  ? ''
                  : JSON.stringify(m.content, null, 2);
        return {
            role: m.role || 'unknown',
            raw,
            html: renderMarkdown(raw),
            isLong: raw.length > 300,
            _expanded: false,
        };
    });
}

function renderContent(text) {
    if (!text) return '';
    // If it's valid JSON, pretty-print in a code block
    try {
        const parsed = JSON.parse(text);
        const pretty = JSON.stringify(parsed, null, 2);
        return `<pre class="sg-md-code"><code>${pretty.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    } catch {}
    return renderMarkdown(text);
}

const CHART_COLORS = [
    '#36a2eb',
    '#ff6384',
    '#ffce56',
    '#4bc0c0',
    '#9966ff',
    '#ff9f40',
    '#c9cbcf',
    '#7bc8a4',
];

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
        authenticated: true,
        _authRequiredHandler: null,
        _wsReconnectTimer: null,

        init() {
            if (!this._authRequiredHandler) {
                this._authRequiredHandler = () => {
                    this.authenticated = false;
                };
                window.addEventListener('sg-auth-required', this._authRequiredHandler);
            }

            // Read page from URL hash
            const hash = window.location.hash.slice(1);
            const validPages = this.pages.map((p) => p.id);
            if (hash && validPages.includes(hash)) this.page = hash;

            this.connectWs();
        },

        navigate(p) {
            this.page = p;
            window.location.hash = p;
            // Notify per-tab Alpine components so they can re-fetch their
            // data. Every data-tab wrapper (providers / models /
            // keys / blacklist / middlewares) binds
            // @page-change.window="..." to its own init() — without this
            // dispatch the tab stays stuck on whatever state it had on
            // first mount and a user has to hard-refresh the browser to
            // see mutations made from another tab (e.g. a provider created
            // in the Providers tab that auto-provisioned models).
            window.dispatchEvent(new CustomEvent('page-change', { detail: p }));
        },

        _handleLogMessage(raw) {
            try {
                const msg = JSON.parse(raw);
                if (msg.type === 'log') {
                    window.dispatchEvent(
                        new CustomEvent('soul-log', { detail: msg.data })
                    );
                }
            } catch {}
        },

        connectWs() {
            if (this.ws || this.sse || this._wsReconnectTimer) {
                return;
            }
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${proto}//${location.host}${managementUrl('/management/ws/logs')}`;
            const ws = new WebSocket(wsUrl);
            let opened = false;
            let fellBack = false;
            const openTimer = setTimeout(() => {
                if (!opened && !fellBack) {
                    fellBack = true;
                    try {
                        ws.close();
                    } catch {}
                    this.connectSse();
                }
            }, 4000);
            ws.onopen = () => {
                opened = true;
                clearTimeout(openTimer);
                if (fellBack) {
                    try {
                        ws.close();
                    } catch {}
                    return;
                }
                this.wsConnected = true;
                this.streamMode = 'ws';
            };
            ws.onclose = () => {
                clearTimeout(openTimer);
                this.ws = null;
                if (fellBack) return;
                if (!opened) {
                    // WebSocket never connected -- fall back to SSE
                    fellBack = true;
                    this.connectSse();
                    return;
                }
                this.wsConnected = false;
                this.streamMode = '';
                if (!this._wsReconnectTimer) {
                    this._wsReconnectTimer = setTimeout(() => {
                        this._wsReconnectTimer = null;
                        this.connectWs();
                    }, 3000);
                }
            };
            ws.onmessage = (e) => this._handleLogMessage(e.data);
            this.ws = ws;
        },

        connectSse() {
            if (this.sse) {
                this.sse.close();
                this.sse = null;
            }
            const sseUrl = managementUrl('/management/logs/stream/sse');
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
const PROVIDER_TREE_EXPANDED_STORAGE_KEY =
    'soulGateway.providers.tree.expanded';

function providersPage() {
    return {
        providers: [],
        templates: {},
        providerFilter: '',
        providerTreeExpanded: new Set([
            'AchillesCLI',
            'AchillesIDE',
            'proxies',
            'basic',
            'webmeetInfra',
            'UmamiAgent',
        ]),
        showProviderCreate: false,
        showEdit: false,
        editing: null,
        testing: null,
        testResult: null,
        syncing: null,
        syncResult: null,
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

        form: {
            template: 'custom',
            providerKey: '',
            displayName: '',
            adapterKey: 'openai',
            baseUrl: '',
            apiKey: '',
            authStrategy: 'api_key',
            oauthAdapterKey: '',
            providerMode: 'external_api',
            kind: 'external_api',
        },
        editForm: {
            displayName: '',
            adapterKey: '',
            baseUrl: '',
            apiKey: '',
            authStrategy: 'api_key',
            enabled: true,
        },

        // Pipeline composer state
        showComposer: false,
        composerProvider: null,
        composerBackendKey: '',
        composerPipeline: [],
        availableBackends: [],
        availableProviderMiddlewares: [],
        // Per-binding settings editor
        bindingSettingsOpen: false,
        bindingSettingsIndex: -1,
        bindingSettingsJson: '',
        bindingSettingsError: '',

        get treeView() {
            return window.SoulGatewayTreeView;
        },

        get filteredProviders() {
            return this.treeView.filterProvidersForTree(
                this.providers,
                this.providerFilter
            );
        },

        get providerTreeRows() {
            return this.treeView.buildProviderTreeRows(this.filteredProviders, {
                expanded: this.providerTreeExpanded,
            });
        },

        providerTreeRowKey(row) {
            if (row?.rowType === 'group') {
                return `group:${row.path || row.key || ''}`;
            }
            return `provider:${row?.item?.provider_key || row?.key || ''}`;
        },

        providerEmptyMessage() {
            const hasFilter = String(this.providerFilter || '').trim().length > 0;
            if (this.providers.length > 0 && hasFilter) {
                return 'No providers match filter';
            }
            return 'No providers configured. Click "Add Provider" to get started.';
        },

        /** Derive OAuth adapter options from loaded templates — no hardcoded list. */
        get oauthAdapterOptions() {
            const options = [];
            const seen = new Set();
            if (this.templates && typeof this.templates === 'object') {
                for (const [key, tpl] of Object.entries(this.templates)) {
                    const adapterKey =
                        tpl.oauth_adapter_key || tpl.oauthAdapterKey;
                    if (adapterKey && !seen.has(adapterKey)) {
                        seen.add(adapterKey);
                        options.push({
                            key: adapterKey,
                            label:
                                tpl.display_name ||
                                tpl.displayName ||
                                adapterKey,
                        });
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
                        options.push({
                            key: adapterKey,
                            label:
                                tpl.display_name ||
                                tpl.displayName ||
                                adapterKey,
                        });
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
            this.providerTreeExpanded = this.treeView.loadExpandedSet(
                window.localStorage,
                PROVIDER_TREE_EXPANDED_STORAGE_KEY,
                Array.from(this.providerTreeExpanded)
            );
        },

        providerDisplayKey(provider) {
            return this.treeView.providerDisplayKey(provider);
        },

        providerDisplayName(provider) {
            return this.treeView.providerDisplayName(provider) || '-';
        },

        providerIndentStyle(row) {
            const depth = Number.isFinite(row?.depth) ? row.depth : 0;
            return `padding-left: ${0.75 + depth * 1.25}rem`;
        },

        providerGroupSummary(row) {
            return `${row.enabledCount}/${row.count} enabled`;
        },

        toggleProviderGroup(row) {
            if (!row?.path) return;
            this.providerTreeExpanded = this.treeView.toggleExpandedPath(
                this.providerTreeExpanded,
                row.path
            );
            this.treeView.saveExpandedSet(
                window.localStorage,
                PROVIDER_TREE_EXPANDED_STORAGE_KEY,
                this.providerTreeExpanded
            );
        },

        formatTestDetail(result) {
            if (typeof result?.detail === 'string') return result.detail;
            if (result?.detail == null) {
                return result?.ok ? 'Connected' : 'Connection failed';
            }
            return JSON.stringify(result.detail);
        },

        formatSyncDetail(result) {
            if (!result) return '';
            const providerName =
                result.providerName ||
                result.providerKey ||
                result.providerId ||
                'Provider';
            const counts = [
                ['discovered', 'discovered'],
                ['created', 'created'],
                ['updated', 'updated'],
                ['disabled', 'disabled'],
                ['synced', 'synced'],
            ]
                .filter(([key]) => result[key] != null)
                .map(([key, label]) => `${label}: ${result[key]}`);
            return `${providerName} sync complete: ${
                counts.length ? counts.join(', ') : 'no count details returned'
            }`;
        },

        onTemplateChange() {
            const t = this.templates[this.form.template];
            if (!t) return;

            // Set scalar fields immediately
            this.form.displayName = t.display_name || '';
            this.form.baseUrl = t.base_url || '';
            this.form.authStrategy = t.auth_strategy || 'api_key';
            this.form.kind = t.kind || 'external_api';
            if (this.form.template !== 'custom') {
                this.form.providerKey = this.form.template;
            }

            // Defer dropdown-bound fields to next tick so x-for options render first
            const adapterKey = t.adapter_key || t.protocol || 'openai';
            const oauthKey = t.oauth_adapter_key || '';
            this.$nextTick(() => {
                this.form.adapterKey = adapterKey;
                this.form.oauthAdapterKey = oauthKey;
            });
        },

        openCreate() {
            this.form = {
                template: 'custom',
                providerKey: '',
                displayName: '',
                adapterKey: 'openai',
                baseUrl: '',
                apiKey: '',
                authStrategy: 'api_key',
                oauthAdapterKey: '',
                providerMode: 'external_api',
                kind: 'external_api',
            };
            this.showProviderCreate = true;
        },

        async create() {
            const payload = { ...this.form };
            delete payload.template;
            if (!payload.oauthAdapterKey) delete payload.oauthAdapterKey;
            const isCustomPipeline = payload.providerMode === 'custom';
            payload.kind = isCustomPipeline
                ? 'custom'
                : (payload.kind || 'external_api');
            if (!payload.providerKey) {
                alert('Provider key is required');
                return;
            }
            if (!isCustomPipeline && payload.authStrategy !== 'none' && !payload.baseUrl) {
                alert('Base URL is required for External API providers');
                return;
            }
            if (!isCustomPipeline && payload.authStrategy !== 'oauth' && payload.authStrategy !== 'none' && !payload.apiKey) {
                alert('API Key is required for non-OAuth providers');
                return;
            }
            const result = await api.post('/management/providers', payload);
            if (result.error) {
                alert(result.error.message || result.error);
                return;
            }
            this.showProviderCreate = false;
            this.providers = unwrapArray(
                await api.get('/management/providers')
            );
        },

        edit(p) {
            this.editing = p;
            this.editForm = {
                displayName: p.display_name || '',
                adapterKey: p.adapter_key || 'openai',
                baseUrl: p.base_url || '',
                apiKey: '',
                authStrategy: p.auth_strategy || 'api_key',
                enabled: p.enabled ?? true,
            };
            this.showEdit = true;
        },

        async saveEdit() {
            const payload = { ...this.editForm };
            if (!payload.apiKey) delete payload.apiKey;
            await api.patch(
                `/management/providers/${this.editing.id}`,
                payload
            );
            this.showEdit = false;
            this.editing = null;
            this.providers = unwrapArray(
                await api.get('/management/providers')
            );
        },

        async remove(p) {
            if (
                !confirm(
                    `Delete provider "${p.provider_key}"? Auto-discovered models for this provider will be removed.`
                )
            )
                return;
            const result = await api.del(`/management/providers/${p.id}`);
            if (result.error) {
                alert(result.error.message || result.error);
                return;
            }
            this.providers = unwrapArray(
                await api.get('/management/providers')
            );
        },

        async testConnection(p) {
            this.testing = p.id;
            this.testResult = null;
            try {
                this.testResult = await api.post(
                    `/management/providers/${p.id}/test`,
                    {}
                );
            } catch (e) {
                this.testResult = { ok: false, detail: e.message };
            }
            this.testing = null;
        },

        async syncModels(p) {
            this.syncing = p.id;
            this.syncResult = null;
            try {
                const result = await api.post(
                    `/management/providers/${p.id}/sync-models`,
                    {}
                );
                if (result.error) {
                    alert(result.error.message || result.error);
                    return;
                }
                this.providers = unwrapArray(
                    await api.get('/management/providers')
                );
                window.dispatchEvent(
                    new CustomEvent('provider-models-synced', {
                        detail: {
                            providerId: p.id,
                            providerKey: p.provider_key,
                        },
                    })
                );
                this.syncResult = {
                    ...result,
                    providerId: p.id,
                    providerKey: p.provider_key,
                    providerName:
                        p.display_name || p.provider_key || String(p.id),
                };
            } catch (e) {
                alert(e.message || 'Failed to sync provider models');
            } finally {
                this.syncing = null;
            }
        },

        async discoverModels(p) {
            this.discoverProvider = p;
            this.discoveredModels = null; // null = loading, [] = loaded empty
            this.showDiscover = true;
            try {
                this.discoveredModels = unwrapArray(
                    await api.post(
                        `/management/providers/${p.id}/discover-models`,
                        {}
                    )
                );
            } catch (e) {
                this.discoveredModels = [];
                alert(e.message || 'Failed to discover models');
            }
        },

        async addDiscoveredModel(model) {
            if (!this.discoverProvider) return;
            const slug = _providerSlug(this.discoverProvider.provider_key);
            const providerModelId = model.modelId;
            if (!providerModelId) return;
            await api.post('/management/models', {
                modelKey: `${slug}/${providerModelId}`,
                displayName: model.displayName || providerModelId,
                providerId: this.discoverProvider.id,
                providerModelId,
                pricingMode:
                    model.pricing?.mode ||
                    (model.pricing ? 'token' : 'external_directory'),
                inputPricePerMillion:
                    model.pricing?.inputPricePerMillion ?? null,
                outputPricePerMillion:
                    model.pricing?.outputPricePerMillion ?? null,
                requestPriceUsd: model.pricing?.requestPriceUsd ?? null,
            });
            model._added = true;
        },

        async viewAuth(p) {
            this.authProvider = p;
            this.showAuthModal = true;
            await this.refreshAuthStatus(p);
        },

        async refreshAuthStatus(p) {
            this.authStatus = await api.get(
                `/management/providers/${p.id}/accounts`
            );
        },

        async addAccount() {
            this.authFlow = await api.post(
                `/management/providers/${this.authProvider.id}/auth/start`,
                {}
            );
            if (this.authFlow.type === 'device-flow') {
                this.authPolling = true;
                this.pollDeviceFlow();
            } else if (this.authFlow.type === 'pkce') {
                window.open(
                    this.authFlow.authUrl,
                    '_blank',
                    'width=600,height=700'
                );
                this.authPolling = true;
                this.pollPKCEFlow();
            }
        },

        async pollDeviceFlow() {
            const flowId =
                this.authFlow?.flowId || this.authFlow?.flow_id || '';
            while (this.authPolling) {
                await new Promise((r) => setTimeout(r, 5000));
                try {
                    const result = await api.get(
                        `/management/providers/${this.authProvider.id}/auth/pending/${flowId}`
                    );
                    if (result.status === 'complete') {
                        this.authPolling = false;
                        this.authFlow = null;
                        await this.refreshAuthStatus(this.authProvider);
                        break;
                    }
                    if (result.status === 'error') {
                        this.authPolling = false;
                        this.authFlow = {
                            ...this.authFlow,
                            error: result.error,
                        };
                        break;
                    }
                } catch {
                    break;
                }
            }
        },

        async pollPKCEFlow() {
            const flowId =
                this.authFlow?.flowId || this.authFlow?.flow_id || '';
            let attempts = 0;
            while (this.authPolling && attempts < 60) {
                await new Promise((r) => setTimeout(r, 3000));
                attempts++;
                const status = await api.get(
                    `/management/providers/${this.authProvider.id}/accounts`
                );
                if (
                    status.accounts?.length >
                    (this.authStatus?.accounts?.length || 0)
                ) {
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
            await api.del(
                `/management/providers/${this.authProvider.id}/accounts/${accountId}`
            );
            await this.refreshAuthStatus(this.authProvider);
        },

        async resetAuthQuota(account) {
            const accountId = account?.id ?? account?.index;
            if (accountId == null) return;
            await api.post(
                `/management/providers/${this.authProvider.id}/accounts/${accountId}/reset-quota`,
                {}
            );
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
                    this.authFlow = {
                        ...this.authFlow,
                        error: 'URL must contain code and state parameters',
                    };
                    return;
                }
                const result = await api.get(
                    `/management/providers/${this.authProvider.id}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
                );
                if (result.status === 'complete') {
                    this.authPolling = false;
                    this.authFlow = null;
                    this.callbackUrl = '';
                    await this.refreshAuthStatus(this.authProvider);
                } else {
                    this.authFlow = {
                        ...this.authFlow,
                        error: result.error || 'Callback failed',
                    };
                }
            } catch (e) {
                this.authFlow = {
                    ...this.authFlow,
                    error: e.message || 'Failed to process callback URL',
                };
            }
        },

        // ---- Pipeline Composer methods ----

        async openComposer(provider) {
            this.composerProvider = provider;
            this.composerBackendKey = provider.adapter_key || '';
            this.composerPipeline = [];

            // Fetch backends, available middlewares, and current bindings in parallel
            const [backendsRes, middlewaresRes, bindingsRes] =
                await Promise.all([
                    api.get('/management/backends'),
                    api.get('/management/provider-middlewares'),
                    api.get(`/management/providers/${provider.id}/middlewares`),
                ]);

            this.availableBackends = Array.isArray(backendsRes?.backends)
                ? backendsRes.backends
                : unwrapArray(backendsRes);
            this.availableProviderMiddlewares = Array.isArray(
                middlewaresRes?.middlewares
            )
                ? middlewaresRes.middlewares
                : unwrapArray(middlewaresRes);
            this.composerPipeline = normalizeProviderMiddlewareBindings(
                bindingsRes
            );

            this.showComposer = true;
        },

        async saveComposer() {
            if (!this.composerProvider) return;
            const pid = this.composerProvider.id;

            // 1. Update provider backend selection (adapter_key)
            await api.patch(`/management/providers/${pid}`, {
                adapterKey: this.composerBackendKey || null,
            });

            // 2. Sync provider middleware bindings: delete removed, upsert kept
            const currentRes = await api.get(
                `/management/providers/${pid}/middlewares`
            );
            const current = normalizeProviderMiddlewareBindings(currentRes);

            for (const old of current) {
                const stillPresent = this.composerPipeline.some(
                    (binding) => binding.id === old.id
                );
                if (!stillPresent) {
                    await api.del(
                        `/management/providers/${pid}/middlewares/${old.id}`
                    );
                }
            }

            for (let i = 0; i < this.composerPipeline.length; i++) {
                const binding = this.composerPipeline[i];
                if (binding.id) {
                    await api.patch(
                        `/management/providers/${pid}/middlewares/${binding.id}`,
                        {
                            sortOrder: i + 1,
                            settings: binding.settings || {},
                        }
                    );
                } else {
                    await api.post(
                        `/management/providers/${pid}/middlewares`,
                        {
                            middlewareKey: binding.middlewareKey,
                            sortOrder: i + 1,
                            enabled: true,
                            settings: binding.settings || {},
                        }
                    );
                }
            }

            this.showComposer = false;
            this.composerProvider = null;
            this.providers = unwrapArray(
                await api.get('/management/providers')
            );
        },

        addMiddleware(middlewareKey) {
            if (!middlewareKey) return;
            const meta = this.availableProviderMiddlewares.find(
                (m) => m.key === middlewareKey
            );
            this.composerPipeline.push({
                middlewareKey,
                settings: meta?.defaultSettings
                    ? { ...meta.defaultSettings }
                    : {},
            });
        },

        removeMiddleware(index) {
            this.composerPipeline.splice(index, 1);
        },

        moveMiddlewareUp(index) {
            if (index <= 0) return;
            const arr = this.composerPipeline;
            [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
        },

        moveMiddlewareDown(index) {
            const arr = this.composerPipeline;
            if (index >= arr.length - 1) return;
            [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
        },

        openBindingSettings(index) {
            const binding = this.composerPipeline[index];
            this.bindingSettingsIndex = index;
            this.bindingSettingsJson = JSON.stringify(
                binding.settings || {},
                null,
                2
            );
            this.bindingSettingsError = '';
            this.bindingSettingsOpen = true;
        },

        saveBindingSettings() {
            try {
                const parsed = JSON.parse(this.bindingSettingsJson);
                this.composerPipeline[this.bindingSettingsIndex].settings =
                    parsed;
                this.bindingSettingsOpen = false;
            } catch (e) {
                this.bindingSettingsError = 'Invalid JSON: ' + e.message;
            }
        },

        formatDate,
    };
}

// ---- Time range helper ----
function timeRangeToParams(range, customFrom, customTo) {
    const now = new Date();
    if (range === 'day')
        return { from: new Date(now - 86400000).toISOString() };
    if (range === 'week')
        return { from: new Date(now - 7 * 86400000).toISOString() };
    if (range === 'month')
        return { from: new Date(now - 30 * 86400000).toISOString() };
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
        logsLoading: false,
        logsTotal: 0,
        logsOffset: 0,
        logsLimit: 50,
        expandedDetail: null,
        sortCol: 'started_at',
        sortDir: 'desc',
        // Filters (clickable cell values)
        filters: {}, // { agent_name: 'claude-code', cache_hit: true, session_id: 'abc...' }
        keyword: '',
        // Time filtering
        timeRange: 'day',
        customFrom: '',
        customTo: '',
        // Column widths (resizable)
        colWidths: {
            time: 144,
            tier: 80,
            model: 168,
            agent: 96,
            session: 80,
            latency: 80,
            tokens: 80,
            cost: 80,
            cache: 56,
            status: 64,
        },
        _resizing: null,
        _logsLoadSeq: 0,
        _liveLogHandler: null,
        _seenLiveLogIds: new Set(),

        async init() {
            await this.loadKeys();
            if (this.keys.length > 0) {
                await this.selectKey(this.keys[0], { force: true });
            } else {
                await this.loadLogs();
            }

            if (!this._liveLogHandler) {
                this._liveLogHandler = (e) => this.handleLiveLog(e.detail);
                window.addEventListener('soul-log', this._liveLogHandler);
            }
        },

        handleLiveLog(rawLog) {
            const log = normalizeAuditLog(rawLog);
            if (!log || !log.id) {
                return;
            }

            const alreadyVisible = this.selectedLogs.some(
                (entry) => entry.id === log.id
            );
            if (this._seenLiveLogIds.has(log.id) || alreadyVisible) {
                this._seenLiveLogIds.add(log.id);
                return;
            }
            this._seenLiveLogIds.add(log.id);

            const keyId = log.api_key_id || '__unknown__';
            let summary = this.keys.find((entry) => entry.list_id === keyId);
            if (!summary) {
                summary = normalizeLogKeySummaries([
                    {
                        api_key_id: keyId === '__unknown__' ? null : keyId,
                        key_label:
                            log.key_label ||
                            log.label ||
                            log.key_hint ||
                            (keyId === '__unknown__' ? 'Unknown key' : 'Missing key'),
                        key_hint: log.key_hint || '',
                        request_count: 0,
                        error_count: 0,
                        total_cost: 0,
                    },
                ])[0];
                this.keys = [...this.keys, summary];
            }
            if (!this.selectedKey) {
                this.selectedKey = summary;
                this.selectedLogs = [];
                this.logsTotal = 0;
                this.logsOffset = 0;
            }
            if (summary) {
                summary.request_count += 1;
                summary.last_activity = log.started_at || new Date().toISOString();
                if (log.status && log.status !== 'succeeded') {
                    summary.error_count += 1;
                }
                summary.total_cost += Number(log.total_cost || 0);
                this.keys = sortLogKeySummaries(this.keys);
            }
            if (!this.selectedKey || this.selectedKey.list_id !== keyId) {
                return;
            }
            this.selectedLogs.unshift(log);
            if (this.selectedLogs.length > this.logsLimit) this.selectedLogs.pop();
            this.logsTotal++;
        },

        async loadKeys() {
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
            const params = new URLSearchParams(tp);
            const previousKeyId = this.selectedKey?.list_id || null;
            this.keys = sortLogKeySummaries(
                normalizeLogKeySummaries(
                await api.get(`/management/logs/keys?${params}`)
                )
            );
            this.selectedKey =
                this.keys.find((key) => key.list_id === previousKeyId) ||
                this.keys[0] ||
                null;
        },

        async onTimeChange() {
            await this.loadKeys();
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
                else if (key === 'session_id')
                    label = `Session: ${String(value).slice(0, 8)}`;
                else if (key === 'cache_hit')
                    label = `Cache: ${value ? 'HIT' : 'MISS'}`;
                else label = `${key}: ${value}`;
                return { key, label };
            });
        },

        async selectKey(key, { force = false } = {}) {
            if (!key) {
                return;
            }
            if (!force && this.selectedKey?.list_id === key.list_id) {
                return;
            }
            this.selectedKey = key;
            this.logsOffset = 0;
            this.expandedDetail = null;
            this.filters = {};
            this.keyword = '';
            this.sortCol = 'started_at';
            this.sortDir = 'desc';
            this.selectedLogs = [];
            this.logsTotal = Number(key.request_count || 0);
            await this.loadLogs();
        },

        async loadLogs() {
            this.expandedDetail = null;
            const loadSeq = ++this._logsLoadSeq;
            const selectedKeyId = this.selectedKey?.list_id || null;
            this.logsLoading = true;
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
            const p = {
                limit: this.logsLimit,
                offset: this.logsOffset,
                sort: toLogSortColumn(this.sortCol),
                order: this.sortDir,
                ...tp,
            };
            if (this.selectedKey?.api_key_id) p.api_key_id = this.selectedKey.api_key_id;
            if (this.keyword) p.keyword = this.keyword;
            // Apply cell filters
            if (this.filters.agent_name) p.agent_name = this.filters.agent_name;
            if (this.filters.session_id) p.session_id = this.filters.session_id;
            // cache_hit filter needs backend support -- filter client-side for now
            const params = new URLSearchParams(p);
            try {
                const result = await api.get(`/management/logs?${params}`);
                if (
                    loadSeq !== this._logsLoadSeq ||
                    selectedKeyId !== (this.selectedKey?.list_id || null)
                ) {
                    return;
                }
                let rows = normalizeAuditLogs(result);
                // Client-side cache filter
                if (this.filters.cache_hit !== undefined) {
                    rows = rows.filter(
                        (r) => !!r.cache_hit === this.filters.cache_hit
                    );
                }
                this.selectedLogs = rows;
                for (const row of rows) {
                    if (row.id) {
                        this._seenLiveLogIds.add(row.id);
                    }
                }
                this.logsTotal = result.total || 0;
            } finally {
                if (loadSeq === this._logsLoadSeq) {
                    this.logsLoading = false;
                }
            }
        },

        async toggleDetail(log) {
            if (this.expandedDetail === log.id) {
                this.expandedDetail = null;
                return;
            }
            if (!log._detail) {
                log._detail = normalizeAuditLogDetail(
                    await api.get(
                        `/management/logs/${encodeURIComponent(log.request_id || log.id)}`
                    )
                );
            }
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

        cw(col) {
            return this.colWidths[col] + 'px';
        },

        formatTime,
        formatDate,
        formatMessages,
        renderContent,
        formatCost(v) {
            return v ? '$' + Number(v).toFixed(4) : '-';
        },
        formatTokens(v) {
            return v ? Number(v).toLocaleString() : '-';
        },
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
            this.availableKeys = unwrapArray(await api.get('/management/keys'));
            await this.load();
        },

        async load() {
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
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

        onTimeChange() {
            this.load();
        },
        onFilterChange() {
            this.load();
        },

        get modelRequestRows() {
            const byModel = new Map();
            for (const r of this._modelRequests) {
                const m = r.resolved_model;
                if (!byModel.has(m))
                    byModel.set(m, {
                        model: m,
                        total: 0,
                        cached: 0,
                        nonCached: 0,
                        keys: [],
                    });
                const entry = byModel.get(m);
                const t = Number(r.total || 0);
                const c = Number(r.cached || 0);
                const nc = Number(r.non_cached || 0);
                entry.total += t;
                entry.cached += c;
                entry.nonCached += nc;
                entry.keys.push({
                    api_key_id: r.api_key_id,
                    key_label: r.key_label,
                    key_hint: r.key_hint,
                    total: t,
                    cached: c,
                    nonCached: nc,
                });
            }
            return [...byModel.values()].sort(
                (a, b) => b.nonCached - a.nonCached
            );
        },

        renderChart() {
            const canvas = this.$refs.usageChart;
            if (!canvas || canvas.clientWidth === 0) return;

            if (this._chart) {
                this._chart.destroy();
                this._chart = null;
            }

            const data = this._dailyData;
            if (data.length === 0) return;

            const models = [
                ...new Set(data.map((r) => r.resolved_model)),
            ].filter(Boolean);

            // Build unique sorted day labels from the data
            const daySet = new Set();
            const dataMap = new Map();
            for (const r of data) {
                const pd = new Date(r.period);
                const dayKey = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth() + 1).padStart(2, '0')}-${String(pd.getUTCDate()).padStart(2, '0')}`;
                daySet.add(dayKey);
                dataMap.set(
                    dayKey + '||' + r.resolved_model,
                    Number(r.total_cost || 0)
                );
            }
            const days = [...daySet].sort();

            this._chart = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: days.map((d) => {
                        const p = d.split('-');
                        return new Date(
                            p[0],
                            p[1] - 1,
                            p[2]
                        ).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                        });
                    }),
                    datasets: models.map((model, i) => ({
                        label: model,
                        data: days.map(
                            (day) => dataMap.get(day + '||' + model) || 0
                        ),
                        backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                    })),
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    scales: {
                        x: { stacked: true },
                        y: {
                            stacked: true,
                            ticks: { callback: (v) => '$' + v.toFixed(4) },
                        },
                    },
                    plugins: { legend: { position: 'bottom' } },
                },
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
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
            const params = new URLSearchParams(tp);
            const data = await api.get(
                `/management/metrics/activity?${params}`
            );
            this.keyData = (data.by_key || []).map((k) => ({
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
            const params = new URLSearchParams({
                api_key_id: this.expandedKey,
                limit: this.keyLogsLimit,
                offset: this.keyLogsOffset,
                sort: toLogSortColumn(this.sortCol),
                order: this.sortDir,
            });
            const result = await api.get(`/management/logs?${params}`);
            this.keyLogs = normalizeAuditLogs(result);
            this.keyLogsTotal = result.total || 0;
        },

        async toggleDetail(log) {
            if (this.expandedDetail === log.id) {
                this.expandedDetail = null;
                return;
            }
            if (!log._detail) {
                log._detail = normalizeAuditLogDetail(
                    await api.get(
                        `/management/logs/${encodeURIComponent(log.request_id || log.id)}`
                    )
                );
            }
            this.expandedDetail = log.id;
        },

        formatTime,
        formatDate,
        formatMessages,
        renderContent,
        formatCost(v) {
            return v ? '$' + Number(v).toFixed(4) : '-';
        },
        formatTokens(v) {
            return v ? Number(v).toLocaleString() : '-';
        },
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
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
            const params = new URLSearchParams(tp);
            const data = unwrapObject(
                await api.get(`/management/metrics/errors?${params}`)
            );
            this.summary = data.summary || {};
            this.breakdown = data.breakdown || [];
            this.errorModels = data.models || [];
            this.rates = data.rates || [];
            await this.loadErrorLogs();
        },

        async loadErrorLogs() {
            const tp = timeRangeToParams(
                this.timeRange,
                this.customFrom,
                this.customTo
            );
            const params = new URLSearchParams({
                status: 'failed',
                limit: this.logsLimit,
                offset: this.logsOffset,
                ...tp,
            });
            if (this.filterType) params.set('error_type', this.filterType);
            if (this.filterModel) params.set('model', this.filterModel);
            const result = await api.get(`/management/logs?${params}`);
            this.errorLogs = normalizeAuditLogs(result);
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
                log._detail = normalizeAuditLogDetail(
                    await api.get(
                        `/management/logs/${encodeURIComponent(log.request_id || log.id)}`
                    )
                );
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
                const models = [...new Set(rates.map((r) => r.resolved_model))];
                const periods = [...new Set(rates.map((r) => r.period))].sort();

                this._chart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: periods.map((p) =>
                            new Date(p).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                            })
                        ),
                        datasets: models.map((m, i) => ({
                            label: m || 'unknown',
                            data: periods.map((p) => {
                                const row = rates.find(
                                    (r) =>
                                        r.period === p && r.resolved_model === m
                                );
                                return row ? Number(row.error_count) : 0;
                            }),
                            borderColor: CHART_COLORS[i % CHART_COLORS.length],
                            fill: false,
                            tension: 0.3,
                        })),
                    },
                    options: { responsive: true },
                });
            });
        },

        closeChart() {
            if (this._chart) {
                this._chart.destroy();
                this._chart = null;
            }
            this.showChart = false;
        },

        formatTime,
        formatDate,
        formatCost(v) {
            return v ? '$' + Number(v).toFixed(4) : '-';
        },
        formatTokens(v) {
            return v ? Number(v).toLocaleString() : '-';
        },
    };
}

// ---- Models Page ----
const MODEL_TREE_EXPANDED_STORAGE_KEY = 'soulGateway.models.tree.expanded';

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
        modelTreeExpanded: new Set([
            'AchillesCLI',
            'AchillesIDE',
            'axl-proxy',
            'axl-proxy/mistral',
            'proxies',
        ]),
        // Model edit state
        showModelEdit: false,
        editingModel: null,
        modelForm: {
            modelKey: '',
            displayName: '',
            providerKey: '',
            providerModelId: '',
            providerId: '',
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            requestPriceUsd: 0,
            pricingMode: 'external_directory',
            isFree: false,
            concurrencyLimit: 3,
            queueTimeoutMs: 60000,
            requestTimeoutMs: 120000,
            tags: [],
        },
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
            this.models = this.normalizeModels(models);
            this.providers = unwrapArray(providers);
            this.predefinedTags = unwrapArray(predefinedTags);
            this.modelTreeExpanded = this.treeView.loadExpandedSet(
                window.localStorage,
                MODEL_TREE_EXPANDED_STORAGE_KEY,
                Array.from(this.modelTreeExpanded)
            );
        },

        normalizeModels(payload) {
            return unwrapArray(payload).filter(
                (model) => model.strategy_kind !== 'cascade'
            );
        },

        get treeView() {
            return window.SoulGatewayTreeView;
        },

        get allTags() {
            const tags = new Set(this.predefinedTags || []);
            for (const m of this.models) {
                for (const t of m.tags || []) tags.add(t);
            }
            return [...tags].sort();
        },

        get filteredModels() {
            let list = this.models;
            if (!Array.isArray(list)) return [];
            if (this.modelEnabledOnly) list = list.filter((m) => m.enabled);
            if (this.freeOnly) list = list.filter((m) => m.is_free);
            if (this.billingFilter)
                list = list.filter(
                    (m) => (m.auth_strategy || 'api_key') === this.billingFilter
                );
            if (this.tagFilter)
                list = list.filter((m) =>
                    (m.tags || []).includes(this.tagFilter)
                );
            const q = this.modelFilter.trim();
            if (q) list = this.treeView.filterModelsForTree(list, q);
            return list;
        },

        get modelTreeRows() {
            return this.treeView.buildModelTreeRows(this.filteredModels, {
                expanded: this.modelTreeExpanded,
            });
        },

        modelIndentStyle(row) {
            const depth = Number.isFinite(row?.depth) ? row.depth : 0;
            return `padding-left: ${0.75 + depth * 1.25}rem`;
        },

        modelGroupSummary(row) {
            return `${row.enabledCount}/${row.count} enabled`;
        },

        toggleModelGroup(row) {
            if (!row?.path) return;
            this.modelTreeExpanded = this.treeView.toggleExpandedPath(
                this.modelTreeExpanded,
                row.path
            );
            this.treeView.saveExpandedSet(
                window.localStorage,
                MODEL_TREE_EXPANDED_STORAGE_KEY,
                this.modelTreeExpanded
            );
        },

        modelTreeRowKey(row) {
            if (row?.rowType === 'group') {
                return `group:${row.path || row.key || ''}`;
            }
            return `model:${row?.item?.model_key || row?.key || ''}`;
        },

        async toggleModel(m) {
            const isEnabled = m.enabled;
            if (isEnabled) {
                await api.post(`/management/models/${m.id}/disable`, {});
            } else {
                await api.post(`/management/models/${m.id}/enable`, {});
            }
            this.models = this.normalizeModels(
                await api.get('/management/models')
            );
        },

        async toggleFree(m) {
            await api.patch(`/management/models/${m.id}`, {
                isFree: !m.is_free,
            });
            this.models = this.normalizeModels(
                await api.get('/management/models')
            );
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
            if (!key) {
                this.createProviderModels = [];
                return;
            }
            this.loadingCreateModels = true;
            this.createModelsError = '';
            this.createProviderModels = [];
            this.createModel = '';
            this.createName = '';
            try {
                this.createProviderModels = unwrapArray(
                    await api.get(
                        `/management/models/providers/${encodeURIComponent(key)}/models`
                    )
                );
            } catch (e) {
                this.createModelsError =
                    e.message || 'Failed to fetch models';
            }
            this.loadingCreateModels = false;
        },

        onCreateModelChange() {
            if (this.createModel && this.createProvider) {
                this.createName = _buildModelName(
                    this.createProvider,
                    this.createModel
                );
            }
        },

        get groupedCreateModels() {
            return [['Discovered Models', this.createProviderModels]];
        },

        async createNewModel() {
            if (!this.createProvider || !this.createModel) return;
            const name = this.createName || this.createModel;
            const selected = this.createProviderModels.find(
                (m) => m.provider_model_id === this.createModel
            );
            const providerInfo = this.providers.find(
                (p) => p.provider_key === this.createProvider
            );
            if (!providerInfo?.provider_id) {
                alert('Selected provider is missing provider_id');
                return;
            }
            const payload = {
                modelKey: name,
                displayName: selected?.display_name || this.createModel,
                providerId: providerInfo.provider_id,
                providerModelId: this.createModel,
                pricingMode: selected?.pricing_mode || 'external_directory',
                inputPricePerMillion:
                    selected?.input_price_per_million ?? null,
                outputPricePerMillion:
                    selected?.output_price_per_million ?? null,
                requestPriceUsd: selected?.request_price_usd ?? null,
                isFree: selected?.is_free ?? false,
                capabilities: { ...(selected?.capabilities || {}) },
                tags: [...(selected?.tags || [])],
                metadata: { ...(selected?.metadata || {}) },
            };
            const result = await api.post('/management/models', payload);
            if (result?.error) {
                alert(result.error.message || result.error);
                return;
            }
            this.showModelCreate = false;
            this.models = this.normalizeModels(
                await api.get('/management/models')
            );
        },

        // ---- Edit model flow ----
        editModel(m) {
            this.editingModel = m;
            this.modelForm = {
                modelKey: m.model_key || '',
                displayName: m.display_name || '',
                providerKey: m.provider_key || '',
                providerModelId: m.provider_model_id || '',
                providerId: m.provider_id || '',
                inputPricePerMillion:
                    Number.parseFloat(m.input_price_per_million) || 0,
                outputPricePerMillion:
                    Number.parseFloat(m.output_price_per_million) || 0,
                requestPriceUsd: Number.parseFloat(m.request_price_usd) || 0,
                isFree: !!m.is_free,
                concurrencyLimit: m.concurrency_limit ?? 3,
                queueTimeoutMs: m.queue_timeout_ms ?? 60000,
                requestTimeoutMs: m.request_timeout_ms ?? 120000,
                tags: [...(m.tags || [])],
                pricingMode: m.pricing_mode || 'external_directory',
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
            const tag = this.customTagInput
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
            if (tag && !this.modelForm.tags.includes(tag)) {
                this.modelForm.tags.push(tag);
            }
            this.customTagInput = '';
        },

        onProviderChange() {
            const p = this.providers.find(
                (pr) => pr.provider_key === this.modelForm.providerKey
            );
            this.modelForm.providerId = p?.provider_id || '';
        },

        async saveModel() {
            if (!this.editingModel) return;
            const payload = {
                modelKey: this.modelForm.modelKey,
                displayName: this.modelForm.displayName,
                providerId: this.modelForm.providerId || null,
                providerModelId: this.modelForm.providerModelId,
                concurrencyLimit: this.modelForm.concurrencyLimit,
                queueTimeoutMs: this.modelForm.queueTimeoutMs,
                requestTimeoutMs: this.modelForm.requestTimeoutMs,
                pricingMode: this.modelForm.pricingMode,
                inputPricePerMillion: null,
                outputPricePerMillion: null,
                requestPriceUsd: null,
                isFree: this.modelForm.isFree,
                tags: [...this.modelForm.tags],
            };
            if (payload.pricingMode === 'free') {
                payload.isFree = true;
            } else if (payload.pricingMode === 'request') {
                payload.isFree = false;
                payload.requestPriceUsd = this.modelForm.requestPriceUsd || 0;
            } else if (payload.pricingMode === 'token') {
                payload.isFree = false;
                payload.inputPricePerMillion =
                    this.modelForm.inputPricePerMillion || 0;
                payload.outputPricePerMillion =
                    this.modelForm.outputPricePerMillion || 0;
            } else {
                payload.isFree = false;
            }
            await api.patch(
                `/management/models/${this.editingModel.id}`,
                payload
            );
            this.showModelEdit = false;
            this.editingModel = null;
            this.models = this.normalizeModels(
                await api.get('/management/models')
            );
        },

        async deleteModel(m) {
            if (!confirm(`Delete model "${m.model_key}"?`)) return;
            await api.del(`/management/models/${m.id}`);
            this.showModelEdit = false;
            this.editingModel = null;
            this.models = this.normalizeModels(
                await api.get('/management/models')
            );
        },
    };
}

// ---- Tiers Page ----
function tiersPage() {
    return {
        tiers: [],
        models: [],
        showTierModal: false,
        showModelPicker: false,
        editingTier: null,
        pickerSearch: '',
        pickerSelected: [],
        dragIdx: null,
        dropIdx: null,
        tierForm: {
            tierKey: '',
            displayName: '',
            enabled: true,
            maxAttempts: 5,
            childModelIds: [],
        },

        async init() {
            await this.reload();
        },

        async reload() {
            const [tiers, models] = await Promise.all([
                api.get('/management/tiers'),
                api.get('/management/models'),
            ]);
            this.tiers = unwrapArray(tiers);
            this.models = unwrapArray(models).filter(
                (model) => model.strategy_kind !== 'cascade'
            );
        },

        resetForm() {
            this.tierForm = {
                tierKey: '',
                displayName: '',
                enabled: true,
                maxAttempts: 5,
                childModelIds: [],
            };
            this.pickerSearch = '';
            this.pickerSelected = [];
            this.dragIdx = null;
            this.dropIdx = null;
        },

        openCreate() {
            this.editingTier = null;
            this.resetForm();
            this.showTierModal = true;
        },

        editTier(tier) {
            this.editingTier = tier;
            this.tierForm = {
                tierKey: tier.tierKey || '',
                displayName: tier.displayName || '',
                enabled: !!tier.enabled,
                maxAttempts: tier.maxAttempts ?? 5,
                childModelIds: (tier.children || []).map(
                    (child) => child.modelId
                ),
            };
            this.pickerSearch = '';
            this.pickerSelected = [];
            this.dragIdx = null;
            this.dropIdx = null;
            this.showTierModal = true;
        },

        childModel(modelId) {
            return this.models.find((model) => model.id === modelId) || null;
        },

        childModelLabel(modelId) {
            const model = this.childModel(modelId);
            return model?.model_key || modelId;
        },

        get filteredPickerModels() {
            let list = this.models.filter(
                (model) => !this.tierForm.childModelIds.includes(model.id)
            );

            const query = this.pickerSearch.trim().toLowerCase();
            if (!query) return list;

            return list.filter((model) => {
                const fields = [
                    model.model_key,
                    model.display_name,
                    model.provider_key,
                    ...(model.tags || []),
                ];
                return fields.some((value) =>
                    String(value || '')
                        .toLowerCase()
                        .includes(query)
                );
            });
        },

        openModelPicker() {
            this.pickerSearch = '';
            this.pickerSelected = [];
            this.showModelPicker = true;
        },

        togglePickerModel(modelId) {
            const index = this.pickerSelected.indexOf(modelId);
            if (index >= 0) {
                this.pickerSelected.splice(index, 1);
                return;
            }
            this.pickerSelected.push(modelId);
        },

        addPickerModels() {
            for (const modelId of this.pickerSelected) {
                if (!this.tierForm.childModelIds.includes(modelId)) {
                    this.tierForm.childModelIds.push(modelId);
                }
            }
            this.showModelPicker = false;
            this.pickerSelected = [];
        },

        removeChildModel(modelId) {
            this.tierForm.childModelIds = this.tierForm.childModelIds.filter(
                (childModelId) => childModelId !== modelId
            );
        },

        onDragStart(idx) {
            this.dragIdx = idx;
        },

        onDragOver(evt, idx) {
            evt.preventDefault();
            this.dropIdx = idx;
        },

        onDrop(idx) {
            if (this.dragIdx === null || this.dragIdx === idx) return;
            const item = this.tierForm.childModelIds.splice(this.dragIdx, 1)[0];
            this.tierForm.childModelIds.splice(idx, 0, item);
            this.dragIdx = null;
            this.dropIdx = null;
        },

        onDragEnd() {
            this.dragIdx = null;
            this.dropIdx = null;
        },

        async saveTier() {
            const payload = {
                tierKey: this.tierForm.tierKey.trim(),
                displayName: this.tierForm.displayName.trim(),
                enabled: !!this.tierForm.enabled,
                maxAttempts: Number(this.tierForm.maxAttempts),
                childModelIds: [...this.tierForm.childModelIds],
            };

            const result = this.editingTier
                ? await api.patch(
                      `/management/tiers/${this.editingTier.id}`,
                      payload
                  )
                : await api.post('/management/tiers', payload);

            if (result?.error) {
                alert(result.error.message || result.error);
                return;
            }

            this.showTierModal = false;
            this.editingTier = null;
            this.resetForm();
            await this.reload();
        },

        async removeTier(tier) {
            if (!confirm(`Delete tier "${tier.tierKey}"?`)) return;
            const result = await api.del(`/management/tiers/${tier.id}`);
            if (result?.error) {
                alert(result.error.message || result.error);
                return;
            }
            await this.reload();
        },

        async toggleTier(tier) {
            const action = tier.enabled ? 'disable' : 'enable';
            const result = await api.post(
                `/management/tiers/${tier.id}/${action}`,
                {}
            );
            if (result?.error) {
                alert(result.error.message || result.error);
                return;
            }
            await this.reload();
        },
    };
}

// ---- Keys Page ----
function keysPage() {
    return {
        keys: [],
        currentUser: null,
        currentOwner: '',
        showEdit: false,
        editing: null,
        editForm: {
            label: '',
            rpm_limit: '',
            tpm_limit: '',
            daily_budget_usd: '',
            monthly_budget_usd: '',
            expires_at: '',
        },
        createKeyForm: {
            owner: '',
            name: '',
            label: '',
            rpmLimit: '',
            tpmLimit: '',
            dailyBudgetUsd: '',
            monthlyBudgetUsd: '',
            expiresAt: '',
        },
        showCreateKey: false,
        newUserKey: '',
        createKeyError: '',

        async init() {
            await this.loadCurrentUser();
            const raw = unwrapArray(await api.get('/management/keys'));
            this.keys = raw.map((k) => ({
                ...k,
                daily_spent: Number(k.daily_spent || 0),
            }));
        },

        async loadCurrentUser() {
            try {
                const payload = await api.get('/management/me');
                const user =
                    payload?.user && typeof payload.user === 'object'
                        ? payload.user
                        : null;
                this.currentUser = user;
                this.currentOwner = String(user?.keyOwner || '').trim();
            } catch (err) {
                this.currentUser = null;
                this.currentOwner = '';
                console.warn('Unable to load management user', err);
            }
        },

        budgetPct(k) {
            const budget =
                k.daily_budget_usd != null
                    ? Number(k.daily_budget_usd)
                    : k.daily_budget != null
                      ? Number(k.daily_budget)
                      : null;
            if (budget == null || budget === 0) return null;
            return Math.min(100, (k.daily_spent / budget) * 100);
        },

        remaining(k) {
            const budget =
                k.daily_budget_usd != null
                    ? Number(k.daily_budget_usd)
                    : k.daily_budget != null
                      ? Number(k.daily_budget)
                      : null;
            if (budget == null) return null;
            return Math.max(0, budget - k.daily_spent);
        },

        _budget(k) {
            return k.daily_budget_usd ?? k.daily_budget;
        },

        isRevoked(k) {
            return (
                k?.status === 'revoked' ||
                k?.is_revoked === true ||
                k?.is_revoked === 1 ||
                k?.is_revoked === '1' ||
                k?.is_revoked === 'true'
            );
        },

        edit(k) {
            this.editing = k;
            this.editForm = {
                label: k.label || '',
                rpm_limit: k.rpm_limit ?? '',
                tpm_limit: k.tpm_limit ?? '',
                daily_budget_usd: k.daily_budget_usd ?? k.daily_budget ?? '',
                monthly_budget_usd: k.monthly_budget_usd ?? '',
                expires_at: k.expires_at ?? '',
            };
            this.showEdit = true;
        },

        openCreateKey() {
            this.createKeyForm = {
                owner: this.currentOwner || '',
                name: '',
                label: '',
                rpmLimit: '',
                tpmLimit: '',
                dailyBudgetUsd: '',
                monthlyBudgetUsd: '',
                expiresAt: '',
            };
            this.newUserKey = '';
            this.createKeyError = '';
            this.showCreateKey = true;
        },

        async submitCreateKey() {
            this.createKeyError = '';
            const explicitOwner = String(this.createKeyForm.owner || '').trim();
            const fallbackOwner = String(this.currentOwner || '').trim();
            const owner = explicitOwner || fallbackOwner;
            const name = this.createKeyForm.name.trim();
            const part = /^[A-Za-z0-9._-]+$/;
            if (!part.test(owner) || !part.test(name)) {
                this.createKeyError =
                    'Owner and name must each be non-empty and use only letters, digits, dot, underscore, or hyphen.';
                return;
            }
            const subjectId = `user:${owner}:${name}`;
            const payload = {
                subjectId,
                label: this.createKeyForm.label.trim() || `${owner}/${name}`,
            };
            for (const f of [
                'rpmLimit',
                'tpmLimit',
                'dailyBudgetUsd',
                'monthlyBudgetUsd',
            ]) {
                const v = String(this.createKeyForm[f]).trim();
                if (v !== '') payload[f] = Number(v);
            }
            const expiresAt = String(this.createKeyForm.expiresAt).trim();
            if (expiresAt) payload.expiresAt = expiresAt;

            try {
                // 1) provision the policy row. api.post resolves with the JSON body even on
                //    4xx (it only throws on 401/403), so we MUST inspect it — a 409 duplicate
                //    or 400 returns { error: {...} } and must NOT fall through to mint (F1).
                const provision = await api.post('/management/keys', payload);
                if (provision?.error || !provision?.key) {
                    this.createKeyError =
                        provision?.error?.message ||
                        'Could not provision the key row.';
                    return;
                }
                // 2) only now mint the signed key via the router (admin browser session)
                this.newUserKey = await this._mintUserKey(`${owner}:${name}`);
                // 3) refresh the list — keysPage() has no loadKeys(); init() reloads this.keys
                await this.init();
            } catch (e) {
                this.createKeyError = e?.message || 'Failed to create key.';
            }
        },

        async _mintUserKey(userId) {
            const res = await fetch('/api/router/identity/user-api-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ userId }),
            });
            if (res.status === 401 || res.status === 403) {
                redirectToPloinkyLogin();
                throw new Error('Ploinky admin session required.');
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.apiKey) {
                throw new Error(data?.message || 'The router did not return a key.');
            }
            return data.apiKey;
        },

        async saveEdit() {
            // The PATCH route accepts camelCase fields; rpm/tpm must stay > 0
            // (schema CHECK), so omit them when blank rather than sending null.
            const payload = { label: this.editForm.label };
            const rpm = Number(this.editForm.rpm_limit);
            const tpm = Number(this.editForm.tpm_limit);
            if (Number.isFinite(rpm) && rpm > 0) payload.rpmLimit = rpm;
            if (Number.isFinite(tpm) && tpm > 0) payload.tpmLimit = tpm;
            payload.dailyBudgetUsd =
                this.editForm.daily_budget_usd === ''
                    ? null
                    : Number(this.editForm.daily_budget_usd);
            payload.monthlyBudgetUsd =
                this.editForm.monthly_budget_usd === ''
                    ? null
                    : Number(this.editForm.monthly_budget_usd);
            payload.expiresAt =
                this.editForm.expires_at === ''
                    ? null
                    : this.editForm.expires_at;
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
            if (
                !confirm(
                    'Reset budget for this key? This starts a new billing period from now.'
                )
            )
                return;
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
        showRuleEditor: false,
        editing: null,
        form: { pattern: '', match_type: 'substring', description: '' },

        async init() {
            this.rules = unwrapArray(
                await api.get('/management/blacklist/rules')
            );
        },

        edit(r) {
            this.editing = r;
            this.form = {
                pattern: r.pattern,
                match_type: r.match_type,
                description: r.description || '',
            };
            this.showRuleEditor = true;
        },

        async save() {
            const body = { ...this.form };
            if (this.editing) {
                await api.patch(
                    `/management/blacklist/rules/${this.editing.id}`,
                    body
                );
            } else {
                await api.post('/management/blacklist/rules', body);
            }
            this.showRuleEditor = false;
            this.editing = null;
            this.form = {
                pattern: '',
                match_type: 'substring',
                description: '',
            };
            this.rules = unwrapArray(
                await api.get('/management/blacklist/rules')
            );
        },

        async toggleEnabled(r) {
            await api.patch(`/management/blacklist/rules/${r.id}`, {
                enabled: !r.enabled,
            });
            this.rules = unwrapArray(
                await api.get('/management/blacklist/rules')
            );
        },

        async remove(r) {
            if (!confirm('Delete this blacklist rule?')) return;
            await api.del(`/management/blacklist/rules/${r.id}`);
            this.rules = unwrapArray(
                await api.get('/management/blacklist/rules')
            );
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
                const modelMws = unwrapArray(
                    await api.get(`/management/models/${model.id}/middlewares`)
                );
                const match = modelMws.find(
                    (mm) =>
                        (mm.middlewareKey || mm.middleware_key) ===
                        (this.selectedMw.middleware_key ||
                            this.selectedMw.middlewareKey)
                );
                modelAssignments.push({
                    model,
                    assigned: !!match,
                    enabled: match?.enabled ?? false,
                    sortOrder: match?.sortOrder ?? 100,
                    settings: match?.settings || {},
                    assignmentId: match?.id,
                });
            }
            this.modelAssignments = modelAssignments;
        },

        async toggleModelAssignment(a) {
            if (a.assigned) {
                await api.del(
                    `/management/models/${a.model.id}/middlewares/${a.assignmentId}`
                );
            } else {
                await api.post(`/management/models/${a.model.id}/middlewares`, {
                    middlewareId: this.selectedMw.id,
                    enabled: true,
                    sortOrder: 100,
                    settings: {},
                });
            }
            await this.loadAssignments();
        },

        async toggleModelEnabled(a) {
            if (!a.assignmentId) return;
            await api.patch(
                `/management/models/${a.model.id}/middlewares/${a.assignmentId}`,
                {
                    enabled: !a.enabled,
                }
            );
            await this.loadAssignments();
        },

        async updateModelSortOrder(a) {
            if (!a.assignmentId) return;
            await api.patch(
                `/management/models/${a.model.id}/middlewares/${a.assignmentId}`,
                {
                    sortOrder: parseInt(a.sortOrder) || 100,
                }
            );
        },

        openSettings(a) {
            this.editingAssignment = a;
            const merged = {
                ...(this.selectedMw.default_settings || {}),
                ...(a.settings || {}),
            };
            this.settingsJson = JSON.stringify(merged, null, 2);
            this.settingsError = '';
            this.showSettings = true;
        },

        async saveSettings() {
            try {
                const parsed = JSON.parse(this.settingsJson);
                this.settingsError = '';
                await api.patch(
                    `/management/models/${this.editingAssignment.model.id}/middlewares/${this.editingAssignment.assignmentId}`,
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
                this.selectedMw =
                    this.middlewares.find((m) => m.id === this.selectedMw.id) ||
                    null;
            }
        },

        typeBadge(type) {
            const value = type || '';
            if (value === 'builtin') return 'badge-info';
            if (value === 'custom') return 'badge-warning';
            if (value === 'transport') return 'badge-secondary';
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
                for (const t of m.tags || []) tags.add(t);
            }
            return [...tags].sort();
        },

        get filteredModels() {
            let list = this.models;
            if (!Array.isArray(list)) return [];
            if (this.enabledOnly) list = list.filter((m) => m.enabled);
            if (this.freeOnly) list = list.filter((m) => m.is_free);
            if (this.billingFilter)
                list = list.filter(
                    (m) => (m.auth_strategy || 'api_key') === this.billingFilter
                );
            if (this.tagFilter)
                list = list.filter((m) =>
                    (m.tags || []).includes(this.tagFilter)
                );
            const q = this.search.trim().toLowerCase();
            if (q)
                list = list.filter(
                    (m) =>
                        (m.model_key || '').toLowerCase().includes(q) ||
                        (m.provider_key || '').toLowerCase().includes(q) ||
                        (m.tags || []).some((t) => t.toLowerCase().includes(q))
                );
            return list;
        },

        get selectedCount() {
            return this.selectedModels.length;
        },

        isSelected(name) {
            return this.selectedModels.includes(name);
        },

        toggleModel(name) {
            const idx = this.selectedModels.indexOf(name);
            if (idx >= 0) {
                this.selectedModels.splice(idx, 1);
                if (this.defaultModel === name)
                    this.defaultModel = this.selectedModels[0] || '';
            } else {
                this.selectedModels.push(name);
                if (!this.defaultModel) this.defaultModel = name;
            }
        },

        selectAllVisible() {
            for (const m of this.filteredModels) {
                const key = m.model_key;
                if (!this.selectedModels.includes(key))
                    this.selectedModels.push(key);
            }
            if (!this.defaultModel && this.selectedModels.length)
                this.defaultModel = this.selectedModels[0];
        },

        clearAll() {
            this.selectedModels = [];
            this.defaultModel = '';
        },

        _parseContext(cw) {
            if (!cw) return 200000;
            const s = String(cw).toLowerCase().replace(/,/g, '');
            if (s.endsWith('m') || s.endsWith('mil'))
                return parseFloat(s) * 1000000;
            if (s.endsWith('k')) return parseFloat(s) * 1000;
            const n = parseInt(s);
            return isNaN(n) ? 200000 : n;
        },

        _getSelectedModelObjects() {
            return this.selectedModels
                .map((name) => this.models.find((m) => m.model_key === name))
                .filter(Boolean);
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
            return m.model_key;
        },

        _genOpenCode() {
            const models = {};
            for (const m of this._getSelectedModelObjects()) {
                const key = this._modelName(m);
                models[key] = {
                    name: m.display_name || key,
                    limit: {
                        context: this._parseContext(getModelContextWindow(m)),
                        output: 32768,
                    },
                };
            }
            const config = {
                $schema: 'https://opencode.ai/config.json',
                model: this.defaultModel
                    ? `soul-gateway/${this.defaultModel}`
                    : '',
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
            const sonnet = selected.find((m) =>
                this._modelName(m).toLowerCase().includes('sonnet')
            );
            const opus = selected.find((m) =>
                this._modelName(m).toLowerCase().includes('opus')
            );
            const haiku = selected.find((m) =>
                this._modelName(m).toLowerCase().includes('haiku')
            );
            if (sonnet) overrides.sonnet = this._modelName(sonnet);
            if (opus) overrides.opus = this._modelName(opus);
            if (haiku) overrides.haiku = this._modelName(haiku);
            for (const m of selected) {
                if (m !== sonnet && m !== opus && m !== haiku) {
                    const shortName = this._modelName(m).split('/').pop();
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
            lines.push('env_key = "PLOINKY_AGENT_API_KEY"');
            if (this.apiKey) {
                lines.push('');
                lines.push('# Set this environment variable:');
                lines.push(`# export PLOINKY_AGENT_API_KEY="${this.apiKey}"`);
            }
            return lines.join('\n');
        },

        async copyConfig() {
            try {
                await navigator.clipboard.writeText(this.configOutput);
                this.copied = true;
                setTimeout(() => (this.copied = false), 2000);
            } catch {
                const ta = document.createElement('textarea');
                ta.value = this.configOutput;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                this.copied = true;
                setTimeout(() => (this.copied = false), 2000);
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

Object.assign(window, {
    app,
    providersPage,
    logsPage,
    costsPage,
    activityPage,
    errorsPage,
    modelsPage,
    tiersPage,
    keysPage,
    blacklistPage,
    middlewaresPage,
    exportPage,
    formatTime,
    formatDate,
    renderContent,
    sgAuthBadge,
    formatModelContextWindow,
    getModelPricingView,
});
