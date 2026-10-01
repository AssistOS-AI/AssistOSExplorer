import { appendLiveTimeline, renderLiveCpuChart } from './workspace-monitor-charts.js';

const MAX_SAMPLES = 300;

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function runtimeSeriesId(runtime, index = 0) {
  const repoName = String(runtime?.repoName || '').trim();
  const agentName = String(runtime?.agentName || '').trim();
  const containerName = String(runtime?.containerName || '').trim();
  const identity = repoName && agentName && agentName !== '-'
    ? `${repoName}/${agentName}`
    : containerName || agentName || `runtime-${index}`;
  return encodeURIComponent(identity);
}

export function runtimeIsReady(runtime) {
  if (['refused', 'blocked', 'failed', 'stopped'].includes(runtime?.availability)) return false;
  return typeof runtime?.state?.ready === 'boolean'
    ? runtime.state.ready
    : Boolean(runtime?.state?.running);
}

export function hardwareResourceDisplay(runtime) {
  const limits = runtime?.limits;
  const cpu = limits?.cpu?.assurance === 'kernel' ? ` / ${limits.cpu.cores * 100}% quota (${limits.cpu.cores} cores, kernel)` : limits ? ' / no limit' : '';
  const memory = limits?.memory?.assurance === 'kernel' ? ` / ${formatBytes(limits.memory.bytes)} kernel limit` : limits ? ' / no limit' : '';
  const gpu = limits?.gpu?.assurance === 'best-effort' ? `GPU ${limits.gpu.smPercent}% SM / ${formatBytes(limits.gpu.vramBytes)} per CUDA process (best-effort)` : '';
  const problem = runtime?.problem;
  const reason = runtime?.availability === 'blocked'
    ? `Blocked by ${problem?.blockedBy?.ref || problem?.blockedBy?.key || 'required dependency'}. ${problem?.rootCause ? `Root refusal ${problem.rootCause.ref || problem.rootCause.key || ''}. ` : ''}${problem?.rootCause?.reason || problem?.reason || ''} ${problem?.rootCause?.fix || problem?.fix || ''}`
    : `${problem?.reason || ''} ${problem?.fix || ''}`;
  return { cpu, memory, gpu, status: runtime?.availability || runtime?.state?.status || 'unknown', reason: reason.trim() };
}

function setText(root, role, value) {
  const target = root.querySelector(`[data-role="${role}"]`);
  if (target) target.textContent = value;
}

export class WorkspaceMonitorResources {
  constructor(element, { onSelectionChange, onSelectionCleared, onLiveUpdate } = {}) {
    this.element = element;
    this.onSelectionChange = onSelectionChange;
    this.onSelectionCleared = onSelectionCleared;
    this.onLiveUpdate = onLiveUpdate;
    this.samples = [];
    this.runtimeSamples = new Map();
    this.selectedKey = null;
    this.entries = [];
    this.lastSampledAt = 0;
  }

  selectedEntry() {
    return this.entries.find((entry) => entry.key === this.selectedKey) || null;
  }

  renderSnapshot(payload) {
    const reportedSampledAt = Date.parse(payload.sampledAt);
    const sampledAt = Number.isFinite(reportedSampledAt) ? reportedSampledAt : Date.now();
    if (sampledAt <= this.lastSampledAt) return;
    this.lastSampledAt = sampledAt;
    const total = payload.total || {};
    const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
    const routerCpu = Number(payload.router?.metrics?.cpuPercent);
    const routerMemory = Number(payload.router?.metrics?.memoryBytes);
    const safeRouterCpu = Number.isFinite(routerCpu) ? routerCpu : 0;
    const safeRouterMemory = Number.isFinite(routerMemory) ? routerMemory : 0;
    const agents = runtimes.reduce((sum, runtime) => ({
      cpuPercent: sum.cpuPercent + (runtime.metrics?.available === false ? 0 : Number(runtime.metrics?.cpuPercent) || 0),
      memoryBytes: sum.memoryBytes + (runtime.metrics?.available === false ? 0 : Number(runtime.metrics?.memoryBytes) || 0)
    }), { cpuPercent: 0, memoryBytes: 0 });
    const reportedTotalCpu = Number(total.cpuPercent);
    const reportedTotalMemory = Number(total.memoryBytes);
    const totalCpu = Number.isFinite(reportedTotalCpu) ? reportedTotalCpu : agents.cpuPercent + safeRouterCpu;
    const totalMemory = Number.isFinite(reportedTotalMemory) ? reportedTotalMemory : agents.memoryBytes + safeRouterMemory;
    this.renderOverviewValues(runtimes, { totalCpu, totalMemory, agents, routerCpu: safeRouterCpu, routerMemory: safeRouterMemory });
    this.updateRuntimeEntries(runtimes, sampledAt);
    this.renderOverviewChart(totalCpu, agents.cpuPercent, safeRouterCpu, sampledAt);
    this.onLiveUpdate?.(new Date(sampledAt));
  }

  renderOverviewValues(runtimes, { totalCpu, totalMemory, agents, routerCpu, routerMemory }) {
    setText(this.element, 'total-cpu', `${totalCpu.toFixed(1)}%`);
    setText(this.element, 'agents-cpu', `${agents.cpuPercent.toFixed(1)}%`);
    setText(this.element, 'router-cpu', `${routerCpu.toFixed(1)}%`);
    setText(this.element, 'total-memory', formatBytes(totalMemory));
    setText(this.element, 'agents-memory', formatBytes(agents.memoryBytes));
    setText(this.element, 'router-memory', formatBytes(routerMemory));
    setText(this.element, 'runtime-count', String(runtimes.length));
    setText(this.element, 'running-count', String(runtimes.filter(runtimeIsReady).length));
    setText(this.element, 'unavailable-count', String(runtimes.filter((runtime) => runtimeIsReady(runtime) && runtime.metrics?.available === false).length));
  }

