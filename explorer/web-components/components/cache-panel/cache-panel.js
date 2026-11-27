import { createCacheApi, cacheAccessDenied } from '../../../services/infrastructure/cacheApi.js';
import { escapeHtml } from '../admin-settings-panel/admin-settings-utils.js';

const minutes = [1, 2, 5];
const ACTION_LABELS = { off: 'Switch off', page: 'Allow caching', default: 'Reset' };

// Refusals the Router answers for a route change; the panel states them in plain words and re-reads.
const REFUSALS = {
    unknown_application: 'This application is no longer listed. The list has been refreshed.',
    unknown_route: 'This route is no longer a public route of the application. The list has been refreshed.',
    route_never: 'The application forbids caching this route, so no setting can be saved for it.',
    route_marked: 'The application already marks this route for caching, so it cannot be added again.',
    route_uncached: 'Nothing is cached on this route, so there is nothing to switch off.',
    route_not_choosable: 'Caching cannot be allowed on this route: the application has not marked any route as never cached, or the route only accepts POST requests.',
};

const CHECK_ERRORS = {
    wildcard_path: 'Only an exact path can be checked, not a path pattern.',
    unknown_route: 'This route is no longer a public route of the application.',
    no_published_host: 'No published host sends this path to the application, so it cannot be checked.',
    cache_unavailable: 'The Router could not fetch this page to check it. Try again later.',
};

export function describeCacheError(error, table = REFUSALS) {
    if (error?.code === 'rate_limited') {
        const seconds = Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : 1;
        return `Checks are limited to one per second. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    return table[error?.code] || '';
}

function describePurge(result) {
    const retry = result.outcome === 'cooldown' && Number.isFinite(result.retryAfterSeconds)
        ? ` (retry after ${result.retryAfterSeconds} seconds)` : '';
    return escapeHtml(result.outcome) + retry;
}

export function routeKey(agent, path) {
    return JSON.stringify([agent, path]);
}

const isNever = (route) => route.manifest === 'never' || route.source === 'never';

// The one place that decides which actions a row offers: stale rows only Reset (even on a route
// that has since become `never`, so the saved setting can always be removed), never rows none.
export function offeredActions(route) {
    if (route.stale) return ['default'];
    if (isNever(route)) return [];
    const choices = Array.isArray(route.choices) ? route.choices.filter((choice) => Object.hasOwn(ACTION_LABELS, choice)) : [];
    return [...choices, ...(route.checkable === true ? ['check'] : [])];
}

function describeMark(route) {
    const setting = route.setting?.setting;
    if (route.stale) {
        return { label: 'Stale', tone: 'warning', notes: [`The saved ${setting === 'page' ? '“allow caching”' : '“switch off”'} setting no longer matches this route and has no effect.`] };
    }
    if (route.manifest === 'never' || route.source === 'never') {
        return { label: 'Never', tone: 'locked', notes: [route.neverBy && route.neverBy !== route.path ? `Covered by ${route.neverBy}` : 'The application forbids caching this route.'] };
    }
    if (route.source === 'off' || setting === 'off') {
        return { label: 'Switched off', tone: 'off', notes: route.manifest ? [`Manifest ${route.manifest}`] : [] };
    }
    if (route.source === 'administrator' || setting === 'page') return { label: 'Added by administrator', tone: 'success', notes: [] };
    if (route.source === 'manifest' || route.manifest) return { label: `Manifest ${route.manifest || route.effective}`, tone: 'success', notes: [] };
    return { label: 'Not cached', tone: '', notes: [] };
}

function renderCheck(entry) {
    if (!entry) return '';
    if (entry.error) return `<p class="cache-check error" role="status">${escapeHtml(entry.error)}</p>`;
    if (!entry.check || typeof entry.check !== 'object') return '<p class="cache-check error" role="status">The Router returned no check result.</p>';
    const { host, path, status, cdnHeader, cacheControl } = entry.check;
    return `<p class="cache-check" role="status"><strong>Checked now:</strong> HTTP ${escapeHtml(status)} from ${escapeHtml(host)}${escapeHtml(path)}. Cloudflare header sent: <code>${escapeHtml(cdnHeader || 'none')}</code>. Application header: <code>${escapeHtml(cacheControl || 'none')}</code>.</p>`;
}

function renderActions(app, route, ui, disabled) {
    const key = routeKey(app.agent, route.path);
    const attributes = `data-cache-agent="${escapeHtml(app.agent)}" data-cache-path="${escapeHtml(route.path)}"`;
    // A stale row can share its path with the live row; only the live row carries confirm and check state.
    if (!route.stale && ui.confirming && routeKey(ui.confirming.agent, ui.confirming.path) === key) {
        const prompt = ui.confirming.setting === 'off'
            ? 'Switch off caching for this route? Cached copies on the application’s hosts may be cleared.'
            : `Allow Cloudflare to cache this route for ${app.pageSeconds / 60} ${app.pageSeconds === 60 ? 'minute' : 'minutes'}? Every visitor can then get the same copy, so allow it only for pages that do not differ by visitor.`;
        return `<p class="cache-confirm" role="alert">${escapeHtml(prompt)}</p><div class="cache-actions">
            <button type="button" class="general-button" data-cache-route-action="confirm" ${attributes}${disabled ? ' disabled' : ''}>Confirm</button>
            <button type="button" class="gray-button" data-cache-route-action="cancel" ${attributes}>Cancel</button></div>`;
    }
    const actions = offeredActions(route);
    if (!actions.length) {
        if (!isNever(route)) return '';
        const reason = escapeHtml(route.neverBy && route.neverBy !== route.path ? `Never cached (covered by ${route.neverBy})` : 'Never cached');
        return `<span class="cache-locked" title="${reason}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Locked</span>`;
    }
    return `<div class="cache-actions">${actions.map((action) => action === 'check'
        ? `<button type="button" class="gray-button" data-cache-route-action="check" ${attributes}${disabled || ui.checking ? ' disabled' : ''}>${ui.checking === key ? 'Checking…' : 'Check'}</button>`
        : `<button type="button" class="gray-button" data-cache-route-action="${action}" ${attributes}${disabled ? ' disabled' : ''}>${ACTION_LABELS[action]}</button>`).join('')}</div>`;
}

