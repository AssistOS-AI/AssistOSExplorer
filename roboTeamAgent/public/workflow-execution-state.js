const states = {
    pending: { label: 'Not started', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18' },
    unvisited: { label: 'Not started', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18' },
    queued: { label: 'Queued', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2' },
    starting: { label: 'Starting', path: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M5.6 5.6l2.8 2.8 M15.6 15.6l2.8 2.8 M5.6 18.4l2.8-2.8 M15.6 8.4l2.8-2.8' },
    running: { label: 'Running', path: 'M8 5l11 7-11 7Z' },
    completed: { label: 'Completed', path: 'M4 12l5 5L20 6' },
    failed: { label: 'Failed', path: 'M6 6l12 12 M6 18L18 6' },
    pausing: { label: 'Pausing', path: 'M8 5v14 M16 5v14 M3 12h2 M19 12h2' },
    paused: { label: 'Paused', path: 'M8 5v14 M16 5v14' },
    terminated: { label: 'Terminated', path: 'M6 6h12v12H6Z' },
};

export function executionStatePresentation(state) {
    return states[state] || { label: String(state || 'Unknown'), path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 8v5 M12 16h.01' };
}

export function executionStateIcon(state, ownerDocument = document) {
    const presentation = executionStatePresentation(state);
    const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        class: 'execution-state-icon', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
    const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', presentation.path);
    svg.append(path);
    return svg;
}

export function renderExecutionState(element, state, ownerDocument = document) {
    if (element.dataset.executionState === state) return;
    const presentation = executionStatePresentation(state);
    const svg = executionStateIcon(state, ownerDocument);
    const label = ownerDocument.createElement('span'); label.textContent = presentation.label;
    element.dataset.executionState = state;
    element.replaceChildren(svg, label);
}

export function renderExecutionStateLegend(element, ownerDocument = document, group = 'primary') {
    const primary = ['running', 'completed', 'failed', 'paused', 'pending'];
    const more = ['queued', 'starting', 'pausing', 'terminated'];
    const legendStates = group === 'all' ? [...primary, ...more] : group === 'more' ? more : primary;
    element.replaceChildren(...legendStates.map(state => {
        const item = ownerDocument.createElement('li');
        item.className = 'phase-state-legend-item';
        renderExecutionState(item, state, ownerDocument);
        return item;
    }));
}

export function fittingLegendCount(widths, available, gap = 8) {
    let used = 0, count = 0;
    for (const width of widths) {
        const next = used + (count ? gap : 0) + width;
        if (next > available) break;
        used = next; count++;
    }
    return count;
}

export function initExecutionStateLegend(section, ownerWindow = window) {
    const doc = section.ownerDocument;
    const list = section.querySelector('#phaseStateLegend');
    const toggle = section.querySelector('#phaseLegendToggle');
    const popup = section.querySelector('#phaseLegendPopover');
    renderExecutionStateLegend(list, doc, 'all');
    renderExecutionStateLegend(section.querySelector('#phaseStateLegendMore'), doc, 'all');
    let disposed = false;
    const position = () => {
        if (!popup.matches(':popover-open')) return;
        const trigger = toggle.getBoundingClientRect();
        if (trigger.bottom < 0 || trigger.top > ownerWindow.innerHeight) { popup.hidePopover(); return; }
        const below = Math.max(0, ownerWindow.innerHeight - trigger.bottom - 12);
        const above = Math.max(0, trigger.top - 12);
        const opensAbove = below < popup.scrollHeight && above > below;
        popup.style.maxHeight = `${opensAbove ? above : below}px`;
        const bounds = popup.getBoundingClientRect();
        popup.style.left = `${Math.max(12, Math.min(trigger.right - bounds.width, ownerWindow.innerWidth - bounds.width - 12))}px`;
        popup.style.top = `${opensAbove ? trigger.top - bounds.height - 6 : trigger.bottom + 6}px`;
    };
    const resize = () => {
        if (disposed) return;
        const items = Array.from(list.children);
        for (const item of items) item.hidden = false;
        const gap = parseFloat(ownerWindow.getComputedStyle(list).columnGap) || 0;
        const count = fittingLegendCount(items.map(item => item.getBoundingClientRect().width), list.clientWidth, gap);
        items.forEach((item, index) => { item.hidden = index >= count; });
        position();
    };
    const onToggle = event => {
        toggle.setAttribute('aria-expanded', String(event.newState === 'open'));
        position();
    };
    popup.addEventListener('toggle', onToggle);
    const observer = new ownerWindow.ResizeObserver(resize);
    observer.observe(list);
    ownerWindow.addEventListener('resize', resize);
    ownerWindow.addEventListener('scroll', position, true);
    doc.fonts?.addEventListener('loadingdone', resize);
    doc.fonts?.ready.then(resize);
    resize();
    return { dispose() {
        disposed = true; observer.disconnect();
        popup.removeEventListener('toggle', onToggle);
        ownerWindow.removeEventListener('resize', resize);
        ownerWindow.removeEventListener('scroll', position, true);
        doc.fonts?.removeEventListener('loadingdone', resize);
        if (popup.matches(':popover-open')) popup.hidePopover();
    } };
}
