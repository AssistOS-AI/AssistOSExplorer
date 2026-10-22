import { createHardwareLimitsApi, hardwareAccessDenied, HardwareLimitsError } from '../../../services/infrastructure/hardwareLimitsApi.js';
import { AUTHORITY_HELP, GPU_HELP, sameToken, reconcileDrafts, draftLimits, describeApplied, describeUsage, describeProblem, formatBytes } from './hardware-limits-model.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

// Keep controls, focus and expanded details in place during background status updates.
function patchHardwareNode(current, next) {
    if (current.isEqualNode(next)) return;
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
        current.replaceWith(next.cloneNode(true));
        return;
    }
    if (current.nodeType !== 1) {
        current.nodeValue = next.nodeValue;
        return;
    }
    for (const attribute of [...current.attributes]) {
        if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
        if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of [...next.attributes]) {
        if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    if (current.tagName === 'INPUT' && current !== current.ownerDocument.activeElement && current.value !== next.value) current.value = next.value;
    const children = [...current.childNodes];
    const nextChildren = [...next.childNodes];
    for (let index = 0; index < Math.max(children.length, nextChildren.length); index += 1) {
        if (!nextChildren[index]) children[index].remove();
        else if (!children[index]) current.append(nextChildren[index].cloneNode(true));
        else patchHardwareNode(children[index], nextChildren[index]);
    }
}

function policyDescription(limits = {}) {
    const values = [];
    if (limits.cpus != null) values.push(`${limits.cpus} CPU cores`);
    if (limits.memoryPercent != null) values.push(`${limits.memoryPercent}% of Box RAM`);
    if (limits.memoryBytes != null) values.push(`${formatBytes(limits.memoryBytes)} RAM`);
    if (limits.memory != null) values.push(`${limits.memory} RAM`);
    if (limits.pidsLimit != null) values.push(`${limits.pidsLimit} processes`);
    const gpu = limits.gpu || limits.gpuShare;
    if (gpu?.vramPercent != null) values.push(`${gpu.smPercent}% GPU SM / ${gpu.vramPercent}% of physical VRAM`);
    else if (gpu?.vramMiB != null) values.push(`${gpu.smPercent}% GPU SM / ${gpu.vramMiB} MiB per CUDA process`);
    return values.join(', ') || 'no limits';
}

export function renderHardwarePreview(agent, draft = {}, snapshot = {}) {
    const inherited = agent.declared || {};
    const gpu = inherited.gpu || inherited.gpuShare || {};
    const memory = draft.memoryPercent ? `${draft.memoryPercent}% of Box RAM${snapshot.envelope?.memoryBytes ? ` (${formatBytes(snapshot.envelope.memoryBytes * Number(draft.memoryPercent) / 100)})` : ''}`
        : inherited.memoryBytes != null ? formatBytes(inherited.memoryBytes) : inherited.memory || 'No limit';
    const proposed = [draft.cpus ? `${draft.cpus} cores` : inherited.cpus != null ? `${inherited.cpus} cores` : 'No limit', memory,
        draft.smPercent ? `${draft.smPercent}%` : gpu.smPercent != null ? `${gpu.smPercent}%` : 'No share',
        draft.vramPercent ? `${draft.vramPercent}% of physical VRAM` : gpu.vramPercent != null ? `${gpu.vramPercent}% of physical VRAM` : gpu.vramMiB != null ? `${gpu.vramMiB} MiB per CUDA process` : 'No share'];
    const instances = agent.containers || [];
    const labels = ['CPU', 'RAM', 'GPU SM', 'GPU VRAM'];
    const current = instances.map((instance) => instance.limits ? [
        instance.limits.cpu?.assurance === 'kernel' ? `${instance.limits.cpu.cores} cores` : 'No limit',
        instance.limits.memory?.assurance === 'kernel' ? formatBytes(instance.limits.memory.bytes) : 'No limit',
        instance.limits.gpu?.assurance === 'best-effort' ? `${instance.limits.gpu.smPercent}%` : 'No share',
        instance.limits.gpu?.assurance === 'best-effort' ? `${formatBytes(instance.limits.gpu.vramBytes)} per CUDA process` : 'No share',
    ] : labels.map(() => 'Not reported'));
    return `<h4 class="settings-card-title">Changes to apply</h4><table class="hardware-change-table"><thead><tr><th>Resource</th><th>Currently applied</th><th>After apply</th></tr></thead><tbody>${labels.map((label, index) => {
        const values = [...new Set(current.map((row) => row[index]))];
        const before = values.length > 1 ? 'Varies by instance' : values[0] || 'Not running';
        return `<tr><th scope="row">${label}</th><td>${escapeHtml(before)}</td><td>${escapeHtml(proposed[index])}</td></tr>`;
    }).join('')}</tbody></table><p class="settings-card-meta">Empty fields inherit the agent defaults.</p><div class="hardware-default-preview"><b class="settings-card-title">Restore defaults</b><p class="settings-card-meta">${escapeHtml(policyDescription(inherited))}. Restoring defaults applies these values directly.</p></div>`;
}

