import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../shared/ui/expanded-modal-loading.js', import.meta.url), 'utf8'))
    .replace('export function', 'function');

test('loading stays with its original panel without consuming global tokens', () => {
    let current = null;
    const hidden = [];
    let shown = 0;
    const ui = { showLoading: () => ++shown, hideLoading: token => hidden.push(token) };
    const install = vm.runInNewContext(`${source}\ninstallExpandedModalLoading`, { document: { querySelector: () => current } });
    install(ui);
    const outside = ui.showLoading();
    const first = { isConnected: true, webSkelPresenter: { renderLoadingState() {} } };
    current = first;
    const a = ui.showLoading();
    const b = ui.showLoading();
    assert.equal(shown, 1);
    assert.equal(first.expandedLoaderCount, 2);
    const next = { isConnected: true, webSkelPresenter: { renderLoadingState() {} } };
    current = next;
    first.isConnected = false;
    const c = ui.showLoading();
    ui.hideLoading(a); ui.hideLoading(a); ui.hideLoading(b);
    assert.equal(first.expandedLoaderCount, 0);
    assert.equal(next.expandedLoaderCount, 1);
    ui.hideLoading(c); ui.hideLoading(outside);
    assert.equal(next.expandedLoaderCount, 0);
    assert.deepEqual(hidden, [outside]);
});
