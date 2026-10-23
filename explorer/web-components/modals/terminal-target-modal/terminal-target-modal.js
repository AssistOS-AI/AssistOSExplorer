import { normalizeTerminalProfileSource } from '../../../utils/liveSessionSource.mjs';

const DISCOVERY_PATH = '/webtty/target-discoveries';
const PROFILE_SOURCE_LOCATION = 'terminal-profiles:source';
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNAVAILABLE_REASONS = Object.freeze(['home-unreachable', 'home-read-only']);
const MAX_PROFILES = 256;
const PROFILE_TIMEOUT_MS = 5000;
const PREPARE_TIMEOUT_MS = 30000;
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

function normalizeDiscoveryProfile(profile, expected) {
    if (!hasExactKeys(profile, ['provider', 'id', 'label'])
        || profile.provider !== expected.provider || profile.id !== expected.id
        || !PROFILE_ID_PATTERN.test(profile.id)) {
        throw new Error('Invalid terminal discovery profile.');
    }
    return Object.freeze({
        provider: profile.provider,
        id: profile.id,
        label: safeDisplayText(profile.label, 128, 'profile label'),
    });
}

// `options.profile` is the {provider, id} that the request asked for, or empty for a plain {dir} request.
// A plain response must be exactly today's shape. A profiled response must echo the requested profile,
// and only then may a row omit `launch` and carry a known `unavailable` reason instead.
export function normalizeTerminalDiscoveryPayload(payload, options = {}) {
    const expectedProfile = options?.profile || null;
    if (!hasExactKeys(payload, ['ok', 'discovery']) || payload.ok !== true
        || !hasExactKeys(payload.discovery, [
            'id', 'directory', 'expiresAt', 'agentTargetsAvailable', 'targets',
            ...(expectedProfile ? ['profile'] : []),
        ])) {
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
    const profile = expectedProfile ? normalizeDiscoveryProfile(source.profile, expectedProfile) : null;

    const launches = new Set();
    const targets = source.targets.map((target) => {
        if (!isPlainObject(target)) {
            throw new Error('Invalid terminal target.');
        }
        const hasLaunch = Object.hasOwn(target, 'launch');
        const hasUnavailable = Object.hasOwn(target, 'unavailable');
        if (hasLaunch === hasUnavailable
            || (hasUnavailable && (!expectedProfile || !UNAVAILABLE_REASONS.includes(target.unavailable)))) {
            throw new Error('Invalid terminal target availability.');
        }
        let launch = '';
        if (hasLaunch) {
            launch = String(target.launch || '');
            if (!IDENTIFIER_PATTERN.test(launch) || launches.has(launch)) {
                throw new Error('Invalid terminal launch identifier.');
            }
            launches.add(launch);
        }
        if (target.kind !== 'box' && target.kind !== 'agent') {
            throw new Error('Invalid terminal target kind.');
        }
        if (target.access !== 'rw' && target.access !== 'ro') {
            throw new Error('Invalid terminal target access.');
        }
        return Object.freeze({
            ...(hasLaunch ? { launch } : { unavailable: target.unavailable }),
            kind: target.kind,
            label: safeDisplayText(target.label, 128, 'label'),
            detail: safeDisplayText(target.detail, 256, 'detail'),
            access: target.access,
            cwdDisplay: safeDisplayText(target.cwdDisplay, 4096, 'working directory'),
        });
    });
    if (targets.filter((target) => target.kind === 'box').length !== 1) {
        throw new Error('Terminal target discovery did not return one Box target.');
    }

    return Object.freeze({
        id,
        directory: source.directory,
        expiresAt: source.expiresAt,
        agentTargetsAvailable: source.agentTargetsAvailable,
        ...(profile ? { profile } : {}),
        targets: Object.freeze(sortTerminalTargets(targets)),
    });
}

export function buildTerminalLaunchUrl(handoff) {
    const attach = isPlainObject(handoff) && hasExactKeys(handoff, ['attach']);
    const launch = typeof handoff === 'string'
        || (isPlainObject(handoff) && hasExactKeys(handoff, ['launch']));
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
    const profile = options.profile ? { provider: options.profile.provider, id: options.profile.id } : null;
    const response = await fetchImpl(DISCOVERY_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: mutationHeaders(),
        body: JSON.stringify({ dir: String(directory ?? ''), ...(profile ? { profile } : {}) }),
        signal: options.signal,
    });
    return normalizeTerminalDiscoveryPayload(await readJsonResponse(response), { profile });
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

function profileFailure(error, robot) {
    if (robot && (/profile/i.test(String(error?.code || '')) || [404, 409, 422].includes(error?.status))) {
        return `${robot.label}'s home folder is not available for a terminal. Choose another robot or try again.`;
    }
    return userFacingFailure(error);
}

function prepareFailure(error, robot) {
    if (error?.status === 401) return 'Your authentication session has expired.';
    if (error?.status === 403) return 'Administrator access is required.';
    return `${robot.label} could not be prepared. No terminal was opened.`;
}

function displayLabel(value, fallback) {
    return typeof value === 'string' && value.trim() && utf8Length(value) <= 128 && !/[\0\r\n]/.test(value)
        ? value.trim()
        : fallback;
}

// Sources are declared by agents as `terminal-profile-source` contributions. The declaring agent is assigned
// by the server, and `base` must name that agent, exactly like a Live Session source.
export function discoverTerminalProfileSources(appPlugins = globalThis.assistOS?.workspace?.appPlugins) {
    const seen = new Set();
    const sources = [];
    for (const source of appPlugins?.[PROFILE_SOURCE_LOCATION] || []) {
        const config = normalizeTerminalProfileSource(source?.terminalProfiles, source?.agent);
        if (source?.contributionType !== 'terminal-profile-source' || !config || seen.has(config.base)) continue;
        seen.add(config.base);
        sources.push(Object.freeze({
            agent: source.agent,
            label: displayLabel(source.label, source.agent),
            base: config.base,
        }));
    }
    return sources;
}

export function normalizeTerminalProfilesPayload(payload) {
    if (!hasExactKeys(payload, ['ok', 'profiles']) || payload.ok !== true
        || !Array.isArray(payload.profiles) || payload.profiles.length > MAX_PROFILES) {
        throw new Error('Invalid terminal profile list.');
    }
    const ids = new Set();
    return Object.freeze(payload.profiles.map((profile) => {
        if (!hasExactKeys(profile, ['id', 'label']) || typeof profile.id !== 'string'
            || !PROFILE_ID_PATTERN.test(profile.id) || ids.has(profile.id)) {
            throw new Error('Invalid terminal profile.');
        }
        ids.add(profile.id);
        return Object.freeze({ id: profile.id, label: safeDisplayText(profile.label, 128, 'robot label') });
    }));
}

export async function requestTerminalProfiles(source, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(source.base, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
    });
    return normalizeTerminalProfilesPayload(await readJsonResponse(response));
}