function renderRouteRow(app, route, ui, disabled) {
    const mark = describeMark(route);
    const setting = route.setting;
    const notes = [...mark.notes, ...(setting ? [`Set by ${setting.by} at ${setting.at}`] : [])];
    return `<tr data-cache-route>
        <td data-label="Path"><code class="cache-path" title="${escapeHtml(route.path)}">${escapeHtml(route.path)}</code></td>
        <td data-label="Mark"><span class="status-badge cache-mark ${mark.tone}">${escapeHtml(mark.label)}</span>${notes.map((note) => `<span class="cache-note">${escapeHtml(note)}</span>`).join('')}</td>
        <td data-label="Cloudflare header for an anonymous request"><code>${escapeHtml(route.cdnHeader)}</code>${renderCheck(route.stale ? null : ui.checks.get(routeKey(app.agent, route.path)))}</td>
        <td data-label="Actions" class="cache-actions-cell">${renderActions(app, route, ui, disabled)}</td>
    </tr>`;
}

function renderRoutesTable(app, ui, disabled) {
    if (!Array.isArray(app.publicRoutes)) {
        // An older Router sends only the manifest-marked routes: show them read-only.
        const marked = Array.isArray(app.routes) ? app.routes : [];
        if (!marked.length) return '<p class="settings-card-meta">This application marks no cacheable paths.</p>';
        return `<table class="cache-routes-table cache-routes-plain" aria-label="Cacheable paths of ${escapeHtml(app.agent)}"><thead><tr><th scope="col">Path</th><th scope="col">Mark</th></tr></thead><tbody>${marked.map((route) =>
            `<tr><td data-label="Path"><code class="cache-path" title="${escapeHtml(route.path)}">${escapeHtml(route.path)}</code></td><td data-label="Mark"><span class="status-badge cache-mark success">Manifest ${escapeHtml(route.cache)}</span></td></tr>`).join('')}</tbody></table>`;
    }
    const note = app.adminChoices === false
        ? '<p class="settings-card-meta">Caching can be allowed on other routes only after the application marks at least one route as never cached.</p>' : '';
    if (!app.publicRoutes.length) return `<p class="settings-card-meta">This application has no public routes.</p>${note}`;
    return `<table class="cache-routes-table" aria-label="Public routes of ${escapeHtml(app.agent)}"><thead><tr><th scope="col">Path</th><th scope="col">Mark</th><th scope="col">Cloudflare header for an anonymous request</th><th scope="col">Actions</th></tr></thead><tbody>${app.publicRoutes.map((route) => renderRouteRow(app, route, ui, disabled)).join('')}</tbody></table>${note}`;
}