export function renderHardwareLimits(snapshot, drafts, { busy = false, error = '', results = null, expandedContainers = [], pendingContainers = [], selectedAgentRef = null, notice = '' } = {}) {
    if (!snapshot) return `<p class="settings-status ${error ? 'error' : 'loading'}" role="status">${escapeHtml(error || 'Loading hardware limits…')}</p>`;
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    const selectedRef = agents.some((agent) => agent.ref === selectedAgentRef) ? selectedAgentRef : (agents.find((agent) => agent.ref === 'local-llms/local-llm') || agents[0])?.ref;
    const agentLabel = (agent) => agent.ref === 'local-llms/local-llm' ? 'Local LLMs' : agent.ref;
    const selectedAgent = agents.find((agent) => agent.ref === selectedRef);
    const hasPendingChanges = agents.some((agent) => (agent.containers || []).some((instance) => instance.limitsState === 'pending'));
    const gpuEnabled = snapshot.gpu?.eligible === true;
    const disabled = busy ? ' disabled' : '';
    const fields = [['cpus', 'CPU cores', '0.01'], ['memoryPercent', 'RAM %', '1'], ['smPercent', 'GPU SM %', '1'], ['vramPercent', 'GPU VRAM %', '1']];
    return `<div class="hardware-limits-toolbar"><div class="settings-card-info"><h2 class="settings-section-title">Hardware limits</h2><p class="settings-section-description">Manage the resources available to each workspace agent.</p></div><div class="settings-card-actions"><button class="gray-button" type="button" data-hardware-action="refresh"${disabled}>Refresh</button>${hasPendingChanges ? `<button class="general-button" type="button" data-hardware-action="apply-all"${disabled}>Apply all pending</button>` : ''}</div></div>
        <section class="hardware-limits-summary" aria-label="Workspace resources">
            <div class="hardware-resource"><span class="settings-card-meta">CPU capacity</span><strong>${escapeHtml(snapshot.envelope?.cpus ?? 'Not reported')}${snapshot.envelope?.cpus != null ? ' <small>cores</small>' : ''}</strong></div>
            <div class="hardware-resource"><span class="settings-card-meta">Box memory</span><strong>${escapeHtml(formatBytes(snapshot.envelope?.memoryBytes))}</strong></div>
            <div class="hardware-resource"><span class="settings-card-meta">Hardware gate</span><strong class="hardware-resource-state">${escapeHtml(snapshot.gate?.state || 'unknown')}</strong><span class="settings-card-meta">${snapshot.gate?.prepared === true ? 'Prepared' : 'Preparation unverified'}</span></div>
            <div class="hardware-resource"><span class="settings-card-meta">GPU backend</span><strong class="hardware-resource-state">${escapeHtml(snapshot.gpu?.mode || 'unavailable')}</strong><span class="settings-card-meta">${escapeHtml(snapshot.gpu?.assurance || 'none')}</span></div>
        </section>
        <details class="hardware-limit-help"><summary>How limits work · GPU assurance and administrator authority</summary>${!gpuEnabled ? `<p>${escapeHtml(snapshot.gpu?.fix || snapshot.gpu?.reason || 'GPU editing requires a verified eligible NVIDIA backend.')}</p>` : ''}<p>Save and apply stores the desired policy, then applies it to this agent’s registered instances. Restore defaults clears the override and applies the declared defaults. Both actions may restart instances. CPU and RAM limits use kernel controllers. RAM and GPU percentages are whole numbers from 1 to 100. GPU VRAM percentage uses physical device memory; applied rows show the resolved bytes per CUDA process. Empty fields inherit declared limits; Restore defaults restores all declared values.</p><p>Controllers: ${escapeHtml((snapshot.gate?.controllers || []).join(', ') || 'none observed')}.</p>${GPU_HELP.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}<p>Host operator commands: <code>sudo nvidia-smi -i 0 -c EXCLUSIVE_PROCESS</code>; undo with <code>sudo nvidia-smi -i 0 -c DEFAULT</code>.</p><p>${escapeHtml(AUTHORITY_HELP)}</p><p>An optional no-wait child refusal does not block its parent. A required refused dependency blocks its consumers; those consumers are never ready. If Explorer itself is blocked, host <code>ploinky limits status</code>, <code>ploinky limits clear</code> and Router administration provide recovery.</p></details>
        <p class="hardware-limits-error" data-role="hardware-error" role="status"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>
        ${notice ? `<p class="settings-status" role="status">${escapeHtml(notice)}</p>` : ''}
        ${results ? `<div role="status"><strong>Apply results</strong>${results.length ? results.map((result) => `<p>${escapeHtml(result.key || result.containerName || '')}${result.observedKey && result.observedKey !== result.key ? ` (observed ${escapeHtml(result.observedKey)})` : ''}: ${escapeHtml(result.state || result.status || (result.ok ? 'completed' : 'unavailable'))} ${escapeHtml(result.message || describeProblem({ availability: result.state, problem: result.problem }))} ${escapeHtml(result.fix || '')}</p>`).join('') : '<p>No instances changed.</p>'}${expandedContainers.length ? `<p>Coordinated instances: ${expandedContainers.map(escapeHtml).join(', ')}</p>` : ''}${pendingContainers.length ? `<p>Still pending: ${pendingContainers.map(escapeHtml).join(', ')}</p>` : ''}</div>` : ''}
        ${agents.length ? `<div class="hardware-agent-picker"><label class="settings-card-title" for="hardware-agent-search">Agent</label><div class="hardware-agent-control"><input id="hardware-agent-search" class="form-input" type="text" role="combobox" aria-autocomplete="list" aria-controls="hardware-agent-options" aria-expanded="false" data-hardware-agent-search autocomplete="off" placeholder="Search agents…" aria-label="Search and select an agent" value="${escapeHtml(agentLabel(selectedAgent))}"${disabled}><button class="gray-button" type="button" data-agent-picker-toggle aria-label="Show all agents"${disabled}><img class="select-arrow" src="/explorer/shared/assets/icons/arrow.svg" alt=""></button></div><div id="hardware-agent-options" class="custom-select-options-list" role="listbox" aria-label="Agents" hidden></div><span class="settings-card-meta">Search by agent name, then choose an agent to edit its limits.</span></div>` : ''}
        ${agents.length ? agents.map((agent, index) => {
        if (agent.ref !== selectedRef) return '';
        const draft = drafts.get(agent.ref);
        const containers = Array.isArray(agent.containers) ? agent.containers : [];
        return `<article class="settings-card settings-card-static hardware-policy" data-agent-index="${index}"><div class="hardware-policy-heading"><div class="settings-card-info"><h3 class="settings-card-title">${escapeHtml(agentLabel(agent))}</h3>${agent.ref === 'local-llms/local-llm' ? `<span class="settings-card-meta">${escapeHtml(agent.ref)}</span>` : ''}<span class="settings-card-meta">${containers.length} ${containers.length === 1 ? 'instance' : 'instances'}</span></div></div>
            ${containers.length ? `<ul class="hardware-instance-overview" aria-label="Instance status">${containers.map((instance) => `<li><div>${containers.length > 1 || instance.alias != null ? `<span class="settings-card-meta">${escapeHtml(instance.alias == null ? 'Canonical instance' : `Alias: ${instance.alias}`)} · </span>` : ''}<span class="hardware-instance-state">${escapeHtml(instance.availability || 'stopped')}</span> / ${escapeHtml(instance.limitsState || 'unavailable')}</div><span class="settings-card-meta">CPU ${Number.isFinite(instance.usage?.cpuPercent) ? `${instance.usage.cpuPercent.toFixed(1)}%` : 'unknown'} · RAM ${Number.isFinite(instance.usage?.memoryBytes) ? escapeHtml(formatBytes(instance.usage.memoryBytes)) : 'unknown'}</span>${describeProblem(instance) ? `<p class="hardware-instance-problem">${escapeHtml(describeProblem(instance))}</p>` : ''}</li>`).join('')}</ul><details class="hardware-instance-diagnostics"><summary>Instance diagnostics</summary><table class="hardware-instances"><thead><tr><th>Exact instance</th><th>Availability / limits</th><th>Desired / applied / usage</th></tr></thead><tbody>${containers.map((instance, instanceIndex) => `<tr><td data-label="Exact instance">${escapeHtml(instance.alias == null ? 'Canonical instance' : `Alias: ${instance.alias}`)}<code>${escapeHtml(instance.key)}</code></td><td data-label="Availability / limits" data-state="${escapeHtml(instance.availability)}"><span class="hardware-instance-state">${escapeHtml(instance.availability || 'stopped')}</span> / ${escapeHtml(instance.limitsState || 'unavailable')}<p class="hardware-instance-problem">${escapeHtml(describeProblem(instance))}</p></td><td data-label="Desired / applied / usage"><p class="hardware-instance-detail">Desired ${escapeHtml(policyDescription(instance.effective))}</p>Applied ${escapeHtml(describeApplied(instance.limits))}<p class="hardware-instance-detail">${escapeHtml(describeUsage(instance))}</p></td></tr>`).join('')}</tbody></table></details>` : '<p class="hardware-instance-detail">Not enabled. Saved policy will apply when this agent starts.</p>'}
            ${draft?.conflict ? `<p class="hardware-limits-conflict" role="status">Policy changed elsewhere. Your unsaved values remain below. Review the refreshed values before saving again. Stored ${escapeHtml(policyDescription(agent.configured))}; declared ${escapeHtml(policyDescription(agent.declared))}; effective ${escapeHtml(policyDescription(agent.effective))}.</p>` : ''}
            <div class="hardware-editor-layout"><div class="hardware-policy-form"><div class="hardware-limit-fields">${fields.map(([field, label, step]) => `<label class="hardware-limit-field">${label}<input class="form-input" type="number" step="${step}" min="${field === 'cpus' ? '0.05' : '1'}"${field !== 'cpus' ? ' max="100"' : ''} data-hardware-field="${field}" data-agent-index="${index}" placeholder="Inherit" value="${escapeHtml(draft?.[field] || '')}"${disabled}${!gpuEnabled && ['smPercent', 'vramPercent'].includes(field) ? ' disabled aria-describedby="hardware-gpu-status"' : ''}></label>`).join('')}</div>
            ${!gpuEnabled ? '<p id="hardware-gpu-status" class="hardware-gpu-notice settings-card-meta">GPU limits are unavailable in this workspace.</p>' : ''}</div><aside class="hardware-change-preview" aria-label="Limit changes" aria-live="polite">${renderHardwarePreview(agent, draft, snapshot)}</aside></div>
            <div class="hardware-policy-footer"><p class="hardware-restart-note settings-card-meta">Saving or restoring defaults restarts this agent’s registered instances and may interrupt active work. If the agent is not enabled, limits take effect on its next start.</p>            <div class="hardware-policy-actions settings-card-actions"><button class="gray-button" type="button" data-hardware-action="restore-apply" data-agent-index="${index}"${disabled}>Restore defaults</button>${draft?.dirty ? '<span class="hardware-instance-detail">Unsaved edits</span>' : ''}<button class="general-button" type="button" data-hardware-action="save-apply" data-agent-index="${index}"${disabled}>${draft?.conflict ? 'Review, save and apply' : 'Save and apply'}</button></div></div>
            </article>`;
    }).join('') : '<p>No installed agents are available.</p>'}
`;
}

