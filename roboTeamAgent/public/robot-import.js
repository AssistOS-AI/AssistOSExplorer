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

export function importReport(result) {
    const created = result.created.length;
    const parts = [`${created} ${created === 1 ? 'robot' : 'robots'} created`];
    if (result.existing) parts.push(`${result.existing} already ${result.existing === 1 ? 'exists' : 'exist'}`);
    if (result.invalid.length) parts.push(`${result.invalid.length} invalid: ${result.invalid.join(', ')}`);
    return parts.join(' · ');
}

// The Robots tab's Import CSV button: one robot per address, named exactly by it.
export function initRobotImport({ button, fileInput, api, report, onImported }) {
    let busy = false, admin = false;
    const sync = () => { button.disabled = !admin || busy; };
    button.addEventListener('click', () => { if (admin && !busy) fileInput.click(); });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file || !admin || busy) return;
        busy = true; sync();
        button.textContent = 'Importing…';
        try {
            const addresses = parseEmailCsv(await file.text());
            if (!addresses.length) throw new Error('No email addresses found.');
            const result = await api('api/robots/import-emails', { method: 'POST', body: { addresses } });
            report(`${file.name}: ${importReport(result)}`, result.invalid.length ? 'error' : 'success');
            if (result.created.length) await onImported();
        } catch (error) { report(`${file.name}: ${error.message}`, 'error'); }
        finally { busy = false; button.textContent = 'Import CSV'; sync(); }
    });
    return { setContext(canAdmin) { admin = canAdmin; sync(); } };
}
