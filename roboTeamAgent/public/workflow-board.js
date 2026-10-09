import { edgeRoute } from './workflow-routing.js';

const svgNS = 'http://www.w3.org/2000/svg';
export function workflowNodeRole(task, graph) {
    const start = task.id === graph.entryTaskId;
    const end = !graph.edges.some(edge => edge.sourceTaskId === task.id);
    return start ? (end ? 'start-end' : 'start') : (end ? 'end' : 'intermediate');
}

const roleIcons = {
    start: { role: 'start', label: 'Start node', path: 'M8 5l11 7-11 7Z' },
    intermediate: { role: 'intermediate', label: 'Intermediate step', path: 'M5 6l6 6-6 6 M13 6l6 6-6 6' },
    end: { role: 'end', label: 'End node', path: 'M5 21V3h14l-3 5 3 5H5' }
};

export function workflowRoleIcons(role) {
    return role === 'start-end' ? [roleIcons.start, roleIcons.end] : [roleIcons[role]];
}

function graphRoleIcons(role) {
    const group = document.createElement('span'); group.className = 'graph-role-icons';
    group.title = workflowRoleIcons(role).map(icon => icon.label).join(' / ');
    for (const definition of workflowRoleIcons(role)) {
        const icon = document.createElementNS(svgNS, 'svg');
        for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round', role: 'img', 'aria-label': definition.label, focusable: 'false',
            class: `graph-role-icon graph-role-icon-${definition.role}` })) icon.setAttribute(name, value);
        const title = document.createElementNS(svgNS, 'title'); title.textContent = definition.label;
        const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', definition.path);
        icon.append(title, path); group.append(icon);
    }
    return group;
}

