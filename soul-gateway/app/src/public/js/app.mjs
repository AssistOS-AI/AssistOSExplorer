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

    form: { template: 'custom', name: '', display_name: '', protocol: 'openai', base_url: '', api_key: '' },
    editForm: { display_name: '', protocol: '', base_url: '', api_key: '', is_enabled: true },

    async init() {
      [this.providers, this.templates] = await Promise.all([
        api.get('/api/v1/providers'),
        api.get('/api/v1/providers/templates'),
      ]);
    },

    onTemplateChange() {
      const t = this.templates[this.form.template];
      if (t) {
        this.form.display_name = t.display_name || '';
        this.form.protocol = t.protocol || 'openai';
        this.form.base_url = t.base_url || '';
        if (this.form.template !== 'custom') {
          this.form.name = this.form.template;
        }
      }
    },

    openCreate() {
      this.form = { template: 'custom', name: '', display_name: '', protocol: 'openai', base_url: '', api_key: '' };
      this.showCreate = true;
    },

    async create() {
      const payload = { ...this.form };
      delete payload.template;
      if (!payload.name || !payload.base_url || !payload.api_key) {
        alert('Name, Base URL, and API Key are required');
        return;
      }
      const result = await api.post('/api/v1/providers', payload);
      if (result.error) {
        alert(result.error.message || result.error);
        return;
      }
      this.showCreate = false;
      this.providers = await api.get('/api/v1/providers');
    },

    edit(p) {
      this.editing = p;
      this.editForm = {
        display_name: p.display_name || '',
        protocol: p.protocol || 'openai',
        base_url: p.base_url || '',
        api_key: '',
        is_enabled: p.is_enabled,
      };
      this.showEdit = true;
    },

    async saveEdit() {
      const payload = { ...this.editForm };
      if (!payload.api_key) delete payload.api_key;
      await api.put(`/api/v1/providers/${this.editing.id}`, payload);
      this.showEdit = false;
      this.editing = null;
      this.providers = await api.get('/api/v1/providers');
    },

    async remove(p) {
      if (!confirm(`Delete provider "${p.name}"? Models using this provider will lose their provider configuration.`)) return;
      await api.del(`/api/v1/providers/${p.id}`);
      this.providers = await api.get('/api/v1/providers');
    },

    async testConnection(p) {
      this.testing = p.id;
      this.testResult = null;
      try {
        this.testResult = await api.post(`/api/v1/providers/${p.id}/test`, {});
      } catch (e) {
        this.testResult = { ok: false, error: e.message };
      }
      this.testing = null;
    },

    async discoverModels(p) {
      this.discoverProvider = p;
      this.discoveredModels = [];
      this.showDiscover = true;
      try {
        const models = await api.get(`/api/v1/providers/${p.id}/models`);
        this.discoveredModels = Array.isArray(models) ? models : [];
      } catch {
        this.discoveredModels = [];
      }
    },

    async addDiscoveredModel(model) {
      if (!this.discoverProvider) return;
      await api.post('/api/v1/models', {
        name: model.id,
        provider_key: this.discoverProvider.name,
        provider_model: model.id,
        provider_config_id: this.discoverProvider.id,
        input_price: model.input_price || 0,
        output_price: model.output_price || 0,
        mode: 'deep',
      });
      model._added = true;
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
    search: '',
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
      this.keys = await api.get(`/api/v1/tree?${params}`);
    },

    filteredKeys() {
      if (!this.search) return this.keys;
      const q = this.search.toLowerCase();
      return this.keys.filter(k =>
        (k.key_label || '').toLowerCase().includes(q) ||
        (k.key_hint || '').toLowerCase().includes(q)
      );
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
      // cache_hit filter needs backend support — filter client-side for now
      const params = new URLSearchParams(p);
      const result = await api.get(`/api/v1/logs?${params}`);
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
      if (!log._detail) { log._detail = await api.get(`/api/v1/logs/${log.id}`); }
      this.expandedDetail = log.id;
    },

    formatTime, formatDate, formatMessages, renderContent,
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
      if (!canvas || canvas.clientWidth === 0) return;

      // Destroy previous chart instance
      if (this._chart) { this._chart.destroy(); this._chart = null; }

      const data = this._dailyData;
      if (data.length === 0) return;

      const models = [...new Set(data.map(r => r.resolved_model))].filter(Boolean);
      const days = [];
      const d = new Date(this.year, this.month, 1);
      const endOfMonth = new Date(this.year, this.month + 1, 1);
      while (d < endOfMonth) {
        days.push(new Date(d));
        d.setDate(d.getDate() + 1);
      }

      const dataMap = new Map();
      for (const r of data) {
        const pd = new Date(r.period);
        const key = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth()+1).padStart(2,'0')}-${String(pd.getUTCDate()).padStart(2,'0')}||${r.resolved_model}`;
        dataMap.set(key, Number(r.total_cost || 0));
      }

      const fmtDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

      this._chart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: days.map(d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
          datasets: models.map((model, i) => ({
            label: model,
            data: days.map(day => dataMap.get(fmtDay(day) + '||' + model) || 0),
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
      const data = await api.get(`/api/v1/metrics/activity?${params}`);
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
      const result = await api.get(`/api/v1/logs?${params}`);
      this.keyLogs = result.rows || [];
      this.keyLogsTotal = result.total || 0;
    },

    async toggleDetail(log) {
      if (this.expandedDetail === log.id) { this.expandedDetail = null; return; }
      if (!log._detail) { log._detail = await api.get(`/api/v1/logs/${log.id}`); }
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
      const data = await api.get(`/api/v1/metrics/errors?${params}`);
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
      const result = await api.get(`/api/v1/logs?${params}`);
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
    // Models table state
    modelFilter: '',
    modelEnabledOnly: false,
    // Model edit state
    showModelEdit: false,
    editingModel: null,
    modelForm: { name: '', display_name: '', provider_key: '', provider_model: '', provider_config_id: '', mode: 'deep', input_price: 0, output_price: 0, max_concurrency: 3, sort_order: 100, context_window: '' },
    // Model create state
    showModelCreate: false,
    createProvider: '',
    createProviderModels: [],
    loadingCreateModels: false,
    createModelsError: '',
    createModel: '',
    createName: '',

    async init() {
      [this.models, this.providers] = await Promise.all([
        api.get('/api/v1/models'),
        api.get('/api/v1/models/providers'),
      ]);
    },

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
        const models = await api.get(`/api/v1/models/providers/${encodeURIComponent(key)}/models`);
        if (Array.isArray(models)) {
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
      if (this.createModel) this.createName = this.createModel;
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
        name,
        provider_key: this.createProvider,
        provider_model: this.createModel,
        upstream_source: selected?.owned_by || '',
        mode: 'deep',
        input_price: selected?.input_price || 0,
        output_price: selected?.output_price || 0,
      };
      if (providerInfo?.source === 'database') {
        payload.provider_config_id = providerInfo.id;
      }
      const result = await api.post('/api/v1/models', payload);
      if (result?.error) {
        alert(result.error.message || result.error);
        return;
      }
      this.showModelCreate = false;
      this.models = await api.get('/api/v1/models');
    },

    // ---- Edit model flow ----
    editModel(m) {
      this.editingModel = m;
      this.modelForm = {
        name: m.name || '',
        display_name: m.display_name || '',
        provider_key: m.provider_key || '',
        provider_model: m.provider_model || '',
        provider_config_id: m.provider_config_id || '',
        mode: m.mode || 'deep',
        input_price: parseFloat(m.input_price) || 0,
        output_price: parseFloat(m.output_price) || 0,
        max_concurrency: m.max_concurrency ?? 3,
        sort_order: m.sort_order ?? 100,
        context_window: m.context_window || '',
      };
      this.showModelEdit = true;
    },

    onProviderChange() {
      const p = this.providers.find(pr => pr.key === this.modelForm.provider_key);
      if (p?.source === 'database') {
        this.modelForm.provider_config_id = p.id;
      } else {
        this.modelForm.provider_config_id = '';
      }
    },

    async saveModel() {
      if (!this.editingModel) return;
      const payload = { ...this.modelForm };
      if (!payload.provider_config_id) payload.provider_config_id = null;
      await api.put(`/api/v1/models/${this.editingModel.id}`, payload);
      this.showModelEdit = false;
      this.editingModel = null;
      this.models = await api.get('/api/v1/models');
    },

    async deleteModel(m) {
      if (!confirm(`Delete model "${m.name}"?`)) return;
      await api.del(`/api/v1/models/${m.id}`);
      this.showModelEdit = false;
      this.editingModel = null;
      this.models = await api.get('/api/v1/models');
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
    tierForm: { name: '', display_name: '', models: [], fallback_tier: '' },

    async init() {
      [this.tiers, this.models] = await Promise.all([
        api.get('/api/v1/tiers'),
        api.get('/api/v1/models'),
      ]);
    },

    editTier(t) {
      this.editingTier = t;
      this.tierForm = {
        name: t.name,
        display_name: t.display_name || '',
        models: [...(t.models || [])],
        fallback_tier: t.fallback_tier || '',
      };
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
