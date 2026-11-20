import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForComponentReady } from '../../shared/ui/component-readiness.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a render reset cannot release the loader before afterRender publishes initialLoad', async () => {
    const beforeRender = deferred(), afterRender = deferred(), data = deferred(), finalRender = deferred();
    const node = { presenterReadyPromise: Promise.resolve(), renderCompletePromise: beforeRender.promise, webSkelPresenter: {} };
    let ready = false;
    const pending = waitForComponentReady(node).then(() => { ready = true; });
    await tick();
    node.renderCompletePromise = afterRender.promise;
    beforeRender.resolve();
    await tick();
    assert.equal(ready, false);
    node.webSkelPresenter.initialLoad = data.promise;
    afterRender.resolve();
    await tick();
    assert.equal(ready, false);
    node.renderCompletePromise = finalRender.promise;
    data.resolve();
    await tick();
    assert.equal(ready, false);
    finalRender.resolve();
    await pending;
    assert.equal(ready, true);
});

test('cancelled mounting never waits for an unstarted data read', async () => {
    const rendering = deferred();
    let cancelled = false;
    const node = { renderCompletePromise: rendering.promise, webSkelPresenter: { get initialLoad() { assert.fail('read after cancel'); } } };
    const pending = waitForComponentReady(node, () => cancelled);
    await tick();
    cancelled = true;
    rendering.resolve();
    assert.equal(await pending, false);
});
