import { drawBoard } from './workflow-board.js';
import { generateGraph } from './workflow-generator.js';
const warningText = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node('button', text, 'button'); element.type = 'button'; element.onclick = action; return element; };

export function createWorkflowEditor({ api }) {
    const dialog = document.querySelector('#workflowDialog');
    const form = document.querySelector('#workflowForm');
    const taskList = document.querySelector('#taskList');
    const taskPanel = document.querySelector('#taskEditorPanel');
    const board = document.querySelector('#workflowBoard');
    const message = document.querySelector('#workflowMessage');
    const addTaskButton = document.querySelector('#addTaskButton');
    const addTaskPanel = document.querySelector('#addTaskPanel');
    let graph, catalog = [], canAdmin = false, selected = null, selectedEdgeId = null, currentPage = 'settings', version = 0, coverageRequest = 0, generator;
    const blank = () => ({ name: '', description: '', entryTaskId: '', tasks: [], edges: [], layout: {} });
    const readonly = () => !canAdmin || graph?.kind === 'default';
    const changed = () => { version++; };
    function showError(error) { message.textContent = error.message; }
    function showPage(page) {
        const previousPage = currentPage;
        currentPage = page;
        for (const panel of document.querySelectorAll('[data-workflow-page]')) panel.hidden = panel.dataset.workflowPage !== page;
        for (const control of document.querySelectorAll('.workflow-page-button')) {
            const active = control.dataset.page === page;
            control.setAttribute('aria-pressed', String(active));
            if (active) control.setAttribute('aria-current', 'page'); else control.removeAttribute('aria-current');
        }
        if (page === 'graph' && previousPage !== 'graph') renderBoard();
    }
    function select(id) { selected = id; renderList(); renderTaskEditor(); showPage('task'); }
    function layoutFor(index) { return { x: 40 + index % 4 * 240, y: 40 + Math.floor(index / 4) * 150 }; }
    async function checkCoverage() {
        if (readonly() || !graph.tasks.length) return;
        const request = ++coverageRequest;
        try {
            const result = await api('api/roboflow/validate', { method: 'POST', body: { ...graph, name: graph.name || 'Draft' } });
            if (request !== coverageRequest || !dialog.open) return;
            message.textContent = [result.coverage.warning ? warningText : '', ...result.diagnostics.map(item => item.message)].filter(Boolean).join('\n');
            for (const task of result.coverage.tasks) taskList.querySelector(`[data-task-id="${CSS.escape(task.taskId)}"]`)?.classList.toggle('coverage-warning', !task.matchingRobotIds.length);
        } catch (error) { if (request === coverageRequest) showError(error); }
    }
    function connect({ source, target }) {
        if (source.taskId === target.taskId) return;
        graph.edges.push({ id: `edge-${crypto.randomUUID()}`, sourceTaskId: source.taskId, targetTaskId: target.taskId, sourcePort: source.side, targetPort: target.side }); changed(); render();
    }
    function renderBoard() { drawBoard(board, graph, { readOnly: readonly(), onSelect: id => { selected = id; renderList(); renderTaskEditor(); }, selectedEdgeId, onSelectEdge: id => { selectedEdgeId = id; renderBoard(); }, onSetEntry: id => { graph.entryTaskId = id; selected = id; changed(); render(); }, onChange: event => { if (event.connect) connect(event.connect); else changed(); } }); }
    function field(label, element) { const wrapper = node('label', null, 'field'); wrapper.append(node('span', label), element); return wrapper; }
    function renderList() {
        taskList.replaceChildren();
        for (const task of graph.tasks) {
            const row = node('li');
            const item = node('button', null, 'task-list-item');
            item.type = 'button';
            item.dataset.taskId = task.id;
            if (task.id === selected) item.classList.add('selected');
            item.append(node('strong', task.name || 'Untitled task'), node('span', task.executionType || 'terminal / desktop / browser'));
            item.onclick = () => select(task.id);
            row.append(item);
            taskList.append(row);
        }
        if (!graph.tasks.length) taskList.append(node('li', 'No tasks yet. Use + to add one.', 'task-list-empty'));
    }
    function renderTaskEditor() {
        taskPanel.replaceChildren();
        const task = graph.tasks.find(item => item.id === selected);
        if (!task) {
            if (graph.tasks.length) taskPanel.append(node('p', 'Select a task to edit it.', 'hint'));
            return;
        }
        const card = node('section', null, 'task-editor'); card.dataset.taskId = task.id;
        card.append(node('h3', 'Edit task'));
        const name = node('input'); name.value = task.name || ''; name.maxLength = 120;
        name.oninput = () => {
            task.name = name.value; changed();
            const listItem = taskList.querySelector(`[data-task-id="${CSS.escape(task.id)}"] strong`); if (listItem) listItem.textContent = task.name;
            renderBoard();
        };
        const description = node('textarea'); description.value = task.description || '';
        description.oninput = () => { task.description = description.value; changed(); };
        const mode = node('select');
        for (const value of task.supportedExecutionTypes ? ['terminal / desktop / browser'] : ['terminal', 'desktop', 'browser']) mode.add(new Option(value, value));
        mode.value = task.executionType || 'terminal / desktop / browser';
        mode.onchange = () => {
            task.executionType = mode.value; changed();
            const listItem = taskList.querySelector(`[data-task-id="${CSS.escape(task.id)}"] span`); if (listItem) listItem.textContent = mode.value;
            renderBoard();
        };
        card.append(field('Name', name), field('Description', description), field('Execution type', mode));
        const sets = node('fieldset'); sets.append(node('legend', 'Skillsets'));
        const known = [...catalog];
        const currentSkillsets = Array.isArray(task.skillsets) ? task.skillsets : [];
        for (const id of currentSkillsets) if (!known.some(set => set.id === id)) known.push({ id, name: `${id} (unavailable)` });
        for (const set of known) {
            const check = node('input'); check.type = 'checkbox'; check.checked = currentSkillsets.includes(set.id);
            check.onchange = () => { const latest = Array.isArray(task.skillsets) ? task.skillsets : []; task.skillsets = check.checked ? [...new Set([...latest, set.id])] : latest.filter(id => id !== set.id); changed(); void checkCoverage(); };
            const label = node('label', null, 'skillset-option'); label.append(check, node('span', `${set.repositoryName || set.repositoryId || ''} / ${set.name}${set.description ? ` — ${set.description}` : ''}`)); sets.append(label);
        }
        card.append(sets, button('Delete task', () => {
            graph.tasks = graph.tasks.filter(item => item.id !== task.id);
            graph.edges = graph.edges.filter(edge => edge.sourceTaskId !== task.id && edge.targetTaskId !== task.id);
            delete graph.layout[task.id];
            if (graph.entryTaskId === task.id) graph.entryTaskId = graph.tasks[0]?.id || '';
            if (selected === task.id) selected = graph.tasks[0]?.id || null;
            changed(); render(); showPage(graph.tasks.length ? 'graph' : 'settings');
        }));
        for (const control of card.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        taskPanel.append(card);
    }
    function renderAddTask() {
        const previous = addTaskPanel.querySelector('.task-editor');
        const previousValues = previous ? [...previous.querySelectorAll('input:not([type="checkbox"]),textarea,select')].map(control => control.value) : [];
        const previousSkillsets = previous ? [...previous.querySelectorAll('input[type="checkbox"]:checked')].map(control => control.value) : [];
        addTaskPanel.replaceChildren();
        const card = node('section', null, 'task-editor');
        card.append(node('h3', 'Add task'));
        const name = node('input'); name.maxLength = 120; name.placeholder = 'Review change';
        const description = node('textarea'); description.rows = 3; description.placeholder = 'Describe what this task should do.';
        const mode = node('select');
        for (const value of ['terminal', 'desktop', 'browser']) mode.add(new Option(value, value));
        const sets = node('fieldset'); sets.append(node('legend', 'Skillsets'));
        for (const set of catalog) {
            const check = node('input'); check.type = 'checkbox'; check.value = set.id; check.checked = previousSkillsets.includes(set.id);
            const label = node('label', null, 'skillset-option');
            label.append(check, node('span', `${set.repositoryName || set.repositoryId || ''} / ${set.name}${set.description ? ` — ${set.description}` : ''}`));
            sets.append(label);
        }
        const save = button('Save task', () => {
            if (!name.value.trim() || !description.value.trim()) { card.querySelector('.task-form-error').textContent = 'Enter a name and description.'; return; }
            const id = `task-${crypto.randomUUID()}`;
            graph.tasks.push({ id, name: name.value.trim(), description: description.value.trim(), skillsets: [...sets.querySelectorAll('input:checked')].map(input => input.value), executionType: mode.value });
            graph.layout[id] = layoutFor(graph.tasks.length - 1);
            graph.entryTaskId ||= id; selected = id; changed(); addTaskPanel.replaceChildren(); render(); showPage('task');
        });
        const error = node('p', '', 'task-form-error'); error.setAttribute('role', 'alert');
        card.append(field('Name', name), field('Description', description), field('Execution type', mode), sets, error, save);
        if (previousValues.length) { name.value = previousValues[0]; description.value = previousValues[1] || ''; mode.value = previousValues[2] || 'terminal'; }
        for (const control of card.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        addTaskPanel.append(card);
    }
    function render() {
        if (!graph.tasks.some(task => task.id === selected)) selected = graph.entryTaskId || graph.tasks[0]?.id || null;
        if (!graph.edges.some(edge => edge.id === selectedEdgeId)) selectedEdgeId = null;
        renderList();
        renderTaskEditor();
        if (addTaskPanel.firstElementChild) renderAddTask();
        renderBoard();
        void checkCoverage();
    }
    async function open(value) {
        graph = value ? structuredClone(value) : blank(); delete graph.coverage; delete graph.diagnostics;
        version++; coverageRequest++; message.textContent = ''; selected = graph.entryTaskId || graph.tasks[0]?.id || null; currentPage = 'settings'; addTaskPanel.replaceChildren();
        form.elements.name.value = graph.name; form.elements.description.value = graph.description;
        document.querySelector('#workflowDialogTitle').textContent = graph.kind === 'default' ? 'Default workflow (read-only)' : graph.id ? 'Edit workflow' : 'Create workflow';
        for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        for (const control of document.querySelectorAll('.workflow-page-button')) control.disabled = false;
        addTaskButton.disabled = readonly();
        for (const id of ['workflowCancelButton', 'workflowDialogClose']) document.querySelector(`#${id}`).disabled = false;
        document.querySelector('#workflowCreateButton').hidden = readonly();
        document.documentElement.classList.add('workflow-modal-open');
        dialog.showModal(); render(); showPage('settings');
        try { const result = await api('api/roboflow/skillsets'); catalog = result.skillsets; render(); if (result.diagnostics.length) message.textContent = result.diagnostics.map(item => item.message).join('\n'); } catch (error) { showError(error); }
    }
    async function load(admin = canAdmin) {
        canAdmin = admin;
        document.querySelector('#addWorkflowButton').disabled = !canAdmin;
        const { workflows } = await api('api/roboflow/workflows');
        const list = document.querySelector('#workflowsList'); list.replaceChildren();
        document.querySelector('#workflowCount').textContent = `${workflows.length} workflows`;
        for (const workflow of workflows) {
            const card = node('article', null, 'workflow-card');
            card.append(node('h3', workflow.name), node('p', workflow.description));
            if (workflow.coverage?.warning) { const warning = node('span', '⚠', 'workflow-warning'); warning.title = warningText; warning.setAttribute('aria-label', warningText); card.append(warning); }
            card.append(node('p', `${workflow.tasks.length} tasks · ${workflow.edges.length} connections`), button(canAdmin && workflow.kind !== 'default' ? 'Edit workflow' : 'View workflow', () => open(workflow)));
            if (canAdmin && workflow.kind !== 'default') card.append(button('Delete', async () => { if (!confirm(`Delete workflow ${workflow.name}?`)) return; try { await api(`api/roboflow/workflows/${workflow.id}`, { method: 'DELETE' }); await load(); } catch (error) { document.querySelector('#workflowListMessage').textContent = error.message; } }));
            list.append(card);
        }
        if (dialog.open) await checkCoverage();
    }
    document.querySelector('#addWorkflowButton').onclick = () => open();
    document.querySelector('#workflowCancelButton').onclick = () => dialog.close();
    document.querySelector('#workflowDialogClose').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { coverageRequest++; generator?.abort(); document.documentElement.classList.remove('workflow-modal-open'); });
    form.elements.name.oninput = event => { graph.name = event.target.value; changed(); };
    form.elements.description.oninput = event => { graph.description = event.target.value; changed(); };
    for (const control of document.querySelectorAll('.workflow-page-button')) control.onclick = () => showPage(control.dataset.page);
    addTaskButton.onclick = () => { renderAddTask(); showPage('addTask'); addTaskPanel.querySelector('input')?.focus(); };
    document.addEventListener('keydown', event => {
        if (readonly() || !dialog.open || currentPage !== 'graph' || !selectedEdgeId || !['Delete', 'Backspace'].includes(event.key)) return;
        if (event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
        event.preventDefault(); graph.edges = graph.edges.filter(edge => edge.id !== selectedEdgeId); selectedEdgeId = null; changed(); render();
    });
    document.querySelector('#cancelGeneration').onclick = () => generator?.abort();
    document.querySelector('#generateWorkflow').onclick = async () => {
        const capturedVersion = version;
        generator = new AbortController(); const control = generator;
        document.querySelector('#generateWorkflow').disabled = true; document.querySelector('#cancelGeneration').hidden = false;
        try {
            const result = await generateGraph(document.querySelector('#generationDescription').value, { signal: control.signal, onProgress: status => { message.textContent = `Generating graph: ${status}`; } });
            if (!dialog.open || control.signal.aborted) return;
            if (version !== capturedVersion && !confirm('Replace the draft edited during generation?')) return;
            const identity = { id: graph.id, revision: graph.revision }; graph = { ...result.graph, ...identity };
            form.elements.name.value = graph.name; form.elements.description.value = graph.description;
            selected = graph.entryTaskId || graph.tasks[0]?.id || null; changed(); render(); showPage('graph');
        } catch (error) { if (dialog.open) showError(error); }
        finally { if (generator === control) { generator = null; document.querySelector('#generateWorkflow').disabled = readonly(); document.querySelector('#cancelGeneration').hidden = true; } }
    };
    form.onsubmit = async event => {
        event.preventDefault(); if (readonly()) return;
        if (!graph.name.trim()) { showPage('settings'); message.textContent = 'Enter a workflow name before saving.'; form.elements.name.focus(); return; }
        if (!graph.tasks.length) { renderAddTask(); showPage('addTask'); message.textContent = 'Add at least one task before saving.'; addTaskPanel.querySelector('input')?.focus(); return; }
        const invalidTask = graph.tasks.find(task => !task.name?.trim() || !task.description?.trim());
        if (invalidTask) {
            select(invalidTask.id);
            message.textContent = 'Enter a name and description for this task before saving.';
            taskPanel.querySelector(!invalidTask.name?.trim() ? 'input' : 'textarea')?.focus();
            return;
        }
        try { await api(graph.id ? `api/roboflow/workflows/${graph.id}` : 'api/roboflow/workflows', { method: graph.id ? 'PUT' : 'POST', body: graph }); dialog.close(); await load(); }
        catch (error) { showError(error); }
    };
    window.addEventListener('focus', () => { void load().catch(() => {}); });
    return { load };
}
