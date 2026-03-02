// ---- Helpers ----
const api = {
  async get(path) {
    const res = await fetch(path);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
    return res.json();
  }
};

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const CHART_COLORS = ['#36a2eb', '#ff6384', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#c9cbcf', '#7bc8a4'];

// ---- Main App ----
function app() {
  return {
    page: 'models',
    pages: [
      { id: 'models', label: 'Models' },
      { id: 'keys', label: 'Keys' },
      { id: 'logs', label: 'Logs' },
      { id: 'errors', label: 'Errors' },
      { id: 'activity', label: 'Activity' },
      { id: 'costs', label: 'Usage' },
      { id: 'blacklist', label: 'Blacklist' },
    ],
    wsConnected: false,
    streamMode: '', // 'ws', 'sse', or ''
    ws: null,
    sse: null,

    init() {
      // Read page from URL hash
      const hash = window.location.hash.slice(1);
      if (hash && this.pages.some(p => p.id === hash)) this.page = hash;

      this.connectWs();
    },

    navigate(p) {
      this.page = p;
      window.location.hash = p;
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
      const ws = new WebSocket(`${proto}//${location.host}/ws/v1/logs`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.wsConnected = true;
        this.streamMode = 'ws';
      };
      ws.onclose = () => {
        this.ws = null;
        if (!opened) {
          // WebSocket never connected — fall back to SSE
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
      const sse = new EventSource('/api/v1/logs/stream');
      sse.onopen = () => {
        this.wsConnected = true;
        this.streamMode = 'sse';
      };
      sse.onerror = () => {
        this.wsConnected = false;
        this.streamMode = '';
        // EventSource auto-reconnects, but if it keeps failing
        // we mark offline and let it retry on its own
      };
      sse.onmessage = (e) => this._handleLogMessage(e.data);
      this.sse = sse;
    },
  };
}

// ---- Logs Page (Tree View) ----
function logsPage() {
  return {
    treeData: [],
    tree: [],
    search: '',
    selectedNode: null,
    selectedLogs: [],
    logsTotal: 0,
    logsOffset: 0,
    logsLimit: 50,
    expandedDetail: null,
    sortCol: 'started_at',
    sortDir: 'desc',

    async init() {
      this.treeData = await api.get('/api/v1/tree');
      this.buildTree();

      // Listen for live logs and refresh tree
      window.addEventListener('soul-log', (e) => {
        // Add to selected logs if relevant
        if (this.selectedNode && this.selectedLogs.length > 0) {
          const log = e.detail;
          const matches = this.selectedNode.type === 'agent'
            ? log.agent_name === this.selectedNode.name
            : log.session_id === this.selectedNode.id;
          if (matches) {
            this.selectedLogs.unshift(log);
            if (this.selectedLogs.length > this.logsLimit) this.selectedLogs.pop();
            this.logsTotal++;
          }
        }
      });
    },

    buildTree() {
      const keyMap = new Map();

      for (const row of this.treeData) {
        const kid = row.api_key_id || '_none';
        if (!keyMap.has(kid)) {
          keyMap.set(kid, {
            type: 'key',
            id: kid,
            label: row.key_label || row.key_hint || kid.slice(0, 8),
            hint: row.key_hint || '',
            agents: new Map(),
            expanded: false,
          });
        }
        const key = keyMap.get(kid);

        const aname = row.agent_name || 'unknown';
        if (!key.agents.has(aname)) {
          key.agents.set(aname, {
            type: 'agent',
            name: aname,
            sessions: [],
            expanded: false,
          });
        }
        const agent = key.agents.get(aname);

        if (row.session_id) {
          agent.sessions.push({
            type: 'session',
            id: row.session_id,
            request_count: Number(row.request_count || 0),
            total_tokens: Number(row.total_tokens || 0),
            total_cost: Number(row.total_cost || 0),
            first_request: row.first_request,
            last_request: row.last_request,
          });
        }
      }

      this.tree = Array.from(keyMap.values()).map(k => ({
        ...k,
        agents: Array.from(k.agents.values()),
      }));
    },

    filteredTree() {
      if (!this.search) return this.tree;
      const q = this.search.toLowerCase();
      const result = [];

      for (const k of this.tree) {
        const keyMatch = k.label.toLowerCase().includes(q) || k.hint.toLowerCase().includes(q);
        const filteredAgents = k.agents.filter(a => a.name.toLowerCase().includes(q));

        if (keyMatch || filteredAgents.length > 0) {
          result.push({
            ...k,
            agents: keyMatch ? k.agents : filteredAgents,
            expanded: true,
          });
        }
      }
      return result;
    },

    setSort(col) {
      if (this.sortCol === col) {
        this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        this.sortCol = col;
        this.sortDir = 'desc';
      }
      this.logsOffset = 0;
      this.loadSelectedLogs();
    },

    async selectSession(session) {
      this.selectedNode = session;
      this.logsOffset = 0;
      this.expandedDetail = null;
      this.sortCol = 'started_at';
      this.sortDir = 'desc';
      await this.loadSelectedLogs();
    },

    async selectAgent(agent, keyId) {
      this.selectedNode = { type: 'agent', name: agent.name, keyId };
      this.logsOffset = 0;
      this.expandedDetail = null;
      this.sortCol = 'started_at';
      this.sortDir = 'desc';
      await this.loadSelectedLogs();
    },

    async loadSelectedLogs() {
      if (!this.selectedNode) return;
      let result;
      if (this.selectedNode.type === 'session') {
        const params = new URLSearchParams({ limit: this.logsLimit, offset: this.logsOffset, sort: this.sortCol, order: this.sortDir });
        result = await api.get(`/api/v1/sessions/${this.selectedNode.id}/logs?${params}`);
      } else {
        const params = new URLSearchParams({ agent_name: this.selectedNode.name, api_key_id: this.selectedNode.keyId, limit: this.logsLimit, offset: this.logsOffset, sort: this.sortCol, order: this.sortDir });
        result = await api.get(`/api/v1/logs?${params}`);
      }
      this.selectedLogs = result.rows || [];
      this.logsTotal = result.total || 0;
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) {
        this.expandedDetail = null;
        return;
      }
      if (!log._detail) {
        log._detail = await api.get(`/api/v1/logs/${log.id}`);
      }
      this.expandedDetail = log.id;
    },

    formatTime, formatDate,
    formatCost(v) { return v ? '$' + Number(v).toFixed(4) : '-'; },
    formatTokens(v) { return v ? Number(v).toLocaleString() : '-'; },
  };
}

// ---- Costs Page ----
function costsPage() {
  return {
    // Month navigation
    year: new Date().getFullYear(),
    month: new Date().getMonth(), // 0-indexed
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

    get monthLabel() {
      return new Date(this.year, this.month).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    },

    get from() {
      return new Date(this.year, this.month, 1).toISOString();
    },

    get to() {
      return new Date(this.year, this.month + 1, 1).toISOString();
    },

    async init() {
      this.availableKeys = await api.get('/api/v1/keys');
      await this.load();
    },

    async load() {
      const params = new URLSearchParams({ from: this.from, to: this.to });
      if (this.filterModel) params.set('model', this.filterModel);
      if (this.filterKey) params.set('api_key_id', this.filterKey);
      const data = await api.get(`/api/v1/metrics/usage?${params}`);

      this.totalCost = Number(data.total?.total_cost || 0);
      this.totalTokens = Number(data.total?.total_tokens || 0);
      this.totalRequests = Number(data.total?.request_count || 0);
      this.availableModels = data.models || [];
      this._dailyData = data.daily_by_model || [];
      this._modelRequests = data.model_requests || [];
      this.expandedModel = null;

      this.$nextTick(() => this.renderChart());
    },

    prevMonth() {
      if (this.month === 0) { this.year--; this.month = 11; }
      else this.month--;
      this.load();
    },

    nextMonth() {
      if (this.month === 11) { this.year++; this.month = 0; }
      else this.month++;
      this.load();
    },

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
      if (!canvas) return;
      if (this._chart) { this._chart.destroy(); this._chart = null; }

      const data = this._dailyData;
      if (data.length === 0) return;

      const models = [...new Set(data.map(r => r.resolved_model))].filter(Boolean);
      // Build all days in the month
      const days = [];
      const d = new Date(this.year, this.month, 1);
      const endOfMonth = new Date(this.year, this.month + 1, 1);
      while (d < endOfMonth) {
        days.push(new Date(d));
        d.setDate(d.getDate() + 1);
      }

      // Map data by day+model — normalize period to local date string for matching
      const dataMap = new Map();
      for (const r of data) {
        const pd = new Date(r.period);
        // Use UTC date components to avoid timezone shifts
        const dateKey = `${pd.getUTCFullYear()}-${pd.getUTCMonth()}-${pd.getUTCDate()}`;
        dataMap.set(dateKey + '||' + r.resolved_model, Number(r.total_cost || 0));
      }

      const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

      try {
        this._chart = new Chart(canvas, {
          type: 'bar',
          data: {
            labels: days.map(d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
            datasets: models.map((model, i) => ({
              label: model,
              data: days.map(day => dataMap.get(dayKey(day) + '||' + model) || 0),
              backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
            }))
          },
          options: {
            responsive: true,
            scales: {
              x: { stacked: true },
              y: { stacked: true, ticks: { callback: v => '$' + v.toFixed(2) } },
            },
            plugins: { legend: { position: 'bottom' } },
          }
        });
      } catch (err) {
        console.warn('[Usage] Chart render failed:', err.message);
      }
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

    async init() {
      const data = await api.get('/api/v1/metrics/activity');
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
      const result = await api.get(`/api/v1/logs?${params}`);
      this.keyLogs = result.rows || [];
      this.keyLogsTotal = result.total || 0;
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) { this.expandedDetail = null; return; }
      if (!log._detail) { log._detail = await api.get(`/api/v1/logs/${log.id}`); }
      this.expandedDetail = log.id;
    },

    formatTime, formatDate,
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

    async init() {
      const data = await api.get('/api/v1/metrics/errors');
      this.summary = data.summary || {};
      this.breakdown = data.breakdown || [];
      this.errorModels = data.models || [];
      this.rates = data.rates || [];
      await this.loadErrorLogs();
    },

    async loadErrorLogs() {
      const params = new URLSearchParams({ status: 'error', limit: this.logsLimit, offset: this.logsOffset });
      if (this.filterType) params.set('error_type', this.filterType);
      if (this.filterModel) params.set('model', this.filterModel);
      const result = await api.get(`/api/v1/logs?${params}`);
      this.errorLogs = result.rows || [];
      this.logsTotal = result.total || 0;
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
        log._detail = await api.get(`/api/v1/logs/${log.id}`);
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
    providerModels: [],
    loadingProviderModels: false,
    providerModelsError: '',
    // Tiers state
    tiers: [],
    showTierCreate: false,
    editingTier: null,
    tierForm: { name: '', display_name: '', models: [], fallback_tier: '' },
    // Tier "add model" state
    tierAddProvider: '',
    tierAddModel: '',
    tierAddName: '',
    // Models table state
    modelFilter: '',
    modelEnabledOnly: false,

    async init() {
      [this.models, this.providers, this.tiers] = await Promise.all([
        api.get('/api/v1/models'),
        api.get('/api/v1/models/providers'),
        api.get('/api/v1/tiers'),
      ]);
    },

    async fetchProviderModels() {
      const key = this.tierAddProvider;
      if (!key) { this.providerModels = []; return; }
      this.loadingProviderModels = true;
      this.providerModelsError = '';
      this.providerModels = [];
      try {
        const models = await api.get(`/api/v1/models/providers/${encodeURIComponent(key)}/models`);
        if (Array.isArray(models)) {
          this.providerModels = models;
        } else if (models?.error) {
          this.providerModelsError = models.error.message || 'Failed to load models';
        }
      } catch (e) {
        this.providerModelsError = 'Failed to fetch models';
      }
      this.loadingProviderModels = false;
      // Clear current selection since provider changed
      this.tierAddModel = '';
      this.tierAddName = '';
    },

    onTierProviderChange() {
      this.fetchProviderModels();
    },

    onTierModelChange() {
      const selected = this.providerModels.find(m => m.id === this.tierAddModel);
      if (selected) {
        // Default name to provider_model id
        this.tierAddName = this.tierAddModel;
      }
    },

    get groupedProviderModels() {
      const groups = {};
      for (const m of this.providerModels) {
        const key = m.owned_by || 'other';
        (groups[key] ||= []).push(m);
      }
      return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    },

    async addModelToTier() {
      if (!this.tierAddModel || !this.tierAddProvider) return;
      const name = this.tierAddName || this.tierAddModel;
      // Don't add duplicates to tier
      if (this.tierForm.models.includes(name)) return;

      const selected = this.providerModels.find(m => m.id === this.tierAddModel);
      // Create model_config (idempotent — backend returns existing on conflict)
      await api.post('/api/v1/models', {
        name,
        provider_key: this.tierAddProvider,
        provider_model: this.tierAddModel,
        upstream_source: selected?.owned_by || '',
        mode: 'deep',
        input_price: selected?.input_price || 0,
        output_price: selected?.output_price || 0,
      });

      this.tierForm.models.push(name);
      this.models = await api.get('/api/v1/models');
      // Reset add fields
      this.tierAddModel = '';
      this.tierAddName = '';
    },

    // Tier methods
    editTier(t) {
      this.editingTier = t;
      this.tierForm = {
        name: t.name,
        display_name: t.display_name || '',
        models: [...(t.models || [])],
        fallback_tier: t.fallback_tier || '',
      };
      this.tierAddProvider = '';
      this.tierAddModel = '';
      this.tierAddName = '';
      this.providerModels = [];
      this.showTierCreate = true;
    },

    async saveTier() {
      const payload = { ...this.tierForm };
      if (!payload.fallback_tier) payload.fallback_tier = null;
      if (this.editingTier) {
        await api.put(`/api/v1/tiers/${this.editingTier.id}`, payload);
      } else {
        await api.post('/api/v1/tiers', payload);
      }
      this.showTierCreate = false;
      this.editingTier = null;
      this.tierAddProvider = '';
      this.tierAddModel = '';
      this.tierAddName = '';
      this.providerModels = [];
      this.tiers = await api.get('/api/v1/tiers');
    },

    async removeTier(t) {
      if (!confirm(`Delete tier "${t.name}"?`)) return;
      await api.del(`/api/v1/tiers/${t.id}`);
      this.tiers = await api.get('/api/v1/tiers');
    },

    async toggleTier(t) {
      await api.put(`/api/v1/tiers/${t.id}/toggle`, {});
      this.tiers = await api.get('/api/v1/tiers');
    },

    // Models table
    get filteredModels() {
      let list = this.models;
      if (!Array.isArray(list)) return [];
      if (this.modelEnabledOnly) list = list.filter(m => m.is_enabled);
      const q = this.modelFilter.trim().toLowerCase();
      if (q) list = list.filter(m => m.name.toLowerCase().includes(q) || (m.provider_key || '').toLowerCase().includes(q));
      return list;
    },

    async toggleModel(m) {
      await api.put(`/api/v1/models/${m.id}/toggle`, {});
      this.models = await api.get('/api/v1/models');
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
    form: { label: '', key: '', monthly_budget: '' },
    editForm: { label: '', monthly_budget: '' },

    async init() {
      this.keys = await api.get('/api/v1/keys');
    },

    generate() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      this.form.key = 'sk-soul-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    },

    async create() {
      const payload = { ...this.form };
      if (!payload.key) delete payload.key;
      payload.monthly_budget = payload.monthly_budget === '' ? null : Number(payload.monthly_budget);
      const result = await api.post('/api/v1/keys', payload);
      this.newKey = result.key || '';
      this.showCreate = false;
      this.form.key = '';
      this.form.monthly_budget = '';
      this.keys = await api.get('/api/v1/keys');
    },

    edit(k) {
      this.editing = k;
      this.editForm = { label: k.label || '', monthly_budget: k.monthly_budget ?? '' };
      this.showEdit = true;
    },

    async saveEdit() {
      const payload = { ...this.editForm };
      payload.monthly_budget = payload.monthly_budget === '' ? null : Number(payload.monthly_budget);
      await api.put(`/api/v1/keys/${this.editing.id}`, payload);
      this.showEdit = false;
      this.editing = null;
      this.keys = await api.get('/api/v1/keys');
    },

    async revoke(k) {
      if (!confirm('Revoke this API key?')) return;
      await api.del(`/api/v1/keys/${k.id}`);
      this.keys = await api.get('/api/v1/keys');
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
      this.rules = await api.get('/api/v1/blacklist');
    },

    edit(r) {
      this.editing = r;
      this.form = { pattern: r.pattern, match_type: r.match_type, description: r.description || '' };
      this.showCreate = true;
    },

    async save() {
      const body = { ...this.form };
      if (this.editing) {
        await api.put(`/api/v1/blacklist/${this.editing.id}`, body);
      } else {
        await api.post('/api/v1/blacklist', body);
      }
      this.showCreate = false;
      this.editing = null;
      this.form = { pattern: '', match_type: 'substring', description: '' };
      this.rules = await api.get('/api/v1/blacklist');
    },

    async toggleEnabled(r) {
      await api.put(`/api/v1/blacklist/${r.id}`, { is_enabled: !r.is_enabled });
      this.rules = await api.get('/api/v1/blacklist');
    },

    async remove(r) {
      if (!confirm('Delete this blacklist rule?')) return;
      await api.del(`/api/v1/blacklist/${r.id}`);
      this.rules = await api.get('/api/v1/blacklist');
    },

    formatDate,
  };
}
