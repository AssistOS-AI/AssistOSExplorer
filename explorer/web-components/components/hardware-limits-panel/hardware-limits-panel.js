import { createHardwareLimitsApi, hardwareAccessDenied, HardwareLimitsError } from '../../../services/infrastructure/hardwareLimitsApi.js';
import { AUTHORITY_HELP, GPU_HELP, sameToken, reconcileDrafts, draftLimits, describeApplied, describeUsage, describeProblem, formatBytes } from './hardware-limits-model.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
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

export function renderHardwareLimits(snapshot, drafts, { busy = false, error = '', results = null, expandedContainers = [], pendingContainers = [] } = {}) {
    if (!snapshot) return `<p class="hardware-limits-error" role="status">${escapeHtml(error || 'Loading hardware limits…')}</p>`;
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    const gpuEnabled = snapshot.gpu?.eligible === true;
    const disabled = busy ? ' disabled' : '';
    const fields = [['cpus', 'CPU cores', '0.01'], ['memoryPercent', 'RAM %', '1'], ['smPercent', 'GPU SM %', '1'], ['vramPercent', 'GPU VRAM %', '1']];
    return `<div class="hardware-limits-toolbar"><div><strong>Hardware limits</strong><p class="hardware-limits-facts">Gate ${escapeHtml(snapshot.gate?.state || 'unknown')}; ${snapshot.gate?.prepared === true ? 'prepared' : 'preparation unverified'}. Envelope ${escapeHtml(snapshot.envelope?.cpus ?? 'unknown')} CPU cores / ${escapeHtml(formatBytes(snapshot.envelope?.memoryBytes))}. Controllers: ${escapeHtml((snapshot.gate?.controllers || []).join(', ') || 'none observed')}.</p></div><div class="hardware-policy-actions"><button class="gray-button" type="button" data-hardware-action="refresh"${disabled}>Refresh</button><button class="general-button" type="button" data-hardware-action="apply-all"${disabled}>Apply all pending</button></div></div>
        <p>Saving changes desired policy. Apply recreates exact instances. CPU and RAM limits use kernel controllers. RAM and GPU percentages are whole numbers from 1 to 100. GPU VRAM percentage uses physical device memory; applied rows show the resolved bytes per CUDA process. Empty fields inherit declared limits; Clear override restores all declared values.</p>
        <p class="hardware-limits-facts">GPU ${escapeHtml(snapshot.gpu?.mode || 'unavailable')} (${escapeHtml(snapshot.gpu?.assurance || 'none')}). ${gpuEnabled ? '' : escapeHtml(snapshot.gpu?.fix || snapshot.gpu?.reason || 'GPU editing requires a verified eligible NVIDIA backend.')}</p>
        ${error ? `<p class="hardware-limits-error" role="status">${escapeHtml(error)}</p>` : ''}
        ${results ? `<div role="status"><strong>Apply results</strong>${results.length ? results.map((result) => `<p>${escapeHtml(result.key || result.containerName || '')}${result.observedKey && result.observedKey !== result.key ? ` (observed ${escapeHtml(result.observedKey)})` : ''}: ${escapeHtml(result.state || result.status || (result.ok ? 'completed' : 'unavailable'))} ${escapeHtml(result.message || describeProblem({ availability: result.state, problem: result.problem }))} ${escapeHtml(result.fix || '')}</p>`).join('') : '<p>No instances changed.</p>'}${expandedContainers.length ? `<p>Coordinated instances: ${expandedContainers.map(escapeHtml).join(', ')}</p>` : ''}${pendingContainers.length ? `<p>Still pending: ${pendingContainers.map(escapeHtml).join(', ')}</p>` : ''}</div>` : ''}
        ${agents.length ? agents.map((agent, index) => {
        const draft = drafts.get(agent.ref);
        const containers = Array.isArray(agent.containers) ? agent.containers : [];
        return `<article class="hardware-policy" data-agent-index="${index}"><h3>${escapeHtml(agent.ref)}</h3>
            <p class="hardware-instance-detail">Stored ${escapeHtml(policyDescription(agent.configured))}; declared ${escapeHtml(policyDescription(agent.declared))}; effective ${escapeHtml(policyDescription(agent.effective))}.</p>
            ${draft?.conflict ? '<p class="hardware-limits-conflict" role="status">Policy changed elsewhere. Your unsaved values remain below. Review the refreshed stored and effective values before saving again.</p>' : ''}
            <div class="hardware-limit-fields">${fields.map(([field, label, step]) => `<label class="hardware-limit-field">${label}<input class="form-input" type="number" step="${step}" min="${field === 'cpus' ? '0.05' : '1'}"${field !== 'cpus' ? ' max="100"' : ''} data-hardware-field="${field}" data-agent-index="${index}" value="${escapeHtml(draft?.[field] || '')}"${disabled}${!gpuEnabled && ['smPercent', 'vramPercent'].includes(field) ? ' disabled' : ''}></label>`).join('')}</div>
            <div class="hardware-policy-actions"><button class="general-button" type="button" data-hardware-action="save" data-agent-index="${index}"${disabled}>${draft?.conflict ? 'Review and save' : 'Save desired limits'}</button><button class="gray-button" type="button" data-hardware-action="clear" data-agent-index="${index}"${disabled}>Clear override</button>${draft?.dirty ? '<span class="hardware-instance-detail">Unsaved edits</span>' : ''}</div>
            ${containers.length ? `<table class="hardware-instances"><thead><tr><th>Exact instance</th><th>Availability / limits</th><th>Applied / usage</th><th>Action</th></tr></thead><tbody>${containers.map((instance, instanceIndex) => `<tr><td>${escapeHtml(instance.alias == null ? 'Canonical instance' : `Alias: ${instance.alias}`)}<code>${escapeHtml(instance.key)}</code></td><td><span class="hardware-instance-state">${escapeHtml(instance.availability || 'stopped')}</span> / ${escapeHtml(instance.limitsState || 'unavailable')}<p class="hardware-instance-problem">${escapeHtml(describeProblem(instance))}</p></td><td>${escapeHtml(describeApplied(instance.limits))}<p class="hardware-instance-detail">${escapeHtml(describeUsage(instance))}</p></td><td><button class="general-button" type="button" data-hardware-action="apply" data-agent-index="${index}" data-instance-index="${instanceIndex}"${disabled}>Apply instance</button></td></tr>`).join('')}</tbody></table>` : '<p class="hardware-instance-detail">Not enabled. Saved policy will apply when this agent starts.</p>'}
            </article>`;
    }).join('') : '<p>No installed agents are available.</p>'}
        <details class="hardware-limit-help"><summary>GPU assurance and administrator authority</summary>${GPU_HELP.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}<p>Host operator commands: <code>sudo nvidia-smi -i 0 -c EXCLUSIVE_PROCESS</code>; undo with <code>sudo nvidia-smi -i 0 -c DEFAULT</code>.</p><p>${escapeHtml(AUTHORITY_HELP)}</p><p>An optional no-wait child refusal does not block its parent. A required refused dependency blocks its consumers; those consumers are never ready. If Explorer itself is blocked, host <code>ploinky limits status</code>, <code>ploinky limits clear</code> and Router administration provide recovery.</p></details>`;
}

