import { initCreateRobotDialog, initRobotMenu } from './robot-controls.js';
import { initScheduleFolderPicker } from './schedule-folder-picker.js';

export function scheduleSummary(timing) {
    if (timing.kind === 'daily') return `Daily at ${timing.times.join(', ')} · ${timing.timeZone}`;
    const minutes = timing.everyMinutes;
    const [value, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
    return `Every ${value} ${unit}${value === 1 ? '' : 's'}`;
}
export function schedulePayload(values, times) {
    const timing = values.scheduleKind === 'daily'
        ? { kind: 'daily', times, timeZone: values.timeZone.trim() }
        : { kind: 'interval', everyMinutes: Number(values.intervalValue) * Number(values.intervalUnit) };
    return { name: values.name.trim(), workflowTypeId: values.workflowTypeId, folder: values.folder.trim(), objective: values.objective.trim(),
        enabled: values.enabled, timing, ...(values.defaultWorkflow ? { executionType: values.executionType } : {}) };
}
export function initCronJobs({ root = document, api, endpoint, bindLink, closeMenus }) {
    const panel = root.querySelector('#kronJobsPanel'), list = root.querySelector('#cronList'), template = root.querySelector('#cronTemplate');
    const trigger = root.querySelector('#createCronButton'), dialog = root.querySelector('#cronDialog'), form = root.querySelector('#cronForm');
    const message = root.querySelector('#cronMessage'), formMessage = root.querySelector('#cronFormMessage'), timesList = root.querySelector('#cronTimes');
    const control = name => form.elements.namedItem(name);
    const pendingMutations = new Set();
    const folderPicker = initScheduleFolderPicker({ root, api, input: control('folder') });
    let workflows = [], jobs = [], admin = false, editing = null, loading = null, busy = false, stopped = false, timer = null, newDraft = null, opener = trigger, savedClose = false, requestEpoch = 0, requestController = null;
    const close = root.querySelector('#cronClose'), cancel = root.querySelector('#cronCancel');
    const owner = initCreateRobotDialog({ dialog, trigger, closeButton: close, cancelButton: cancel, onOpen: () => open(null, trigger, false) });
    const date = (value, timing) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timing.kind === 'daily' ? { timeZone: timing.timeZone } : {}) }).format(new Date(value));
    function setBusy(value) {
        busy = value; owner.setBusy(value);
        for (const input of form.querySelectorAll('input, select, textarea, button')) input.disabled = value;
        if (!value) syncFields();
    }
    function values() { return Object.fromEntries(['name', 'workflowTypeId', 'folder', 'objective', 'scheduleKind', 'timeZone', 'intervalValue', 'intervalUnit', 'executionType'].map(name => [name, control(name).value])); }
    function captureDraft() {
        if (!editing && !busy) newDraft = { ...values(), enabled: control('enabled').checked, times: [...timesList.querySelectorAll('input')].map(input => input.value) };
    }
    dialog.addEventListener('close', () => { if (!savedClose) captureDraft(); savedClose = false; if (opener?.isConnected) opener.focus(); });
    function addTime(value = '09:00') {
        if (timesList.children.length >= 24) return;
        const row = root.createElement('div'); row.className = 'cron-time';
        const input = root.createElement('input'); input.type = 'time'; input.value = value; input.required = true; input.setAttribute('aria-label', `Daily time ${timesList.children.length + 1}`);
        const remove = root.createElement('button'); remove.type = 'button'; remove.className = 'button secondary icon-button'; remove.textContent = '×'; remove.title = 'Remove time'; remove.setAttribute('aria-label', 'Remove daily time');
        remove.onclick = () => { row.remove(); if (!timesList.children.length) addTime(); syncFields(); };
        row.append(input, remove); timesList.append(row); syncFields();
    }
    function syncFields() {
        const daily = control('scheduleKind').value === 'daily';
        root.querySelector('#cronInterval').hidden = daily; root.querySelector('#cronDaily').hidden = !daily;
        control('intervalValue').disabled = daily || busy; control('intervalValue').required = !daily;
        control('intervalUnit').disabled = daily || busy; control('timeZone').required = daily; control('timeZone').disabled = !daily || busy;
        [...timesList.querySelectorAll('input')].forEach((input, index) => { input.disabled = !daily || busy; input.setAttribute('aria-label', `Daily time ${index + 1}`); });
        control('intervalValue').max = String(Math.floor(525600 / Number(control('intervalUnit').value)));
        root.querySelector('#cronAddTime').disabled = busy || timesList.children.length >= 24;
        const workflow = workflows.find(workflow => workflow.id === control('workflowTypeId').value);
        const defaultWorkflow = workflow?.kind === 'default';
        root.querySelector('#cronExecutionField').hidden = !defaultWorkflow; control('executionType').disabled = !defaultWorkflow || busy;
        const requiresObjective = !workflow?.defaultObjective, hasOverride = Boolean(control('objective').value.trim());
        root.querySelector('#cronObjectiveField').hidden = !requiresObjective && !hasOverride;
        control('objective').required = requiresObjective; control('objective').disabled = busy || (!requiresObjective && !hasOverride);
        root.querySelector('#cronObjectiveLabel').textContent = requiresObjective ? 'Objective' : 'Objective override (optional)';
        root.querySelector('#cronObjectiveHint').hidden = requiresObjective;
        root.querySelector('#cronObjectiveHint').textContent = hasOverride ? 'Leave the override empty to use the workflow’s default objective.' : 'Uses the selected workflow’s default objective.';
    }
    function open(job, invoking = trigger, show = true) {
        if (!admin || busy) return;
        closeMenus(); editing = job; opener = invoking; form.reset(); formMessage.textContent = '';
        root.querySelector('#cronDialogTitle').textContent = job ? 'Edit Cron job' : 'Create Cron job';
        root.querySelector('#cronSave').textContent = job ? 'Save changes' : 'Create job';
        const select = control('workflowTypeId'); select.replaceChildren();
        for (const workflow of workflows) { const option = root.createElement('option'); option.value = workflow.id; option.textContent = workflow.name; select.append(option); }
        control('timeZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        timesList.replaceChildren();
        if (job) {
            for (const name of ['name', 'workflowTypeId', 'folder', 'objective']) control(name).value = job[name];
            control('enabled').checked = job.enabled; control('scheduleKind').value = job.timing.kind; control('executionType').value = job.executionType || 'terminal';
            if (job.timing.kind === 'daily') control('timeZone').value = job.timing.timeZone;
            else {
                const minutes = job.timing.everyMinutes, unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
                control('intervalUnit').value = String(unit); control('intervalValue').value = String(minutes / unit);
            }
        } else if (newDraft) {
            for (const [name, value] of Object.entries(newDraft)) if (name !== 'times' && name !== 'enabled') control(name).value = value;
            control('enabled').checked = newDraft.enabled;
        }
        for (const time of (job?.timing.kind === 'daily' ? job.timing.times : !job && newDraft?.times || ['09:00'])) addTime(time);
        folderPicker.setFolder(control('folder').value, job?.folderLabel);
        syncFields();
        if (show && !dialog.open) dialog.showModal();
        control('name').focus();
    }
    root.querySelector('#cronAddTime').onclick = () => { addTime(''); timesList.lastElementChild.querySelector('input').focus(); };
    control('scheduleKind').onchange = syncFields; control('workflowTypeId').onchange = syncFields; control('intervalUnit').onchange = syncFields;
    const zones = root.querySelector('#cronTimeZones');
    for (const timeZone of [...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, ...(Intl.supportedValuesOf?.('timeZone') || [])])].filter(Boolean)) {
        const option = root.createElement('option'); option.value = timeZone; zones.append(option);
    }
    form.onsubmit = async event => {
        event.preventDefault(); if (!admin || busy) return;
        const job = editing;
        const payload = schedulePayload({ ...values(), enabled: control('enabled').checked,
            defaultWorkflow: workflows.find(workflow => workflow.id === control('workflowTypeId').value)?.kind === 'default' }, [...timesList.querySelectorAll('input')].map(input => input.value));
        setBusy(true); formMessage.textContent = '';
        let saved = false;
        try {
            await api(`api/roboflow/schedules${job ? `/${job.id}` : ''}`, { method: job ? 'PUT' : 'POST', body: { ...payload, ...(job ? { revision: job.revision } : {}) } });
            saved = true; if (!job) newDraft = null;
            message.textContent = job ? 'Cron job updated.' : 'Cron job created.'; message.className = 'message success';
        } catch (error) { formMessage.textContent = error.message; formMessage.className = 'message error'; }
        finally { setBusy(false); }
        if (saved) { savedClose = true; editing = null; owner.complete(); await refresh(true, false); }
    };
    async function mutate(job, button, operation) {
        if (!admin || button.disabled || pendingMutations.has(job.id)) return;
        if (operation === 'delete' && !confirm(`Delete Cron job “${job.name}”? Any already running workflow will remain unchanged.`)) return;
        pendingMutations.add(job.id);
        const card = button.closest('.cron-card'), menuToggle = card.querySelector('.manage-toggle');
        closeMenus(); menuToggle.focus({ preventScroll: true });
        card.querySelectorAll('[data-robot-menu-options] button').forEach(control => { control.disabled = true; });
        try {
            if (operation === 'delete') {
                await api(`api/roboflow/schedules/${job.id}`, { method: 'DELETE' });
            } else if (operation === 'run-now') {
                await api(`api/roboflow/schedules/${job.id}/run-now`, { method: 'POST', body: { revision: job.revision } });
            } else await api(`api/roboflow/schedules/${job.id}`, { method: 'PUT', body: { revision: job.revision, enabled: !job.enabled } });
            message.textContent = operation === 'run-now' ? (job.enabled ? 'Workflow started. The next scheduled run has been recalculated.' : 'Workflow started. Automatic scheduling remains disabled.') : '';
            message.className = 'message success';
        } catch (error) { message.textContent = error.message; message.className = 'message error'; }
        finally { pendingMutations.delete(job.id); await refresh(true, false); if (!stopped) render(); }
    }
    function render() {
        const focused = root.activeElement?.dataset.navigationKey;
        list.replaceChildren(); root.querySelector('#cronCount').textContent = `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`;
        if (!jobs.length) {
            const empty = root.createElement('div'); empty.className = 'empty-state';
            const heading = root.createElement('h3'); heading.textContent = 'No Cron jobs yet';
            const hint = root.createElement('p'); hint.textContent = admin ? 'Create a job to run a workflow automatically.' : 'An administrator can create scheduled workflows.';
            empty.append(heading, hint); list.append(empty);
        }
        for (const job of jobs) {
            const card = template.content.firstElementChild.cloneNode(true);
            card.querySelector('.cron-name').textContent = job.name;
            const state = card.querySelector('.cron-state'); state.textContent = job.enabled ? 'Enabled' : 'Disabled'; state.classList.add(job.enabled ? 'enabled' : 'disabled');
            card.querySelector('.cron-workflow').textContent = job.workflowName;
            card.querySelector('.cron-timing').textContent = scheduleSummary(job.timing);
            card.querySelector('.cron-next').textContent = job.nextRunAt ? `Next run · ${date(job.nextRunAt, job.timing)}` : 'No upcoming run';
            const outcome = job.launching ? 'Launching' : job.lastOutcome === 'skipped' ? 'Skipped' : job.lastFlowStatus || job.lastOutcome;
            card.querySelector('.cron-last').textContent = job.lastAttemptAt ? `Last attempt · ${date(job.lastAttemptAt, job.timing)} · ${outcome || '—'}` : 'Not run yet';
            const error = card.querySelector('.cron-error'); error.hidden = !job.lastError && !job.lastFlowError; error.textContent = job.lastError || job.lastFlowError || '';
            const run = card.querySelector('.cron-view-run'); run.hidden = !job.lastFlowId;
            if (job.lastFlowId) { run.href = endpoint(`flows?flowId=${encodeURIComponent(job.lastFlowId)}`); run.dataset.navigationKey = `cron-run:${job.id}`; bindLink(run); }
            const toggle = card.querySelector('.cron-toggle'); toggle.textContent = job.enabled ? 'Disable' : 'Enable'; toggle.dataset.navigationKey = `cron-toggle:${job.id}`;
            toggle.setAttribute('aria-label', `${job.enabled ? 'Disable' : 'Enable'} ${job.name}`); toggle.onclick = () => mutate(job, toggle, 'toggle');
            const edit = card.querySelector('.cron-edit'); edit.onclick = () => open(job, card.querySelector('.manage-toggle'));
            const remove = card.querySelector('.cron-delete'); remove.onclick = () => mutate(job, remove, 'delete');
            const runNow = card.querySelector('.cron-run-now'); runNow.onclick = () => mutate(job, runNow, 'run-now');
            const held = job.launching || ['pending', 'running', 'paused'].includes(job.lastFlowStatus);
            runNow.disabled = held;
            if (held) runNow.title = 'This job already has a running or paused workflow';
            if (pendingMutations.has(job.id)) card.querySelectorAll('[data-robot-menu-options] button').forEach(control => { control.disabled = true; });
            card.querySelector('.manage-toggle').dataset.navigationKey = `cron-menu:${job.id}`;
            card.querySelector('.cron-actions').hidden = !admin;
            initRobotMenu({ menu: card.querySelector('.robot-manage'), id: `cron-options-${job.id}`, label: `More actions for ${job.name}`, closeMenus });
            list.append(card);
        }
        if (focused) [...list.querySelectorAll('[data-navigation-key]')].find(element => element.dataset.navigationKey === focused)?.focus({ preventScroll: true });
    }
    async function refresh(force = false, clearError = true) {
        if (stopped || loading) return loading;
        if (!force && (panel.hidden || dialog.open || root.querySelector('.cron-card [data-robot-menu-toggle][aria-expanded="true"]'))) return;
        const epoch = requestEpoch, controller = new AbortController(); requestController = controller;
        loading = (async () => {
            try {
                const response = await api('api/roboflow/schedules', { signal: controller.signal }); if (stopped || epoch !== requestEpoch) return;
                jobs = response.schedules; if (clearError) { message.textContent = ''; message.className = 'message'; } render();
            } catch (error) { if (!stopped && epoch === requestEpoch && !controller.signal.aborted) { message.textContent = `Cron jobs unavailable: ${error.message}`; message.className = 'message error'; } }
        })();
        try { await loading; } finally { loading = null; if (requestController === controller) requestController = null; }
    }
    function resume() { stopped = false; clearInterval(timer); timer = setInterval(() => { if (!root.hidden) void refresh(); }, 60_000); void refresh(); }
    window.addEventListener('pagehide', () => { stopped = true; requestEpoch++; requestController?.abort(); clearInterval(timer); });
    window.addEventListener('pageshow', resume);
    resume();
    return { refresh, setContext(catalog, canAdmin) { workflows = catalog; admin = canAdmin; trigger.disabled = !admin || !workflows.length; if (!admin) { folderPicker.close(); if (dialog.open) dialog.close(); } void refresh(true); } };
}
