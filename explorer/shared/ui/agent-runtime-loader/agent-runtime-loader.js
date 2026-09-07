import { registerRuntimeComponent } from '../runtime-component-registration.js';

const COMPONENT_NAME = 'agent-runtime-loader';
const COMPONENT_BASE_URL = '/explorer/shared/ui/agent-runtime-loader/agent-runtime-loader';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 180000;
const TERMINAL_RUNTIME_STATES = new Set(['dead', 'exited', 'failed']);
let registrationPromise = null;

function describeError(error, fallback = 'The agent did not become available.') {
    return String(error?.message || fallback).trim() || fallback;
}

function isPermanentRequestError(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    return [400, 401, 403, 422].includes(status);
}

export async function readMarketplaceAgent(agentRef) {
    try {
        const response = await fetch('/api/marketplace', {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return null;
        const payload = await response.json();
        const agents = payload?.marketplace?.agents || payload?.agents || [];
        return Array.isArray(agents)
            ? agents.find((entry) => String(entry?.ref || '') === agentRef) || null
            : null;
    } catch (_) {
        return null;
    }
}

export function isAgentRuntimeStartupError(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || '').toLowerCase();
    const message = describeError(error, '').toLowerCase();
    return [502, 503, 504].includes(status)
        || ['agent_not_ready', 'target_inactive', 'agent_runtime_inactive'].includes(code)
        || /still starting|not ready|bad gateway|service unavailable|failed to fetch|fetch failed|agent runtime inactive|target inactive/.test(message);
}

export function isTerminalAgentRuntimeState(status) {
    return TERMINAL_RUNTIME_STATES.has(String(status || '').toLowerCase());
}

export async function waitForAgentRuntimeAvailability(config = {}) {
    const now = config.now || Date.now;
    const startedAt = now();
    const pollIntervalMs = Math.max(250, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = Math.max(1000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const readRuntime = config.readRuntime || readMarketplaceAgent;
    const wait = config.wait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    let lastError = null;

    while (!config.cancelled?.()) {
        const runtime = config.agentRef ? await readRuntime(config.agentRef) : null;
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        if (runtime?.active === false) {
            const modeHint = config.enableMode ? ` using ${config.enableMode} mode` : '';
            const error = new Error(`${config.label || 'Agent'} is disabled. An administrator can enable it in Marketplace${modeHint}. Retry after enabling it.`);
            error.code = 'agent_disabled';
            throw error;
        }
        if (isTerminalAgentRuntimeState(runtimeStatus)) {
            const detail = lastError ? describeError(lastError) : '';
            throw new Error(detail || `${config.label || 'Agent'} failed to start (${runtimeStatus}).`);
        }
        if (config.cancelled?.()) return undefined;
        if (runtime && runtime.running !== true) {
            if (now() - startedAt >= timeoutMs) {
                throw new Error(`${config.label || 'Agent'} did not become ready before the startup timeout.`);
            }
            await wait(pollIntervalMs);
            continue;
        }
        try {
            return await config.operation?.();
        } catch (error) {
            lastError = error;
            const runtimeStarting = runtime && runtime.running !== true;
            if (isPermanentRequestError(error) || (!runtimeStarting && !isAgentRuntimeStartupError(error))) {
                throw error;
            }
            if (now() - startedAt >= timeoutMs) throw error;
        }
        await wait(pollIntervalMs);
    }
    return undefined;
}

async function fetchText(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to load ${COMPONENT_NAME} (${response.status}).`);
    return response.text();
}

export async function ensureAgentRuntimeLoaderRegistered(webSkel = window.webSkel || window.assistOS?.webSkel || window.UI) {
    if (customElements.get(COMPONENT_NAME)) return;
    if (registrationPromise) return registrationPromise;
    registrationPromise = (async () => {
        if (!webSkel?.defineComponent) throw new Error('WebSkel is unavailable.');
        const [template, css] = await Promise.all([
            fetchText(`${COMPONENT_BASE_URL}.html`),
            fetchText(`${COMPONENT_BASE_URL}.css`)
        ]);
        await registerRuntimeComponent(webSkel, {
            name: COMPONENT_NAME,
            type: 'components',
            loadedTemplate: template,
            loadedCSSs: [css],
            presenterClassName: 'AgentRuntimeLoader',
            presenterModule: { AgentRuntimeLoader }
        });
    })().catch((error) => {
        registrationPromise = null;
        throw error;
    });
    return registrationPromise;
}

export class AgentRuntimeLoader {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.runId = 0;
        this.config = null;
        this.onRetryClick = () => this.retry();
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.agent-runtime-loader-root');
        this.title = this.element.querySelector('[data-role="title"]');
        this.message = this.element.querySelector('[data-role="message"]');
        this.retryButton = this.element.querySelector('[data-local-action="retry"]');
        this.retryButton?.removeEventListener('click', this.onRetryClick);
        this.retryButton?.addEventListener('click', this.onRetryClick);
        this.renderState('loading');
    }

    afterUnload() {
        this.runId += 1;
        this.retryButton?.removeEventListener('click', this.onRetryClick);
    }

    renderState(phase, message = '') {
        if (!this.root) return;
        this.phase = phase;
        const label = String(this.config?.label || 'Agent');
        this.root.dataset.phase = phase;
        this.title.textContent = phase === 'disabled' ? `${label} is disabled`
            : phase === 'error' ? `${label} could not start` : `Starting ${label}`;
        this.message.textContent = message || (phase === 'error'
            ? `${label} is unavailable.`
            : `Waiting for ${label} to become available. This page will open automatically.`);
        this.retryButton.hidden = !['error', 'disabled'].includes(phase);
    }

    start(config = {}) {
        const key = String(config.key || config.agentRef || config.label || 'agent');
        if (this.config?.key === key && (this.active || ['error', 'disabled'].includes(this.phase))) return;
        this.config = { ...config, key };
        this.active = true;
        void this.run();
    }

    retry() {
        if (!this.config || this.active) return;
        this.active = true;
        void this.run();
    }

    async run() {
        const runId = ++this.runId;
        this.renderState('loading');
        try {
            const result = await waitForAgentRuntimeAvailability({
                ...this.config,
                cancelled: () => runId !== this.runId,
            });
            if (runId !== this.runId) return;
            this.active = false;
            this.config.onReady?.(result);
        } catch (error) {
            if (runId !== this.runId) return;
            this.active = false;
            this.renderState(error?.code === 'agent_disabled' ? 'disabled' : 'error', describeError(error));
            this.config.onError?.(error);
        }
    }
}

export async function mountAgentRuntimeLoader(mount, config = {}) {
    await ensureAgentRuntimeLoaderRegistered();
    if (!mount?.isConnected) return null;
    let element = mount.querySelector?.(':scope > agent-runtime-loader');
    if (!element) {
        mount.textContent = '';
        element = document.createElement(COMPONENT_NAME);
        element.setAttribute('data-presenter', COMPONENT_NAME);
        mount.appendChild(element);
    }
    await element.presenterReadyPromise;
    if (!element.isConnected) return null;
    element.webSkelPresenter?.start(config);
    return element.webSkelPresenter || null;
}
