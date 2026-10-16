import { api, endpoint } from './roboflow-api.js';
import { initPageNavigation } from './page-navigation.js';

const navigation = initPageNavigation({
    fallbackUrl: endpoint('?tab=workflow-types'),
    captureView: () => ({ scrollX: window.scrollX, scrollY: window.scrollY }),
});

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
    navigation.bindLink(item);
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
    if (navigation.view) requestAnimationFrame(() => window.scrollTo(navigation.view.scrollX || 0, navigation.view.scrollY || 0));
} catch (error) {
    message.textContent = error.message;
    message.classList.add('is-error');
}
