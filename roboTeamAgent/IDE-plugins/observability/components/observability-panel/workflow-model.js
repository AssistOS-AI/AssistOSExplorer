export const WORKFLOW_BASE = '/base-agent-additional-server/roboTeamAgent/3001/';
export const TABS = ['human', 'running', 'history'];
const ACTIVE = new Set(['running', 'pending', 'queued', 'starting', 'pausing']);
const TERMINAL = new Set(['completed', 'failed', 'paused', 'terminated']);
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function workflowsForTab(flows, tab) {
    const states = tab === 'human' ? new Set(['paused', 'failed']) : tab === 'running' ? ACTIVE : TERMINAL;
    return flows.filter(flow => states.has(flow.status)).sort((a, b) =>
        (timestamp(b.createdAt) || 0) - (timestamp(a.createdAt) || 0));
}

export function elapsedMs(flow, now = Date.now()) {
    if (Number.isFinite(flow.elapsedMs) && flow.elapsedMs >= 0) {
        const active = timestamp(flow.activeSince);
        return flow.elapsedMs + (ACTIVE.has(flow.status) && Number.isFinite(active) ? Math.max(0, now - active) : 0);
    }
    if (flow.status === 'pending') return 0;
    const start = timestamp(flow.startedAt || flow.createdAt);
    const end = ACTIVE.has(flow.status) ? now : timestamp(flow.finishedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '—';
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600) % 24;
    const minutes = Math.floor(seconds / 60) % 60;
    return [days ? `${days}d` : '', hours || days ? `${hours}h` : '', minutes || hours || days ? `${minutes}m` : '', `${seconds % 60}s`].filter(Boolean).join(' ');
}

export function formatDate(value) {
    const date = timestamp(value);
    return Number.isFinite(date) ? new Date(date).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) : '—';
}

export function executedNodes(flow) {
    return (flow.instances || []).filter(instance => instance.state === 'completed'
        || (TERMINAL.has(instance.state) && Boolean(instance.startedAt))).length;
}

export function workflowUrl(id) {
    return `${WORKFLOW_BASE}flows?flowId=${encodeURIComponent(id)}`;
}

export async function fetchWorkflows({ signal, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(`${WORKFLOW_BASE}api/roboflow/flows`, {
        credentials: 'include', cache: 'no-store', signal, headers: { accept: 'application/json' },
    });
    if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
            ? 'Workflow access is unavailable for this session.'
            : `Could not load workflows (${response.status}).`);
        error.status = response.status;
        throw error;
    }
    const data = await response.json();
    if (!Array.isArray(data?.flows)) throw new Error('The workflow service returned an invalid list.');
    return data.flows;
}

export async function answerHumanInput(flowId, input, { signal, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(`${WORKFLOW_BASE}api/roboflow/flows/${encodeURIComponent(flowId)}/human-input/answer`, {
        method: 'POST', credentials: 'include', signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Could not send the answer (${response.status}).`);
    return result.flow;
}
