const api = (relative) => new URL(relative, document.baseURI).toString();

const elements = {
    refreshButton: document.getElementById('refreshButton'),
    flowsList: document.getElementById('flowsList'),
    flowCount: document.getElementById('flowCount'),
    detail: document.getElementById('detail'),
    detailTitle: document.getElementById('detail-title'),
    flowSummary: document.getElementById('flowSummary'),
    invocations: document.getElementById('invocations'),
    backButton: document.getElementById('backButton'),
    workflowsList: document.getElementById('workflowsList'),
    workflowCount: document.getElementById('workflowCount'),
    overview: document.getElementById('overview'),
    workflowsPanel: document.getElementById('workflowsPanel'),
    message: document.getElementById('message'),
};

function setMessage(text, kind = '') {
    elements.message.textContent = text || '';
    elements.message.className = `message ${kind}`.trim();
}

function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

async function apiGet(path, { text = false } = {}) {
    const response = await fetch(api(path), { credentials: 'include', headers: { accept: text ? 'text/plain' : 'application/json' } });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return text ? response.text() : response.json();
}

function currentFlowId() {
    return new URLSearchParams(window.location.search).get('flow') || '';
}

function flowCard(flow) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'flow-card';
    card.innerHTML = `
        <span class="flow-card-title"></span>
        <span class="flow-card-objective"></span>
        <span class="flow-card-meta"></span>`;
    card.querySelector('.flow-card-title').textContent = flow.workflowName || flow.workflowTypeId;
    card.querySelector('.flow-card-objective').textContent = flow.objective;
    const active = (flow.invocations || []).filter((invocation) => !['completed', 'failed', 'stopped', 'interrupted'].includes(invocation.state)).length;
    card.querySelector('.flow-card-meta').textContent = `${flow.status} · ${flow.invocations.length} run(s)${active ? ` · ${active} active` : ''} · ${formatTime(flow.createdAt)}`;
    card.addEventListener('click', () => { window.location.search = `?flow=${encodeURIComponent(flow.id)}`; });
    return card;
}

function summaryRow(label, value) {
    const wrap = document.createElement('p');
    wrap.className = 'summary-row';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    wrap.appendChild(strong);
    wrap.appendChild(document.createTextNode(value || '—'));
    return wrap;
}

function invocationCard(flow, invocation) {
    const card = document.createElement('article');
    card.className = `invocation state-${invocation.state}`;
    const header = document.createElement('div');
    header.className = 'invocation-header';
    header.innerHTML = `
        <span class="invocation-robot"></span>
        <span class="invocation-type"></span>
        <span class="invocation-state"></span>`;
    header.querySelector('.invocation-robot').textContent = invocation.robotName;
    header.querySelector('.invocation-type').textContent = invocation.executionType;
    header.querySelector('.invocation-state').textContent = invocation.state;
    card.appendChild(header);

    if (invocation.instruction) card.appendChild(summaryRow('Instruction', invocation.instruction));
    if (invocation.summary) {
        const summary = document.createElement('pre');
        summary.className = 'invocation-summary';
        summary.textContent = invocation.summary;
        card.appendChild(summary);
    }
    if (invocation.error) card.appendChild(summaryRow('Error', invocation.error));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'button secondary';
    toggle.textContent = 'Show full log';
    const log = document.createElement('pre');
    log.className = 'invocation-log';
    log.hidden = true;
    log.textContent = 'Loading…';
    toggle.addEventListener('click', async () => {
        if (!log.hidden) { log.hidden = true; toggle.textContent = 'Show full log'; return; }
        log.hidden = false;
        toggle.textContent = 'Hide full log';
        if (log.dataset.loaded === 'true') return;
        try {
            log.textContent = await apiGet(`api/roboflow/flows/${flow.id}/invocations/${invocation.id}/log`, { text: true }) || '(empty)';
            log.dataset.loaded = 'true';
        } catch (error) {
            log.textContent = error.message;
        }
    });
    card.appendChild(toggle);
    card.appendChild(log);
    return card;
}

async function renderDetail(flowId) {
    const { flow } = await apiGet(`api/roboflow/flows/${flowId}?logs=none`);
    elements.overview.hidden = true;
    elements.workflowsPanel.hidden = true;
    elements.detail.hidden = false;
    elements.detailTitle.textContent = flow.workflowName || flow.workflowTypeId;
    elements.flowSummary.replaceChildren(
        summaryRow('Objective', flow.objective),
        summaryRow('Folder', flow.folder),
        summaryRow('Status', flow.status),
        summaryRow('Created', formatTime(flow.createdAt)),
        summaryRow('Finished', formatTime(flow.finishedAt)),
        summaryRow('Result', flow.result),
    );
    elements.invocations.replaceChildren();
    for (const step of flow.steps || []) {
        const card = document.createElement('article');
        card.className = `invocation state-${step.state}`;
        const header = document.createElement('div');
        header.className = 'invocation-header';
        header.innerHTML = `
            <span class="invocation-robot"></span>
            <span class="invocation-type"></span>
            <span class="invocation-state"></span>`;
        header.querySelector('.invocation-robot').textContent = `Decision ${step.index}`;
        header.querySelector('.invocation-type').textContent = step.robotName || '';
        header.querySelector('.invocation-state').textContent = step.state;
        card.appendChild(header);
        if (step.summary) {
            const summary = document.createElement('pre');
            summary.className = 'invocation-summary';
            summary.textContent = step.summary;
            card.appendChild(summary);
        }
        if (step.error) card.appendChild(summaryRow('Error', step.error));
        elements.invocations.appendChild(card);
    }
    if (!flow.invocations.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No robot runs yet.';
        elements.invocations.appendChild(empty);
    }
    for (const invocation of flow.invocations) elements.invocations.appendChild(invocationCard(flow, invocation));
    elements.backButton.onclick = () => { window.location.search = ''; };
}

async function renderOverview() {
    elements.detail.hidden = true;
    elements.overview.hidden = false;
    elements.workflowsPanel.hidden = false;
    const [{ flows }, { workflows }] = await Promise.all([
        apiGet('api/roboflow/flows'),
        apiGet('api/roboflow/workflows'),
    ]);
    elements.flowCount.textContent = String(flows.length);
    elements.flowsList.replaceChildren();
    if (!flows.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No task flows yet.';
        elements.flowsList.appendChild(empty);
    }
    for (const flow of flows) elements.flowsList.appendChild(flowCard(flow));

    elements.workflowCount.textContent = String(workflows.length);
    elements.workflowsList.replaceChildren();
    for (const workflow of workflows) {
        const card = document.createElement('article');
        card.className = 'workflow-card';
        const title = document.createElement('h3');
        title.textContent = workflow.name;
        card.appendChild(title);
        if (workflow.description) {
            const description = document.createElement('p');
            description.textContent = workflow.description;
            card.appendChild(description);
        }
        const list = document.createElement('ul');
        for (const member of workflow.members) {
            const item = document.createElement('li');
            const decision = member.id === workflow.decisionMemberId ? ' · decision maker' : '';
            item.textContent = `${member.robotName} · ${member.executionType}${member.role ? ` · ${member.role}` : ''}${decision}`;
            list.appendChild(item);
        }
        card.appendChild(list);
        elements.workflowsList.appendChild(card);
    }
}

async function refresh() {
    setMessage('');
    try {
        const flowId = currentFlowId();
        if (flowId) await renderDetail(flowId);
        else await renderOverview();
    } catch (error) {
        setMessage(error.message, 'is-error');
    }
}

elements.refreshButton.addEventListener('click', refresh);
window.addEventListener('popstate', refresh);
await refresh();
