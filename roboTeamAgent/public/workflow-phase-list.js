import { taskSidebarPresentation } from './workflow-editor.js';
import { executionStatePresentation, executionStateIcon } from './workflow-execution-state.js';

const terminalStates = new Set(['completed', 'failed', 'paused', 'terminated']);

export function phasePauseControl(instance, flow) {
    if (!instance || ['completed', 'failed', 'terminated'].includes(flow?.status)) return null;
    if (instance.state === 'paused') {
        const blocked = flow?.humanInput?.status === 'pending';
        return { action: 'resume', label: 'Resume', disabled: blocked,
            title: blocked ? 'Answer the pending question in Observability before resuming' : 'Resume the workflow from its paused phases' };
    }
    if (terminalStates.has(instance.state) || instance.state === 'pending') return null;
    return { action: 'pause', label: 'Pause', disabled: instance.state === 'pausing', title: 'Pause the workflow at this phase' };
}

export function phaseListPresentation(task, graph, instance) {
    const presentation = taskSidebarPresentation({ ...task, executionType: instance?.executionType || task.executionType }, graph);
    return { ...presentation, number: graph.tasks.findIndex(candidate => candidate.id === task.id) + 1,
        state: instance?.state || 'pending', stateLabel: executionStatePresentation(instance?.state || 'pending').label,
        canPause: Boolean(instance && !terminalStates.has(instance.state)) };
}

export function createPhaseListItem({ task, graph, instance = null, flow = null, controlsPending = false, selected = false, repeated = false,
    elapsed = '', onSelect, onPause, onResume, ownerDocument = document }) {
    const presentation = phaseListPresentation(task, graph, instance);
    const node = (tag, className, text = '') => {
        const element = ownerDocument.createElement(tag);
        element.className = className; element.textContent = text;
        return element;
    };
    const item = node('li', 'phase-list-row');
    const card = node('div', `phase-card${instance ? '' : ' is-pending'}${selected ? ' is-selected' : ''}`);
    card.dataset.state = presentation.state; card.dataset.executionState = presentation.state; card.dataset.nodeRole = presentation.role;
    const select = node('button', 'phase-select'); select.type = 'button';
    select.dataset.phaseKey = instance ? `instance:${instance.id}` : `task:${task.id}`;
    select.dataset.taskId = task.id;
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `${presentation.number}. ${task.name} · ${presentation.roleLabel} · ${presentation.icons.map(icon => icon.label).join(' · ')} · ${presentation.stateLabel}${repeated ? ` · Visit ${instance.sequence + 1}` : ''}${instance && task.kind !== 'run-workflows' ? ` · Robot: ${instance.robotName || 'Awaiting robot'}` : ''}`);
    select.onclick = onSelect;
    const number = node('span', 'phase-card-number', String(presentation.number)); number.setAttribute('aria-hidden', 'true');
    const icons = node('span', 'phase-card-status-icon');
    icons.title = presentation.stateLabel; icons.setAttribute('aria-hidden', 'true');
    icons.append(executionStateIcon(presentation.state, ownerDocument));
    const name = node('strong', 'phase-card-name', task.name);
    name.title = task.name;
    const meta = node('span', 'phase-card-meta');
    if (instance && task.kind !== 'run-workflows') {
        const robot = node('span', 'phase-card-robot');
        robot.title = `Robot: ${instance.robotName || 'Awaiting robot'}`;
        const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
        const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 3v3 M10 3h4 M7 6h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z M2 10v6 M22 10v6 M9 10v2 M15 10v2 M9 16h6');
        svg.append(path);
        robot.append(svg, node('span', 'phase-card-robot-name', instance.robotName || 'Awaiting robot'));
        meta.append(robot);
    }
    if (repeated) meta.append(node('span', 'phase-card-visit', `Visit ${instance.sequence + 1}`));
    select.append(number, icons, name, meta); card.append(select);
    if (elapsed) select.append(node('span', 'phase-card-duration', elapsed));
    const control = phasePauseControl(instance, flow);
    if (control) {
        const pause = node('button', 'phase-pause phase-list-pause', control.label); pause.type = 'button';
        pause.dataset.phaseKey = `control:${instance.id}`;
        pause.dataset.taskId = task.id;
        pause.title = control.title;
        pause.disabled = controlsPending || control.disabled;
        pause.setAttribute('aria-label', `${control.label} workflow · ${task.name}`);
        pause.onclick = control.action === 'resume' ? onResume : onPause;
        card.append(pause);
    }
    item.append(card);
    return item;
}
