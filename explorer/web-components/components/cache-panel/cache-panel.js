import { createCacheApi, cacheAccessDenied } from '../../../services/infrastructure/cacheApi.js';
import { escapeHtml } from '../admin-settings-panel/admin-settings-utils.js';

const minutes = [1, 2, 5];
// The only settings a route change may send; an action outside this record is never acted on.
const ROUTE_SETTINGS = Object.freeze({ off: 'off', page: 'page', default: 'default' });

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
    wildcard_path: 'Only an exact path can be tested, not a path pattern.',
    unknown_route: 'This route is no longer a public route of the application.',
    no_published_host: 'No published host sends this path to the application, so it cannot be tested.',
    cache_unavailable: 'The Router could not fetch this page to test it. Try again later.',
};

export function describeCacheError(error, table = REFUSALS) {
    if (error?.code === 'rate_limited') {
        const seconds = Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : 1;
        return `Tests are limited to one per second. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
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

// The one place that decides what a route offers, and so which rows are shown at all. A stale row
// (even one whose entry has since become `never`) offers only `default`, so the saved setting can
// always be removed. A never route, a route under a never wildcard, a publicProtocol route and a
// route with no choice offer nothing and are not rendered.
export function offeredActions(route) {
    if (route.stale) return ['default'];
    if (isNever(route) || route.neverBy || route.publicProtocol) return [];
    const choices = Array.isArray(route.choices) ? route.choices.filter((choice) => Object.hasOwn(ROUTE_SETTINGS, choice)) : [];
    if (!choices.length) return [];
    return [...choices, ...(route.checkable === true ? ['check'] : [])];
}

// Which way a route's switch is set and the one action that turning it sends, taken from the actions
// the row offers: a saved setting is removed (`default`), a manifest class is switched `off`, an
// unmarked choosable route is allowed `page`.
export function routeSwitch(route) {
    const actions = offeredActions(route);
    if (actions.includes('default')) return { on: route.setting?.setting === 'page', action: 'default' };
    if (actions.includes('off')) return { on: true, action: 'off' };
    if (actions.includes('page')) return { on: false, action: 'page' };
    return null;
}

function describeMinutes(seconds) {
    const count = Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : 5;
    return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
}

function describeApplication(app) {
    if (!app.enabled) return 'Caching is off. Cloudflare keeps no copies of this application.';
    if (app.held) return 'Page caching is held, so pages are not kept. Release files are still kept for a year. Visitors who are signed in always get a fresh answer.';
    return `Pages are kept for ${describeMinutes(app.pageSeconds)} and release files for a year. Visitors who are signed in always get a fresh answer.`;
}

function describeStatus(app, route) {
    if (!route.effective) return 'Not cached';
    if (!app.enabled) return 'Not cached while the application is off';
    if (route.effective === 'immutable') return 'Cached for a year';
    if (app.held) return 'Not cached while held';
    return `Cached for ${describeMinutes(app.pageSeconds)}`;
}

function describeSource(route) {
    const setting = route.setting?.setting;
    if (route.source === 'off' || setting === 'off') return 'switched off by an administrator';
    if (route.source === 'administrator' || setting === 'page') return 'added by an administrator';
    if (route.source === 'manifest' || route.manifest) return 'from the application';
    return 'not marked by the application';
}

function describeStale(route) {
    return `The saved ${route.setting?.setting === 'page' ? '“allow caching”' : '“switch off”'} setting no longer matches this route and has no effect.`;
}

function renderCheck(entry) {
    if (!entry) return '';
    if (entry.error) return `<p class="cache-check error" role="status">${escapeHtml(entry.error)}</p>`;
    if (!entry.check || typeof entry.check !== 'object') return '<p class="cache-check error" role="status">The Router returned no test result.</p>';
    const { host, path, status, cdnHeader, cacheControl } = entry.check;
    return `<p class="cache-check" role="status"><strong>Tested now:</strong> HTTP ${escapeHtml(status)} from ${escapeHtml(host)}${escapeHtml(path)}. Cloudflare header sent: <code>${escapeHtml(cdnHeader || 'none')}</code>. Application header: <code>${escapeHtml(cacheControl || 'none')}</code>.</p>`;
}

const settingNote = (route) => (route.setting ? ` title="Set by ${escapeHtml(route.setting.by)} at ${escapeHtml(route.setting.at)}"` : '');

function renderRoute(app, route, ui, disabled) {
    const attributes = `data-cache-agent="${escapeHtml(app.agent)}" data-cache-path="${escapeHtml(route.path)}"`;
    const path = `<code class="cache-path" title="${escapeHtml(route.path)}">${escapeHtml(route.path)}</code>`;
    if (route.stale) {
        return `<li class="cache-route cache-route-stale" data-cache-route>${path}
            <div class="cache-route-state"><span class="status-badge warning">Stale</span><span class="cache-route-source"${settingNote(route)}>${escapeHtml(describeStale(route))}</span></div>
            <div class="cache-route-controls"><button type="button" class="gray-button" data-cache-route-action="default" ${attributes}${disabled ? ' disabled' : ''}>Remove</button></div></li>`;
    }
    const key = routeKey(app.agent, route.path);
    const toggle = routeSwitch(route);
    const switchHtml = toggle ? `<button type="button" role="switch" aria-checked="${toggle.on ? 'true' : 'false'}" aria-label="Caching for ${escapeHtml(route.path)}" title="${toggle.on ? 'Switch off' : 'Switch on'}" class="plugin-settings-toggle cache-route-switch${toggle.on ? ' enabled' : ''}" data-cache-route-action="${toggle.action}" ${attributes}${disabled ? ' disabled' : ''}><span class="plugin-settings-switch-track" aria-hidden="true"><span class="plugin-settings-switch-thumb"></span></span></button>` : '';
    const testHtml = offeredActions(route).includes('check')
        ? `<button type="button" class="gray-button cache-test" data-cache-route-action="check" ${attributes}${disabled || ui.checking ? ' disabled' : ''}>${ui.checking === key ? 'Testing…' : 'Test'}</button>` : '';
    return `<li class="cache-route" data-cache-route>${path}
        <span class="cache-route-status">${escapeHtml(describeStatus(app, route))}</span>
        <span class="cache-route-source"${settingNote(route)}>${escapeHtml(describeSource(route))}</span>
        <div class="cache-route-controls">${testHtml}${switchHtml}</div>
        ${renderCheck(ui.checks.get(key))}</li>`;
}

function renderRoutes(app, ui, disabled) {
    let rows;
    if (Array.isArray(app.publicRoutes)) {
        rows = app.publicRoutes.filter((route) => offeredActions(route).length).map((route) => renderRoute(app, route, ui, disabled));
        if (!rows.length) return '<p class="cache-card-meta">No routes can be changed here.</p>';
    } else {
        // An older Router sends only the manifest-marked routes: show them read-only.
        const marked = Array.isArray(app.routes) ? app.routes : [];
        if (!marked.length) return '<p class="cache-card-meta">This application marks no cacheable paths.</p>';
        rows = marked.map((route) => `<li class="cache-route"><code class="cache-path" title="${escapeHtml(route.path)}">${escapeHtml(route.path)}</code>
            <span class="cache-route-status">${escapeHtml(describeStatus(app, { effective: route.cache }))}</span>
            <span class="cache-route-source">from the application</span></li>`);
    }
    return `<div class="cache-routes${Array.isArray(app.publicRoutes) ? '' : ' cache-routes-plain'}"><div class="cache-routes-head"><span>Routes</span><span class="status-badge">${rows.length}</span></div>
        <ul class="cache-route-list" aria-label="Routes of ${escapeHtml(app.agent)}">${rows.join('')}</ul></div>`;
}

function renderApplication(app, ui, disabled) {
    const agent = escapeHtml(app.agent);
    const state = app.held
        ? `<span class="status-badge warning">Held since ${escapeHtml(app.held.since)} by ${escapeHtml(app.held.by)}</span>`
        : `<span class="status-badge${app.enabled ? ' success' : ''}">${app.enabled ? 'On' : 'Off'}</span>`;
    const hosts = Array.isArray(app.hosts) && app.hosts.length ? `Published on ${app.hosts.map(escapeHtml).join(', ')}` : 'No published hosts';
    return `<article class="settings-card settings-card-static cache-card cache-app">
        <div class="cache-card-top">
            <div class="cache-card-title-row"><h3 class="cache-card-title">${agent}</h3>${state}</div>
            <div class="cache-card-controls">
                <label class="cache-freshness"><span class="form-label">Page freshness</span><select class="form-input" data-cache-minutes="${agent}"${disabled ? ' disabled' : ''}>
                    ${minutes.map((value) => `<option value="${value}"${value * 60 === app.pageSeconds ? ' selected' : ''}>${value} ${value === 1 ? 'minute' : 'minutes'}</option>`).join('')}
                </select></label>
                <button type="button" role="switch" aria-checked="${app.enabled ? 'true' : 'false'}" class="plugin-settings-toggle${app.enabled ? ' enabled' : ''}" data-cache-toggle="${agent}"${disabled || app.held ? ' disabled' : ''}><span class="plugin-settings-switch-track" aria-hidden="true"><span class="plugin-settings-switch-thumb"></span></span><span class="plugin-settings-switch-text">Caching</span></button>
            </div>
            <div class="cache-card-text"><p>${escapeHtml(describeApplication(app))}</p><p class="cache-card-meta">${hosts}</p></div>
        </div>
        <hr class="cache-divider">
        ${renderRoutes(app, ui, disabled)}
    </article>`;
}

function renderHosts(snapshot, apps, disabled) {
    const hosts = [...(snapshot.hosts || [])];
    for (const app of apps) {
        for (const name of app.hosts || []) if (!hosts.some((entry) => entry.host === name)) hosts.push({ host: name, purgeConfigured: false, lastPurge: null });
    }
    if (!hosts.length) return '<p class="cache-card-meta">No published hosts.</p>';
    return `<ul class="cache-list cache-hosts" aria-label="Published hosts">${hosts.map((host) => {
        const last = host.lastPurge;
        return `<li class="cache-host">
            <div class="cache-host-main"><strong class="cache-host-name">${escapeHtml(host.host)}</strong><span class="status-badge${host.purgeConfigured ? ' success' : ''}">${host.purgeConfigured ? 'Purge configured' : 'Purge unconfigured'}</span></div>
            <span class="cache-card-meta cache-host-history">${last ? `Last recorded clear: ${describePurge(last)} at ${escapeHtml(last.at)} by ${escapeHtml(last.by)}` : 'No recorded clear'}</span>
            <button type="button" class="gray-button" data-purge-host="${escapeHtml(host.host)}"${disabled || !host.purgeConfigured ? ' disabled' : ''}>Clear cache now</button>
        </li>`;
    }).join('')}</ul>`;
}

function renderClearCard(snapshot, apps, disabled, messages) {
    return `<section class="settings-card settings-card-static cache-card cache-clear" aria-label="Clear cache">
        <div class="cache-card-top">
            <div class="cache-card-title-row"><h3 class="cache-card-title">Clear cache</h3><span class="cache-help" role="img" tabindex="0" aria-label="Hosts without purge configured cannot be cleared here." title="Hosts without purge configured cannot be cleared here.">?</span></div>
            <div class="cache-card-text"><p>Removes Cloudflare’s copies for a host, so the next visitor gets a fresh answer. Cleared at most once every 15 seconds per host.</p></div>
        </div>
        ${messages}
        ${renderHosts(snapshot, apps, disabled)}
    </section>`;
}

export function renderCachePanel({ snapshot = null, busy = false, unconfirmed = false, error = '', results = [], receivedAt = '', checks = new Map(), checking = '' } = {}) {
    const disabled = busy || unconfirmed;
    const apps = Array.isArray(snapshot?.applications) ? snapshot.applications : null;
    const ui = { checks, checking };
    // Results and errors belong to the Clear cache card; before the first read there is no card, so the error stands alone.
    const messages = `${error ? `<p class="settings-status error cache-message" role="alert">${escapeHtml(error)}</p>` : ''}
        ${results.length ? `<div class="settings-status success cache-results" role="status"><strong>Clear request results</strong> <span class="cache-card-meta">Response received at ${escapeHtml(receivedAt)}</span><ul>${results.map((item) =>
            `<li>${escapeHtml(item.host)} · ${describePurge(item)}</li>`).join('')}</ul></div>` : ''}`;
    return `<div class="cache-head"><div class="cache-head-text"><h2 class="settings-section-title cache-title">Cache</h2><p class="settings-section-description">Choose what Cloudflare keeps copies of, and clear them. This page cannot see Cloudflare’s rules or cached objects.</p></div>
        <div class="settings-card-actions"><button type="button" class="gray-button" data-cache-refresh${busy ? ' disabled' : ''}>Refresh</button></div></div>
        ${apps ? renderClearCard(snapshot, apps, disabled, messages) : messages}
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
        return this.run(async (options) => {
            this.acceptReply(agent, await this.api.setApplication({ agent, enabled, pageSeconds }, options));
        });
    }

    acceptReply(agent, reply) {
        this.snapshot = { ...this.snapshot, applications: this.snapshot.applications.map((entry) => entry.agent === agent ? reply.application : entry) };
        this.results = reply.purges || [];
    }

    // Only an action the row offers is ever acted on; the path is the Router's normalized one. A switch
    // acts at once, like the application switch: the Router's reply carries the purge results.
    routeAction(action, agent, path) {
        const route = this.findRoute(agent, path, action);
        if (!route || this.busy || this.unconfirmed || this.denied) return;
        if (action === 'check') return this.check(agent, path);
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
            else this.checks.set(key, { error: describeCacheError(error, CHECK_ERRORS) || 'The test could not be completed. Try again.' });
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
