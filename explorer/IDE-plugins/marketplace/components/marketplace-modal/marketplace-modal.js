import {
  callExplorerTool,
  parseToolResult
} from '/explorer/services/infrastructure/explorerApi.js';
import {
  buildAgentSettingsItems
} from '/explorer/web-components/modals/settings-modal/settings-agent-model.js';
import {
  ensureSettingsComponentRegistered,
  resolvePluginSettingsUrl
} from '/explorer/web-components/modals/settings-modal/settings-component-loader.js';
import {
  flattenPluginsByKey,
  getCachedRuntimePlugins
} from '/explorer/web-components/modals/settings-modal/settings-plugin-model.js';
import {
  fetchMarketplaceProof
} from '/explorer/services/infrastructure/authApi.js';
import {
  isRetryableRuntimeStatusStreamError,
  publishRuntimeStatusEvents,
  RUNTIME_STATUS_UPDATED_EVENT
} from '/explorer/services/infrastructure/runtimeStatusEvents.js';
import {
    getVisibleMarketplaceCatalog,
    marketplaceAgentRepositoryName,
} from './marketplaceVisibility.js';

const RUNTIME_STATUS_RECONNECT_DELAY_MS = 1000;

const MARKETPLACE_AGENT_STATUS_LABELS = Object.freeze({
  disabled: 'Disabled',
  starting: 'Starting up',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  paused: 'Paused',
  unknown: 'Unknown'
});
const MARKETPLACE_AGENT_TRANSITIONAL_STATUSES = new Set(['starting']);
const MARKETPLACE_AGENT_STATUS_REFRESH_MS = 3000;

export class MarketplaceModal {
  constructor(element, invalidate) {
    this.element = element;
    this.invalidate = invalidate;
    this.state = {
      marketplace: null,
      activeTab: 'agents',
      busy: false,
      status: 'Loading marketplace...',
      statusType: '',
      agentSearchInput: '',
      agentSearchQuery: '',
      activeRepoKindTab: 'agents',
      expandedAgentRepos: {},
      agentSettingsRaw: [],
      agentSettingsItems: [],
      agentSettingsDataLoaded: false,
      agentSettingsBusyKey: '',
      agentMutationBusyRef: '',
      agentMutationVerb: ''
    };
    this.invalidate();
  }

  beforeRender() {}

  afterRender() {
    this.unloaded = false;
    this.repoNameInput = this.element.querySelector('#marketplaceRepoName');
    this.repoUrlInput = this.element.querySelector('#marketplaceRepoUrl');
    this.repoBranchInput = this.element.querySelector('#marketplaceRepoBranch');
    this.addRepoButton = this.element.querySelector('#marketplaceAddRepo');
    this.statusEl = this.element.querySelector('#marketplaceStatus');
    this.repositoriesEl = this.element.querySelector('#marketplaceRepositories');
    this.agentsEl = this.element.querySelector('#marketplaceAgents');
    this.agentSearchInput = this.element.querySelector('#marketplaceAgentSearch');
    this.tabButtons = Array.from(this.element.querySelectorAll('[data-tab]'));
    this.tabPanels = Array.from(this.element.querySelectorAll('[data-panel]'));
    this.repoKindButtons = Array.from(this.element.querySelectorAll('[data-repo-kind-tab]'));

    this.element.querySelector('[data-action="close"]')?.addEventListener('click', this.close);
    this.addRepoButton?.addEventListener('click', this.addRepository);
    this.repoUrlInput?.addEventListener('input', this.suggestRepoName);
    this.agentSearchInput?.addEventListener('input', this.handleAgentSearchInput);
    this.agentsEl?.addEventListener('click', this.handleAgentClick);
    this.repositoriesEl?.addEventListener('click', this.handleRepositoryClick);
    this.tabButtons.forEach(button => button.addEventListener('click', this.switchTab));
    this.repoKindButtons.forEach(button => button.addEventListener('click', this.switchRepoKindTab));

    this.renderState();
    if (!this.state.marketplace && !this.loadingStarted) {
      this.loadingStarted = true;
      this.loadMarketplace();
    } else if (this.canManageMarketplace() && !this.state.agentSettingsDataLoaded) {
      this.loadAgentSettingsData()
        .then(() => {
          this.renderAgents();
          this.syncInteractiveState();
        })
        .catch((error) => {
          this.setStatus(error?.message || 'Failed to load agent settings.', 'error');
        });
    }
    this.startAgentStatusStream();
  }