export function drawBoard(container, graph, { readOnly = false, onChange = () => {}, onSelect = () => {}, onSelectEdge = () => {}, selectedEdgeId = null, states = {} } = {}) {
    container._workflowBoardCleanup?.();
    const controller = new AbortController();
    container._workflowBoardCleanup = () => controller.abort();
    container.replaceChildren();
    container.classList.add('workflow-board');
    const surface = document.createElement('div'); surface.className = 'graph-surface';
    const points = graph.tasks.map(task => graph.layout[task.id]);
    surface.style.width = `${Math.max(320, ...points.map(p => p.x + 230))}px`;
    surface.style.height = `${Math.max(220, ...points.map(p => p.y + 130))}px`;
    const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('graph-edges');
    const markerId = `arrow-${Math.random().toString(36).slice(2)}`;
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    for (const [name, value] of Object.entries({ id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })) marker.setAttribute(name, value);
    const arrow = document.createElementNS(svgNS, 'path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); arrow.setAttribute('fill', 'currentColor'); marker.append(arrow); defs.append(marker); svg.append(defs);
    const nodeElements = new Map();
    let offset = { x: 0, y: 0 };
    // End edges at the port's outer edge so the arrowhead is never covered by
    // the connection point.
    const PORT_OFFSET = 11;
    function point(taskId, side) {
        const layout = graph.layout[taskId];
        const element = nodeElements.get(taskId);
        const width = element?.offsetWidth || 190;
        const height = element?.offsetHeight || 70;
        return { x: layout.x + (side === 'right' ? width + PORT_OFFSET : -PORT_OFFSET), y: layout.y + height / 2 };
    }
    function curve(start, end) {
        const direction = end.x >= start.x ? 1 : -1;
        const bend = Math.max(45, Math.abs(end.x - start.x) / 2);
        return `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y} ${end.x - bend * direction} ${end.y} ${end.x} ${end.y}`;
    }
    function fitToContainer() {
        const width = container.clientWidth - 24;
        const height = container.clientHeight - 24;
        if (width <= 0 || height <= 0) return;
        const scale = Math.min(2.5, width / surface.offsetWidth, height / surface.offsetHeight);
        surface.dataset.scale = String(scale);
        surface.style.transform = `translate(${(container.clientWidth - surface.offsetWidth * scale) / 2}px, ${(container.clientHeight - surface.offsetHeight * scale) / 2}px) scale(${scale})`;
    }
    function resizeSurface() {
        edges();
        fitToContainer();
    }
    function edges() {
        svg.querySelectorAll('.graph-edge, .graph-edge-hit, .graph-preview').forEach(edge => edge.remove());
        const obstacles = graph.tasks.map(task => ({ ...graph.layout[task.id],
            width: nodeElements.get(task.id)?.offsetWidth || 190, height: nodeElements.get(task.id)?.offsetHeight || 70 }));
        const segments = [];
        const routes = graph.edges.map(edge => {
            const start = point(edge.sourceTaskId, edge.sourcePort || 'right');
            const end = point(edge.targetTaskId, edge.targetPort || 'left');
            const route = edgeRoute(start, end, edge.sourcePort || 'right', edge.targetPort || 'left', obstacles, segments);
            for (let i = 1; i < route.points.length; i++) segments.push([route.points[i - 1], route.points[i]]);
            return { edge, ...route };
        });
        // Include return lanes and port approaches in the fitted board bounds.
        offset = { x: 20 - Math.min(0, ...routes.map(route => route.minX)),
            y: 20 - Math.min(0, ...routes.map(route => route.minY)) };
        surface.style.width = `${offset.x + Math.max(320, ...graph.tasks.map(task => graph.layout[task.id].x + (nodeElements.get(task.id)?.offsetWidth || 190) + 30), ...routes.map(route => route.maxX + 20))}px`;
        surface.style.height = `${offset.y + Math.max(220, ...graph.tasks.map(task => graph.layout[task.id].y + (nodeElements.get(task.id)?.offsetHeight || 70) + 30), ...routes.map(route => route.maxY + 20))}px`;
        for (const [id, node] of nodeElements) {
            node.style.left = `${graph.layout[id].x + offset.x}px`;
            node.style.top = `${graph.layout[id].y + offset.y}px`;
        }
        for (const { edge, path, unroutable } of routes) {
            const line = document.createElementNS(svgNS, 'path'); line.classList.add('graph-edge');
            if (unroutable) line.setAttribute('stroke-dasharray', '6 4');
            if (edge.id === selectedEdgeId) line.classList.add('selected');
            line.setAttribute('d', path); line.setAttribute('marker-end', `url(#${markerId})`);
            const hit = document.createElementNS(svgNS, 'path'); hit.classList.add('graph-edge-hit');
            hit.setAttribute('d', path); hit.setAttribute('tabindex', readOnly ? '-1' : '0'); hit.setAttribute('role', 'button');
            hit.setAttribute('aria-label', `Connection from ${edge.sourceTaskId} to ${edge.targetTaskId}`);
            hit.addEventListener('click', () => onSelectEdge(edge.id));
            hit.addEventListener('keydown', event => { if (!readOnly && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelectEdge(edge.id); } });
            for (const element of [hit, line]) element.setAttribute('transform', `translate(${offset.x} ${offset.y})`);
            svg.append(hit, line);
        }
    }
    surface.append(svg);
    container.append(surface);
    let connecting = null;
    const localPoint = event => { const rect = surface.getBoundingClientRect(), scale = Number(surface.dataset.scale) || 1; return { x: (event.clientX - rect.left) / scale - offset.x, y: (event.clientY - rect.top) / scale - offset.y }; };
    const drawPreview = position => {
        svg.querySelector('.graph-preview')?.remove();
        if (!connecting) return;
        const start = point(connecting.taskId, connecting.side);
        const preview = document.createElementNS(svgNS, 'path'); preview.classList.add('graph-preview'); preview.setAttribute('d', curve(start, position)); preview.setAttribute('transform', `translate(${offset.x} ${offset.y})`); svg.append(preview);
    };
    const finishConnect = (event, cancelled = false) => {
        if (!connecting) return;
        const origin = connecting; connecting = null;
        svg.querySelector('.graph-preview')?.remove();
        if (cancelled) return;
        const targetPort = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.graph-port');
        const destination = targetPort && { taskId: targetPort.dataset.taskId, side: targetPort.dataset.side };
        if (destination && destination.taskId !== origin.taskId) onChange({ connect: { source: origin, target: destination } });
    };
    window.addEventListener('pointermove', event => { if (connecting) drawPreview(localPoint(event)); }, { signal: controller.signal });
    window.addEventListener('pointerup', event => finishConnect(event), { signal: controller.signal });
    window.addEventListener('pointercancel', event => finishConnect(event, true), { signal: controller.signal });
    window.addEventListener('keydown', event => { if (event.key === 'Escape' && connecting) { connecting = null; svg.querySelector('.graph-preview')?.remove(); } }, { signal: controller.signal });
    for (const task of graph.tasks) {
        const node = document.createElement('div'); node.className = 'graph-node'; node.tabIndex = 0;
        node.dataset.taskId = task.id;
        node.dataset.nodeRole = workflowNodeRole(task, graph);
        nodeElements.set(task.id, node);
        const roleLabel = workflowRoleIcons(node.dataset.nodeRole).map(icon => icon.label).join(' / ');
        node.setAttribute('aria-label', `${task.name}. ${roleLabel}. ${readOnly ? '' : 'Arrow keys move this task.'}`);
        if (task.creator) node.classList.add('graph-creator');
        if (task.kind === 'run-workflows') node.classList.add('graph-coordinator');
        if (task.id === graph.entryTaskId) node.classList.add('graph-entry');
        if (!graph.edges.some(edge => edge.sourceTaskId === task.id)) node.classList.add('graph-terminal');
        if (states[task.id]) node.classList.add(`graph-state-${states[task.id]}`);
        const label = document.createElement('strong'); label.textContent = task.name;
        const detail = document.createElement('span'); detail.className = 'graph-node-detail';
        const detailText = document.createElement('span'); detailText.className = 'graph-node-detail-text'; detailText.textContent = `${task.kind === 'run-workflows' ? 'RoboFlow coordinator' : `${task.creator ? 'Sub-flows · ' : ''}${task.executionType || 'terminal / desktop / browser'}`}${states[task.id] ? ` · ${states[task.id]}` : ''}`;
        detail.append(detailText);
        detail.title = detailText.textContent;
        if (task.allowsHumanInput && task.kind !== 'run-workflows') {
            const icon = document.createElementNS(svgNS, 'svg');
            icon.classList.add('graph-human-input');
            for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', role: 'img', 'aria-label': 'Allows human input', focusable: 'false' })) icon.setAttribute(name, value);
            const title = document.createElementNS(svgNS, 'title'); title.textContent = 'Allows human input';
            const person = document.createElementNS(svgNS, 'path');
            person.setAttribute('d', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0v1H5Z');
            icon.append(title, person);
            detail.append(icon);
        }
        node.append(graphRoleIcons(node.dataset.nodeRole), label, detail);
        const place = () => { node.style.left = `${graph.layout[task.id].x + offset.x}px`; node.style.top = `${graph.layout[task.id].y + offset.y}px`; };
        place();
        node.addEventListener('click', () => onSelect(task.id));
        if (!readOnly) {
            for (const side of ['left', 'right']) {
                const port = document.createElement('button'); port.type = 'button'; port.className = `graph-port graph-port-${side}`; port.textContent = '●'; port.title = 'Drag to another connection point'; port.dataset.taskId = task.id; port.dataset.side = side;
                port.setAttribute('aria-label', `${side} connection point for ${task.name}`);
                port.addEventListener('pointerdown', event => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation(); connecting = { taskId: task.id, side, pointerId: event.pointerId }; drawPreview(localPoint(event));
                });
                node.append(port);
            }
            node.addEventListener('pointerdown', event => {
                if (event.target.closest?.('.graph-port') || event.button !== 0) return;
                const start = { x: event.clientX, y: event.clientY, ...graph.layout[task.id] };
                const clientX = event.clientX, clientY = event.clientY;
                const scale = Number(surface.dataset.scale) || 1;
                node.setPointerCapture(event.pointerId);
                const move = next => {
                    graph.layout[task.id] = { x: Math.max(0, start.x + (next.clientX - clientX) / scale), y: Math.max(0, start.y + (next.clientY - clientY) / scale) };
                    place(); edges();
                };
                const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); resizeSurface(); onChange({ moved: task.id }); };
                node.addEventListener('pointermove', move); node.addEventListener('pointerup', up, { once: true });
            });
            node.addEventListener('keydown', event => {
                const deltas = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
                if (!deltas[event.key] || event.target !== node) return;
                event.preventDefault(); const [dx, dy] = deltas[event.key];
                graph.layout[task.id].x = Math.max(0, graph.layout[task.id].x + dx); graph.layout[task.id].y = Math.max(0, graph.layout[task.id].y + dy); place(); resizeSurface(); onChange({ moved: task.id });
            });
        }
        surface.append(node);
    }
    edges();
    fitToContainer();
    const resizeObserver = new ResizeObserver(fitToContainer);
    resizeObserver.observe(container);
    controller.signal.addEventListener('abort', () => resizeObserver.disconnect(), { once: true });
}
