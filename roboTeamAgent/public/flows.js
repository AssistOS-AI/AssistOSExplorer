import { api, endpoint } from './roboflow-api.js';

const list = document.querySelector('#flowsList');
const message = document.querySelector('#flowsMessage');

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function flowItem(flow) {
    const item = document.createElement('a');
    item.className = 'flow-item';
    item.href = endpoint(`flows?flowId=${encodeURIComponent(flow.id)}`);
    const head = document.createElement('div');
    head.className = 'flow-item-head';
    const name = document.createElement('strong');
    name.textContent = flow.workflowName || flow.id;
    const status = document.createElement('span');
    status.className = 'flow-item-status';
    status.textContent = flow.status;
    status.dataset.status = flow.status;
    head.append(name, status);
    const meta = document.createElement('span');
    meta.className = 'flow-item-meta';
    meta.textContent = [flow.objective, formatDate(flow.createdAt)].filter(Boolean).join(' · ');
    item.append(head, meta);
    return item;
}

try {
    const { flows } = await api('api/roboflow/flows');
    document.querySelector('#flowCount').textContent = String(flows.length);
    message.textContent = flows.length ? '' : 'No flow executions yet.';
    list.replaceChildren(...flows.map(flowItem));
} catch (error) {
    message.textContent = error.message;
    message.classList.add('is-error');
}
