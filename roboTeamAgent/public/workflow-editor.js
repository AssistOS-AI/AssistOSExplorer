import { drawBoard } from './workflow-board.js';
const warningText = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node('button', text, 'button'); element.type = 'button'; element.onclick = action; return element; };

function appUrl(relative = '') {
    const basePath = globalThis.ROBOTEAM_CONFIG?.publicBasePath || './';
    return new URL(relative.replace(/^\/+/, ''), new URL(basePath, location.origin)).toString();
}

function leaveEditor() {
    location.assign(appUrl(''));
}

export function createWorkflowEditor({ api }) {
    const form = document.querySelector('#workflowForm');
    const taskList = document.querySelector('#taskList');
    const taskPanel = document.querySelector('#taskEditorPanel');
    const board = document.querySelector('#workflowBoard');
    const message = document.querySelector('#workflowMessage');
    const addTaskButton = document.querySelector('#addTaskButton');
    const addTaskPanel = document.querySelector('#addTaskPanel');
    let graph, catalog = [], canAdmin = false, selected = null, selectedEdgeId = null, currentPage = 'settings', version = 0, coverageRequest = 0, addSkillsets = [];
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
    function showCoverageMessage(result) {
        message.replaceChildren();
        const lines = [];
        if (result.coverage.warning) {
            const line = node('span', null, 'coverage-warning-line');
            const icon = node('span', '⚠', 'coverage-warning-icon');
            icon.setAttribute('aria-hidden', 'true');
            line.append(icon, node('span', warningText));
            lines.push(line);
        }
        for (const item of result.diagnostics) lines.push(node('span', item.message, 'coverage-diagnostic'));
        lines.forEach((line, index) => {
            if (index) message.append(document.createTextNode('\n'));
            message.append(line);
        });
    }
    async function checkCoverage() {
        if (readonly() || !graph.tasks.length) return;
        const request = ++coverageRequest;
        try {
            const result = await api('api/roboflow/validate', { method: 'POST', body: { ...graph, name: graph.name || 'Draft' } });
            if (request !== coverageRequest) return;
            showCoverageMessage(result);
            for (const task of result.coverage.tasks) taskList.querySelector(`[data-task-id="${CSS.escape(task.taskId)}"]`)?.classList.toggle('coverage-warning', !task.matchingRobotIds.length);
        } catch (error) { if (request === coverageRequest) showError(error); }
    }
    function connect({ source, target }) {
        if (source.taskId === target.taskId) return;
        graph.edges.push({ id: `edge-${crypto.randomUUID()}`, sourceTaskId: source.taskId, targetTaskId: target.taskId, sourcePort: source.side, targetPort: target.side }); changed(); render();
    }
    function renderBoard() { drawBoard(board, graph, { readOnly: readonly(), onSelect: id => { selected = id; renderList(); renderTaskEditor(); }, selectedEdgeId, onSelectEdge: id => { selectedEdgeId = id; renderBoard(); }, onSetEntry: id => { graph.entryTaskId = id; selected = id; changed(); render(); }, onChange: event => { if (event.connect) connect(event.connect); else changed(); } }); }
    function field(label, element) { const wrapper = node('label', null, 'field'); wrapper.append(node('span', label), element); return wrapper; }
    function fieldBlock(label, element) { const wrapper = node('div', null, 'field'); wrapper.append(node('span', label), element); return wrapper; }
    function skillsetPicker(selectedIds) {
        const wrapper = node('div', null, 'skillset-picker');
        const pills = node('div', null, 'skillset-pills');
        const trigger = node('button', null, 'skillset-trigger');
        trigger.type = 'button';
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.append(node('span', '+', 'skillset-trigger-icon'), node('span', 'Add skill or skillset'), node('span', '▾', 'skillset-trigger-caret'));
        const panel = node('div', null, 'skillset-panel');
        panel.hidden = true;
        const search = node('input'); search.type = 'search'; search.className = 'skillset-search';
        search.placeholder = 'Search skills and skillsets'; search.setAttribute('aria-label', 'Search skills and skillsets');
        const list = node('div', null, 'skillset-list');
        const count = node('span', '', 'skillset-count');
        const footer = node('div', null, 'skillset-panel-footer');
        footer.append(count, button('Done', () => setOpen(false)));
        panel.append(search, list, footer);
        const groups = new Map();
        for (const set of catalog) {
            const key = set.repositoryName || set.repositoryId || 'Skillsets';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(set);
        }
        const known = new Set(catalog.map(set => set.id));
        const unavailable = selectedIds.filter(id => !known.has(id));
        if (unavailable.length) groups.set('Unavailable', unavailable.map(id => ({ id, name: `${id} (unavailable)` })));
        function apply() { changed(); void checkCoverage(); }
        function setOpen(open) {
            panel.hidden = !open;
            trigger.setAttribute('aria-expanded', String(open));
            if (open) search.focus();
        }
        function renderPills() {
            pills.replaceChildren();
            if (!selectedIds.length) { pills.append(node('span', 'No skills selected.', 'skillset-empty')); return; }
            for (const id of selectedIds) {
                const set = catalog.find(item => item.id === id);
                const label = set ? set.name : `${id} (unavailable)`;
                const pill = node('span', null, 'skillset-pill');
                pill.append(node('span', label, 'skillset-pill-label'));
                const remove = node('button', '×', 'skillset-pill-remove');
                remove.type = 'button';
                remove.setAttribute('aria-label', `Remove ${label}`);
                remove.onclick = () => { const index = selectedIds.indexOf(id); if (index >= 0) selectedIds.splice(index, 1); renderPills(); renderOptions(); apply(); };
                pill.append(remove);
                pills.append(pill);
            }
        }
        function renderOptions() {
            const term = search.value.trim().toLowerCase();
            list.replaceChildren();
            let visible = 0;
            for (const [repository, sets] of groups) {
                const matches = sets.filter(set => !term || String(set.name || '').toLowerCase().includes(term)
                    || String(set.description || '').toLowerCase().includes(term) || repository.toLowerCase().includes(term));
                if (!matches.length) continue;
                const group = node('section', null, 'skillset-group');
                group.append(node('h4', repository, 'skillset-group-header'));
                const grid = node('div', null, 'skillset-group-grid');
                for (const set of matches) {
                    const chosen = selectedIds.includes(set.id);
                    const item = node('button', null, 'skillset-pick-item');
                    item.type = 'button';
                    item.setAttribute('aria-pressed', String(chosen));
                    if (chosen) item.classList.add('selected');
                    const text = node('span', null, 'skillset-pick-text');
                    const nameRow = node('span', null, 'skillset-pick-name-row');
                    nameRow.append(node('span', set.name, 'skillset-pick-name'));
                    if (set.kind) nameRow.append(node('span', set.kind, 'skillset-pick-kind'));
                    text.append(nameRow);
                    if (set.description) text.append(node('span', set.description, 'skillset-pick-desc'));
                    item.append(node('span', chosen ? '✓' : '', 'skillset-pick-check'), text);
                    item.onclick = () => { if (chosen) selectedIds.splice(selectedIds.indexOf(set.id), 1); else selectedIds.push(set.id); renderPills(); renderOptions(); apply(); };
                    grid.append(item);
                }
                group.append(grid);
                list.append(group);
                visible += matches.length;
            }
            if (!visible) list.append(node('p', 'No matching skills or skillsets.', 'skillset-empty'));
            count.textContent = selectedIds.length ? `${selectedIds.length} selected` : 'None selected';
        }
        trigger.onclick = () => setOpen(panel.hidden);
        search.oninput = renderOptions;
        wrapper.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || panel.hidden) return;
            event.stopPropagation(); setOpen(false); trigger.focus();
        });
        renderPills(); renderOptions();
        wrapper.append(pills, trigger, panel);
        return wrapper;
    }
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
        const prompt = node('textarea'); prompt.value = task.prompt || '';
        prompt.oninput = () => { task.prompt = prompt.value; changed(); };
        const mode = node('select');
        for (const value of task.supportedExecutionTypes ? ['terminal / desktop / browser'] : ['terminal', 'desktop', 'browser']) mode.add(new Option(value, value));
        mode.value = task.executionType || 'terminal / desktop / browser';
        mode.onchange = () => {
            task.executionType = mode.value; changed();
            const listItem = taskList.querySelector(`[data-task-id="${CSS.escape(task.id)}"] span`); if (listItem) listItem.textContent = mode.value;
            renderBoard();
        };
        const basics = node('div', null, 'task-editor-row');
        basics.append(field('Name', name), field('Execution type', mode));
        card.append(basics, field('Prompt', prompt));
        if (!Array.isArray(task.skillsets)) task.skillsets = [];
        card.append(fieldBlock('Skills', skillsetPicker(task.skillsets)), button('Delete task', () => {
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
        addTaskPanel.replaceChildren();
        const card = node('section', null, 'task-editor');
        card.append(node('h3', 'Add task'));
        const name = node('input'); name.maxLength = 120; name.placeholder = 'Review change';
        const prompt = node('textarea'); prompt.rows = 3; prompt.placeholder = 'Describe what this task should do.';
        const mode = node('select');
        for (const value of ['terminal', 'desktop', 'browser']) mode.add(new Option(value, value));
        const save = button('Save task', () => {
            if (!name.value.trim() || !prompt.value.trim()) { card.querySelector('.task-form-error').textContent = 'Enter a name and prompt.'; return; }
            const id = `task-${crypto.randomUUID()}`;
            graph.tasks.push({ id, name: name.value.trim(), prompt: prompt.value.trim(), skillsets: [...addSkillsets], executionType: mode.value });
            addSkillsets = [];
            graph.layout[id] = layoutFor(graph.tasks.length - 1);
            graph.entryTaskId ||= id; selected = id; changed(); addTaskPanel.replaceChildren(); render(); showPage('task');
        });
        const error = node('p', '', 'task-form-error'); error.setAttribute('role', 'alert');
        const basics = node('div', null, 'task-editor-row');
        basics.append(field('Name', name), field('Execution type', mode));
        card.append(basics, field('Prompt', prompt), fieldBlock('Skills', skillsetPicker(addSkillsets)), error, save);
        if (previousValues.length) { name.value = previousValues[0]; mode.value = previousValues[1] || 'terminal'; prompt.value = previousValues[2] || ''; }
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
    async function open(value = null, { admin = false } = {}) {
        canAdmin = admin;
        graph = value ? structuredClone(value) : blank(); delete graph.coverage; delete graph.diagnostics;
        version++; coverageRequest++; message.textContent = ''; selected = graph.entryTaskId || graph.tasks[0]?.id || null; currentPage = 'settings'; addTaskPanel.replaceChildren();
        form.elements.name.value = graph.name; form.elements.description.value = graph.description;
        for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        for (const control of document.querySelectorAll('.workflow-page-button')) control.disabled = false;
        addTaskButton.disabled = readonly();
        const createButton = document.querySelector('#workflowCreateButton');
        if (createButton) createButton.hidden = readonly();
        render(); showPage('settings');
        try { const result = await api('api/roboflow/skillsets'); catalog = result.skillsets; render(); if (result.diagnostics.length) message.textContent = result.diagnostics.map(item => item.message).join('\n'); } catch (error) { showError(error); }
    }
    document.querySelector('#workflowCancelButton').onclick = leaveEditor;
    form.elements.name.oninput = event => { graph.name = event.target.value; changed(); };
    form.elements.description.oninput = event => { graph.description = event.target.value; changed(); };
    for (const control of document.querySelectorAll('.workflow-page-button')) control.onclick = () => showPage(control.dataset.page);
    addTaskButton.onclick = () => { renderAddTask(); showPage('addTask'); addTaskPanel.querySelector('input')?.focus(); };
    document.addEventListener('keydown', event => {
        if (readonly() || currentPage !== 'graph' || !selectedEdgeId || !['Delete', 'Backspace'].includes(event.key)) return;
        if (event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
        event.preventDefault(); graph.edges = graph.edges.filter(edge => edge.id !== selectedEdgeId); selectedEdgeId = null; changed(); render();
    });
    form.onsubmit = async event => {
        event.preventDefault(); if (readonly()) return;
        if (!graph.name.trim()) { showPage('settings'); message.textContent = 'Enter a workflow name before saving.'; form.elements.name.focus(); return; }
        if (!graph.tasks.length) { renderAddTask(); showPage('addTask'); message.textContent = 'Add at least one task before saving.'; addTaskPanel.querySelector('input')?.focus(); return; }
        const invalidTask = graph.tasks.find(task => !task.name?.trim() || !task.prompt?.trim());
        if (invalidTask) {
            select(invalidTask.id);
            message.textContent = 'Enter a name and prompt for this task before saving.';
            taskPanel.querySelector(!invalidTask.name?.trim() ? 'input' : 'textarea')?.focus();
            return;
        }
        try { await api(graph.id ? `api/roboflow/workflows/${graph.id}` : 'api/roboflow/workflows', { method: graph.id ? 'PUT' : 'POST', body: graph }); leaveEditor(); }
        catch (error) { showError(error); }
    };
    return { open };
}
