const svgNS = 'http://www.w3.org/2000/svg';
export function drawBoard(container, graph, { readOnly = false, onChange = () => {}, onSelect = () => {}, states = {} } = {}) {
    container.replaceChildren();
    container.classList.add('workflow-board');
    const surface = document.createElement('div'); surface.className = 'graph-surface';
    const points = graph.tasks.map(task => graph.layout[task.id]);
    surface.style.width = `${Math.max(1000, ...points.map(p => p.x + 230))}px`;
    surface.style.height = `${Math.max(500, ...points.map(p => p.y + 130))}px`;
    const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('graph-edges');
    const markerId = `arrow-${Math.random().toString(36).slice(2)}`;
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    for (const [name, value] of Object.entries({ id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })) marker.setAttribute(name, value);
    const arrow = document.createElementNS(svgNS, 'path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); arrow.setAttribute('fill', 'currentColor'); marker.append(arrow); defs.append(marker); svg.append(defs);
    function edges() {
        svg.querySelectorAll('.graph-edge').forEach(edge => edge.remove());
        for (const edge of graph.edges) {
            const a = graph.layout[edge.sourceTaskId], b = graph.layout[edge.targetTaskId];
            if (!a || !b) continue;
            const line = document.createElementNS(svgNS, 'path'); line.classList.add('graph-edge');
            const sx = a.x + 190, sy = a.y + 35, tx = b.x, ty = b.y + 35;
            line.setAttribute('d', edge.sourceTaskId === edge.targetTaskId ? `M ${sx} ${sy} C ${sx + 90} ${sy - 110} ${tx - 90} ${ty - 110} ${tx} ${ty}` : `M ${sx} ${sy} C ${sx + 70} ${sy} ${tx - 70} ${ty} ${tx} ${ty}`);
            line.setAttribute('marker-end', `url(#${markerId})`);
            const title = document.createElementNS(svgNS, 'title'); title.textContent = edge.id; line.append(title);
            svg.append(line);
        }
    }
    edges(); surface.append(svg);
    let connecting = null;
    for (const task of graph.tasks) {
        const node = document.createElement('div'); node.className = 'graph-node'; node.tabIndex = 0;
        node.setAttribute('aria-label', `${task.name}. ${readOnly ? '' : 'Arrow keys move this task.'}`);
        if (task.id === graph.entryTaskId) node.classList.add('graph-entry');
        const label = document.createElement('strong'); label.textContent = task.name;
        const detail = document.createElement('span'); detail.textContent = `${task.executionType || 'terminal / desktop / browser'}${states[task.id] ? ` · ${states[task.id]}` : ''}`;
        node.append(label, detail);
        const place = () => { node.style.left = `${graph.layout[task.id].x}px`; node.style.top = `${graph.layout[task.id].y}px`; };
        place();
        node.addEventListener('click', () => onSelect(task.id));
        if (!readOnly) {
            const port = document.createElement('button'); port.type = 'button'; port.className = 'graph-port'; port.textContent = '↗'; port.title = 'Drag to another task to connect'; port.setAttribute('aria-label', `Connect ${task.name}`);
            port.addEventListener('pointerdown', event => { event.stopPropagation(); connecting = task.id; });
            node.addEventListener('pointerup', event => {
                if (connecting) { const source = connecting; connecting = null; onChange({ connect: [source, task.id] }); event.stopPropagation(); }
            });
            node.append(port);
            node.addEventListener('pointerdown', event => {
                if (event.target === port || event.button !== 0) return;
                const start = { x: event.clientX, y: event.clientY, ...graph.layout[task.id] };
                const clientX = event.clientX, clientY = event.clientY;
                node.setPointerCapture(event.pointerId);
                const move = next => {
                    graph.layout[task.id] = { x: Math.max(0, start.x + next.clientX - clientX), y: Math.max(0, start.y + next.clientY - clientY) };
                    place(); edges();
                };
                const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); onChange({ moved: task.id }); };
                node.addEventListener('pointermove', move); node.addEventListener('pointerup', up, { once: true });
            });
            node.addEventListener('keydown', event => {
                const deltas = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
                if (!deltas[event.key] || event.target !== node) return;
                event.preventDefault(); const [dx, dy] = deltas[event.key];
                graph.layout[task.id].x = Math.max(0, graph.layout[task.id].x + dx); graph.layout[task.id].y = Math.max(0, graph.layout[task.id].y + dy); place(); edges(); onChange({ moved: task.id });
            });
        }
        surface.append(node);
    }
    container.append(surface);
}