function renderApplication(app, ui, disabled) {
    const agent = escapeHtml(app.agent);
    const state = app.held
        ? `<span class="status-badge warning">Held since ${escapeHtml(app.held.since)} by ${escapeHtml(app.held.by)}</span>`
        : `<span class="status-badge${app.enabled ? ' success' : ''}">${app.enabled ? 'On' : 'Off'}</span>`;
    const hosts = Array.isArray(app.hosts) && app.hosts.length ? `Published on ${app.hosts.map(escapeHtml).join(', ')}` : 'No published hosts';
    return `<article class="settings-card settings-card-static cache-app">
        <div class="cache-app-heading">
            <div class="cache-app-title"><h3 class="settings-card-title">${agent}</h3>${state}<span class="settings-card-meta">${hosts}</span></div>
            <div class="cache-app-controls">
                <button type="button" role="switch" aria-checked="${app.enabled ? 'true' : 'false'}" class="plugin-settings-toggle${app.enabled ? ' enabled' : ''}" data-cache-toggle="${agent}"${disabled || app.held ? ' disabled' : ''}><span class="plugin-settings-switch-track" aria-hidden="true"><span class="plugin-settings-switch-thumb"></span></span><span class="plugin-settings-switch-text">Caching</span></button>
                <label class="cache-freshness"><span class="form-label">Page freshness</span><select class="form-input" data-cache-minutes="${agent}"${disabled ? ' disabled' : ''}>
                    ${minutes.map((value) => `<option value="${value}"${value * 60 === app.pageSeconds ? ' selected' : ''}>${value} ${value === 1 ? 'minute' : 'minutes'}</option>`).join('')}
                </select></label>
            </div>
        </div>
        ${renderRoutesTable(app, ui, disabled)}
    </article>`;
}

function renderHosts(snapshot, apps, disabled) {
    const hosts = [...(snapshot.hosts || [])];
    for (const app of apps) {
        for (const name of app.hosts || []) if (!hosts.some((entry) => entry.host === name)) hosts.push({ host: name, purgeConfigured: false, lastPurge: null });
    }
    if (!hosts.length) return '<p class="settings-card-meta">No published hosts.</p>';
    return `<section class="cache-hosts" aria-label="Published hosts">${hosts.map((host) => {
        const last = host.lastPurge;
        return `<div class="cache-host">
            <div class="cache-host-main"><strong class="cache-host-name">${escapeHtml(host.host)}</strong><span class="status-badge${host.purgeConfigured ? ' success' : ''}">${host.purgeConfigured ? 'Purge configured' : 'Purge unconfigured'}</span></div>
            <span class="settings-card-meta cache-host-history">${last ? `Last recorded clear: ${describePurge(last)} at ${escapeHtml(last.at)} by ${escapeHtml(last.by)}` : 'No recorded clear'}</span>
            <button type="button" class="gray-button" data-purge-host="${escapeHtml(host.host)}"${disabled || !host.purgeConfigured ? ' disabled' : ''}>Clear cache now</button>
        </div>`;
    }).join('')}</section>`;
}

