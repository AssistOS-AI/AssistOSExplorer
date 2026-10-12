import test from 'node:test';
import assert from 'node:assert/strict';
import { drawBoard } from '../public/workflow-board.js';

// Minimal DOM surface for testing the renderer's pointer handlers without a browser dependency.
class Element extends EventTarget {
    children = [];
    className = '';
    style = {};
    dataset = {};
    captures = new Set();
    classList = { add: (...names) => { this.className += ` ${names.join(' ')}`; } };
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(name, value) { if (name === 'class') this.className = value; }
    matches(selector) { return selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1)); }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    querySelectorAll(selectors) {
        return this.children.flatMap(child => [
            ...(selectors.split(', ').some(selector => child.matches(selector)) ? [child] : []),
            ...child.querySelectorAll(selectors)
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    get offsetWidth() { return parseFloat(this.style.width) || 190; }
    get offsetHeight() { return parseFloat(this.style.height) || 70; }
    get clientWidth() { return 800; }
    get clientHeight() { return 340; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
}

function emit(target, type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [name, value] of Object.entries({ pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100, ...fields })) {
        Object.defineProperty(event, name, { value });
    }
    target.dispatchEvent(event);
}

function fixture(t, options = {}) {
    const previous = Object.fromEntries(['document', 'window', 'ResizeObserver'].map(key => [key, globalThis[key]]));
    const document = { createElement: () => new Element(), createElementNS: () => new Element(), elementFromPoint: () => document.dropTarget };
    globalThis.document = document;
    globalThis.window = new EventTarget();
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    const container = new Element(), selected = [], changes = [];
    const graph = { tasks: [{ id: 'start', name: 'Start' }, { id: 'end', name: 'End' }], entryTaskId: 'start',
        edges: [{ id: 'edge', sourceTaskId: 'start', targetTaskId: 'end' }], layout: { start: { x: 60, y: 60 }, end: { x: 360, y: 60 } } };
    const render = () => drawBoard(container, graph, { onSelect: id => selected.push(id), onChange: event => changes.push(event), ...options });
    render();
    t.after(() => { container._workflowBoardCleanup(); Object.assign(globalThis, previous); });
    return { container, graph, selected, changes, document, render, node: container.querySelector('.graph-entry') };
}

test('a simple click, including tiny pointer jitter, selects without changing layout', t => {
    const { node, graph, selected, changes } = fixture(t);
    for (const jitter of [0, 2]) {
        emit(node, 'pointerdown');
        emit(node, 'pointermove', { clientX: 100 + jitter });
        emit(node, 'pointerup', { clientX: 100 + jitter });
        emit(node, 'click');
    }
    assert.deepEqual(selected, ['start', 'start']);
    assert.deepEqual(changes, []);
    assert.deepEqual(graph.layout.start, { x: 60, y: 60 });
});

test('dragging suppresses the trailing click but not the next ordinary click', t => {
    const { node, graph, selected, changes } = fixture(t);
    emit(node, 'pointerdown');
    emit(node, 'pointermove', { clientX: 140 });
    emit(node, 'pointerup', { clientX: 140 });
    emit(node, 'click', { clientX: 140 });
    assert.deepEqual(selected, []);
    assert.deepEqual(changes, [{ moved: 'start' }]);
    assert.ok(graph.layout.start.x > 60);
    emit(node, 'pointerdown'); emit(node, 'pointerup'); emit(node, 'click');
    assert.deepEqual(selected, ['start']);
    assert.equal(changes.length, 1);
});

test('a drag back to its origin remains a drag, not a click', t => {
    const { node, selected, graph } = fixture(t);
    emit(node, 'pointerdown'); emit(node, 'pointermove', { clientY: 120 });
    emit(node, 'pointermove'); emit(node, 'pointerup'); emit(node, 'click');
    assert.deepEqual(selected, []);
    assert.deepEqual(graph.layout.start, { x: 60, y: 60 });
});

test('cancel, lost capture and Escape restore position without editing or committing', t => {
    const { node, graph, selected, changes } = fixture(t);
    for (const cancellation of ['pointercancel', 'lostpointercapture', 'Escape']) {
        emit(node, 'pointerdown'); emit(node, 'pointermove', { clientX: 140 });
        if (cancellation === 'Escape') emit(window, 'keydown', { key: 'Escape' });
        else emit(node, cancellation);
        emit(node, 'pointerup'); emit(node, 'click');
        assert.deepEqual(graph.layout.start, { x: 60, y: 60 });
    }
    assert.deepEqual(selected, []);
    assert.deepEqual(changes, []);
    emit(node, 'pointerdown'); emit(node, 'pointerup'); emit(node, 'click');
    assert.deepEqual(selected, ['start']);
});

test('connection ports do not select nodes and ignore other pointers', t => {
    const { container, node, document, selected, changes } = fixture(t);
    const ports = container.querySelectorAll('.graph-port-right');
    document.dropTarget = ports[1];
    emit(ports[0], 'pointerdown');
    emit(window, 'pointerup', { pointerId: 2 });
    assert.deepEqual(changes, []);
    emit(window, 'pointerup'); emit(node, 'click');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].connect.target.taskId, 'end');
    assert.deepEqual(selected, []);
    emit(node, 'click', { target: ports[0] });
    assert.deepEqual(selected, []);
    emit(node, 'pointerdown'); emit(node, 'pointerup'); emit(node, 'click');
    assert.deepEqual(selected, ['start']);
});

test('redrawing cancels an active drag and removes its old handlers', t => {
    const { node, graph, render, selected, changes } = fixture(t);
    emit(node, 'pointerdown'); emit(node, 'pointermove', { clientX: 140 });
    render();
    emit(node, 'pointermove', { clientX: 160 }); emit(node, 'pointerup'); emit(node, 'click');
    assert.deepEqual(graph.layout.start, { x: 60, y: 60 });
    assert.deepEqual(changes, []);
    assert.deepEqual(selected, []);
});

test('modified clicks do not edit and arrow-key movement remains available', t => {
    const { node, graph, selected, changes } = fixture(t);
    for (const fields of [{ button: 2 }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { altKey: true }]) emit(node, 'click', fields);
    emit(node, 'keydown', { key: 'ArrowRight' });
    assert.deepEqual(selected, []);
    assert.equal(graph.layout.start.x, 70);
    assert.deepEqual(changes, [{ moved: 'start' }]);
});

test('read-only graph clicks still select tasks', t => {
    const { node, selected, changes } = fixture(t, { readOnly: true });
    emit(node, 'click');
    assert.deepEqual(selected, ['start']);
    assert.deepEqual(changes, []);
});