export class HardwareLimitsPanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.api = props.api || createHardwareLimitsApi();
        this.snapshot = null;
        this.drafts = new Map();
        this.selectedAgentRef = null;
        this.busy = false;
        this.error = '';
        this.notice = '';
        this.results = null;
        this.expandedContainers = [];
        this.pendingContainers = [];
        this.readGeneration = 0;
        this.closed = false;
        this.active = true;
        this.abort = new AbortController();
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.content = this.element.querySelector('[data-role="hardware-content"]');
        if (!this.bound) {
            this.bound = true;
            this.element.addEventListener('input', (event) => this.edit(event.target));
            this.element.addEventListener('click', (event) => {
                const option = event.target.closest?.('[data-agent-picker-option]');
                if (option) return this.selectAgent(option.dataset.agentPickerOption);
                if (event.target.closest?.('[data-agent-picker-toggle]')) {
                    if (this.agentPickerOpen) this.closeAgentPicker();
                    else this.openAgentPicker();
                    return;
                }
                if (event.target.matches?.('[data-hardware-agent-search]') && !this.agentPickerOpen) this.openAgentPicker();
                const button = event.target.closest?.('[data-hardware-action]');
                if (button && this.element.contains(button)) void this.action(button.dataset);
            });
            this.element.addEventListener('keydown', (event) => this.agentPickerKey(event));
            this.element.addEventListener('focusout', (event) => {
                if (event.target.closest?.('.hardware-agent-picker') && !event.relatedTarget?.closest?.('.hardware-agent-picker')) this.closeAgentPicker();
            });
            this.element.ownerDocument?.addEventListener('pointerdown', (event) => {
                if (!this.element.querySelector('.hardware-agent-picker')?.contains(event.target)) this.closeAgentPicker();
            }, { signal: this.abort.signal });
            this.element.addEventListener('hardware-limits-active', (event) => {
                const wasActive = this.active;
                this.active = event.detail === true;
                if (this.active && !wasActive) void this.refresh();
            });
            const initial = this.element.hardwareLimitsSnapshot;
            if (initial) this.acceptSnapshot(initial);
            else await this.refresh();
            if (this.closed) return;
            this.poll = setInterval(() => {
                if (this.active && !this.busy && ![...this.drafts.values()].some((draft) => draft.dirty)) void this.refresh();
            }, 5000);
        }
        this.render();
    }

    afterUnload() {
        this.closed = true;
        this.readGeneration += 1;
        this.abort.abort();
        clearInterval(this.poll);
    }

    render({ incremental = false } = {}) {
        if (!this.content || this.closed) return;
        const html = renderHardwareLimits(this.snapshot, this.drafts, this);
        if (incremental && this.content.ownerDocument) {
            const template = this.content.ownerDocument.createElement('template');
            template.innerHTML = html;
            const next = this.content.cloneNode(false);
            next.append(template.content);
            patchHardwareNode(this.content, next);
        } else {
            this.agentPickerOpen = false;
            this.content.innerHTML = html;
        }
    }

    acceptSnapshot(snapshot, { incremental = false } = {}) {
        if (this.closed) return;
        this.snapshot = snapshot;
        this.drafts = reconcileDrafts(snapshot.agents, snapshot.token, this.drafts);
        this.render({ incremental });
    }

    reportError(error) {
        if (this.closed || error?.name === 'AbortError') return;
        if (hardwareAccessDenied(error)) {
            this.readGeneration += 1;
            this.reading = null;
            this.snapshot = null;
            this.notice = '';
            this.drafts.clear();
            this.results = null;
            this.expandedContainers = [];
            this.pendingContainers = [];
            this.active = false;
            this.element.dispatchEvent(new CustomEvent('hardware-limits-access-denied', { bubbles: true }));
        }
        this.error = `${error?.message || 'Hardware limits are unavailable.'}${error?.fix ? ` ${error.fix}` : ''}`;
        if (this.snapshot && [...this.drafts.values()].some((draft) => draft.dirty)) {
            const status = this.content?.querySelector?.('[data-role="hardware-error"]');
            if (status) { status.textContent = this.error; status.hidden = false; }
            return;
        }
        this.render({ incremental: Boolean(this.snapshot) });
    }

    async refresh({ force = false } = {}) {
        if (this.closed || this.busy || this.reading) return;
        if (this.agentPickerOpen || this.content?.querySelector?.('[data-hardware-agent-search]')?.matches?.(':focus')) return;
        const generation = ++this.readGeneration;
        this.reading = generation;
        try {
            const snapshot = await this.api.read({ signal: this.abort.signal });
            if (this.closed || generation !== this.readGeneration) return;
            if (this.agentPickerOpen || (!force && [...this.drafts.values()].some((draft) => draft.dirty))) return;
            this.error = '';
            this.acceptSnapshot(snapshot, { incremental: !force });
        } catch (error) {
            if (generation === this.readGeneration) this.reportError(error);
        } finally {
            if (this.reading === generation) this.reading = null;
        }
    }

    edit(input) {
        if (input?.hasAttribute?.('data-hardware-agent-search')) {
            if (!this.busy) this.openAgentPicker(input.value, false);
            return;
        }
        const field = input?.dataset?.hardwareField;
        if (!['cpus', 'memoryPercent', 'smPercent', 'vramPercent'].includes(field)) return;
        const agent = this.snapshot?.agents?.[Number(input.dataset.agentIndex)];
        const draft = this.drafts.get(agent?.ref);
        if (!draft || this.busy) return;
        draft[field] = input.value;
        draft.dirty = true;
        const preview = this.content?.querySelector?.('.hardware-change-preview');
        if (preview) preview.innerHTML = renderHardwarePreview(agent, draft, this.snapshot);
    }

    agentChoices(query = '') {
        const search = query.trim().toLocaleLowerCase();
        return (this.snapshot?.agents || []).filter((agent) => `${agent.ref} ${agent.ref === 'local-llms/local-llm' ? 'Local LLMs' : ''}`.toLocaleLowerCase().includes(search));
    }

    openAgentPicker(query = '', selectText = true) {
        if (this.busy || this.closed) return;
        const input = this.content?.querySelector('[data-hardware-agent-search]');
        const list = this.content?.querySelector('#hardware-agent-options');
        if (!input || !list) return;
        this.agentPickerOpen = true;
        input.setAttribute('aria-expanded', 'true');
        list.hidden = false;
        const choices = this.agentChoices(query);
        list.innerHTML = choices.length ? choices.map((agent) => `<button type="button" class="custom-select-option" role="option" aria-selected="${agent.ref === (this.selectedAgentRef || (this.snapshot.agents.find((item) => item.ref === 'local-llms/local-llm') || this.snapshot.agents[0])?.ref)}" data-agent-picker-option="${escapeHtml(agent.ref)}">${escapeHtml(agent.ref === 'local-llms/local-llm' ? 'Local LLMs' : agent.ref)}</button>`).join('') : '<p class="settings-card-meta hardware-agent-empty" role="status">No matching agents.</p>';
        if (selectText) {
            input.focus();
            input.select();
        }
    }

    closeAgentPicker() {
        this.agentPickerOpen = false;
        const input = this.content?.querySelector?.('[data-hardware-agent-search]');
        const list = this.content?.querySelector?.('#hardware-agent-options');
        if (list) list.hidden = true;
        if (input) {
            input.setAttribute('aria-expanded', 'false');
            const selected = this.snapshot?.agents?.find((agent) => agent.ref === this.selectedAgentRef)
                || this.snapshot?.agents?.find((agent) => agent.ref === 'local-llms/local-llm') || this.snapshot?.agents?.[0];
            input.value = selected?.ref === 'local-llms/local-llm' ? 'Local LLMs' : selected?.ref || '';
        }
    }

    selectAgent(ref) {
        if (this.busy || !this.snapshot?.agents?.some((agent) => agent.ref === ref)) return;
        this.selectedAgentRef = ref;
        this.render();
        this.content?.querySelector?.('[data-hardware-agent-search]')?.focus();
    }

    agentPickerKey(event) {
        const input = event.target.matches?.('[data-hardware-agent-search]');
        const option = event.target.closest?.('[data-agent-picker-option]');
        if (!input && !option) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closeAgentPicker();
            this.content?.querySelector('[data-hardware-agent-search]')?.focus();
        }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            if (!this.agentPickerOpen) this.openAgentPicker();
            const options = [...this.content.querySelectorAll('[data-agent-picker-option]')];
            const index = options.indexOf(event.target);
            const next = event.key === 'ArrowDown' ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
            options[next]?.focus();
        }
    }

    async freshToken(draft) {
        const generation = this.readGeneration;
        const fresh = await this.api.read({ signal: this.abort.signal });
        if (this.closed || generation !== this.readGeneration) throw new DOMException('Panel read superseded.', 'AbortError');
        const expected = draft?.conflict ? draft.reviewToken : draft?.baseToken || this.snapshot?.token;
        this.acceptSnapshot(fresh);
        if (!sameToken(expected, fresh.token)) {
            if (draft) {
                draft.conflict = true;
                draft.reviewToken = fresh.token;
            }
            throw new HardwareLimitsError({ error: 'revision_conflict', message: 'Policy changed elsewhere. Review refreshed values; unsaved edits are preserved.' }, 409);
        }
        return fresh.token;
    }

    async action(dataset) {
        if (this.busy || this.closed) return;
        if (dataset.hardwareAction === 'refresh') return this.refresh({ force: true });
        const agent = this.snapshot?.agents?.[Number(dataset.agentIndex)];
        const draft = this.drafts.get(agent?.ref);
        const instance = agent?.containers?.[Number(dataset.instanceIndex)];
        const action = dataset.hardwareAction;
        const combined = ['save-apply', 'restore-apply'].includes(action);
        const saving = ['save', 'save-apply'].includes(action);
        const clearing = ['clear', 'restore-apply'].includes(action);
        if (!this.snapshot || !['save', 'clear', 'save-apply', 'restore-apply', 'apply', 'apply-all'].includes(action)) return;
        if ((saving || clearing) && !agent) return;
        if (action === 'apply' && !instance?.key) return;
        this.busy = true;
        const generation = ++this.readGeneration;
        this.reading = null;
        if (draft && (saving || clearing)) draft.dirty = true;
        this.error = '';
        this.notice = '';
        let policySaved = false;
        let applyFinished = false;
        if (combined) { this.results = null; this.expandedContainers = []; this.pendingContainers = []; }
        this.render();
        try {
            const limits = saving ? draftLimits(draft) : null;
            const token = await this.freshToken(saving || clearing ? draft : null);
            let result;
            const options = { signal: this.abort.signal };
            if (saving) result = await this.api.set(token, agent.ref, limits, options);
            if (clearing) result = await this.api.clear(token, agent.ref, options);
            if (action === 'apply' || action === 'apply-all') result = await this.api.apply(token, action === 'apply' ? [instance.key] : [], options);
            if (this.closed || generation !== this.readGeneration) return;
            if (saving || clearing) {
                policySaved = true;
                this.drafts.delete(agent.ref);
            }
            if (combined) {
                if (!result?.token || !Array.isArray(result.affectedInstances)) throw new Error('Policy saved, but the affected instances could not be verified. Refresh before retrying.');
                const keys = result.affectedInstances;
                if (keys.length) {
                    result = await this.api.apply(result.token, keys, options);
                    if (this.closed || generation !== this.readGeneration) return;
                    this.notice = result?.ok === false ? 'Limits saved. Some instances could not be restarted; review the results below.' : (clearing ? 'Defaults restored and applied.' : 'Limits saved and applied.');
                } else {
                    this.notice = clearing ? 'Defaults restored. They take effect when this agent starts.' : 'Limits saved. They take effect when this agent starts.';
                    result = { ...result, results: [] };
                }
                applyFinished = true;
            }
            this.results = combined || ['apply', 'apply-all'].includes(action) ? result?.results || [] : null;
            this.expandedContainers = result?.expandedContainers || [];
            this.pendingContainers = result?.pendingContainers || [];
            if (result?.ok === false) this.error = result.message || 'Some instances could not be applied. Review their individual results.';
            this.render();
            const refreshed = await this.api.read(options);
            if (!this.closed && generation === this.readGeneration) this.acceptSnapshot(refreshed);
        } catch (error) {
            if (this.closed || generation !== this.readGeneration) return;
            if (Array.isArray(error?.results)) {
                this.results = error.results;
                this.expandedContainers = error.expandedContainers || [];
                this.pendingContainers = error.pendingContainers || [];
                this.render();
            }
            if (error?.code === 'revision_conflict' || error?.committed) {
                try {
                    const refreshed = await this.api.read({ signal: this.abort.signal });
                    if (this.closed || generation !== this.readGeneration) return;
                    this.acceptSnapshot(refreshed);
                    if (draft) { draft.conflict = true; draft.reviewToken = refreshed.token; }
                } catch (refreshError) {
                    this.reportError(refreshError);
                }
            }
            if (combined && policySaved && !applyFinished && !hardwareAccessDenied(error)) this.notice = 'Policy saved, but it could not be fully applied. Refresh and review the instance status before retrying.';
            this.reportError(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }
}
