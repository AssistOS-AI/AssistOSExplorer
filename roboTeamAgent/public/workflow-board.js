const svgNS = 'http://www.w3.org/2000/svg';
export function drawBoard(container, graph, { readOnly = false, onChange = () => {}, onSelect = () => {}, onSetEntry = () => {}, onSelectEdge = () => {}, selectedEdgeId = null, states = {} } = {}) {
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
    function point(taskId, side) {
        const layout = graph.layout[taskId];
        const element = nodeElements.get(taskId);
        return { x: layout.x + (side === 'right' ? (element?.offsetWidth || 190) : 0), y: layout.y + (element?.offsetHeight || 70) / 2 };
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
        const positions = graph.tasks.map(task => graph.layout[task.id]);
        surface.style.width = `${Math.max(320, ...positions.map(point => point.x + 230))}px`;
        surface.style.height = `${Math.max(220, ...positions.map(point => point.y + 130))}px`;
        fitToContainer();
        edges();
    }
    function edges() {
        svg.querySelectorAll('.graph-edge, .graph-edge-hit, .graph-preview').forEach(edge => edge.remove());
        for (const edge of graph.edges) {
            const start = point(edge.sourceTaskId, edge.sourcePort || 'right');
            const end = point(edge.targetTaskId, edge.targetPort || 'left');
            const path = curve(start, end);
            const line = document.createElementNS(svgNS, 'path'); line.classList.add('graph-edge');
            if (edge.id === selectedEdgeId) line.classList.add('selected');
            line.setAttribute('d', path); line.setAttribute('marker-end', `url(#${markerId})`);
            const hit = document.createElementNS(svgNS, 'path'); hit.classList.add('graph-edge-hit');
            hit.setAttribute('d', path); hit.setAttribute('tabindex', readOnly ? '-1' : '0'); hit.setAttribute('role', 'button');
            hit.setAttribute('aria-label', `Connection from ${edge.sourceTaskId} to ${edge.targetTaskId}`);
            hit.addEventListener('click', () => onSelectEdge(edge.id));
            hit.addEventListener('keydown', event => { if (!readOnly && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelectEdge(edge.id); } });
            svg.append(hit, line);
        }
    }
    surface.append(svg);
    container.append(surface);
    let connecting = null;
    const localPoint = event => { const rect = surface.getBoundingClientRect(), scale = Number(surface.dataset.scale) || 1; return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }; };
    const drawPreview = position => {
        svg.querySelector('.graph-preview')?.remove();
        if (!connecting) return;
        const start = point(connecting.taskId, connecting.side);
        const preview = document.createElementNS(svgNS, 'path'); preview.classList.add('graph-preview'); preview.setAttribute('d', curve(start, position)); svg.append(preview);
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
        nodeElements.set(task.id, node);
        node.setAttribute('aria-label', `${task.name}. ${readOnly ? '' : 'Arrow keys move this task.'}`);
        if (task.id === graph.entryTaskId) node.classList.add('graph-entry');
        if (states[task.id]) node.classList.add(`graph-state-${states[task.id]}`);
        const label = document.createElement('strong'); label.textContent = task.name;
        const detail = document.createElement('span'); detail.textContent = `${task.executionType || 'terminal / desktop / browser'}${states[task.id] ? ` · ${states[task.id]}` : ''}`;
        node.append(label, detail);
        const place = () => { node.style.left = `${graph.layout[task.id].x}px`; node.style.top = `${graph.layout[task.id].y}px`; };
        place();
        node.addEventListener('click', () => onSelect(task.id));
        node.addEventListener('dblclick', event => { if (readOnly) return; event.preventDefault(); onSetEntry(task.id); });
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
