const DISCOVERY_PATH = '/webtty/target-discoveries';
const CSRF_COOKIE_NAME = 'ploinky_browser_csrf';
const CSRF_HEADER_NAME = 'X-Ploinky-Browser-CSRF-Token';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_TARGETS = 64;
const REQUEST_TIMEOUT_MS = 10000;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const canonical = [...expected].sort();
    return actual.length === canonical.length
        && actual.every((key, index) => key === canonical[index]);
}

function utf8Length(value) {
    return new TextEncoder().encode(value).byteLength;
}

function safeDisplayText(value, maxLength, fieldName) {
    if (typeof value !== 'string' || !value.length || utf8Length(value) > maxLength || /[\0\r\n]/.test(value)) {
        throw new Error(`Invalid terminal target ${fieldName}.`);
    }
    return value;
}

function compareText(left, right) {
    const leftFolded = String(left || '').toLocaleLowerCase('en-US');
    const rightFolded = String(right || '').toLocaleLowerCase('en-US');
    return leftFolded.localeCompare(rightFolded, 'en-US');
}

export function readBrowserCsrfToken(cookieText = globalThis.document?.cookie || '') {
    for (const part of String(cookieText || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() === CSRF_COOKIE_NAME) {
            return part.slice(separator + 1).trim();
        }
    }
    return '';
}

export function sortTerminalTargets(targets) {
    return [...targets].sort((left, right) => {
        const kindOrder = (left.kind === 'box' ? 0 : 1) - (right.kind === 'box' ? 0 : 1);
        if (kindOrder) return kindOrder;
        return compareText(left.label, right.label)
            || compareText(left.detail, right.detail);
    });
}

const TARGET_KINDS = Object.freeze(['box', 'agent', 'provider']);
const PROVIDER_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROVIDER_NOTICES = 16;
const KIND_LABELS = Object.freeze({ box: 'Box', agent: 'Agent', provider: 'Robot' });
// Ploinky's provider notice reasons, as plain words; another safe reason is shown as it is.
const PROVIDER_REASONS = Object.freeze({
    provider_unavailable: 'the provider is not running or cannot be reached',
    timeout: 'the provider did not answer in time',
    forbidden: 'the provider refused the request',
    inventory_too_large: 'the provider has too many targets to list',
    response_invalid: 'the provider answered with something unexpected',
    declaration_invalid: 'the provider declaration is not valid',
    project_unsupported: 'this folder cannot be opened in a robot terminal',
});
const KIND_DESCRIPTIONS = Object.freeze({ box: 'Ploinky Box', agent: 'Agent', provider: 'Robot terminal' });

// An execution provider that declares terminals (RoboWork robot terminals) but cannot be asked right now is not a row: the discovery
// carries `providers: [{name, available: false, reason}]` and the dialog shows each as a plain line (delta note 5). Box stays available.
function normalizeProviderNotices(value) {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > MAX_PROVIDER_NOTICES) {
        throw new Error('Invalid terminal provider notice list.');
    }
    return Object.freeze(value.map((entry) => {
        if (!hasExactKeys(entry, ['name', 'available', 'reason']) || entry.available !== false) {
            throw new Error('Invalid terminal provider notice.');
        }
        return Object.freeze({
            name: safeDisplayText(entry.name, 128, 'provider name'),
            reason: safeDisplayText(entry.reason, 256, 'provider reason'),
        });
    }));
}