  updateRuntimeEntries(runtimes, sampledAt) {
    const previousKey = this.selectedKey;
    this.entries = runtimes.map((runtime, index) => {
      const key = runtimeSeriesId(runtime, index);
      const name = String(runtime.agentName || runtime.containerName || runtime.name || key);
      const available = runtime.metrics?.available !== false;
      const cpuPercent = available ? Number(runtime.metrics?.cpuPercent || 0) : null;
      const memoryBytes = available ? Number(runtime.metrics?.memoryBytes || 0) : null;
      if (available) {
        const samples = this.runtimeSamples.get(key) || [];
        samples.push({ timestamp: sampledAt, cpuPercent, memoryBytes });
        if (samples.length > MAX_SAMPLES) samples.shift();
        this.runtimeSamples.set(key, samples);
      }
      return { key, name, runtime, available, cpuPercent, memoryBytes };
    });
    if (!this.entries.some((entry) => entry.key === this.selectedKey)) this.selectedKey = this.entries[0]?.key || null;
    this.renderRows();
    this.renderSelected();
    if (this.selectedKey && this.selectedKey !== previousKey) this.onSelectionChange?.();
    else if (!this.selectedKey && previousKey) this.onSelectionCleared?.();
  }

  select(key) {
    if (this.selectedKey !== key) {
      this.selectedKey = key;
      this.renderRows();
      this.renderSelected();
      this.onSelectionChange?.();
    }
    this.scrollToSelectedMonitor();
  }

  scrollToSelectedMonitor() {
    this.element.querySelector('.resource-item-monitor')?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'start'
    });
  }

  renderRows() {
    const tbody = this.element.querySelector('[data-role="resource-rows"]');
    if (!tbody) return;
    tbody.replaceChildren();
    for (const entry of this.entries) {
      const selected = entry.key === this.selectedKey;
      const row = document.createElement('tr');
      row.classList.toggle('selected', selected);
      row.addEventListener('click', () => this.select(entry.key));
      const nameCell = document.createElement('td');
      const selector = document.createElement('button');
      selector.type = 'button';
      selector.className = 'resource-runtime-selector';
      selector.textContent = entry.name;
      selector.setAttribute('aria-pressed', String(selected));
      selector.addEventListener('click', (event) => {
        event.stopPropagation();
        this.select(entry.key);
      });
      nameCell.append(selector);
      row.append(nameCell);
      const values = [
        hardwareResourceDisplay(entry.runtime).status,
        entry.available ? `${entry.cpuPercent.toFixed(1)}%${hardwareResourceDisplay(entry.runtime).cpu}` : 'unavailable',
        entry.available ? `${formatBytes(entry.memoryBytes)}${hardwareResourceDisplay(entry.runtime).memory}` : 'unavailable'
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      tbody.append(row);
    }
  }

  renderSelected() {
    const entry = this.selectedEntry();
    const chart = this.element.querySelector('[data-role="selected-runtime-chart"]');
    if (!entry) {
      setText(this.element, 'selected-runtime-name', 'No runtimes');
      for (const role of ['selected-runtime-status', 'selected-runtime-cpu', 'selected-runtime-memory']) setText(this.element, role, '—');
      setText(this.element, 'selected-runtime-chart-title', 'Runtime CPU load');
      setText(this.element, 'selected-runtime-hardware', '');
      chart?.replaceChildren();
      return;
    }
    setText(this.element, 'selected-runtime-name', entry.name);
    const hardware = hardwareResourceDisplay(entry.runtime);
    setText(this.element, 'selected-runtime-status', hardware.status);
    setText(this.element, 'selected-runtime-cpu', entry.available ? `${entry.cpuPercent.toFixed(1)}%${hardware.cpu}` : 'unavailable');
    setText(this.element, 'selected-runtime-memory', entry.available ? `${formatBytes(entry.memoryBytes)}${hardware.memory}` : 'unavailable');
    setText(this.element, 'selected-runtime-hardware', [hardware.gpu, hardware.reason].filter(Boolean).join('. '));
    setText(this.element, 'selected-runtime-chart-title', `${entry.name} CPU load`);
    if (!chart) return;
    const samples = this.runtimeSamples.get(entry.key) || [];
    if (!samples.length) {
      const empty = document.createElement('p');
      empty.className = 'resource-chart-empty';
      empty.textContent = 'CPU metrics are unavailable for this runtime.';
      chart.replaceChildren(empty);
      return;
    }
    const cpuSamples = samples.map((sample) => sample.cpuPercent);
    renderLiveCpuChart(chart, [{ name: 'agents', samples: cpuSamples }], `${entry.name} CPU ${cpuSamples.at(-1).toFixed(1)}%`);
    appendLiveTimeline(chart, samples[0].timestamp, samples.at(-1).timestamp);
  }

  renderOverviewChart(totalCpu, agentsCpu, routerCpu, sampledAt) {
    this.samples.push({ timestamp: sampledAt, total: totalCpu, agents: agentsCpu, router: routerCpu });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    const chart = this.element.querySelector('[data-role="resource-chart"]');
    renderLiveCpuChart(chart, [
      { name: 'total', samples: this.samples.map((sample) => sample.total) },
      { name: 'agents', samples: this.samples.map((sample) => sample.agents) },
      { name: 'router', samples: this.samples.map((sample) => sample.router) }
    ], `Total CPU ${totalCpu.toFixed(1)}%, Agents CPU ${agentsCpu.toFixed(1)}%, Router CPU ${routerCpu.toFixed(1)}%`);
    appendLiveTimeline(chart, this.samples[0].timestamp, this.samples.at(-1).timestamp);
  }
}
