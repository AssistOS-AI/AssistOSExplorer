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
    let graph, catalog = [], canAdmin = false, selected = null, selectedEdgeId = null, currentPage = 'settings', version = 0, coverageRequest = 0;
    let warningTaskIds = new Set();
    let draggedTaskId = null;
    const blank = () => ({ name: '', description: '', entryTaskId: '', tasks: [], edges: [], layout: {} });
    const readonly = () => !canAdmin || graph?.readOnly === true || graph?.kind === 'default';
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
            warningTaskIds = new Set(result.coverage.tasks.filter(task => !task.matchingRobotIds.length).map(task => task.taskId));
            for (const item of taskList.querySelectorAll('[data-task-id]')) {
                item.classList.toggle('coverage-warning', warningTaskIds.has(item.dataset.taskId));
            }
        } catch (error) { if (request === coverageRequest) showError(error); }
    }
    function syncCoordinator() {
        const creators = graph.tasks.filter(task => task.creator);
        const id = 'run-workflows';
        if (creators.length && !graph.tasks.some(task => task.id === id)) {
            graph.tasks.push({ id, name: 'Run workflows', kind: 'run-workflows', skillsets: [] });
            graph.layout[id] = layoutFor(graph.tasks.length - 1);
        }
        if (!creators.length) {
            graph.tasks = graph.tasks.filter(task => task.id !== id);
            delete graph.layout[id];
        }
        graph.edges = graph.edges.filter(edge => edge.targetTaskId !== id || creators.some(task => task.id === edge.sourceTaskId));
        if (!creators.length) graph.edges = graph.edges.filter(edge => edge.sourceTaskId !== id);
    }
    function connect({ source, target }) {
        if (source.taskId === target.taskId) return;
        if (target.taskId === 'run-workflows' && !graph.tasks.find(task => task.id === source.taskId)?.creator) {
            showError(new Error('Only a task that allows sub-flows can connect to Run workflows.')); return;
        }
        graph.edges.push({ id: `edge-${crypto.randomUUID()}`, sourceTaskId: source.taskId, targetTaskId: target.taskId, sourcePort: source.side, targetPort: target.side }); changed(); render();
    }
    function renderBoard() { drawBoard(board, graph, { readOnly: readonly(), onSelect: id => { selected = id; renderList(); renderTaskEditor(); }, selectedEdgeId, onSelectEdge: id => { selectedEdgeId = id; renderBoard(); }, onChange: event => { if (event.connect) connect(event.connect); else changed(); } }); }
    function field(label, element) { const wrapper = node('label', null, 'field'); wrapper.append(node('span', label), element); return wrapper; }
    function fieldBlock(label, element) { const wrapper = node('div', null, 'field'); wrapper.append(node('span', label), element); return wrapper; }
    let openSkillDialog = null;
    function closeSkillDialog() {
        if (!openSkillDialog) return;
        const { dialog, trigger, previousOverflow } = openSkillDialog;
        openSkillDialog = null;
        trigger?.setAttribute('aria-expanded', 'false');
        document.documentElement.style.overflow = previousOverflow || '';
        try { dialog.close(); } catch { /* Already closed. */ }
        dialog.remove();
    }
    function skillsetPicker(selectedIds) {
        closeSkillDialog();
        const wrapper = node('div', null, 'skillset-picker');
        const pills = node('div', null, 'skillset-pills');
        const trigger = node('button', null, 'skillset-trigger');
        trigger.type = 'button';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.append(node('span', '+', 'skillset-trigger-icon'), node('span', 'Add skill or skillset'), node('span', '▾', 'skillset-trigger-caret'));
        const dialog = document.createElement('dialog');
        dialog.className = 'skillset-dialog';
        dialog.setAttribute('aria-label', 'Add skill or skillset');
        const header = node('div', null, 'skillset-dialog-header');
        header.append(node('h3', 'Add skill or skillset', 'skillset-dialog-title'), button('Close', () => closeSkillDialog()));
        const search = node('input'); search.type = 'search'; search.className = 'skillset-search';
        search.placeholder = 'Search skills and skillsets'; search.setAttribute('aria-label', 'Search skills and skillsets');
        const list = node('div', null, 'skillset-list');
        const count = node('span', '', 'skillset-count');
        const footer = node('div', null, 'skillset-dialog-footer');
        footer.append(count, button('Done', () => closeSkillDialog()));
        dialog.append(header, search, list, footer);
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
        function open() {
            closeSkillDialog();
            document.body.append(dialog);
            const previousOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = 'hidden';
            openSkillDialog = { dialog, trigger, previousOverflow };
            trigger.setAttribute('aria-expanded', 'true');
            dialog.showModal();
            renderOptions();
            search.focus();
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
                    || repository.toLowerCase().includes(term));
                if (!matches.length) continue;
                const group = node('div', null, 'skillset-group');
                const header = node('button', null, 'skillset-group-header');
                header.type = 'button';
                const arrow = node('span', '▸', 'skillset-group-arrow');
                header.append(arrow, node('span', repository, 'skillset-group-name'), node('span', String(matches.length), 'skillset-group-count'));
                const grid = node('div', null, 'skillset-group-grid');
                const setOpen = (openGroup) => {
                    grid.style.display = openGroup ? 'grid' : 'none';
                    arrow.textContent = openGroup ? '▾' : '▸';
                    header.setAttribute('aria-expanded', String(openGroup));
                };
                setOpen(Boolean(term));
                header.onclick = () => setOpen(grid.style.display === 'none');
                for (const set of matches) {
                    const chosen = selectedIds.includes(set.id);
                    const item = node('button', null, 'skillset-pick-item');
                    item.type = 'button';
                    item.setAttribute('aria-pressed', String(chosen));
                    if (chosen) item.classList.add('selected');
                    const nameRow = node('span', null, 'skillset-pick-name-row');
                    nameRow.append(node('span', set.name, 'skillset-pick-name'));
                    if (set.kind) nameRow.append(node('span', set.kind, 'skillset-pick-kind'));
                    item.append(node('span', chosen ? '✓' : '', 'skillset-pick-check'), nameRow);
                    item.onclick = () => { if (chosen) selectedIds.splice(selectedIds.indexOf(set.id), 1); else selectedIds.push(set.id); renderPills(); renderOptions(); apply(); };
                    grid.append(item);
                }
                group.append(header, grid);
                list.append(group);
                visible += matches.length;
            }
            if (!visible) list.append(node('p', 'No matching skills or skillsets.', 'skillset-empty'));
            count.textContent = selectedIds.length ? `${selectedIds.length} selected` : 'None selected';
        }
        trigger.onclick = () => { if (openSkillDialog?.dialog === dialog) closeSkillDialog(); else open(); };
        dialog.addEventListener('cancel', event => { event.preventDefault(); closeSkillDialog(); });
        dialog.addEventListener('click', event => { if (event.target === dialog) closeSkillDialog(); });
        renderPills();
        wrapper.append(pills, trigger);
        return wrapper;
    }
    function clearDropMarkers() {
        for (const row of taskList.children) row.classList.remove('drop-before', 'drop-after');
    }
    function moveTask(sourceId, targetId, after) {
        if (readonly() || sourceId === targetId) return;
        const source = graph.tasks.findIndex(task => task.id === sourceId);
        if (source < 0 || !graph.tasks.some(task => task.id === targetId)) return;
        const [task] = graph.tasks.splice(source, 1);
        const target = graph.tasks.findIndex(task => task.id === targetId);
        graph.tasks.splice(target + (after ? 1 : 0), 0, task);
        changed();
        renderList();
        taskList.querySelector(`[data-task-id="${sourceId}"]`)?.focus();
    }
    function renderList() {
        taskList.replaceChildren();
        for (const task of graph.tasks) {
            const row = node('li', null, 'task-list-row');
            const item = node('button', null, 'task-list-item');
            item.type = 'button';
            item.dataset.taskId = task.id;
            if (!readonly()) {
                const grip = node('span', null, 'task-drag-grip');
                grip.setAttribute('aria-hidden', 'true');
                for (let dot = 0; dot < 6; dot++) grip.append(node('i'));
                item.append(grip);
            }
            if (task.id === selected) item.classList.add('selected');
            if (warningTaskIds.has(task.id)) item.classList.add('coverage-warning');
            item.append(node('strong', task.name || 'Untitled task'), node('span', task.kind === 'run-workflows' ? 'RoboFlow coordinator' : `${task.creator ? 'Sub-flows · ' : ''}${task.executionType || 'terminal / desktop / browser'}`));
            item.onclick = () => select(task.id);
            item.draggable = !readonly();
            if (!readonly()) item.title = 'Drag to reorder, or use Alt + Arrow Up / Arrow Down';
            item.ondragstart = event => {
                if (readonly()) { event.preventDefault(); return; }
                draggedTaskId = task.id;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', task.id);
                item.classList.add('is-dragging');
            };
            item.ondragend = () => {
                draggedTaskId = null;
                item.classList.remove('is-dragging');
                clearDropMarkers();
            };
            row.ondragover = event => {
                if (readonly() || !draggedTaskId || draggedTaskId === task.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                clearDropMarkers();
                const rect = row.getBoundingClientRect();
                row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
            };
            row.ondragleave = event => {
                if (!row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
            };
            row.ondrop = event => {
                if (readonly() || !draggedTaskId) return;
                event.preventDefault();
                const rect = row.getBoundingClientRect();
                const sourceId = draggedTaskId;
                draggedTaskId = null;
                clearDropMarkers();
                moveTask(sourceId, task.id, event.clientY > rect.top + rect.height / 2);
            };
            item.onkeydown = event => {
                if (readonly() || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const after = event.key === 'ArrowDown';
                const target = graph.tasks[graph.tasks.indexOf(task) + (after ? 1 : -1)];
                if (target) moveTask(task.id, target.id, after);
            };
            row.append(item);
            taskList.append(row);
        }
        if (!graph.tasks.length) taskList.append(node('li', 'No tasks yet. Use + to add one.', 'task-list-empty'));
    }
    function renderTaskEditor() {
        closeSkillDialog();
        taskPanel.replaceChildren();
        const task = graph.tasks.find(item => item.id === selected);
        if (!task) {
            if (graph.tasks.length) taskPanel.append(node('p', 'Select a task to edit it.', 'hint'));
            return;
        }
        const card = node('section', null, 'task-editor'); card.dataset.taskId = task.id;
        card.append(node('h3', task.kind === 'run-workflows' ? 'Run workflows' : 'Edit task'));
        if (task.kind === 'run-workflows') {
            card.append(node('p', 'RoboFlow runs the workflows chosen by a task that allows sub-flows in parallel. After all children complete or fail, it follows that task’s selected outgoing edge. A paused child waits for Resume.'));
            card.append(node('p', 'Connect tasks that allow sub-flows to this node and draw its outgoing continuation edges in the graph.'));
            taskPanel.append(card); return;
        }
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
        const isEntry = graph.entryTaskId === task.id;
        const checkbox = (text, checked) => {
            const input = node('input'); input.type = 'checkbox'; input.checked = checked;
            const label = node('label', null, 'task-option');
            label.append(input, document.createTextNode(text));
            return { input, label };
        };
        const entry = checkbox('Start node', isEntry);
        entry.input.onchange = () => {
            // A graph always has one entry; selecting another task replaces it.
            entry.input.checked = true;
            if (graph.entryTaskId === task.id) return;
            graph.entryTaskId = task.id; changed(); renderBoard(); renderList();
        };
        const creator = checkbox('Allow sub-flows', Boolean(task.creator));
        creator.input.onchange = () => {
            if (task.creator && graph.tasks.filter(item => item.creator).length === 1
                && graph.edges.some(edge => edge.sourceTaskId === 'run-workflows' || edge.targetTaskId === 'run-workflows')
                && !confirm('Disallow sub-flows on the last task that allows them? Run workflows and its connections will be removed.')) {
                creator.input.checked = true;
                return;
            }
            task.creator = creator.input.checked;
            syncCoordinator();
            if (task.creator && !graph.edges.some(edge => edge.sourceTaskId === task.id && edge.targetTaskId === 'run-workflows')) {
                graph.edges.push({ id: `edge-${crypto.randomUUID()}`, sourceTaskId: task.id, targetTaskId: 'run-workflows', sourcePort: 'right', targetPort: 'left' });
            }
            changed(); renderList(); renderBoard(); renderTaskEditor();
        };
        const humanInput = checkbox('Allows human input', task.allowsHumanInput === true);
        humanInput.input.onchange = () => { task.allowsHumanInput = humanInput.input.checked; changed(); };
        humanInput.label.title = 'Pause for a business decision missing from the prompt and context.';
        const options = node('div', null, 'task-options');
        options.append(entry.label, creator.label, humanInput.label);
        card.append(basics, options, field('Prompt', prompt));
        if (task.creator) {
            const skill = node('details');
            skill.append(node('summary', 'workflow-creator · Required · View only'));
            const content = node('pre', 'Open to read the skill.'); content.style.whiteSpace = 'pre-wrap'; skill.append(content);
            let loaded = false;
            skill.ontoggle = async () => {
                if (!skill.open || loaded) return;
                try { const result = await api('api/roboflow/creator-skill'); content.textContent = result.content; loaded = true; }
                catch (error) { content.textContent = error.message; }
            };
            card.append(skill);
        }
        if (!Array.isArray(task.skillsets)) task.skillsets = [];
        const deleteTask = button('Delete task', () => {
            if (task.creator && graph.tasks.filter(item => item.creator).length === 1
                && !confirm('Delete the last task that allows sub-flows and remove Run workflows with its connections?')) return;
            graph.tasks = graph.tasks.filter(item => item.id !== task.id);
            graph.edges = graph.edges.filter(edge => edge.sourceTaskId !== task.id && edge.targetTaskId !== task.id);
            delete graph.layout[task.id];
            syncCoordinator();
            if (graph.entryTaskId === task.id) graph.entryTaskId = graph.tasks[0]?.id || '';
            if (selected === task.id) selected = graph.tasks[0]?.id || null;
            changed(); render(); showPage(graph.tasks.length ? 'graph' : 'settings');
        });
        deleteTask.classList.add('task-delete');
        card.append(fieldBlock('Skills', skillsetPicker(task.skillsets)), deleteTask);
        for (const control of card.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        taskPanel.append(card);
    }
    function addTask() {
        if (readonly()) return;
        const id = `task-${crypto.randomUUID()}`;
        graph.tasks.unshift({ id, name: 'New Task', prompt: '', skillsets: [], executionType: 'terminal' });
        graph.layout[id] = layoutFor(Math.max(0, graph.tasks.length - 1));
        graph.entryTaskId ||= id;
        selected = id;
        changed();
        render();
        showPage('task');
        taskPanel.querySelector('input')?.focus();
    }
    function render() {
        if (!graph.tasks.some(task => task.id === selected)) selected = graph.entryTaskId || graph.tasks[0]?.id || null;
        if (!graph.edges.some(edge => edge.id === selectedEdgeId)) selectedEdgeId = null;
        renderList();
        renderTaskEditor();
        renderBoard();
        void checkCoverage();
    }
    async function open(value = null, { admin = false } = {}) {
        canAdmin = admin;
        warningTaskIds = new Set((value?.coverage?.tasks || []).filter(task => !task.matchingRobotIds.length).map(task => task.taskId));
        graph = value ? structuredClone(value) : blank(); delete graph.coverage; delete graph.diagnostics;
        version++; coverageRequest++; message.textContent = ''; selected = graph.entryTaskId || graph.tasks[0]?.id || null; currentPage = 'settings';
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
    addTaskButton.onclick = () => addTask();
    document.addEventListener('keydown', event => {
        if (readonly() || currentPage !== 'graph' || !selectedEdgeId || !['Delete', 'Backspace'].includes(event.key)) return;
        if (event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
        event.preventDefault(); graph.edges = graph.edges.filter(edge => edge.id !== selectedEdgeId); selectedEdgeId = null; changed(); render();
    });
    form.onsubmit = async event => {
        event.preventDefault(); if (readonly()) return;
        if (!graph.name.trim()) { showPage('settings'); message.textContent = 'Enter a workflow name before saving.'; form.elements.name.focus(); return; }
        if (!graph.tasks.length) { message.textContent = 'Add at least one task before saving.'; addTaskButton.focus(); return; }
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