// A discovery is exactly {ok, discovery: {id, directory, expiresAt, agentTargetsAvailable, targets, providers?}}. Rows are the Box, agent
// targets and provider targets (kind `provider`: a robot terminal, with the provider's `provider` name and its opaque `targetId`).
export function normalizeTerminalDiscoveryPayload(payload) {
    const keys = ['id', 'directory', 'expiresAt', 'agentTargetsAvailable', 'targets'];
    if (!hasExactKeys(payload, ['ok', 'discovery'])
        || payload.ok !== true
        || !(hasExactKeys(payload.discovery, keys) || hasExactKeys(payload.discovery, [...keys, 'providers']))) {
        throw new Error('Invalid terminal target discovery response.');
    }
    const source = payload.discovery;
    const id = String(source.id || '');
    if (!IDENTIFIER_PATTERN.test(id)) {
        throw new Error('Invalid terminal discovery identifier.');
    }
    if (typeof source.directory !== 'string' || utf8Length(source.directory) > 4096 || /[\0\r\n]/.test(source.directory)) {
        throw new Error('Invalid terminal discovery directory.');
    }
    if (!Number.isSafeInteger(source.expiresAt) || source.expiresAt <= 0) {
        throw new Error('Invalid terminal discovery expiry.');
    }
    if (typeof source.agentTargetsAvailable !== 'boolean') {
        throw new Error('Invalid terminal agent availability.');
    }
    if (!Array.isArray(source.targets) || !source.targets.length || source.targets.length > MAX_TARGETS) {
        throw new Error('Invalid terminal target list.');
    }

    const launches = new Set();
    const targets = source.targets.map((target) => {
        if (!isPlainObject(target)) {
            throw new Error('Invalid terminal target.');
        }
        const launch = String(target.launch || '');
        if (!IDENTIFIER_PATTERN.test(launch) || launches.has(launch)) {
            throw new Error('Invalid terminal launch identifier.');
        }
        launches.add(launch);
        if (!TARGET_KINDS.includes(target.kind)) {
            throw new Error('Invalid terminal target kind.');
        }
        if (target.access !== 'rw' && target.access !== 'ro') {
            throw new Error('Invalid terminal target access.');
        }
        // A provider row names its provider; Ploinky may also show its opaque `targetId` (optional here, checked when present).
        if (target.kind !== 'provider' && Object.hasOwn(target, 'provider')) {
            throw new Error('Invalid terminal target provider.');
        }
        if (target.kind === 'provider' && Object.hasOwn(target, 'targetId') && !PROVIDER_TARGET_ID_PATTERN.test(String(target.targetId))) {
            throw new Error('Invalid terminal provider target.');
        }
        const provider = target.kind === 'provider' ? {
            provider: safeDisplayText(target.provider, 128, 'provider'),
            ...(Object.hasOwn(target, 'targetId') ? { targetId: target.targetId } : {}),
        } : {};
        return Object.freeze({
            launch,
            kind: target.kind,
            label: safeDisplayText(target.label, 128, 'label'),
            detail: safeDisplayText(target.detail, 256, 'detail'),
            access: target.access,
            cwdDisplay: safeDisplayText(target.cwdDisplay, 4096, 'working directory'),
            ...provider,
        });
    });
    const providers = normalizeProviderNotices(source.providers);
    if (targets.filter((target) => target.kind === 'box').length !== 1) {
        throw new Error('Terminal target discovery did not return one Box target.');
    }

    return Object.freeze({
        id,
        directory: source.directory,
        expiresAt: source.expiresAt,
        agentTargetsAvailable: source.agentTargetsAvailable,
        targets: Object.freeze(sortTerminalTargets(targets)),
        providers,
    });
}

export function buildTerminalLaunchUrl(handoff) {
    const attach = isPlainObject(handoff) && hasExactKeys(handoff, ['attach']);
    const launch = typeof handoff === 'string' || (isPlainObject(handoff) && hasExactKeys(handoff, ['launch']));
    const normalized = attach ? handoff.attach : typeof handoff === 'string' ? handoff : handoff?.launch;
    if ((!attach && !launch) || typeof normalized !== 'string'
        || !(attach ? /^[A-Za-z0-9_-]{32}$/ : IDENTIFIER_PATTERN).test(normalized)) {
        throw new Error('Invalid terminal launch identifier.');
    }
    return `/webtty/#${attach ? 'attach' : 'launch'}=${encodeURIComponent(normalized)}`;
}

export function reserveTerminalWindow(windowRef = globalThis.window) {
    // Chromium deliberately returns null for window.open() when the noopener
    // feature is present, even when it opened the tab. Probe with a same-origin
    // blank tab so a null return still means blocked. Fail closed unless opener
    // isolation and an explicit hyperlink no-referrer policy can both be
    // established before navigating that tab to the fragment-only handoff.
    const popup = windowRef?.open?.('about:blank', '_blank') || null;
    if (!popup) return null;
    try {
        popup.opener = null;
        if (popup.opener !== null) {
            throw new Error('The terminal popup opener could not be isolated.');
        }
        return popup;
    } catch (_) {
        try {
            popup.close?.();
        } catch (_) {}
        return null;
    }
}

export function navigateTerminalWindow(popup, handoff) {
    try {
        if (!popup || popup.closed || popup.opener !== null) throw new Error('Unsafe terminal popup.');
        const anchor = popup.document.createElement('a');
        anchor.href = buildTerminalLaunchUrl(handoff);
        anchor.target = '_self';
        anchor.rel = 'noopener noreferrer';
        anchor.referrerPolicy = 'no-referrer';
        popup.document.body.appendChild(anchor);
        anchor.click();
        return popup;
    } catch (_) {
        try { popup?.close?.(); } catch (_) {}
        return null;
    }
}

