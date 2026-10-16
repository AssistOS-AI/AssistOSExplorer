import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = file => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const tokens = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));

test('intense execution accents distinguish pending/starting and failed/paused without changing other states', async () => {
    const css = await read('workflow-editor.css');
    const light = tokens(css.match(/:root \{ --execution-pending[^}]+\}/)[0]);
    const dark = tokens(css.match(/\.theme-dark \{ --execution-pending[^}]+\}/)[0]);
    assert.equal(light['--execution-pending'], '#606060');
    assert.equal(light['--execution-starting'], '#00acc1');
    assert.equal(light['--execution-failed'], '#b91c1c');
    assert.equal(light['--execution-paused'], '#facc15');
    assert.equal(dark['--execution-pending'], '#b5b5b5');
    assert.equal(dark['--execution-starting'], '#00acc1');
    assert.equal(dark['--execution-failed'], '#ef4444');
    assert.equal(dark['--execution-paused'], '#facc15');
    for (const theme of [light, dark]) {
        assert.notEqual(theme['--execution-pending'], theme['--execution-starting']);
        assert.notEqual(theme['--execution-failed'], theme['--execution-paused']);
    }
    for (const [state, value] of Object.entries({ queued: '#7c3aed', running: '#1d4ed8', completed: '#15803d', terminated: '#475569' })) {
        assert.equal(light[`--execution-${state}`], value);
    }
    for (const [state, value] of Object.entries({ queued: '#c4b5fd', running: '#93c5fd', completed: '#86efac', terminated: '#cbd5e1' })) {
        assert.equal(dark[`--execution-${state}`], value);
    }
    assert.match(css, /data-execution-state='pausing'[^}]*--execution-color: var\(--execution-paused\)/);
});

test('bright accents stay on icons and surfaces while text uses readable theme-specific ink', async () => {
    const [graph, phases, dashboard] = await Promise.all([read('workflow-editor.css'), read('workflow-execution.css'), read('styles.css')]);
    assert.match(graph, /--execution-starting-ink: #00616e/);
    assert.match(graph, /--execution-paused-ink: #725600/);
    assert.match(graph, /\.execution-state-icon \{[^}]*color: var\(--execution-color\)/);
    assert.match(graph, /\.graph-node\[data-execution-state\] strong \{ color: var\(--execution-text\)/);
    assert.match(graph, /\.graph-node \.graph-execution-state \{[^}]*color: var\(--execution-text\)/);
    assert.match(phases, /\.phase-card-name \{[^}]*color: var\(--execution-text\)/);
    assert.match(phases, /\.phase-state-legend-item \{[^}]*color: var\(--execution-text\)/);
    assert.match(dashboard, /\.cron-card \.cron-run-status \{ color: var\(--execution-text\)/);
});