export class HardwareLimitsPanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.api = props.api || createHardwareLimitsApi();
        this.snapshot = null;
        this.drafts = new Map();
        this.busy = false;
        this.error = '';
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
                const button = event.target.closest?.('[data-hardware-action]');
                if (button && this.element.contains(button)) void this.action(button.dataset);
            });
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

    render() {
        if (this.content && !this.closed) this.content.innerHTML = renderHardwareLimits(this.snapshot, this.drafts, this);
    }

    acceptSnapshot(snapshot) {
        if (this.closed) return;
        this.snapshot = snapshot;
        this.drafts = reconcileDrafts(snapshot.agents, snapshot.token, this.drafts);
        this.render();
    }

    reportError(error) {
        if (this.closed || error?.name === 'AbortError') return;
        if (hardwareAccessDenied(error)) {
            this.readGeneration += 1;
            this.reading = null;
            this.snapshot = null;
            this.drafts.clear();
            this.results = null;
            this.expandedContainers = [];
            this.pendingContainers = [];
            this.active = false;
            this.element.dispatchEvent(new CustomEvent('hardware-limits-access-denied', { bubbles: true }));
        }
        this.error = `${error?.message || 'Hardware limits are unavailable.'}${error?.fix ? ` ${error.fix}` : ''}`;
        this.render();
    }

    async refresh() {
        if (this.closed || this.busy || this.reading) return;
        const generation = ++this.readGeneration;
        this.reading = generation;
        try {
            const snapshot = await this.api.read({ signal: this.abort.signal });
            if (this.closed || generation !== this.readGeneration) return;
            this.error = '';
            this.acceptSnapshot(snapshot);
        } catch (error) {
            if (generation === this.readGeneration) this.reportError(error);
        } finally {
            if (this.reading === generation) this.reading = null;
        }
    }

    edit(input) {
        const field = input?.dataset?.hardwareField;
        if (!['cpus', 'memoryPercent', 'smPercent', 'vramPercent'].includes(field)) return;
        const agent = this.snapshot?.agents?.[Number(input.dataset.agentIndex)];
        const draft = this.drafts.get(agent?.ref);
        if (!draft || this.busy) return;
        draft[field] = input.value;
        draft.dirty = true;
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
        if (dataset.hardwareAction === 'refresh') return this.refresh();
        const agent = this.snapshot?.agents?.[Number(dataset.agentIndex)];
        const draft = this.drafts.get(agent?.ref);
        const instance = agent?.containers?.[Number(dataset.instanceIndex)];
        const action = dataset.hardwareAction;
        if (!this.snapshot || !['save', 'clear', 'apply', 'apply-all'].includes(action)) return;
        if (['save', 'clear'].includes(action) && !agent) return;
        if (action === 'apply' && !instance?.key) return;
        this.busy = true;
        const generation = ++this.readGeneration;
        this.reading = null;
        if (draft && ['save', 'clear'].includes(action)) draft.dirty = true;
        this.error = '';
        this.render();
        try {
            const limits = action === 'save' ? draftLimits(draft) : null;
            const token = await this.freshToken(['save', 'clear'].includes(action) ? draft : null);
            let result;
            const options = { signal: this.abort.signal };
            if (action === 'save') result = await this.api.set(token, agent.ref, limits, options);
            if (action === 'clear') result = await this.api.clear(token, agent.ref, options);
            if (action === 'apply' || action === 'apply-all') result = await this.api.apply(token, action === 'apply' ? [instance.key] : [], options);
            if (this.closed || generation !== this.readGeneration) return;
            if (action === 'save' || action === 'clear') this.drafts.delete(agent.ref);
            this.results = ['apply', 'apply-all'].includes(action) ? result?.results || [] : null;
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
            this.reportError(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }
}