export function openTerminalLaunchWindow(handoff, windowRef = globalThis.window) {
    buildTerminalLaunchUrl(handoff);
    return navigateTerminalWindow(reserveTerminalWindow(windowRef), handoff);
}

function mutationHeaders() {
    return {
        'Content-Type': 'application/json',
        [CSRF_HEADER_NAME]: readBrowserCsrfToken(),
    };
}

async function readJsonResponse(response) {
    let body = null;
    try {
        body = await response.json();
    } catch (_) {
        throw Object.assign(new Error('The terminal target response was invalid.'), { status: response.status });
    }
    if (!response.ok) {
        throw Object.assign(new Error('The terminal target request failed.'), {
            status: response.status,
            code: typeof body?.error === 'string' ? body.error : '',
        });
    }
    return body;
}

export async function requestTerminalTargetDiscovery(directory, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(DISCOVERY_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: mutationHeaders(),
        body: JSON.stringify({ dir: String(directory ?? '') }),
        signal: options.signal,
    });
    return normalizeTerminalDiscoveryPayload(await readJsonResponse(response));
}

export async function cancelTerminalTargetDiscovery(discoveryId, options = {}) {
    const normalized = String(discoveryId || '');
    if (!IDENTIFIER_PATTERN.test(normalized)) {
        return true;
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(`${DISCOVERY_PATH}/${encodeURIComponent(normalized)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: options.keepalive === true,
        headers: mutationHeaders(),
    });
    let body = null;
    try {
        body = await response.json();
    } catch (_) {
        throw Object.assign(new Error('The terminal target discovery could not be cancelled.'), {
            status: response.status,
        });
    }
    if (response.status === 200
        && hasExactKeys(body, ['ok'])
        && body.ok === true) {
        return true;
    }
    if (response.status === 404
        && hasExactKeys(body, ['ok', 'error'])
        && body.ok === false
        && body.error === 'not_found') {
        return true;
    }
    throw Object.assign(new Error('The terminal target discovery could not be cancelled.'), {
        status: response.status,
    });
}

function userFacingFailure(error) {
    if (error?.status === 401) return 'Your authentication session has expired.';
    if (error?.status === 403) return 'Administrator access is required.';
    if (error?.status === 429) return 'Terminal target capacity has been reached. Try again shortly.';
    if (error?.status === 503) return 'Terminal targets are temporarily unavailable.';
    return 'Terminal targets could not be loaded.';
}

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
}

export class TerminalTargetModal {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.directory = typeof props?.dir === 'string'
            ? props.dir
            : String(element?.dataset?.dir || '');
        this.targetsByLaunch = new Map();
        this.discoveryId = '';
        this.discoveryExpiresAt = 0;
        this.discoveryController = null;
        this.discoveryTimer = null;
        this.requestSequence = 0;
        this.started = false;
        this.closed = false;
        this.handedOff = false;
        this.viewState = 'loading';
        this.viewMessage = 'Finding available terminal targets…';
        this.currentDiscovery = null;
        this.boundKeydown = this.handleKeydown.bind(this);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        const dialog = this.element.closest?.('dialog');
        dialog?.setAttribute?.('aria-labelledby', 'terminalTargetTitle');
        this.directoryElement = this.element.querySelector('#terminalTargetDirectory');
        this.statusElement = this.element.querySelector('#terminalTargetStatus');
        this.warningElement = this.element.querySelector('#terminalTargetWarning');
        this.noticeElement = this.element.querySelector('#terminalTargetNotice');
        this.robotNoticeElement = this.element.querySelector('#terminalTargetRobotNotice');
        this.providersElement = this.element.querySelector('#terminalTargetProviders');
        this.listElement = this.element.querySelector('#terminalTargetList');
        this.retryButton = this.element.querySelector('#terminalTargetRetry');
        this.refreshButton = this.element.querySelector('#terminalTargetRefresh');
        this.element.removeEventListener('keydown', this.boundKeydown);
        this.element.addEventListener('keydown', this.boundKeydown);
        this.directoryElement.textContent = this.directory ? `/${this.directory}` : '/';
        if (this.viewState === 'ready' && this.currentDiscovery) {
            this.renderReady(this.currentDiscovery);
        } else if (this.viewState === 'error') {
            this.renderError(this.viewMessage);
        } else {
            this.renderLoading(this.viewMessage);
        }
        if (!this.started) {
            this.started = true;
            void this.discoverTargets();
        }
    }

    async afterUnload() {
        this.closed = true;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.clearExpiryTimer();
        this.element?.removeEventListener?.('keydown', this.boundKeydown);
        if (!this.handedOff && this.discoveryId) {
            const discoveryId = this.discoveryId;
            this.discoveryId = '';
            try {
                await cancelTerminalTargetDiscovery(discoveryId, { keepalive: true });
            } catch (_) {
                // Expiry cleanup remains authoritative when best-effort modal cancellation is lost.
            }
        }
    }

    clearExpiryTimer() {
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = null;
        }
    }

    renderLoading(message) {
        this.viewState = 'loading';
        this.viewMessage = message;
        this.currentDiscovery = null;
        this.targetsByLaunch.clear();
        this.listElement.replaceChildren();
        this.listElement.setAttribute('aria-busy', 'true');
        this.warningElement.hidden = true;
        this.noticeElement.hidden = true;
        if (this.robotNoticeElement) this.robotNoticeElement.hidden = true;
        if (this.providersElement) this.providersElement.hidden = true;
        this.retryButton.hidden = true;
        this.refreshButton.hidden = true;
        this.refreshButton.disabled = true;
        this.statusElement.textContent = message;
    }

    renderError(message) {
        this.viewState = 'error';
        this.viewMessage = message;
        this.currentDiscovery = null;
        this.targetsByLaunch.clear();
        this.listElement.replaceChildren();
        this.listElement.setAttribute('aria-busy', 'false');
        this.noticeElement.hidden = true;
        if (this.robotNoticeElement) this.robotNoticeElement.hidden = true;
        if (this.providersElement) this.providersElement.hidden = true;
        this.warningElement.textContent = message;
        this.warningElement.dataset.state = 'error';
        this.warningElement.hidden = false;
        this.retryButton.hidden = false;
        this.refreshButton.hidden = true;
        this.refreshButton.disabled = true;
        this.statusElement.textContent = 'No terminal was opened.';
        this.retryButton.focus?.();
    }

    renderTarget(target) {
        const item = document.createElement('li');
        item.className = 'terminal-target-item';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'terminal-target-button';
        button.dataset.launch = target.launch;
        button.setAttribute('data-local-action', 'selectTarget');
        button.setAttribute(
            'aria-label',
            `${target.label}, ${KIND_DESCRIPTIONS[target.kind]}, ${target.detail}, ${target.access === 'ro' ? 'read only' : 'read and write'}, ${target.cwdDisplay}`
        );

        const heading = document.createElement('span');
        heading.className = 'terminal-target-heading';
        heading.appendChild(createTextElement('span', 'terminal-target-label', target.label));
        heading.appendChild(createTextElement(
            'span',
            `terminal-target-kind terminal-target-kind-${target.kind}`,
            KIND_LABELS[target.kind]
        ));
        heading.appendChild(createTextElement(
            'span',
            `terminal-target-access terminal-target-access-${target.access}`,
            target.access === 'ro' ? 'Read only' : 'Read and write'
        ));
        button.appendChild(heading);
        button.appendChild(createTextElement('span', 'terminal-target-detail', target.detail));
        button.appendChild(createTextElement('span', 'terminal-target-cwd', target.cwdDisplay));
        item.appendChild(button);
        return item;
    }

    renderReady(discovery) {
        this.viewState = 'ready';
        this.viewMessage = '';
        this.currentDiscovery = discovery;
        this.targetsByLaunch.clear();
        this.listElement.replaceChildren();
        const fragment = document.createDocumentFragment();
        for (const target of discovery.targets) {
            this.targetsByLaunch.set(target.launch, target);
            fragment.appendChild(this.renderTarget(target));
        }
        this.listElement.appendChild(fragment);
        this.listElement.setAttribute('aria-busy', 'false');

        const agentCount = discovery.targets.filter((target) => target.kind === 'agent').length;
        this.noticeElement.hidden = agentCount === 0;
        if (this.robotNoticeElement) {
            this.robotNoticeElement.hidden = !discovery.targets.some((target) => target.kind === 'provider');
        }
        if (this.providersElement) {
            const notices = discovery.providers || [];
            this.providersElement.replaceChildren(...notices.map((notice) => createTextElement('li', 'terminal-target-provider-notice',
                `${notice.name} terminals are unavailable: ${PROVIDER_REASONS[notice.reason] || notice.reason}.`)));
            this.providersElement.hidden = notices.length === 0;
        }
        if (!discovery.agentTargetsAvailable) {
            this.warningElement.textContent = 'Agent terminals are temporarily unavailable. Ploinky Box remains available.';
            this.warningElement.dataset.state = 'warning';
            this.warningElement.hidden = false;
        } else if (agentCount === 0) {
            this.warningElement.textContent = 'No running agent has a proven mount for this folder. Ploinky Box remains available.';
            this.warningElement.dataset.state = 'info';
            this.warningElement.hidden = false;
        } else {
            this.warningElement.hidden = true;
        }
        this.retryButton.hidden = true;
        this.refreshButton.hidden = false;
        this.refreshButton.disabled = false;
        this.statusElement.textContent = `${discovery.targets.length} terminal target${discovery.targets.length === 1 ? '' : 's'} available.`;
    }

    scheduleExpiry(expiresAt) {
        this.clearExpiryTimer();
        const delay = Math.max(0, Math.min(2_147_483_000, expiresAt - Date.now() + 50));
        this.discoveryTimer = setTimeout(() => {
            this.discoveryTimer = null;
            if (!this.closed && !this.handedOff) {
                void this.refreshTargets();
            }
        }, delay);
    }

    async discoverTargets() {
        const sequence = ++this.requestSequence;
        this.discoveryController?.abort();
        const controller = new AbortController();
        this.discoveryController = controller;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        try {
            const discovery = await requestTerminalTargetDiscovery(this.directory, { signal: controller.signal });
            if (this.closed || sequence !== this.requestSequence) return;
            this.discoveryController = null;
            this.discoveryId = discovery.id;
            this.discoveryExpiresAt = discovery.expiresAt;
            this.renderReady(discovery);
            this.scheduleExpiry(discovery.expiresAt);
        } catch (error) {
            if (this.closed || sequence !== this.requestSequence) return;
            if (error?.name === 'AbortError' && !timedOut) return;
            this.discoveryController = null;
            this.renderError(timedOut ? 'Terminal target discovery timed out.' : userFacingFailure(error));
        } finally {
            clearTimeout(timeout);
        }
    }

    async invalidateCurrentDiscovery(required) {
        if (!this.discoveryId) return true;
        const discoveryId = this.discoveryId;
        try {
            await cancelTerminalTargetDiscovery(discoveryId);
            if (this.discoveryId === discoveryId) {
                this.discoveryId = '';
                this.discoveryExpiresAt = 0;
            }
            return true;
        } catch (error) {
            if (required) throw error;
            return false;
        }
    }

    async refreshTargets() {
        if (this.closed || this.handedOff) return;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.clearExpiryTimer();
        this.renderLoading('Refreshing available terminal targets…');
        try {
            await this.invalidateCurrentDiscovery(true);
        } catch (_) {
            if (!this.closed) {
                this.renderError('The previous terminal choices could not be invalidated. Try again.');
            }
            return;
        }
        if (!this.closed) {
            await this.discoverTargets();
        }
    }

    retryDiscovery() {
        return this.refreshTargets();
    }

    selectTarget(button) {
        if (this.closed || this.handedOff) return false;
        const launch = String(button?.dataset?.launch || '');
        const target = this.targetsByLaunch.get(launch);
        if (!target) {
            this.renderError('These terminal choices are no longer available. Refresh and choose again.');
            return false;
        }

        let popup = null;
        try {
            popup = openTerminalLaunchWindow(target.launch);
        } catch (_) {
            popup = null;
        }
        if (!popup) {
            this.warningElement.textContent = 'The browser blocked the new terminal tab. Allow popups for this site, then choose the target again.';
            this.warningElement.dataset.state = 'error';
            this.warningElement.hidden = false;
            this.statusElement.textContent = 'No terminal was opened.';
            button?.focus?.();
            return false;
        }

        this.handedOff = true;
        this.clearExpiryTimer();
        assistOS.UI.closeModal(this.element);
        return true;
    }

    closeModal() {
        if (this.closed) return;
        this.closed = true;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.clearExpiryTimer();
        const discoveryId = this.discoveryId;
        this.discoveryId = '';
        if (discoveryId) {
            void cancelTerminalTargetDiscovery(discoveryId, { keepalive: true }).catch(() => {});
        }
        assistOS.UI.closeModal(this.element);
    }

    handleKeydown(event) {
        if (event?.key !== 'Escape') return;
        event.preventDefault?.();
        event.stopPropagation?.();
        this.closeModal();
    }
}