  afterUnload() {
    this.stopAgentStatusStream();
    this.unloaded = true;
    if (this.statusClearTimer) {
      clearTimeout(this.statusClearTimer);
      this.statusClearTimer = null;
    }
    if (this.agentSearchTimer) {
      clearTimeout(this.agentSearchTimer);
      this.agentSearchTimer = null;
    }
    if (this.agentStatusRefreshTimer) {
      clearTimeout(this.agentStatusRefreshTimer);
      this.agentStatusRefreshTimer = null;
    }
    this.element.querySelector('[data-action="close"]')?.removeEventListener('click', this.close);
    this.addRepoButton?.removeEventListener('click', this.addRepository);
    this.repoUrlInput?.removeEventListener('input', this.suggestRepoName);
    this.agentSearchInput?.removeEventListener('input', this.handleAgentSearchInput);
    this.agentsEl?.removeEventListener('click', this.handleAgentClick);
    this.repositoriesEl?.removeEventListener('click', this.handleRepositoryClick);
    this.tabButtons?.forEach(button => button.removeEventListener('click', this.switchTab));
    this.repoKindButtons?.forEach(button => button.removeEventListener('click', this.switchRepoKindTab));
  }

  close = () => {
    const dialog = this.element.closest('dialog');
    if (dialog && typeof dialog.close === 'function') {
      dialog.close();
      return;
    }
    window.close();
    setTimeout(() => {
      window.assistOS?.UI?.changeToDynamicPage?.('file-exp', 'file-exp');
    }, 100);
  };

  closeModal() {
    this.close();
  }

  setStatus(message, type = '') {
    if (this.statusClearTimer) {
      clearTimeout(this.statusClearTimer);
      this.statusClearTimer = null;
    }
    this.state.status = message;
    this.state.statusType = type;
    this.renderStatus();
  }

  dismissStatus = () => {
    this.setStatus('');
  };

  setBusy(busy) {
    this.state.busy = Boolean(busy);
    this.syncInteractiveState();
  }

  switchTab = (event) => {
    const tab = event.currentTarget?.dataset?.tab || 'agents';
    this.state.activeTab = tab === 'repos' ? 'repos' : 'agents';
    this.renderTabs();
  };

  switchRepoKindTab = (event) => {
    const tab = event.currentTarget?.dataset?.repoKindTab || 'agents';
    this.state.activeRepoKindTab = ['agents', 'others'].includes(tab) ? tab : 'agents';
    this.renderRepoKindTabs();
    this.renderRepositories();
    this.syncInteractiveState();
  };

