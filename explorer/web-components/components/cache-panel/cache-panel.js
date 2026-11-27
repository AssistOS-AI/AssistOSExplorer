import { createCacheApi, cacheAccessDenied } from '../../../services/infrastructure/cacheApi.js';
import { escapeHtml } from '../admin-settings-panel/admin-settings-utils.js';

const minutes = [1, 2, 5];

function describePurge(result) {
    const retry = result.outcome === 'cooldown' && Number.isFinite(result.retryAfterSeconds)
        ? ` (retry after ${result.retryAfterSeconds} seconds)` : '';
    return escapeHtml(result.outcome) + retry;
}

function renderHost(name, hosts, disabled) {
    const host = hosts.find((entry) => entry.host === name);
    const last = host?.lastPurge;
    return `<div class="cache-host">
        <strong class="cache-host-name">${escapeHtml(name)}</strong>
        <button type="button" class="gray-button" data-purge-host="${escapeHtml(name)}"${disabled || !host?.purgeConfigured ? ' disabled' : ''}>Clear cache now</button>
        ${!host?.purgeConfigured ? '<span class="settings-card-meta">Purge unconfigured</span>' : ''}
        <span class="settings-card-meta cache-host-history">${last ? `Last recorded clear: ${describePurge(last)} at ${escapeHtml(last.at)} by ${escapeHtml(last.by)}` : 'No recorded clear'}</span>
    </div>`;
}

function renderApplication(app, hosts, disabled) {
    const agent = escapeHtml(app.agent);
    return `<article class="settings-card settings-card-static">
        <div class="cache-card-heading"><h3 class="settings-card-title">${agent}</h3>${app.held ? `<span class="status-badge">Held since ${escapeHtml(app.held.since)} by ${escapeHtml(app.held.by)}</span>` : ''}</div>
        <div class="cache-controls">
            <label class="editor-settings-toggle"><input type="checkbox" role="switch" data-cache-toggle="${agent}"${app.enabled ? ' checked' : ''}${disabled || app.held ? ' disabled' : ''}><span>Enable caching</span></label>
            <label class="cache-freshness"><span>Page freshness</span><select class="form-input" data-cache-minutes="${agent}"${disabled ? ' disabled' : ''}>
                ${minutes.map((value) => `<option value="${value}"${value * 60 === app.pageSeconds ? ' selected' : ''}>${value} ${value === 1 ? 'minute' : 'minutes'}</option>`).join('')}
            </select></label>
        </div>
        <details class="cache-routes"><summary>Cacheable paths (${app.routes.length})</summary><ul>${app.routes.map((route) =>
            `<li><code>${escapeHtml(route.path)}</code> · ${escapeHtml(route.cache)}</li>`).join('')}</ul></details>
        ${app.hosts.length ? app.hosts.map((name) => renderHost(name, hosts, disabled)).join('') : '<p class="settings-card-meta">No published hosts.</p>'}
    </article>`;
}

export class CachePanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.api = props.api || createCacheApi();
        this.abort = new AbortController();
        this.active = true;
        this.snapshot = element.cacheSnapshot || null;
        this.results = [];
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
            const { cacheToggle, cacheMinutes } = target.dataset;
            if (cacheToggle !== undefined) void this.change(cacheToggle, { enabled: target.checked });
            if (cacheMinutes !== undefined) void this.change(cacheMinutes, { pageSeconds: Number(target.value) * 60 });
        }, options);
        this.element.addEventListener('click', ({ target }) => {
            const button = target.closest?.('button');
            if (!button || !this.element.contains(button)) return;
            if (button.dataset.purgeHost !== undefined) void this.purge(button.dataset.purgeHost);
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
        const disabled = this.busy || Boolean(this.error);
        const apps = this.snapshot?.applications;
        this.content.innerHTML = `<div class="cache-heading"><div class="cache-title-row"><h2 class="settings-section-title">Cache</h2>
            <button type="button" class="gray-button cache-refresh" data-cache-refresh aria-label="Refresh cache settings" title="Refresh cache settings"${this.busy ? ' disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.4-5.7M20 4v5h-5"/></svg></button></div>
            <p class="settings-section-description">Versioned files are cached for one year while caching is enabled. This page cannot see Cloudflare’s rules or cached objects.</p></div>
            ${this.error ? `<p class="settings-status error" role="alert">${escapeHtml(this.error)}</p>` : ''}
            ${this.results.length ? `<div class="settings-card settings-card-static cache-results" role="status"><strong>Clear request results</strong><p class="settings-card-meta">Response received at ${escapeHtml(this.receivedAt)}</p><ul>${this.results.map((item) =>
                `<li>${escapeHtml(item.host)} · ${describePurge(item)}</li>`).join('')}</ul></div>` : ''}
            ${apps ? apps.map((app) => renderApplication(app, this.snapshot.hosts, disabled)).join('') : ''}
            ${apps?.length === 0 ? '<p class="settings-empty-state">No applications have cacheable paths.</p>' : ''}
            ${!apps && !this.error ? '<p class="settings-status loading" role="status">Loading cache settings…</p>' : ''}`;
    }

    change(agent, patch) {
        const app = this.snapshot?.applications.find((entry) => entry.agent === agent);
        if (!app || this.error) return;
        const { enabled = app.enabled, pageSeconds = app.pageSeconds } = patch;
        if ((app.held && enabled !== app.enabled) || !minutes.includes(pageSeconds / 60)) return;
        if (enabled === app.enabled && pageSeconds === app.pageSeconds) return;
        return this.run(async (options) => {
            const reply = await this.api.setApplication({ agent, enabled, pageSeconds }, options);
            this.snapshot = { ...this.snapshot, applications: this.snapshot.applications.map((entry) => entry.agent === agent ? reply.application : entry) };
            this.results = reply.purges || [];
        });
    }

    purge(host) {
        if (this.error || !this.snapshot?.hosts.some((entry) => entry.host === host && entry.purgeConfigured)) return;
        return this.run(async (options) => {
            const reply = await this.api.purgeHost({ host }, options);
            this.results = [reply.purge];
        });
    }

    refresh() {
        return this.run();
    }

    async run(mutation) {
        const { signal } = this.abort;
        if (this.busy || this.denied || signal.aborted) return;
        this.busy = true;
        this.error = '';
        this.results = [];
        this.render();
        let reading = false;
        try {
            if (mutation) {
                await mutation({ signal });
                this.receivedAt = new Date().toISOString();
                this.render();
            }
            if (signal.aborted) return;
            reading = true;
            this.snapshot = await this.api.read({ signal });
        } catch (error) {
            if (signal.aborted) return;
            if (cacheAccessDenied(error)) {
                this.denied = true;
                this.snapshot = null;
                this.results = [];
                this.element.dispatchEvent(new CustomEvent('cache-access-denied', { bubbles: true }));
            } else {
                this.error = reading ? 'Could not refresh cache settings. Refresh to get the latest status.' : 'Could not confirm the cache request. Refresh before trying again.';
            }
        } finally {
            this.busy = false;
            this.render();
        }
    }
}
