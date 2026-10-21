import { initCreateRobotDialog } from './robot-controls.js';

// Reads the address column of a CSV export, or one address per line. A header cell named
// "email" or "e-mail" selects its column; otherwise the first column is used. Other columns
// (passwords, recovery codes) are dropped here and never leave the browser.
export function parseEmailCsv(text) {
    const rows = String(text || '').replace(/^﻿/u, '').split(/\r?\n/u).filter(line => line.trim());
    if (!rows.length) return [];
    const separator = [',', ';', '\t'].find(candidate => rows[0].includes(candidate));
    const cells = line => (separator ? line.split(separator) : [line]).map(cell => cell.trim().replace(/^"(.*)"$/u, '$1').trim());
    const header = cells(rows[0]);
    const named = header.findIndex(cell => /^e-?mail(\s*address)?$/iu.test(cell));
    const column = Math.max(named, 0);
    return [...new Set((named >= 0 ? rows.slice(1) : rows).map(line => cells(line)[column] || '').filter(Boolean))];
}

export function emailPoolSummary(pool) {
    const total = pool.emails.length;
    return `${total} ${total === 1 ? 'email' : 'emails'} · ${pool.freeCount} free`;
}

export function importReport(result) {
    const parts = [`${result.added} added`];
    if (result.duplicates) parts.push(`${result.duplicates} already present`);
    if (result.invalid.length) parts.push(`${result.invalid.length} invalid: ${result.invalid.join(', ')}`);
    return parts.join(' · ');
}

export function initEmailPool({ root = document, api, closeMenus }) {
    const panel = root.querySelector('#emailsPanel'), content = root.querySelector('#emailAdminContent');
    const tableBody = root.querySelector('#emailTableBody'), message = root.querySelector('#emailMessage');
    const count = root.querySelector('#emailCount'), trigger = root.querySelector('#addEmailsButton');
    const importButton = root.querySelector('#importEmailsButton'), fileInput = root.querySelector('#emailCsvFile');
    const dialog = root.querySelector('#emailDialog'), form = root.querySelector('#emailForm');
    const formMessage = root.querySelector('#emailFormMessage'), textarea = form.elements.namedItem('addresses');
    let admin = false, pool = null, loading = null, busy = false, timer = null;
    const pending = new Set();
    const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    const owner = initCreateRobotDialog({ dialog, trigger, closeButton: root.querySelector('#emailClose'),
        cancelButton: root.querySelector('#emailCancel'), onOpen: () => { closeMenus(); form.reset(); formMessage.textContent = ''; } });

    function report(text, tone = '') { message.textContent = text; message.className = `message${tone ? ` ${tone}` : ''}`; }

    async function addAddresses(addresses) {
        if (!addresses.length) throw new Error('No email addresses found.');
        return api('api/email-pool/emails', { method: 'POST', body: { addresses } });
    }

    form.onsubmit = async event => {
        event.preventDefault(); if (!admin || busy) return;
        busy = true; owner.setBusy(true); formMessage.textContent = '';
        for (const input of form.querySelectorAll('textarea, button')) input.disabled = true;
        let result = null;
        try { result = await addAddresses(parseEmailCsv(textarea.value)); }
        catch (error) { formMessage.textContent = error.message; formMessage.className = 'message error'; }
        finally {
            busy = false; owner.setBusy(false);
            for (const input of form.querySelectorAll('textarea, button')) input.disabled = false;
        }
        if (!result) return;
        owner.complete();
        report(importReport(result), result.invalid.length ? 'error' : 'success');
        await refresh(true);
    };

    importButton.onclick = () => { if (admin && !busy) fileInput.click(); };
    fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file || !admin || busy) return;
        busy = true; importButton.disabled = true;
        try {
            const result = await addAddresses(parseEmailCsv(await file.text()));
            report(`${file.name}: ${importReport(result)}`, result.invalid.length ? 'error' : 'success');
        } catch (error) { report(`${file.name}: ${error.message}`, 'error'); }
        finally { busy = false; importButton.disabled = !admin; await refresh(true); }
    };

    async function mutate(key, button, operation, success) {
        if (!admin || pending.has(key)) return;
        pending.add(key); closeMenus(); button.disabled = true;
        try { report(success(await operation()), 'success'); }
        catch (error) { report(error.message, 'error'); }
        finally { pending.delete(key); await refresh(true); }
    }

    function cell(text, className) {
        const td = root.createElement('td'); td.textContent = text; if (className) td.className = className; return td;
    }

    function renderEmail(email) {
        const row = root.createElement('tr');
        row.append(
            cell(email.address, 'proxy-address'),
            cell(email.robotId ? email.robotName || email.robotId : 'Free', email.robotId ? '' : 'proxy-state proxy-state-ok'),
            cell(email.assignedAt ? date(email.assignedAt) : '—'),
        );
        const actions = root.createElement('td'); actions.className = 'proxy-row-actions';
        const button = root.createElement('button');
        button.type = 'button'; button.className = email.robotId ? 'button secondary' : 'button danger';
        if (email.robotId) {
            button.textContent = 'Release';
            button.title = 'The robot receives an email again the next time it starts';
            button.disabled = pending.has(email.robotId);
            button.onclick = () => mutate(email.robotId, button, () => api(`api/email-pool/assignments/${email.robotId}`, { method: 'DELETE' }),
                () => `${email.robotName || email.robotId} no longer holds ${email.address}.`);
        } else {
            button.textContent = 'Delete';
            button.disabled = pending.has(email.id);
            button.onclick = () => mutate(email.id, button, () => api(`api/email-pool/emails/${email.id}`, { method: 'DELETE' }),
                () => `${email.address} deleted.`);
        }
        actions.append(button); row.append(actions);
        return row;
    }

    function render() {
        content.hidden = !admin; trigger.disabled = !admin; importButton.disabled = !admin || busy;
        if (!admin) {
            count.textContent = '';
            report('Only administrators can view and manage robot emails.');
            return;
        }
        if (!pool) return;
        count.textContent = emailPoolSummary(pool);
        tableBody.replaceChildren(...pool.emails.map(renderEmail));
        root.querySelector('#emailTableWrap').hidden = !pool.emails.length;
        root.querySelector('#emailEmpty').hidden = pool.emails.length > 0;
    }

    async function refresh(force = false) {
        if (loading) return loading;
        if (!admin) { render(); return; }
        if (!force && (panel.hidden || dialog.open)) return;
        loading = (async () => {
            try { pool = await api('api/email-pool'); render(); }
            catch (error) { report(`Robot emails unavailable: ${error.message}`, 'error'); }
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