// Prepares the profile on its owning agent with the same browser mutation proof Explorer sends to every agent route.
export async function prepareTerminalProfile(source, id, options = {}) {
    if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
        throw new Error('Invalid terminal profile identifier.');
    }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(`${source.base}/${encodeURIComponent(id)}/prepare`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: mutationHeaders(),
        body: '{}',
        signal: options.signal,
    });
    const body = await readJsonResponse(response);
    if (!hasExactKeys(body, ['ok', 'id', 'label', 'root']) || body.ok !== true || body.id !== id
        || typeof body.root !== 'string' || !body.root || utf8Length(body.root) > 4096 || /[\0\r\n]/.test(body.root)) {
        throw new Error('The terminal profile preparation response was invalid.');
    }
    return Object.freeze({ id, label: safeDisplayText(body.label, 128, 'robot label'), root: body.root });
}

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
}

function closePopup(popup) {
    try { popup?.close?.(); } catch (_) {}
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
        this.profileSources = [];
        this.robots = [];
        this.robotErrors = [];
        this.robotsLoaded = false;
        this.profileController = null;
        this.selectedRobotKey = '';
        this.selectedLaunch = '';
        this.opening = false;
        this.prepareController = null;
        this.boundKeydown = this.handleKeydown.bind(this);
        this.boundChange = this.handleChange.bind(this);
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
        this.listElement = this.element.querySelector('#terminalTargetList');
        this.retryButton = this.element.querySelector('#terminalTargetRetry');
        this.refreshButton = this.element.querySelector('#terminalTargetRefresh');
        this.robotSelect = this.element.querySelector('#terminalTargetRobot');
        this.robotNote = this.element.querySelector('#terminalTargetRobotNote');
        this.disclosureElement = this.element.querySelector('#terminalTargetDisclosure');
        this.openButton = this.element.querySelector('#terminalTargetOpen');
        this.element.removeEventListener('keydown', this.boundKeydown);
        this.element.addEventListener('keydown', this.boundKeydown);
        this.element.removeEventListener('change', this.boundChange);
        this.element.addEventListener('change', this.boundChange);
        this.directoryElement.textContent = this.directory ? `/${this.directory}` : '/';
        this.renderRobotOptions();
        if (this.viewState === 'ready' && this.currentDiscovery) {
            this.renderReady(this.currentDiscovery);
        } else if (this.viewState === 'error') {
            this.renderError(this.viewMessage);
        } else {
            this.renderLoading(this.viewMessage);
        }
        if (!this.started) {
            this.started = true;
            void this.loadRobots();
            void this.discoverTargets();
        }
    }

    async afterUnload() {
        this.closed = true;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.profileController?.abort();
        this.profileController = null;
        this.prepareController?.abort();
        this.prepareController = null;
        this.clearExpiryTimer();
        this.element?.removeEventListener?.('keydown', this.boundKeydown);
        this.element?.removeEventListener?.('change', this.boundChange);
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

    selectedRobot() {
        return this.robots.find((robot) => robot.key === this.selectedRobotKey) || null;
    }

    async loadRobots() {
        const sources = discoverTerminalProfileSources();
        this.profileSources = sources;
        this.robotsLoaded = false;
        this.updateControls();
        const controller = new AbortController();
        this.profileController?.abort();
        this.profileController = controller;
        const results = await Promise.all(sources.map(async (source) => {
            const sourceController = new AbortController();
            const abort = () => sourceController.abort();
            controller.signal.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(abort, PROFILE_TIMEOUT_MS);
            try {
                return { source, profiles: await requestTerminalProfiles(source, { signal: sourceController.signal }) };
            } catch (error) {
                return { source, error };
            } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', abort);
            }
        }));
        if (this.closed || this.profileController !== controller) return;
        this.profileController = null;
        const robots = [];
        const errors = [];
        results.forEach(({ source, profiles, error }, index) => {
            if (error) {
                errors.push(`${source.label}: robots could not be loaded.`);
                return;
            }
            for (const profile of profiles) {
                robots.push({
                    key: `${index}:${profile.id}`,
                    agent: source.agent,
                    base: source.base,
                    id: profile.id,
                    label: profile.label,
                    display: sources.length > 1 ? `${profile.label} (${source.label})` : profile.label,
                });
            }
        });
        robots.sort((left, right) => compareText(left.label, right.label) || compareText(left.display, right.display));
        this.robots = robots;
        this.robotErrors = errors;
        this.robotsLoaded = true;
        this.renderRobotOptions();
        this.updateControls();
    }

    renderRobotOptions() {
        if (!this.robotSelect) return;
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = !this.selectedRobotKey;
        placeholder.textContent = 'Choose a robot';
        const options = this.robots.map((robot) => {
            const option = document.createElement('option');
            option.value = robot.key;
            option.textContent = robot.display;
            option.selected = robot.key === this.selectedRobotKey;
            return option;
        });
        this.robotSelect.replaceChildren(placeholder, ...options);
    }

    robotAvailabilityMessage() {
        if (!this.robotsLoaded) return 'Loading robots…';
        if (!this.profileSources.length) return 'RoboTeam is not available.';
        if (!this.robots.length) {
            return this.robotErrors.length ? this.robotErrors.join(' ') : 'No robots exist yet: create one in RoboTeam.';
        }
        return this.robotErrors.join(' ');
    }

    rowState(target) {
        const robot = this.selectedRobot();
        if (!robot) return { disabled: true, reason: 'Choose a robot first' };
        if (target.unavailable === 'home-unreachable') {
            return { disabled: true, reason: `This container cannot see ${robot.label}'s home folder` };
        }
        if (target.unavailable === 'home-read-only') {
            return { disabled: true, reason: `This container can only read ${robot.label}'s home folder` };
        }
        return { disabled: false, reason: '' };
    }

    openGate() {
        const robot = this.selectedRobot();
        const target = this.targetsByLaunch.get(this.selectedLaunch);
        const discovery = this.currentDiscovery;
        if (this.closed || this.handedOff || this.opening || this.viewState !== 'ready' || !robot || !target
            || !discovery?.profile || discovery.profile.provider !== robot.agent || discovery.profile.id !== robot.id
            || Date.now() >= discovery.expiresAt) {
            return null;
        }
        return { robot, target };
    }

    updateControls() {
        const robot = this.selectedRobot();
        const target = this.targetsByLaunch.get(this.selectedLaunch) || null;
        if (this.robotSelect) this.robotSelect.disabled = this.opening || !this.robots.length;
        if (this.openButton) this.openButton.disabled = !this.openGate();
        if (this.refreshButton) this.refreshButton.disabled = this.opening || this.viewState !== 'ready';
        if (this.retryButton) this.retryButton.disabled = this.opening;
        if (this.robotNote) {
            const message = this.robotAvailabilityMessage();
            this.robotNote.textContent = message;
            this.robotNote.hidden = !message;
        }
        if (!this.disclosureElement) return;
        this.disclosureElement.hidden = !robot;
        if (!robot) {
            this.disclosureElement.replaceChildren();
            return;
        }
        const sentences = [`HOME will be ${robot.label}'s home folder. Settings the robot wrote there (git, ssh, coding-agent configuration) can run commands when you use those tools here, and logins, history and files you create there are stored where the robot can read them.`];
        if (target?.kind === 'box') {
            sentences.push('The Box runs the Ploinky router and controls every agent container.');
        }
        // The robot's own tool setup is loaded only inside the agent that declares the profile.
        if (target && !(target.kind === 'agent' && target.detail.split('/').pop() === robot.agent)) {
            sentences.push("The robot's tool setup is not loaded here.");
        }
        this.disclosureElement.replaceChildren(...sentences.map((sentence) => createTextElement('p', '', sentence)));
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
        this.retryButton.hidden = true;
        this.refreshButton.hidden = true;
        this.refreshButton.disabled = true;
        this.statusElement.textContent = message;
        this.updateControls();
    }

    renderError(message) {
        this.viewState = 'error';
        this.viewMessage = message;
        this.currentDiscovery = null;
        this.targetsByLaunch.clear();
        this.listElement.replaceChildren();
        this.listElement.setAttribute('aria-busy', 'false');
        this.noticeElement.hidden = true;
        this.warningElement.textContent = message;
        this.warningElement.dataset.state = 'error';
        this.warningElement.hidden = false;
        this.retryButton.hidden = false;
        this.refreshButton.hidden = true;
        this.refreshButton.disabled = true;
        this.statusElement.textContent = 'No terminal was opened.';
        this.updateControls();
        this.retryButton.focus?.();
    }

    renderTarget(target) {
        const { disabled, reason } = this.rowState(target);
        const item = document.createElement('li');
        item.className = 'terminal-target-item';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'terminal-target-button';
        if (target.launch) button.dataset.launch = target.launch;
        button.disabled = disabled;
        button.setAttribute('data-local-action', 'selectTarget');
        button.setAttribute('aria-pressed', String(Boolean(target.launch) && target.launch === this.selectedLaunch));
        button.setAttribute(
            'aria-label',
            `${target.label}, ${target.kind === 'box' ? 'Ploinky Box' : 'Agent'}, ${target.detail}, ${target.access === 'ro' ? 'read only' : 'read and write'}, ${target.cwdDisplay}${reason ? `, unavailable: ${reason}` : ''}`
        );

        const heading = document.createElement('span');
        heading.className = 'terminal-target-heading';
        heading.appendChild(createTextElement('span', 'terminal-target-label', target.label));
        heading.appendChild(createTextElement(
            'span',
            `terminal-target-kind terminal-target-kind-${target.kind}`,
            target.kind === 'box' ? 'Box' : 'Agent'
        ));
        heading.appendChild(createTextElement(
            'span',
            `terminal-target-access terminal-target-access-${target.access}`,
            target.access === 'ro' ? 'Read only' : 'Read and write'
        ));
        button.appendChild(heading);
        button.appendChild(createTextElement('span', 'terminal-target-detail', target.detail));
        button.appendChild(createTextElement('span', 'terminal-target-cwd', target.cwdDisplay));
        if (reason) button.appendChild(createTextElement('span', 'terminal-target-reason', reason));
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
            if (target.launch) this.targetsByLaunch.set(target.launch, target);
            fragment.appendChild(this.renderTarget(target));
        }
        if (!this.targetsByLaunch.has(this.selectedLaunch)) this.selectedLaunch = '';
        this.listElement.appendChild(fragment);
        this.listElement.setAttribute('aria-busy', 'false');

        const agentCount = discovery.targets.filter((target) => target.kind === 'agent').length;
        this.noticeElement.hidden = agentCount === 0;
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
        const enabled = discovery.targets.filter((target) => !this.rowState(target).disabled).length;
        this.statusElement.textContent = !this.selectedRobot()
            ? 'Choose a robot to enable the terminal targets.'
            : `${enabled} terminal target${enabled === 1 ? '' : 's'} available.`;
        this.updateControls();
    }

    scheduleExpiry(expiresAt) {
        this.clearExpiryTimer();
        const delay = Math.max(0, Math.min(2_147_483_000, expiresAt - Date.now() + 50));
        this.discoveryTimer = setTimeout(() => {
            this.discoveryTimer = null;
            if (!this.closed && !this.handedOff && !this.opening) {
                void this.refreshTargets();
            }
        }, delay);
    }

    async discoverTargets() {
        const sequence = ++this.requestSequence;
        this.discoveryController?.abort();
        const controller = new AbortController();
        this.discoveryController = controller;
        const robot = this.selectedRobot();
        const profile = robot ? { provider: robot.agent, id: robot.id } : null;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        try {
            const discovery = await requestTerminalTargetDiscovery(this.directory, { signal: controller.signal, profile });
            if (this.closed || sequence !== this.requestSequence) {
                // The server already holds launch choices for a response nobody will use.
                void cancelTerminalTargetDiscovery(discovery.id, { keepalive: this.closed }).catch(() => {});
                return;
            }
            this.discoveryController = null;
            this.discoveryId = discovery.id;
            this.discoveryExpiresAt = discovery.expiresAt;
            this.selectedLaunch = '';
            this.renderReady(discovery);
            this.scheduleExpiry(discovery.expiresAt);
        } catch (error) {
            if (this.closed || sequence !== this.requestSequence) return;
            if (error?.name === 'AbortError' && !timedOut) return;
            this.discoveryController = null;
            this.renderError(timedOut ? 'Terminal target discovery timed out.' : profileFailure(error, profile && robot));
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
        // Replacing the discovery while Open prepares the robot would void the launch that Open is about to use.
        if (this.closed || this.handedOff || this.opening) return;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.clearExpiryTimer();
        this.selectedLaunch = '';
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

    handleChange(event) {
        const field = event?.target;
        if (field?.id === 'terminalTargetRobot') {
            this.chooseRobot(String(field.value || ''));
        }
    }

    // Choosing or changing the robot replaces every prior launch choice with a discovery for that robot.
    chooseRobot(key) {
        if (this.closed || this.handedOff || this.opening) return false;
        const robot = this.robots.find((candidate) => candidate.key === key) || null;
        this.selectedRobotKey = robot ? robot.key : '';
        void this.refreshTargets();
        return Boolean(robot);
    }

    selectTarget(button) {
        if (this.closed || this.handedOff || this.opening || button?.disabled) return false;
        const launch = String(button?.dataset?.launch || '');
        const target = this.targetsByLaunch.get(launch);
        if (!target) {
            this.renderError('These terminal choices are no longer available. Refresh and choose again.');
            return false;
        }
        if (this.rowState(target).disabled) return false;
        this.selectedLaunch = launch;
        this.renderReady(this.currentDiscovery);
        this.listElement.querySelector?.(`[data-launch="${launch}"]`)?.focus?.();
        return true;
    }

    async openTerminal() {
        const gate = this.openGate();
        if (!gate) {
            this.statusElement.textContent = 'Choose a robot and an available terminal target first.';
            return false;
        }
        const { robot, target } = gate;
        // The launch belongs to this exact discovery and row; anything that replaces them while the robot is prepared voids it.
        const discoveryId = this.currentDiscovery.id;
        // Reserve the isolated tab in the click event, before any await, so popup blocking stays detectable.
        let popup = null;
        try {
            popup = reserveTerminalWindow();
        } catch (_) {
            popup = null;
        }
        if (!popup) {
            this.warningElement.textContent = 'The browser blocked the new terminal tab. Allow popups for this site, then choose Open again.';
            this.warningElement.dataset.state = 'error';
            this.warningElement.hidden = false;
            this.statusElement.textContent = 'No terminal was opened.';
            this.openButton?.focus?.();
            return false;
        }

        const controller = new AbortController();
        this.prepareController = controller;
        this.opening = true;
        this.warningElement.hidden = true;
        this.statusElement.textContent = `Preparing ${robot.label}…`;
        this.updateControls();
        const timer = setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS);
        let failure = '';
        try {
            await prepareTerminalProfile(robot, robot.id, { signal: controller.signal });
        } catch (error) {
            failure = prepareFailure(error, robot);
        } finally {
            clearTimeout(timer);
            if (this.prepareController === controller) this.prepareController = null;
        }
        if (this.closed) {
            closePopup(popup);
            return false;
        }
        this.opening = false;
        if (!failure && (this.currentDiscovery?.id !== discoveryId || this.targetsByLaunch.get(target.launch) !== target)) {
            failure = 'These terminal choices changed while the robot was being prepared. Choose again.';
        }
        if (!failure && Date.now() >= this.discoveryExpiresAt) {
            failure = 'These terminal choices expired while the robot was being prepared. Choose again.';
        }
        if (!failure) {
            const navigated = navigateTerminalWindow(popup, target.launch);
            if (navigated) {
                this.handedOff = true;
                this.clearExpiryTimer();
                assistOS.UI.closeModal(this.element);
                return true;
            }
            failure = 'The browser could not open the terminal tab. Allow popups for this site, then choose Open again.';
        } else {
            closePopup(popup);
        }
        this.warningElement.textContent = failure;
        this.warningElement.dataset.state = 'error';
        this.warningElement.hidden = false;
        this.statusElement.textContent = 'No terminal was opened.';
        this.updateControls();
        if (!this.handedOff && Date.now() >= this.discoveryExpiresAt) void this.refreshTargets();
        return false;
    }

    closeModal() {
        if (this.closed) return;
        this.closed = true;
        this.requestSequence += 1;
        this.discoveryController?.abort();
        this.discoveryController = null;
        this.profileController?.abort();
        this.profileController = null;
        this.prepareController?.abort();
        this.prepareController = null;
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
