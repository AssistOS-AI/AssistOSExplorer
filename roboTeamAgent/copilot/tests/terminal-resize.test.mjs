import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LineEditor } from '../src/ui/LineEditor.mjs';
import {
    CommandSelector,
    listenForResize,
} from '../src/ui/CommandSelector.mjs';
import { listenForEditorResize } from '../src/repl/InteractivePrompt.mjs';

function stripAnsi(value) {
    return String(value).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|.)/g, '');
}

class FakeTerminal extends EventEmitter {
    constructor(columns) {
        super();
        this.columns = columns;
        this.writes = [];
    }

    write(value) {
        this.writes.push(String(value));
    }
}

class SandboxTerminal extends FakeTerminal {
    constructor(columns) {
        super(columns);
        this.actualColumns = columns;
    }

    getWindowSize() {
        return [this.columns, 24];
    }

    _refreshSize() {
        this.columns = this.actualColumns;
    }
}

test('boxed input redraws its complete border at the resized terminal width', () => {
    const terminal = new FakeTerminal(80);
    const editor = new LineEditor({
        boxed: true,
        prompt: '> ',
        rightHint: 'a-model-with-a-long-name',
        stream: terminal,
    });
    editor.setBuffer('keep this input visible');
    editor.render();

    terminal.columns = 36;
    editor.redraw();
    const resized = stripAnsi(terminal.writes.at(-1));

    assert.match(resized, new RegExp(`╭${'─'.repeat(34)}╮`));
    assert.match(resized, /keep this input visible/);
    assert.doesNotMatch(resized, /a-model-with-a-long-name/);
});

test('command selector rows never exceed the current terminal width', () => {
    const selector = new CommandSelector([{
        name: 'A very long task title that used to wrap onto another line',
        description: 'finished · completed · task_313867f2a315ee603892849e',
    }]);

    for (const width of [32, 80, 140]) {
        const lines = selector.render(width).map(stripAnsi);
        assert.equal(lines.every((line) => line.length <= width), true);
    }
});

test('active terminal UIs redraw on resize and remove their listeners on cleanup', () => {
    const terminal = new FakeTerminal(80);
    let selectorRenders = 0;
    const stopSelectorResize = listenForResize(() => { selectorRenders += 1; }, terminal);
    terminal.emit('resize');
    stopSelectorResize();
    terminal.emit('resize');
    assert.equal(selectorRenders, 1);

    let editorRenders = 0;
    let selectorActive = false;
    const stopEditorResize = listenForEditorResize(
        terminal,
        { redraw: () => { editorRenders += 1; } },
        () => selectorActive,
    );
    terminal.emit('resize');
    selectorActive = true;
    terminal.emit('resize');
    stopEditorResize();
    terminal.emit('resize');
    assert.equal(editorRenders, 1);
    assert.equal(terminal.listenerCount('resize'), 0);
});

test('terminal UIs detect size changes even when SIGWINCH is lost by a sandbox', () => {
    const terminal = new SandboxTerminal(80);
    let pollResize;
    let clearedTimer = null;
    let renders = 0;
    const timer = { unref() {} };
    const stop = listenForResize(
        () => { renders += 1; },
        terminal,
        {
            setIntervalFn(callback) {
                pollResize = callback;
                return timer;
            },
            clearIntervalFn(value) {
                clearedTimer = value;
            },
        },
    );

    pollResize();
    assert.equal(renders, 0);
    terminal.actualColumns = 45;
    pollResize();
    assert.equal(renders, 1);

    stop();
    assert.equal(clearedTimer, timer);
});