  async requestMarketplace(actionBody = null, options = {}) {
    const fetchOptions = {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    };
    let url = '/api/marketplace';
    if (actionBody) {
      fetchOptions.method = 'POST';
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(actionBody);
    }

    const sendRequest = async () => {
      if (actionBody) {
        const proof = await fetchMarketplaceProof();
        delete fetchOptions.headers['x-ploinky-csrf-token'];
        delete fetchOptions.headers['x-ploinky-browser-csrf-token'];
        fetchOptions.headers[proof.header] = proof.csrfToken;
      }
      const response = await fetch(url, fetchOptions);
      const data = await response.json().catch(() => ({}));
      return { response, data };
    };

    let { response, data } = await sendRequest();
    if (actionBody && response.status === 403 && ['csrf_invalid', 'browser_csrf_invalid'].includes(data?.error)) {
      ({ response, data } = await sendRequest());
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.error || `Marketplace request failed (${response.status})`);
    }
    return options.raw === true ? data : data.marketplace;
  }

  async loadMarketplace() {
    this.setBusy(true);
    try {
      this.state.marketplace = await this.requestMarketplace();
      if (this.canManageMarketplace()) {
        await this.loadAgentSettingsData();
        this.startAgentStatusStream();
      }
      this.setStatus('');
    } catch (error) {
      this.setStatus(error?.message || 'Failed to load marketplace.', 'error');
    } finally {
      this.state.busy = false;
      this.renderState();
    }
  }

  startAgentStatusStream() {
    if (this.agentStatusStreamActive || !this.canManageMarketplace()) return;
    this.agentStatusStreamActive = true;
    window.addEventListener(RUNTIME_STATUS_UPDATED_EVENT, this.handleRuntimeStatusUpdated);
    this.openAgentStatusStream();
  }

  stopAgentStatusStream() {
    this.agentStatusStreamActive = false;
    window.removeEventListener(RUNTIME_STATUS_UPDATED_EVENT, this.handleRuntimeStatusUpdated);
    this.agentStatusStreamController?.abort();
    this.agentStatusStreamController = null;
    if (this.agentStatusReconnectTimer) {
      clearTimeout(this.agentStatusReconnectTimer);
      this.agentStatusReconnectTimer = null;
    }
  }

  openAgentStatusStream() {
    if (!this.agentStatusStreamActive || this.agentStatusStreamController) return;
    const controller = new AbortController();
    this.agentStatusStreamController = controller;
    publishRuntimeStatusEvents({signal: controller.signal})
      .catch((error) => {
        if (isRetryableRuntimeStatusStreamError(error)) return;
        this.agentStatusStreamActive = false;
        window.removeEventListener(RUNTIME_STATUS_UPDATED_EVENT, this.handleRuntimeStatusUpdated);
      })
      .finally(() => {
        if (this.agentStatusStreamController === controller) {
          this.agentStatusStreamController = null;
        }
        if (!this.agentStatusStreamActive || controller.signal.aborted) return;
        this.agentStatusReconnectTimer = setTimeout(() => {
          this.agentStatusReconnectTimer = null;
          this.openAgentStatusStream();
        }, RUNTIME_STATUS_RECONNECT_DELAY_MS);
      });
  }

  handleRuntimeStatusUpdated = (event) => {
    const {agents} = getVisibleMarketplaceCatalog(this.state.marketplace);
    const runtimes = Array.isArray(event?.detail?.runtimes) ? event.detail.runtimes : [];
    if (!Array.isArray(agents)) return;
    const runtimesByRef = new Map(runtimes.map((runtime) => [
      `${String(runtime?.repoName || '')}/${String(runtime?.agentName || '')}`,
      runtime
    ]));
    let changed = false;
    for (const agent of agents) {
      const agentRef = String(agent?.ref || `${agent?.repo || ''}/${agent?.name || ''}`);
      const runtime = runtimesByRef.get(agentRef);
      const active = runtime?.enabled === true;
      const running = runtime?.state?.running === true;
      const status = runtime
        ? String(runtime?.state?.status || (active ? 'stopped' : 'inactive')).toLowerCase()
        : 'inactive';
      if (agent.active === active && agent.status === status && agent.running === running) continue;
      if (agent.status !== status || agent.active !== active || agent.running !== running) delete agent.statusDetail;
      agent.active = active;
      agent.status = status;
      agent.running = running;
      this.updateAgentRuntimeUi(agent);
      changed = true;
    }
    if (changed) {
      this.syncInteractiveState();
      this.scheduleAgentStatusRefresh();
    }
  };

  updateAgentRuntimeUi(agent) {
    const agentRef = String(agent?.ref || `${agent?.repo || ''}/${agent?.name || ''}`);
    const rows = this.agentsEl?.querySelectorAll?.('[data-marketplace-agent-ref]') || [];
    const row = Array.from(rows).find(candidate => candidate.dataset.marketplaceAgentRef === agentRef);
    if (!row) return;

    const status = row.querySelector('.marketplace-agent-status');
    if (status) this.updateAgentStatusElement(status, agent);

    const settingsButton = row.querySelector('[data-agent-settings-key]');
    if (settingsButton) this.updateAgentSettingsButton(settingsButton, agent);

    const toggle = row.querySelector('[data-agent-ref]');
    if (toggle) {
      toggle.dataset.active = agent.active ? 'true' : 'false';
      toggle.classList.toggle('active', agent.active === true);
      toggle.textContent = this.state.agentMutationBusyRef === agentRef
        ? `${this.state.agentMutationVerb || (agent.active ? 'Disabling' : 'Enabling')}...`
        : (agent.active ? 'Disable' : 'Enable');
    }
  }

  async loadAgentSettingsData() {
    let pluginsByLocation = getCachedRuntimePlugins();
    if (!pluginsByLocation) {
      const pluginsPayload = await callExplorerTool('collect_ide_plugins', {}, { raw: true, withLoader: false });
      pluginsByLocation = parseToolResult(pluginsPayload) || {};
    }
    this.state.agentSettingsRaw = Array.isArray(pluginsByLocation?.agentSettings)
      ? pluginsByLocation.agentSettings
      : [];
    const pluginItems = flattenPluginsByKey(pluginsByLocation);
    this.state.agentSettingsItems = buildAgentSettingsItems(this.state.agentSettingsRaw, pluginItems, { isAdmin: true });
    this.state.agentSettingsDataLoaded = true;
  }

  suggestRepoName = () => {
    if (!this.repoNameInput || this.repoNameInput.value.trim()) return;
    const url = String(this.repoUrlInput?.value || '').trim();
    const match = url.match(/\/([^/?#]+?)(?:\.git)?(?:[?#].*)?$/);
    if (!match) return;
    const name = match[1].replace(/[^a-zA-Z0-9_.-]+/g, '-');
    if (name) this.repoNameInput.value = name;
  };

  handleAgentSearchInput = (event) => {
    const value = String(event.target?.value || '').trim();
    this.state.agentSearchInput = value;
    if (this.agentSearchTimer) {
      clearTimeout(this.agentSearchTimer);
    }
    this.agentSearchTimer = setTimeout(() => {
      this.agentSearchTimer = null;
      this.state.agentSearchQuery = this.state.agentSearchInput;
      this.renderAgents();
      this.syncInteractiveState();
    }, 500);
  };

  addRepository = async () => {
    if (this.state.busy || this.state.agentMutationBusyRef) return;
    const name = String(this.repoNameInput?.value || '').trim();
    const url = String(this.repoUrlInput?.value || '').trim();
    const branch = String(this.repoBranchInput?.value || '').trim();
    if (!url) {
      this.setStatus('Repository URL is required.', 'error');
      return;
    }
    this.setBusy(true);
    this.setStatus(`Installing ${name || url}...`);
    try {
      const response = await this.requestMarketplace({
        action: 'install_repo',
        url,
        ...(name ? { name } : {}),
        ...(branch ? { branch } : {})
      }, { raw: true });
      this.state.marketplace = response?.marketplace || response;
      this.repoNameInput.value = '';
      this.repoUrlInput.value = '';
      this.repoBranchInput.value = '';
      const result = response?.result || {};
      this.setStatus(`${result.name || name || url} installed.`);
    } catch (error) {
      this.setStatus(error?.message || 'Failed to install repository.', 'error');
    } finally {
      this.state.busy = false;
      this.renderState();
    }
  };

  handleAgentClick = async (event) => {
    if (this.state.busy) return;

    const repoToggle = event.target?.closest?.('[data-repo-tree-toggle]');
    if (repoToggle) {
      this.toggleAgentRepo(repoToggle.dataset.repoName || '');
      return;
    }

    const settingsButton = event.target?.closest?.('[data-agent-settings-key]');
    if (settingsButton) {
      if (settingsButton.disabled || settingsButton.dataset.agentOperational !== 'true') return;
      await this.openAgentSettings(settingsButton.dataset.agentSettingsKey || '');
      return;
    }

    const button = event.target?.closest?.('[data-agent-ref]');
    if (!button) return;
    if (this.state.agentMutationBusyRef) return;

    const agentRef = button.dataset.agentRef || '';
    const active = button.dataset.active === 'true';
    const controls = button.closest?.('.marketplace-agent-controls');
    const modeSelect = controls?.querySelector?.('[data-enable-mode-for]');
    const mode = String(modeSelect?.value || button.dataset.enableMode || 'isolated').trim() || 'isolated';

    this.state.agentMutationBusyRef = agentRef;
    this.state.agentMutationVerb = active ? 'Disabling' : 'Enabling';
    this.setStatus(`${this.state.agentMutationVerb} ${agentRef}...`);
    this.renderAgents();
    this.syncInteractiveState();
    try {
      this.state.marketplace = await this.requestMarketplace({
        action: active ? 'disable_agent' : 'enable_agent',
        agentRef,
        ...(!active ? { mode } : {})
      });
      this.setStatus(`${agentRef} ${active ? 'disabled' : 'enabled'}.`);
    } catch (error) {
      this.setStatus(error?.message || 'Failed to update agent.', 'error');
    } finally {
      this.state.agentMutationBusyRef = '';
      this.state.agentMutationVerb = '';
      this.renderState();
    }
  };

  normalizeAgentSettingsMatchKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  getAgentSettingsCandidates(agent) {
    const repo = String(agent?.repo || '').trim();
    const name = String(agent?.name || '').trim();
    const ref = String(agent?.ref || '').trim();
    return new Set([
      ref,
      name,
      repo && name ? `${repo}/${name}` : '',
      ref.includes('/') ? ref.split('/').pop() : ''
    ].map((value) => this.normalizeAgentSettingsMatchKey(value)).filter(Boolean));
  }

  getAgentSettingsItem(agent) {
    const candidates = this.getAgentSettingsCandidates(agent);
    return (this.state.agentSettingsItems || []).find((item) => {
      if (!item?.available) return false;
      const ownerAgent = this.normalizeAgentSettingsMatchKey(item.ownerAgent);
      const key = this.normalizeAgentSettingsMatchKey(item.key);
      return candidates.has(ownerAgent) || candidates.has(key);
    }) || null;
  }

  async openAgentSettings(key) {
    if (!key || !this.canManageMarketplace()) return;
    if (!this.state.agentSettingsDataLoaded) {
      await this.loadAgentSettingsData();
    }
    const item = (this.state.agentSettingsItems || []).find((entry) => entry?.key === key);
    if (!item || !item.available || !item.sourcePlugin || (!item.settingsUrl && !item.settingsComponent)) {
      this.setStatus('Agent settings are not available.', 'error');
      return;
    }

    this.state.agentSettingsBusyKey = key;
    this.syncInteractiveState();

    try {
      if (item.settingsUrl) {
        if (!this.openAgentSettingsUrlPopup(item)) {
          throw new Error(`Invalid settings URL for ${key}.`);
        }
        this.setStatus(`${item.label || item.component} settings opened.`);
        return;
      }

      await ensureSettingsComponentRegistered({
        ...item.sourcePlugin,
        settingsComponent: item.settingsComponent
      });
      const modal = await assistOS.UI.createReactiveModal(item.settingsComponent, {
        agentSettings: {
          key: item.key,
          label: item.label,
          ownerAgent: item.ownerAgent,
          scope: item.scope,
          settingsComponent: item.settingsComponent,
          settingsUrl: item.settingsUrl,
          assetRootPath: item.assetRootPath
        }
      });
      modal?.classList?.add?.('marketplace-agent-settings-dialog');
      this.setStatus(`${item.label} settings opened.`);
    } catch (error) {
      this.setStatus(error?.message || `Failed to open settings for ${key}.`, 'error');
    } finally {
      this.state.agentSettingsBusyKey = '';
      this.syncInteractiveState();
    }
  }

  openAgentSettingsUrlPopup(item) {
    const settingsUrl = resolvePluginSettingsUrl(item);
    if (!settingsUrl) return false;

    const dialog = document.createElement('dialog');
    dialog.className = 'modal marketplace-agent-settings-dialog';

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = item.label || item.key || 'Agent settings';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'marketplace-agent-settings-close';
    closeButton.setAttribute('aria-label', 'Close settings');
    closeButton.textContent = 'Close';

    const body = document.createElement('div');
    body.className = 'marketplace-agent-settings-dialog-body';

    const frame = document.createElement('iframe');
    frame.className = 'marketplace-agent-settings-frame';
    frame.title = title.textContent;
    frame.src = settingsUrl;

    body.append(frame);
    header.append(title, closeButton);
    dialog.append(header, body);
    document.body.append(dialog);

    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
    return true;
  }

  toggleAgentRepo = (repoName) => {
    const name = String(repoName || '').trim();
    if (!name) return;
    const expandedAgentRepos = { ...(this.state.expandedAgentRepos || {}) };
    expandedAgentRepos[name] = !Boolean(expandedAgentRepos[name]);
    this.state.expandedAgentRepos = expandedAgentRepos;
    this.renderAgents();
    this.syncInteractiveState();
  };

  handleRepositoryClick = async (event) => {
    const button = event.target?.closest?.('[data-repo-name]');
    if (!button || this.state.busy || this.state.agentMutationBusyRef) return;
    const name = button.dataset.repoName || '';
    const installed = button.dataset.installed === 'true';
    const url = button.dataset.repoUrl || '';
    this.setBusy(true);
    this.setStatus(`${installed ? 'Uninstalling' : 'Installing'} ${name || url}...`);
    try {
      const payload = installed
        ? { action: 'uninstall_repo', target: name || url }
        : { action: 'install_repo', url, ...(name ? { name } : {}) };
      const response = await this.requestMarketplace(payload, { raw: true });
      this.state.marketplace = response?.marketplace || response;
      const resultName = response?.result?.name || name || url;
      this.setStatus(`${resultName} ${installed ? 'uninstalled' : 'installed'}.`);
    } catch (error) {
      this.setStatus(error?.message || 'Failed to update repository installation.', 'error');
    } finally {
      this.state.busy = false;
      this.renderState();
    }
  };

  renderStatus() {
    if (!this.statusEl) return;
    const message = this.state.status || '';
    const isError = this.state.statusType === 'error';
    this.statusEl.replaceChildren();
    this.statusEl.classList.toggle('error', isError);
    this.statusEl.setAttribute('role', isError ? 'alert' : 'status');
    if (!message) return;
    const text = document.createElement('span');
    text.textContent = message;
    this.statusEl.append(text);
    if (isError) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'marketplace-status-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss error');
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', this.dismissStatus, { once: true });
      this.statusEl.append(dismiss);
    }
  }

  syncInteractiveState() {
    const busy = this.state.busy === true;
    const mutationBusy = Boolean(this.state.agentMutationBusyRef);
    const canManage = this.canManageMarketplace();
    if (this.addRepoButton) this.addRepoButton.disabled = busy || mutationBusy;

    this.repositoriesEl?.querySelectorAll?.('[data-repo-name]')?.forEach((button) => {
      const unavailable = button.dataset.installed !== 'true' && !button.dataset.repoUrl;
      button.disabled = busy || mutationBusy || unavailable;
    });
    this.agentsEl?.querySelectorAll?.('[data-agent-ref]')?.forEach((button) => {
      button.disabled = busy || mutationBusy;
    });
    this.agentsEl?.querySelectorAll?.('[data-agent-settings-key]')?.forEach((button) => {
      const isOperational = button.dataset.agentOperational === 'true';
      button.disabled = busy
        || !isOperational
        || this.state.agentSettingsBusyKey === button.dataset.agentSettingsKey;
      button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    });
    this.agentsEl?.querySelectorAll?.('[data-enable-mode-for]')?.forEach((select) => {
      const toggle = select.closest?.('.marketplace-agent-controls')?.querySelector?.('[data-agent-ref]');
      const isPendingAgent = select.dataset.enableModeFor === this.state.agentMutationBusyRef;
      const disabled = busy || isPendingAgent || !canManage || toggle?.dataset.active === 'true';
      select.toggleAttribute('disabled', disabled);
      select.webSkelPresenter?.applyDisabledState?.();
    });
  }

  renderState() {
    this.renderTabs();
    const canManage = this.canManageMarketplace();
    this.renderStatus();
    if (this.agentSearchInput && this.agentSearchInput.value !== this.state.agentSearchInput) {
      this.agentSearchInput.value = this.state.agentSearchInput;
    }
    this.element.querySelector('.marketplace-repo-tools')?.classList.toggle('hidden', !canManage);
    this.renderRepoKindTabs();
    this.renderRepositories();
    this.renderAgents();
    this.syncInteractiveState();
    this.scheduleAgentStatusRefresh();
  }

  canManageMarketplace() {
    return this.state.marketplace?.permissions?.canManage === true;
  }

  renderTabs() {
    const active = this.state.activeTab || 'agents';
    this.tabButtons?.forEach(button => {
      const isActive = button.dataset.tab === active;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    this.tabPanels?.forEach(panel => {
      const isActive = panel.dataset.panel === active;
      panel.classList.toggle('hidden', !isActive);
      panel.hidden = !isActive;
    });
  }

  renderRepoKindTabs() {
    const active = ['agents', 'others'].includes(this.state.activeRepoKindTab)
      ? this.state.activeRepoKindTab
      : 'agents';
    this.repoKindButtons?.forEach(button => {
      const isActive = button.dataset.repoKindTab === active;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  repoMatchesKindTab(repo, activeTab = this.state.activeRepoKindTab) {
    const kind = String(repo?.kind || '').trim().toLowerCase();
    if (activeTab === 'others') {
      return kind !== 'agents' && kind !== 'skills' && kind !== 'mixed';
    }
    return kind === 'agents';
  }

  renderRepositories() {
    if (!this.repositoriesEl) return;
    const {repositories} = getVisibleMarketplaceCatalog(this.state.marketplace);
    if (!repositories.length) {
      this.repositoriesEl.innerHTML = '<div class="marketplace-empty">No repositories found.</div>';
      return;
    }
    const activeRepoKindTab = ['agents', 'others'].includes(this.state.activeRepoKindTab)
      ? this.state.activeRepoKindTab
      : 'agents';
    const filteredRepositories = repositories.filter(repo => this.repoMatchesKindTab(repo, activeRepoKindTab));
    if (!filteredRepositories.length) {
      const label = activeRepoKindTab === 'others' ? 'other' : 'agent';
      this.repositoriesEl.innerHTML = `<div class="marketplace-empty">No ${label} repositories found.</div>`;
      return;
    }

    this.repositoriesEl.replaceChildren(...filteredRepositories.map(repo => {
      const canManage = this.canManageMarketplace();
      const row = document.createElement('article');
      row.className = 'marketplace-row';
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'marketplace-title';
      title.textContent = repo.name;
      const description = document.createElement('div');
      description.className = 'marketplace-description';
      description.textContent = repo.description || repo.url || '';
      const activeAgentsCount = Number(repo.activeAgentsCount || 0);
      const note = document.createElement('div');
      note.className = 'marketplace-meta';
      note.textContent = activeAgentsCount > 0
        ? `${activeAgentsCount} enabled agent${activeAgentsCount === 1 ? '' : 's'} will be removed if this repo is uninstalled.`
        : '';
      info.append(title, description);
      if (note.textContent) info.append(note);
      row.append(info);
      if (canManage) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `marketplace-repo-toggle${repo.installed ? ' active' : ''}`;
        toggle.dataset.repoName = repo.name;
        toggle.dataset.repoUrl = repo.url || '';
        toggle.dataset.installed = repo.installed ? 'true' : 'false';
        toggle.disabled = this.state.busy || Boolean(this.state.agentMutationBusyRef) || (!repo.installed && !repo.url);
        toggle.textContent = repo.installed ? 'Uninstall' : 'Install';
        row.append(toggle);
      }
      return row;
    }));
  }

  getAgentDisplayName(agent) {
    const ref = String(agent?.ref || '').trim();
    if (ref.includes('/')) {
      const parts = ref.split('/');
      return parts[parts.length - 1] || ref;
    }
    if (agent?.name) return String(agent.name);
    return ref || 'Unknown agent';
  }

  getAgentLifecycleStatus(agent) {
    if (agent?.active !== true) return 'disabled';
    if (agent?.running === true) return 'running';

    const status = String(agent?.status || '').trim().toLowerCase();
    if (status === 'running') {
      return agent?.running === false ? 'stopped' : 'running';
    }
    if (Object.hasOwn(MARKETPLACE_AGENT_STATUS_LABELS, status) && status !== 'disabled') {
      return status;
    }
    return 'unknown';
  }

  getAgentStatusPresentation(agent) {
    const status = this.getAgentLifecycleStatus(agent);
    return {
      status,
      label: MARKETPLACE_AGENT_STATUS_LABELS[status],
      detail: String(agent?.statusDetail || '').trim()
    };
  }

  isAgentOperational(agent) {
    return this.getAgentLifecycleStatus(agent) === 'running' && agent?.running === true;
  }

  updateAgentStatusElement(element, agent) {
    const presentation = this.getAgentStatusPresentation(agent);
    element.className = `marketplace-agent-status ${presentation.status}`;
    element.textContent = presentation.label;
    element.setAttribute('aria-label', `${this.getAgentDisplayName(agent)} status: ${presentation.label}`);
    if (presentation.detail) element.title = presentation.detail;
    else element.removeAttribute('title');
  }

  updateAgentSettingsButton(button, agent) {
    const isOperational = this.isAgentOperational(agent);
    button.dataset.agentOperational = isOperational ? 'true' : 'false';
    button.disabled = this.state.busy
      || !isOperational
      || this.state.agentSettingsBusyKey === button.dataset.agentSettingsKey;
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    if (isOperational) button.removeAttribute('title');
    else button.title = `Configure is available once ${this.getAgentDisplayName(agent)} is running.`;
  }

  hasTransitionalAgents() {
    return getVisibleMarketplaceCatalog(this.state.marketplace).agents.some(agent => (
      MARKETPLACE_AGENT_TRANSITIONAL_STATUSES.has(this.getAgentLifecycleStatus(agent))
    ));
  }

  scheduleAgentStatusRefresh() {
    if (this.agentStatusRefreshTimer) {
      clearTimeout(this.agentStatusRefreshTimer);
      this.agentStatusRefreshTimer = null;
    }
    if (this.unloaded || !this.hasTransitionalAgents()) return;
    this.agentStatusRefreshTimer = setTimeout(() => {
      this.agentStatusRefreshTimer = null;
      void this.refreshAgentStatuses();
    }, MARKETPLACE_AGENT_STATUS_REFRESH_MS);
  }

  async refreshAgentStatuses() {
    if (this.unloaded) return;
    if (this.state.busy || this.state.agentMutationBusyRef) {
      this.scheduleAgentStatusRefresh();
      return;
    }
    try {
      const marketplace = await this.requestMarketplace();
      if (this.unloaded) return;
      this.state.marketplace = marketplace;
      this.renderRepositories();
      this.renderAgents();
      this.syncInteractiveState();
    } catch {
      // Keep the last verified lifecycle state visible during transient polling failures.
    } finally {
      this.scheduleAgentStatusRefresh();
    }
  }

  renderAgents() {
    if (!this.agentsEl) return;
    const {repositories, agents} = getVisibleMarketplaceCatalog(this.state.marketplace);
    const canManage = this.canManageMarketplace();
    const noRepoName = '__no_repo__';
    const noRepoLabel = '(No repository)';

    if (!repositories.length && !agents.length) {
      this.agentsEl.innerHTML = '<div class="marketplace-empty">No agents found.</div>';
      return;
    }

    const agentsByRepo = new Map();
    for (const agent of agents) {
      const repoName = marketplaceAgentRepositoryName(agent) || noRepoName;
      const list = agentsByRepo.get(repoName);
      if (list) {
        list.push(agent);
      } else {
        agentsByRepo.set(repoName, [agent]);
      }
    }

    const repoEntries = [];
    const usedRepoNames = new Set();
    for (const repo of repositories) {
      const repoName = String(repo?.name || '').trim() || noRepoName;
      usedRepoNames.add(repoName);
      repoEntries.push({
        repoName,
        repoLabel: repoName === noRepoName ? noRepoLabel : repoName,
        repo,
        agents: agentsByRepo.get(repoName) || [],
        hasMetadata: true
      });
    }

    for (const [repoName, list] of agentsByRepo.entries()) {
      if (usedRepoNames.has(repoName)) continue;
      repoEntries.push({
        repoName,
        repoLabel: repoName === noRepoName ? noRepoLabel : repoName,
        repo: { name: repoName === noRepoName ? '' : repoName },
        agents: list,
        hasMetadata: false
      });
    }

    const query = String(this.state.agentSearchQuery || '').trim().toLowerCase();
    const hasQuery = Boolean(query);
    const queryIncludes = (value) => String(value || '').toLowerCase().includes(query);

    const filteredEntries = repoEntries.filter(entry => {
      const repo = entry.repo || {};
      const repoMatches = !hasQuery
        ? true
        : [
            entry.repoLabel,
            repo.url,
            repo.description,
            repo.kind
          ].some(value => queryIncludes(value));

      const matchingAgents = hasQuery
        ? entry.agents.filter(agent => {
            const searchValues = [
              agent.ref,
              agent.repo,
              agent.name,
              `${agent.repo || ''}/${agent.name || ''}`
            ];
            return searchValues.some(value => queryIncludes(value));
          })
        : [];

      entry.matchingAgents = matchingAgents;
      return !hasQuery || repoMatches || matchingAgents.length > 0;
    });

    if (!filteredEntries.length) {
      this.agentsEl.innerHTML = '<div class="marketplace-empty">No agents or repositories match the search.</div>';
      return;
    }

    const createAgentRow = (agent) => {
      const row = document.createElement('article');
      row.className = 'marketplace-row marketplace-agent-row';
      row.dataset.marketplaceAgentRef = agent.ref;

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'marketplace-title';
      const name = document.createElement('span');
      name.textContent = this.getAgentDisplayName(agent);
      const status = document.createElement('span');
      this.updateAgentStatusElement(status, agent);
      title.append(name, status);

      const about = document.createElement('div');
      about.className = 'marketplace-description';
      about.textContent = agent.about || 'No description';
      info.append(title, about);

      row.append(info);
      const controls = document.createElement('div');
      controls.className = 'marketplace-agent-controls';
      const isPendingAgent = this.state.agentMutationBusyRef === agent.ref;

      const modes = Array.isArray(agent.enableModes) && agent.enableModes.length
        ? agent.enableModes
        : ['isolated', 'global', 'devel'];
      const currentMode = modes.includes(agent.enableMode) ? agent.enableMode : 'isolated';
      const modeSelect = document.createElement('select');
      modeSelect.className = 'marketplace-enable-mode';
      modeSelect.dataset.enableModeFor = agent.ref;
      modeSelect.name = 'enableMode';
      modeSelect.setAttribute('aria-label', `Runtime mode for ${this.getAgentDisplayName(agent)}`);
      modeSelect.disabled = this.state.busy || isPendingAgent || !canManage || agent.active;
      for (const mode of modes) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        option.selected = mode === currentMode;
        modeSelect.append(option);
      }
      controls.append(modeSelect);

      if (canManage) {
        const settingsItem = this.getAgentSettingsItem(agent);
        if (settingsItem) {
          const settingsButton = document.createElement('button');
          settingsButton.type = 'button';
          settingsButton.className = 'marketplace-agent-settings';
          settingsButton.dataset.agentSettingsKey = settingsItem.key;
          this.updateAgentSettingsButton(settingsButton, agent);
          settingsButton.textContent = 'Configure';
          controls.append(settingsButton);
        }

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `marketplace-agent-toggle${agent.active ? ' active' : ''}`;
        toggle.dataset.agentRef = agent.ref;
        toggle.dataset.active = agent.active ? 'true' : 'false';
        toggle.dataset.enableMode = currentMode;
        toggle.disabled = this.state.busy || Boolean(this.state.agentMutationBusyRef);
        toggle.textContent = isPendingAgent
          ? `${this.state.agentMutationVerb || (agent.active ? 'Disabling' : 'Enabling')}...`
          : (agent.active ? 'Disable' : 'Enable');
        controls.append(toggle);
      } else {
        // The mode selector has already been appended to controls.
      }

      row.append(controls);
      return row;
    };

    this.agentsEl.replaceChildren(...filteredEntries.map(entry => {
      const repoMatches = !hasQuery
        ? false
        : [
            entry.repoLabel,
            entry.repo.url,
            entry.repo.description,
            entry.repo.kind
          ].some(value => queryIncludes(value));
      const hasAgentMatches = hasQuery ? entry.matchingAgents.length > 0 : false;
      const isExpandedBySearch = hasQuery && (repoMatches || hasAgentMatches);
      const isExpanded = Boolean(isExpandedBySearch || this.state.expandedAgentRepos?.[entry.repoName]);
      const visibleAgents = hasQuery ? entry.matchingAgents : entry.agents;
      const hasAgents = (entry.agents || []).length > 0;

      const wrapper = document.createElement('article');
      wrapper.className = 'marketplace-repo-tree-node';

      const header = document.createElement('div');
      header.className = 'marketplace-row marketplace-repo-row';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `marketplace-tree-toggle${isExpanded ? ' expanded' : ''}`;
      toggle.dataset.repoTreeToggle = '1';
      toggle.dataset.repoName = entry.repoName;
      toggle.disabled = !hasAgents;
      toggle.setAttribute('aria-expanded', String(Boolean(isExpanded)));
      toggle.setAttribute('aria-label', `${isExpanded ? 'Collapse' : 'Expand'} agents for ${entry.repoLabel}`);
      const arrow = document.createElement('span');
      arrow.className = 'marketplace-tree-arrow';
      arrow.textContent = '›';
      toggle.append(arrow);

      const info = document.createElement('div');
      info.className = 'marketplace-repo-info';
      const title = document.createElement('div');
      title.className = 'marketplace-title marketplace-repo-title';
      title.textContent = entry.repoLabel;
      info.append(title);

      header.append(toggle, info);

      const children = document.createElement('div');
      children.className = 'marketplace-agent-tree-children';
      children.dataset.repoName = entry.repoName;
      children.hidden = !isExpanded;

      if (visibleAgents.length > 0) {
        children.replaceChildren(...visibleAgents.map(createAgentRow));
      } else {
        children.innerHTML = `<div class="marketplace-empty marketplace-tree-empty">${
          hasQuery ? 'No agents match the search in this repository.' : 'No agents in this repository.'
        }</div>`;
      }

      wrapper.append(header, children);
      return wrapper;
    }));
  }
}