export function renderCachePanel({ snapshot = null, busy = false, unconfirmed = false, error = '', results = [], receivedAt = '', confirming = null, checks = new Map(), checking = '' } = {}) {
    const disabled = busy || unconfirmed;
    const apps = Array.isArray(snapshot?.applications) ? snapshot.applications : null;
    const ui = { confirming, checks, checking };
    return `<div class="cache-toolbar"><div class="settings-card-info"><h2 class="settings-section-title">Cache</h2><p class="settings-section-description">Cloudflare keeps copies of public answers the Router marks. Release files are kept a year; pages for the minutes you choose. This page cannot see Cloudflare’s rules or cached objects.</p></div>
        <div class="settings-card-actions"><button type="button" class="gray-button" data-cache-refresh${busy ? ' disabled' : ''}>Refresh</button></div></div>
        ${error ? `<p class="settings-status error cache-message" role="alert">${escapeHtml(error)}</p>` : ''}
        ${results.length ? `<div class="settings-status success cache-results" role="status"><strong>Clear request results</strong> <span class="settings-card-meta">Response received at ${escapeHtml(receivedAt)}</span><ul>${results.map((item) =>
            `<li>${escapeHtml(item.host)} · ${describePurge(item)}</li>`).join('')}</ul></div>` : ''}
        ${apps ? renderHosts(snapshot, apps, disabled) : ''}
        ${apps ? apps.map((app) => renderApplication(app, ui, disabled)).join('') : ''}
        ${apps?.length === 0 ? '<p class="settings-empty-state">No applications have cacheable paths.</p>' : ''}
        ${!apps && !error ? '<p class="settings-status loading" role="status">Loading cache settings…</p>' : ''}`;
}

