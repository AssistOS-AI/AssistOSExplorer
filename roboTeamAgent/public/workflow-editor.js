import { drawBoard, workflowNodeRole } from './workflow-board.js';
import { reviseGraph } from './workflow-generator.js';
import { createDescriptionRevision } from './workflow-description-revision.js';
const warningText = 'No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly';
const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node('button', text, 'button'); element.type = 'button'; element.onclick = action; return element; };

const taskIcons = {
    browser: { label: 'Browser', path: 'M3 4h18v16H3z M3 8h18 M6 6h.01 M9 6h.01' },
    terminal: { label: 'Terminal', path: 'M3 4h18v16H3z M7 9l3 3-3 3 M13 15h4' },
    desktop: { label: 'Desktop', path: 'M3 3h18v13H3z M12 16v5 M7 21h10' },
    automatic: { label: 'Automatic execution: terminal, desktop or browser', path: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z' },
    coordinator: { label: 'RoboFlow coordinator', path: 'M8 3h8v5H8z M3 16h6v5H3z M15 16h6v5h-6z M12 8v4 M6 16v-4h12v4' },
    creator: { label: 'Allows sub-flows', path: 'M6 3v18 M6 8h7a5 5 0 0 1 5 5v5 M15 15l3 3 3-3' }
};

export function taskSidebarPresentation(task, graph) {
    const role = workflowNodeRole(task, graph);
    const roleLabel = { start: 'Start node', end: 'End node', intermediate: 'Intermediate node', 'start-end': 'Start / End node' }[role];
    const mode = task.kind === 'run-workflows' ? 'coordinator' : (['browser', 'terminal', 'desktop'].includes(task.executionType) ? task.executionType : 'automatic');
    const icons = [taskIcons[mode]];
    if (task.creator && task.kind !== 'run-workflows') icons.push(taskIcons.creator);
    return { role, roleLabel, icons };
}

function taskIcon({ label, path }, className = 'task-type-icon') {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', role: 'img', 'aria-label': label, focusable: 'false', class: className })) icon.setAttribute(name, value);
    const title = document.createElementNS(icon.namespaceURI, 'title'); title.textContent = label;
    const shape = document.createElementNS(icon.namespaceURI, 'path'); shape.setAttribute('d', path);
    icon.append(title, shape);
    return icon;
}

function appUrl(relative = '') {
    const basePath = globalThis.ROBOTEAM_CONFIG?.publicBasePath || './';
    return new URL(relative.replace(/^\/+/, ''), new URL(basePath, location.origin)).toString();
}

function leaveEditor() {
    location.assign(appUrl(''));
}

export function createWorkflowEditor({ api, onClose = leaveEditor }) {
    const form = document.querySelector('#workflowForm');
    const taskList = document.querySelector('#taskList');
    const taskPanel = document.querySelector('#taskEditorPanel');
    const board = document.querySelector('#workflowBoard');
    const message = document.querySelector('#workflowMessage');
    const addTaskButton = document.querySelector('#addTaskButton');
    const nameControl = form.elements.name;
    const taskPage = document.querySelector('#taskPage');
    const workflowContent = document.querySelector('#workflowContent');
    const review = document.querySelector('#descriptionReview');
    const reviewText = document.querySelector('#descriptionReviewText');
    const reviewRetry = document.querySelector('#descriptionReviewRetry');
    let graph, catalog = [], canAdmin = false, selected = null, selectedEdgeId = null, version = 0, coverageRequest = 0, nameBeforeEditing = '';
    let warningTaskIds = new Set();
    let draggedTaskId = null;
    const blank = () => ({ name: '', description: '', entryTaskId: '', tasks: [], edges: [], layout: {} });
    const readonly = () => !canAdmin || graph?.readOnly === true || graph?.kind === 'default';
    const changed = () => { version++; };
    const descriptionRevision = createDescriptionRevision({
        getGraph: () => graph,
        generate: (snapshot, previous, description, options) => reviseGraph(snapshot, previous, description, { ...options, request: api }),
        apply: revised => {
            for (const key of ['tasks', 'edges', 'entryTaskId', 'layout', 'defaultObjective']) graph[key] = structuredClone(revised[key]);
            selectedEdgeId = null;
            changed(); render();
        },
        onState: (state, reason = '') => {
            review.hidden = state === 'idle';
            review.dataset.state = state;
            reviewRetry.hidden = state !== 'failed';
            reviewText.textContent = ({ edited: 'Description changed — leave the field to check the workflow.',
                checking: 'Checking requirements and updating the graph if needed…',
                regenerated: 'Graph updated. Review the changes, then Save workflow.',
                unchanged: 'No workflow change needed. The graph is unchanged.' }[state] || reason);
            if (['regenerated', 'unchanged'].includes(state) && reason) reviewText.textContent += ` ${reason}`;
            form.setAttribute('aria-busy', String(state === 'checking'));
        }
    });
    reviewRetry.onclick = () => { if (!readonly()) void descriptionRevision.check(); };
    function showError(error) { message.textContent = error.message; }
    function showTaskEditor(show) {
        taskPage.hidden = !show;
        workflowContent.classList.toggle('has-task-details', show);
    }
    function select(id) {
        const hadSelectedEdge = Boolean(selectedEdgeId);
        selected = id; selectedEdgeId = null;
        renderList(); renderTaskEditor(); showTaskEditor(true);
        if (hadSelectedEdge) renderBoard();
    }
    function updateWorkflowName(value) {
        graph.name = value.slice(0, 120);
        nameControl.value = graph.name;
        nameControl.removeAttribute('aria-invalid');
        nameControl.style.setProperty('--field-length', `${Math.max(18, graph.name.length + 2)}ch`);
        changed();
    }
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
                const warning = warningTaskIds.has(item.dataset.taskId);
                item.classList.toggle('coverage-warning', warning);
                if (warning) item.setAttribute('aria-describedby', item.querySelector('.task-coverage-icon').id);
                else item.removeAttribute('aria-describedby');
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
    function renderBoard() { drawBoard(board, graph, { readOnly: readonly(), onSelect: select, selectedEdgeId, onSelectEdge: id => { selectedEdgeId = id; renderBoard(); }, onChange: event => { if (event.connect) connect(event.connect); else changed(); } }); }
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
        for (const [index, task] of graph.tasks.entries()) {
            const row = node('li', null, 'task-list-row');
            const item = node('button', null, 'task-list-item');
            item.type = 'button';
            item.dataset.taskId = task.id;
            const presentation = taskSidebarPresentation(task, graph);
            item.dataset.nodeRole = presentation.role;
            const order = node('span', String(index + 1), 'task-order');
            order.setAttribute('aria-hidden', 'true');
            const icons = node('span', null, 'task-type-icons');
            icons.append(...presentation.icons.map(icon => taskIcon(icon)));
            const warning = taskIcon({ label: warningText, path: 'M12 3L2 21h20z M12 9v5 M12 17h.01' }, 'task-coverage-icon');
            warning.id = `task-sidebar-warning-${task.id}`;
            if (task.id === selected) item.classList.add('selected');
            item.setAttribute('aria-pressed', String(task.id === selected));
            if (warningTaskIds.has(task.id)) { item.classList.add('coverage-warning'); item.setAttribute('aria-describedby', warning.id); }
            const name = task.name || 'Untitled task';
            const description = `${index + 1}. ${name} · ${presentation.roleLabel} · ${presentation.icons.map(icon => icon.label).join(' · ')}`;
            item.setAttribute('aria-label', description);
            item.append(order, icons, node('strong', name), warning);
            item.onclick = () => select(task.id);
            item.draggable = !readonly();
            item.title = `${description}${readonly() ? '' : ' · Drag to reorder, or use Alt + Arrow Up / Arrow Down'}`;
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
            renderList();
            renderBoard();
        };
        const prompt = node('textarea'); prompt.value = task.prompt || '';
        prompt.oninput = () => { task.prompt = prompt.value; changed(); };
        const mode = node('select');
        for (const value of task.supportedExecutionTypes ? ['terminal / desktop / browser'] : ['terminal', 'desktop', 'browser']) mode.add(new Option(value, value));
        mode.value = task.executionType || 'terminal / desktop / browser';
        mode.onchange = () => {
            task.executionType = mode.value; changed();
            renderList();
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
            changed(); showTaskEditor(false); render();
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
        showTaskEditor(true);
        taskPanel.querySelector('input')?.focus();
    }
    function render() {
        if (!graph.tasks.some(task => task.id === selected)) selected = graph.entryTaskId || graph.tasks[0]?.id || null;
        if (!graph.edges.some(edge => edge.id === selectedEdgeId)) selectedEdgeId = null;
        if (!selected) showTaskEditor(false);
        renderList();
        renderTaskEditor();
        renderBoard();
        void checkCoverage();
    }
    async function open(value = null, { admin = false } = {}) {
        canAdmin = admin;
        warningTaskIds = new Set((value?.coverage?.tasks || []).filter(task => !task.matchingRobotIds.length).map(task => task.taskId));
        graph = value ? structuredClone(value) : blank(); delete graph.coverage; delete graph.diagnostics;
        version++; coverageRequest++; message.textContent = ''; selected = graph.entryTaskId || graph.tasks[0]?.id || null;
        updateWorkflowName(graph.name || ''); nameBeforeEditing = graph.name;
        form.elements.description.value = graph.description;
        descriptionRevision.reset(graph.description);
        document.querySelector('#descriptionReviewHint').hidden = readonly();
        for (const control of form.querySelectorAll('input,textarea,select,button')) control.disabled = readonly();
        nameControl.disabled = readonly();
        nameControl.title = readonly() ? 'Workflow name · Read only' : 'Rename workflow · Enter to finish · Escape to cancel';
        document.querySelector('#workflowCancelButton').disabled = false;
        document.querySelector('#closeTaskEditor').disabled = false;
        addTaskButton.disabled = readonly();
        const createButton = document.querySelector('#workflowCreateButton');
        if (createButton) createButton.hidden = readonly();
        showTaskEditor(false); render();
        try { const result = await api('api/roboflow/skillsets'); catalog = result.skillsets; render(); if (result.diagnostics.length) message.textContent = result.diagnostics.map(item => item.message).join('\n'); } catch (error) { showError(error); }
    }
    document.querySelector('#workflowCancelButton').onclick = async () => { await descriptionRevision.dispose(); onClose(); };
    window.addEventListener('pagehide', () => descriptionRevision.dispose());
    nameControl.addEventListener('focusin', () => { nameBeforeEditing = graph.name; });
    nameControl.addEventListener('input', event => { if (!readonly()) updateWorkflowName(event.target.value); });
    nameControl.addEventListener('focusout', () => { if (!readonly()) updateWorkflowName(nameControl.value.trim()); });
    nameControl.addEventListener('keydown', event => {
        if (readonly() || !['Enter', 'Escape'].includes(event.key) || event.isComposing) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') updateWorkflowName(nameBeforeEditing);
        nameControl.blur();
    });
    form.elements.description.oninput = event => {
        if (readonly()) return;
        graph.description = event.target.value; changed(); descriptionRevision.edited();
    };
    form.elements.description.addEventListener('focusout', () => { if (!readonly()) void descriptionRevision.check(); });
    document.querySelector('#closeTaskEditor').onclick = () => { showTaskEditor(false); taskList.querySelector(`[data-task-id="${CSS.escape(selected)}"]`)?.focus(); };
    addTaskButton.onclick = () => addTask();
    const help = document.querySelector('.workflow-help');
    help.addEventListener('keydown', event => { if (event.key === 'Escape' && help.open) { event.preventDefault(); event.stopPropagation(); help.open = false; help.querySelector('summary').focus(); } });
    document.addEventListener('keydown', event => {
        if (readonly() || !selectedEdgeId || !['Delete', 'Backspace'].includes(event.key)) return;
        if (event.target instanceof Element && event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
        event.preventDefault(); graph.edges = graph.edges.filter(edge => edge.id !== selectedEdgeId); selectedEdgeId = null; changed(); render();
    });
    let saving = false;
    form.onsubmit = async event => {
        event.preventDefault(); if (readonly()) return;
        if (saving) return;
        if (!graph.name.trim()) { message.textContent = 'Enter a workflow name before saving.'; nameControl.setAttribute('aria-invalid', 'true'); nameControl.focus(); return; }
        if (!graph.tasks.length) { message.textContent = 'Add at least one task before saving.'; addTaskButton.focus(); return; }
        const invalidTask = graph.tasks.find(task => !task.name?.trim() || !task.prompt?.trim());
        if (invalidTask) {
            select(invalidTask.id);
            message.textContent = 'Enter a name and prompt for this task before saving.';
            taskPanel.querySelector(!invalidTask.name?.trim() ? 'input' : 'textarea')?.focus();
            return;
        }
        saving = true;
        try {
            const beforeReview = JSON.stringify({ tasks: graph.tasks, edges: graph.edges, entryTaskId: graph.entryTaskId, layout: graph.layout });
            if (!await descriptionRevision.check()) return;
            if (beforeReview !== JSON.stringify({ tasks: graph.tasks, edges: graph.edges, entryTaskId: graph.entryTaskId, layout: graph.layout })) {
                reviewText.textContent = 'Graph updated. Review the changes, then choose Save workflow again.';
                return;
            }
            await api(graph.id ? `api/roboflow/workflows/${graph.id}` : 'api/roboflow/workflows', { method: graph.id ? 'PUT' : 'POST', body: graph });
            descriptionRevision.dispose(); onClose();
        } catch (error) { showError(error); }
        finally { saving = false; }
    };
    return { open };
}
