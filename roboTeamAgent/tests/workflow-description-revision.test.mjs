import assert from 'node:assert/strict';
import test from 'node:test';
import { createDescriptionRevision } from '../public/workflow-description-revision.js';
import { reviseGraph } from '../public/workflow-generator.js';

const graph = () => ({ id: 'report', name: 'Report', description: 'Write a report.', entryTaskId: 'a',
    tasks: [{ id: 'a', prompt: 'Write it' }], edges: [], layout: { a: { x: 50, y: 60 } } });
function fixture(generate) {
    const draft = graph(), states = [], applied = [];
    const review = createDescriptionRevision({ getGraph: () => draft, generate,
        apply: value => { applied.push(value); draft.tasks = value.tasks; },
        onState: (...value) => states.push(value) });
    review.reset(draft.description);
    return { draft, states, applied, review };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('unchanged and whitespace-only descriptions do not call the model', async () => {
    const f = fixture(() => assert.fail('Unexpected generation'));
    f.draft.description = '  Write a report.  ';
    assert.equal(await f.review.check(), true);
});

test('a typo decision preserves exact task, edge and position objects', async () => {
    const f = fixture(async (draft, previous, description) => {
        assert.equal(previous, 'Write a report.'); assert.equal(description, 'Write a repport.');
        return { regenerate: false, reason: 'Spelling correction only', graph: { tasks: [{ id: 'ignored' }] } };
    });
    const tasks = f.draft.tasks, edges = f.draft.edges, layout = f.draft.layout;
    f.draft.description = 'Write a repport.'; f.review.edited();
    assert.equal(await f.review.check(), true);
    assert.equal(f.draft.tasks, tasks); assert.equal(f.draft.edges, edges); assert.equal(f.draft.layout, layout);
    assert.equal(f.applied.length, 0); assert.equal(f.states.at(-1)[0], 'unchanged');
    assert.equal(await f.review.check(), true);
});

test('semantic change applies the validated draft once and concurrent Save shares the review', async () => {
    const done = deferred(); let calls = 0;
    const f = fixture(() => { calls++; return done.promise; });
    f.draft.description = 'Do not write a report.';
    const first = f.review.check(); assert.equal(f.review.check(), first);
    done.resolve({ regenerate: true, reason: 'Negation changes the task', graph: { tasks: [{ id: 'changed' }] } });
    assert.equal(await first, true); assert.equal(calls, 1); assert.equal(f.applied.length, 1);
    assert.equal(f.states.at(-1)[0], 'regenerated');
});

test('editing the description cancels review and rejects a late result', async () => {
    const done = deferred(); let signal;
    const f = fixture((draft, previous, description, options) => { signal = options.signal; return done.promise; });
    f.draft.description = 'New objective'; const pending = f.review.check();
    f.draft.description = 'Latest objective'; f.review.edited(); assert.equal(signal.aborted, true);
    done.resolve({ regenerate: true, graph: { tasks: [{ id: 'stale' }] } });
    assert.equal(await pending, false); assert.equal(f.applied.length, 0);
    assert.equal(f.states.at(-1)[0], 'edited');
});

test('task, edge, entry or layout edits during review prevent replacement, but renaming is preserved', async () => {
    for (const mutate of [draft => draft.tasks[0].prompt = 'Manual edit', draft => draft.edges.push({ id: 'edge' }),
        draft => draft.entryTaskId = 'other', draft => draft.layout.a.x++]) {
        const done = deferred(); const f = fixture(() => done.promise);
        f.draft.description = 'New objective'; const pending = f.review.check(); mutate(f.draft);
        done.resolve({ regenerate: true, graph: { tasks: [{ id: 'changed' }] } });
        assert.equal(await pending, false); assert.equal(f.applied.length, 0); assert.equal(f.states.at(-1)[0], 'failed');
    }
    const done = deferred(); const f = fixture(() => done.promise);
    f.draft.description = 'New objective'; const pending = f.review.check(); f.draft.name = 'Manual name';
    done.resolve({ regenerate: false }); assert.equal(await pending, true); assert.equal(f.draft.name, 'Manual name');
});

test('failed, ambiguous and empty-description reviews cannot silently authorize Save; retry remains possible', async () => {
    let success = false;
    const f = fixture(async () => success ? { regenerate: false } : { graph: { tasks: [] } });
    f.draft.description = 'New objective'; assert.equal(await f.review.check(), false);
    assert.equal(f.states.at(-1)[0], 'failed'); success = true;
    assert.equal(await f.review.check(), true);
    f.draft.description = ''; assert.equal(await f.review.check(), false);
    const failing = fixture(async () => { throw new Error('Runtime unavailable'); });
    failing.draft.description = 'New objective'; assert.equal(await failing.review.check(), false);
    assert.match(failing.states.at(-1)[1], /Runtime unavailable/); assert.equal(failing.applied.length, 0);
});

test('closing or switching workflow invalidates pending results', async () => {
    for (const action of ['dispose', 'reset']) {
        const done = deferred(); const f = fixture(() => done.promise);
        f.draft.description = 'Changed'; const pending = f.review.check(); f.review[action]('Another description');
        done.resolve({ regenerate: true, graph: { tasks: [{ id: 'stale' }] } });
        assert.equal(await pending, false); assert.equal(f.applied.length, 0);
    }
});

test('review transport returns the semantic decision and cancels a task accepted after abort', async () => {
    const calls = [];
    const request = async (route, options = {}) => {
        calls.push({ route, options });
        return options.method === 'POST' ? { id: 'generation' } : { status: 'completed', regenerate: false, reason: 'Typo', graph: null };
    };
    const result = await reviseGraph(graph(), 'Previous', 'Next', { request });
    assert.equal(result.regenerate, false); assert.equal(calls[0].options.body.previousDescription, 'Previous');
    const control = new AbortController();
    await assert.rejects(reviseGraph(graph(), 'Previous', 'Next', { signal: control.signal, request: async (route, options = {}) => {
        calls.push({ route, options }); if (options.method === 'POST') { control.abort(); return { id: 'late' }; } return {};
    } }));
    assert.equal(calls.at(-1).route, 'api/roboflow/generations/late'); assert.equal(calls.at(-1).options.method, 'DELETE');
});