export class CachePanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.api = props.api || createCacheApi();
        this.abort = new AbortController();
        this.active = true;
        this.snapshot = element.cacheSnapshot || null;
        this.results = [];
        this.checks = new Map();
        this.confirming = null;
        this.checking = '';
        this.error = '';
        this.unconfirmed = false;
        invalidate();
    }

    beforeRender() {}

    async afterRender() {
        if (this.element.isConnected === false || this.abort.signal.aborted) return;
        this.content = this.element.querySelector('[data-role="cache-content"]');
        this.render();
        if (this.bound) return;
        this.bound = true;
        const options = { signal: this.abort.signal };
        this.element.addEventListener('change', ({ target }) => {
            const { cacheMinutes } = target.dataset;
            if (cacheMinutes !== undefined) void this.change(cacheMinutes, { pageSeconds: Number(target.value) * 60 });
        }, options);
        this.element.addEventListener('click', ({ target }) => {
            const button = target.closest?.('button');
            if (!button || !this.element.contains(button)) return;
            const { purgeHost, cacheToggle, cacheRouteAction, cacheAgent, cachePath } = button.dataset;
            if (purgeHost !== undefined) void this.purge(purgeHost);
            if (cacheToggle !== undefined) {
                const app = this.snapshot?.applications.find((entry) => entry.agent === cacheToggle);
                if (app) void this.change(cacheToggle, { enabled: !app.enabled });
            }
            if (cacheRouteAction !== undefined) void this.routeAction(cacheRouteAction, cacheAgent, cachePath);
            if (button.hasAttribute('data-cache-refresh')) void this.refresh();
        }, options);
        this.element.addEventListener('cache-active', ({ detail }) => {
            const becameActive = detail === true && !this.active;
            this.active = detail === true;
            if (becameActive) void this.refresh();
        }, options);
        if (!this.snapshot) await this.refresh();
    }

    afterUnload() {
        this.abort.abort();
    }

    render() {
        if (!this.content || this.abort.signal.aborted) return;
        if (this.denied) {
            this.content.textContent = 'Administrator access is required.';
            return;
        }
        this.content.innerHTML = renderCachePanel(this);
    }

    // Rows can share a path (a stale setting beside the live entry): pick the one that offers the action.
    findRoute(agent, path, action) {
        const app = this.snapshot?.applications.find((entry) => entry.agent === agent);
        return app?.publicRoutes?.find((entry) => entry.path === path && offeredActions(entry).includes(action));
    }

    change(agent, patch) {
        const app = this.snapshot?.applications.find((entry) => entry.agent === agent);
        if (!app || this.unconfirmed) return;
        const { enabled = app.enabled, pageSeconds = app.pageSeconds } = patch;
        if ((app.held && enabled !== app.enabled) || !minutes.includes(pageSeconds / 60)) return;
        if (enabled === app.enabled && pageSeconds === app.pageSeconds) return;
        this.confirming = null;
        return this.run(async (options) => {
            this.acceptReply(agent, await this.api.setApplication({ agent, enabled, pageSeconds }, options));
        });
    }

    acceptReply(agent, reply) {
        this.snapshot = { ...this.snapshot, applications: this.snapshot.applications.map((entry) => entry.agent === agent ? reply.application : entry) };
        this.results = reply.purges || [];
    }

    // Only an action the row offers is ever acted on; the path is the Router's normalized one.
    routeAction(action, agent, path) {
        if (action === 'cancel') {
            this.confirming = null;
            this.render();
            return;
        }
        if (action === 'confirm') {
            if (!this.confirming) return;
            ({ agent, path } = this.confirming);
            action = this.confirming.setting;
        }
        const route = this.findRoute(agent, path, action);
        if (!route || this.busy || this.unconfirmed || this.denied) return;
        if (action === 'check') return this.check(agent, path);
        if (action !== 'default' && !(this.confirming?.agent === agent && this.confirming.path === path && this.confirming.setting === action)) {
            this.confirming = { agent, path, setting: action };
            this.render();
            return;
        }
        this.confirming = null;
        return this.run(async (options) => {
            this.acceptReply(agent, await this.api.setRoute({ agent, path, setting: action }, options));
        });
    }

    purge(host) {
        if (this.unconfirmed || !this.snapshot?.hosts.some((entry) => entry.host === host && entry.purgeConfigured)) return;
        return this.run(async (options) => {
            const reply = await this.api.purgeHost({ host }, options);
            this.results = [reply.purge];
        });
    }

    refresh() {
        this.confirming = null;
        return this.run();
    }

    // A check changes nothing, so a failure stays in its row and never locks the panel.
    async check(agent, path) {
        const { signal } = this.abort;
        const key = routeKey(agent, path);
        this.busy = true;
        this.checking = key;
        this.checks.delete(key);
        this.render();
        try {
            const reply = await this.api.checkRoute({ agent, path }, { signal });
            this.checks.set(key, { check: reply.check });
        } catch (error) {
            if (signal.aborted) return;
            if (cacheAccessDenied(error)) this.deny();
            else this.checks.set(key, { error: describeCacheError(error, CHECK_ERRORS) || 'The check could not be completed. Try again.' });
        } finally {
            this.busy = false;
            this.checking = '';
            this.render();
        }
    }

    deny() {
        this.denied = true;
        this.snapshot = null;
        this.results = [];
        this.checks.clear();
        this.element.dispatchEvent(new CustomEvent('cache-access-denied', { bubbles: true }));
    }

    async run(mutation) {
        const { signal } = this.abort;
        if (this.busy || this.denied || signal.aborted) return;
        this.busy = true;
        this.error = '';
        this.unconfirmed = false;
        this.results = [];
        this.checks.clear();
        this.render();
        let reading = false;
        try {
            if (mutation) {
                try {
                    await mutation({ signal });
                    this.receivedAt = new Date().toISOString();
                    this.render();
                } catch (error) {
                    // A refusal changed nothing: say why, then show the current state.
                    const refusal = error?.status >= 400 && error.status < 500 ? REFUSALS[error.code] || '' : '';
                    if (!refusal) throw error;
                    this.error = refusal;
                }
            }
            if (signal.aborted) return;
            reading = true;
            this.snapshot = await this.api.read({ signal });
        } catch (error) {
            if (signal.aborted) return;
            if (cacheAccessDenied(error)) {
                this.deny();
            } else {
                this.error = reading ? 'Could not refresh cache settings. Refresh to get the latest status.' : 'Could not confirm the cache request. Refresh before trying again.';
                this.unconfirmed = true;
            }
        } finally {
            this.busy = false;
            this.render();
        }
    }
}
