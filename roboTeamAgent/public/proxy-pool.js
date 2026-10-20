import { initCreateRobotDialog, initRobotMenu } from './robot-controls.js';

const STATUS_LABELS = { enabled: 'Enabled', draining: 'Draining', disabled: 'Disabled' };
const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const HEALTH_LABELS = { pending: 'Not synced yet', ok: 'Synced', error: 'Sync failed', rejected: 'Credentials rejected' };

export function proxyAccountCounts(account) {
    const proxies = `${account.proxyCount} ${account.proxyCount === 1 ? 'proxy' : 'proxies'}`;
    return `${proxies} · ${account.availableCount} available · ${account.assignedCount} in use`;
}

export function proxyState(proxy) {
    if (!proxy.available) return { label: 'Unavailable', tone: 'error' };
    if (proxy.checkStatus === 'failed') return { label: 'Check failed', tone: 'error' };
    if (proxy.robotId) return { label: 'In use', tone: 'busy' };
    return { label: 'Free', tone: 'ok' };
}

export function proxyPoolSummary(pool) {
    const proxies = pool.proxies.length, accounts = pool.accounts.length;
    return `${proxies} ${proxies === 1 ? 'proxy' : 'proxies'} · ${accounts} ${accounts === 1 ? 'account' : 'accounts'}`;
}

export function initProxyPool({ root = document, api, closeMenus }) {
    const panel = root.querySelector('#proxiesPanel'), content = root.querySelector('#proxyAdminContent');
    const accountsList = root.querySelector('#proxyAccountsList'), tableBody = root.querySelector('#proxyTableBody');
    const template = root.querySelector('#proxyAccountTemplate'), message = root.querySelector('#proxyMessage');
    const poolState = root.querySelector('#proxyPoolState'), count = root.querySelector('#proxyCount');
    const trigger = root.querySelector('#addProxyAccountButton'), dialog = root.querySelector('#proxyAccountDialog');
    const form = root.querySelector('#proxyAccountForm'), fields = root.querySelector('#proxyAccountFields');
    const formMessage = root.querySelector('#proxyAccountMessage');
    const control = name => form.elements.namedItem(name);
    let admin = false, pool = null, loading = null, busy = false, timer = null;
    const pending = new Set();
    const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    const owner = initCreateRobotDialog({ dialog, trigger, closeButton: root.querySelector('#proxyAccountClose'),
        cancelButton: root.querySelector('#proxyAccountCancel'), onOpen: openDialog });

    function report(text, tone = '') { message.textContent = text; message.className = `message${tone ? ` ${tone}` : ''}`; }

    function renderFields() {
        const provider = pool?.providers.find(entry => entry.id === control('provider').value);
        fields.replaceChildren();
        for (const field of provider?.fields || []) {
            const label = root.createElement('label');
            const caption = root.createElement('span'); caption.textContent = field.label;
            const input = root.createElement(field.multiline ? 'textarea' : 'input');
            input.name = `config.${field.name}`; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
            if (field.multiline) input.rows = 6;
            else if (field.secret) input.type = 'password';
            label.append(caption, input); fields.append(label);
        }
    }

    function openDialog() {
        closeMenus(); form.reset(); formMessage.textContent = '';
        const select = control('provider'); select.replaceChildren();
        for (const provider of pool?.providers || []) {
            const option = root.createElement('option'); option.value = provider.id; option.textContent = provider.label; select.append(option);
        }
        renderFields();
    }
    control('provider').onchange = renderFields;

    form.onsubmit = async event => {
        event.preventDefault(); if (!admin || busy) return;
        const config = {};
        for (const input of fields.querySelectorAll('[name^="config."]')) config[input.name.slice(7)] = input.value;
        busy = true; owner.setBusy(true); formMessage.textContent = '';
        for (const input of form.querySelectorAll('input, select, textarea, button')) input.disabled = true;
        let added = null;
        try {
            added = await api('api/proxy-pool/accounts', { method: 'POST', body: {
                provider: control('provider').value, label: control('label').value, priority: control('priority').value, config } });
        } catch (error) { formMessage.textContent = error.message; formMessage.className = 'message error'; }
        finally {
            busy = false; owner.setBusy(false);
            for (const input of form.querySelectorAll('input, select, textarea, button')) input.disabled = false;
        }
        if (!added) return;
        owner.complete();
        report(added.sync?.ok ? `Account added with ${added.sync.proxies} ${added.sync.proxies === 1 ? 'proxy' : 'proxies'}.`
            : `Account added, but its first sync failed: ${added.sync?.error || 'unknown error'}`, added.sync?.ok ? 'success' : 'error');
        await refresh(true);
    };

    async function mutate(key, button, operation, success) {
        if (!admin || pending.has(key)) return;
        pending.add(key); closeMenus(); button.disabled = true;
        try { report(success(await operation()), 'success'); }
        catch (error) { report(error.message, 'error'); }
        finally { pending.delete(key); await refresh(true); }
    }

    function renderAccount(account) {
        const card = template.content.firstElementChild.cloneNode(true);
        const status = card.querySelector('.proxy-account-status');
        status.textContent = STATUS_LABELS[account.status] || account.status;
        status.classList.add(`proxy-status-${account.status}`);
        card.querySelector('.proxy-account-label').textContent = account.label;
        card.querySelector('.proxy-account-provider').textContent = `${account.providerLabel} · ${account.summary} · ${PRIORITY_LABELS[account.priority] || account.priority} priority`;
        card.querySelector('.proxy-account-counts').textContent = proxyAccountCounts(account);
        card.querySelector('.proxy-account-sync').textContent = account.lastSyncAt
            ? `${HEALTH_LABELS[account.health] || account.health} · ${date(account.lastSyncAt)}` : HEALTH_LABELS.pending;
        const error = card.querySelector('.proxy-account-error');
        error.hidden = !account.lastError; error.textContent = account.lastError || '';
        const path = `api/proxy-pool/accounts/${account.id}`;
        const sync = card.querySelector('.proxy-account-sync-now');
        sync.onclick = () => mutate(account.id, sync, () => api(`${path}/sync`, { method: 'POST' }),
            result => result.sync.ok ? `${account.label}: ${result.sync.proxies} ${result.sync.proxies === 1 ? 'proxy' : 'proxies'} synced.` : `${account.label}: ${result.sync.error}`);
        for (const next of ['enabled', 'draining', 'disabled']) {
            const button = card.querySelector(`.proxy-account-${{ enabled: 'enable', draining: 'drain', disabled: 'disable' }[next]}`);
            button.hidden = account.status === next;
            button.onclick = () => mutate(account.id, button, () => api(path, { method: 'PATCH', body: { status: next } }),
                () => `${account.label} is now ${STATUS_LABELS[next].toLowerCase()}.`);
        }
        const remove = card.querySelector('.proxy-account-delete');
        remove.onclick = () => {
            if (!confirm(`Delete proxy account “${account.label}”? Its robots receive another proxy when their workstation next starts.`)) return;
            void mutate(account.id, remove, () => api(path, { method: 'DELETE' }), () => `${account.label} deleted.`);
        };
        if (pending.has(account.id)) card.querySelectorAll('[data-robot-menu-options] button').forEach(button => { button.disabled = true; });
        initRobotMenu({ menu: card.querySelector('.robot-manage'), id: `proxy-account-options-${account.id}`, label: `More actions for ${account.label}`, closeMenus });
        return card;
    }

    function cell(text, className) {
        const td = root.createElement('td'); td.textContent = text; if (className) td.className = className; return td;
    }

    function renderProxy(proxy, accounts) {
        const row = root.createElement('tr');
        const state = proxyState(proxy);
        const stateCell = cell(state.label, `proxy-state proxy-state-${state.tone}`);
        if (proxy.checkError) stateCell.title = proxy.checkError;
        const check = proxy.checkedAt ? `${proxy.checkStatus === 'ok' ? proxy.exitIp : 'Failed'} · ${date(proxy.checkedAt)}` : '—';
        row.append(
            cell([proxy.country, proxy.city].filter(Boolean).join(' · ') || '—'),
            cell(`${proxy.host}:${proxy.port}`, 'proxy-address'),
            cell(accounts.get(proxy.accountId)?.label || '—'),
            stateCell,
            cell(proxy.robotId ? proxy.robotName || proxy.robotId : '—'),
            cell(check),
        );
        const actions = root.createElement('td'); actions.className = 'proxy-row-actions';
        const checkButton = root.createElement('button');
        checkButton.type = 'button'; checkButton.className = 'button secondary'; checkButton.textContent = 'Check';
        checkButton.title = 'Ask an IP echo service through this proxy'; checkButton.disabled = pending.has(proxy.id);
        checkButton.onclick = () => mutate(proxy.id, checkButton, () => api(`api/proxy-pool/proxies/${proxy.id}/check`, { method: 'POST' }),
            result => result.check.ok ? `${proxy.host}:${proxy.port} answers from ${result.check.exitIp}.` : `${proxy.host}:${proxy.port} failed: ${result.check.error}`);
        actions.append(checkButton);
        if (proxy.robotId) {
            const release = root.createElement('button');
            release.type = 'button'; release.className = 'button secondary'; release.textContent = 'Release';
            release.title = 'The robot receives a proxy again when its workstation next starts';
            release.disabled = pending.has(proxy.robotId);
            release.onclick = () => mutate(proxy.robotId, release, () => api(`api/proxy-pool/assignments/${proxy.robotId}`, { method: 'DELETE' }),
                () => `${proxy.robotName || proxy.robotId} no longer holds ${proxy.host}:${proxy.port}.`);
            actions.append(release);
        }
        row.append(actions);
        return row;
    }

    function render() {
        content.hidden = !admin; trigger.disabled = !admin;
        if (!admin) {
            count.textContent = ''; poolState.hidden = true;
            report('Only administrators can view and manage the proxy pool.');
            return;
        }
        if (!pool) return;
        count.textContent = proxyPoolSummary(pool);
        poolState.hidden = false;
        poolState.textContent = pool.active ? 'Pool active: robot workstations start only behind a proxy.' : 'Pool inactive: robot workstations connect directly.';
        poolState.classList.toggle('active', pool.active);
        accountsList.replaceChildren();
        if (!pool.accounts.length) {
            const empty = root.createElement('div'); empty.className = 'empty-state';
            const heading = root.createElement('h3'); heading.textContent = 'No proxy accounts yet';
            const hint = root.createElement('p'); hint.textContent = 'Add a provider account to give robot browsers their own address.';
            empty.append(heading, hint); accountsList.append(empty);
        }
        for (const account of pool.accounts) accountsList.append(renderAccount(account));
        const accounts = new Map(pool.accounts.map(account => [account.id, account]));
        tableBody.replaceChildren(...pool.proxies.map(proxy => renderProxy(proxy, accounts)));
        root.querySelector('#proxyTableWrap').hidden = !pool.proxies.length;
    }

    async function refresh(force = false) {
        if (loading) return loading;
        if (!admin) { render(); return; }
        if (!force && (panel.hidden || dialog.open || panel.querySelector('[data-robot-menu-toggle][aria-expanded="true"]'))) return;
        loading = (async () => {
            try { pool = await api('api/proxy-pool'); render(); }
            catch (error) { report(`Proxy pool unavailable: ${error.message}`, 'error'); }
        })();
        try { await loading; } finally { loading = null; }
    }

    clearInterval(timer);
    timer = setInterval(() => { if (!panel.hidden) void refresh(); }, 60_000);
    window.addEventListener('pagehide', () => clearInterval(timer));
    return {
        refresh,
        setContext(canAdmin) {
            const changed = admin !== canAdmin;
            admin = canAdmin;
            if (changed && admin) report('');
            if (!admin && dialog.open) dialog.close();
            if (changed || !panel.hidden) void refresh(true);
        },
    };
}
