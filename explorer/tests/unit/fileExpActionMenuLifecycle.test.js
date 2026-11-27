import test from 'node:test';
import assert from 'node:assert/strict';

import { attachFsActions } from '../../web-components/pages/file-exp/file-exp-fs-actions.js';

test('context menu renders all items before its single visible open', () => {
    const calls = [];
    let opened = false;
    const trigger = {
        setAttribute(name, value) {
            calls.push(`trigger:${name}:${value}`);
        }
    };
    const firstItem = {
        focus() {
            calls.push('focus');
        }
    };
    const container = {
        classList: {
            add(name) {
                assert.equal(name, 'open');
                assert.equal(opened, false);
                opened = true;
                calls.push('open');
            }
        },
        querySelector(selector) {
            if (selector === '.action-menu-trigger') return trigger;
            if (selector === '.action-menu-item') return firstItem;
            return null;
        }
    };
    const fileExp = {
        state: { openMenuPath: null },
        element: {
            querySelector() {
                return container;
            }
        },
        setDocumentListener() {},
        setOpenMenuPath(path, options) {
            assert.deepEqual(options, { invalidate: false });
            this.state.openMenuPath = path;
            calls.push('state');
        },
        startCodingReadiness(path) {
            assert.equal(path, '/workspace/file.txt');
            calls.push('readiness');
        },
        refreshContextMenuItems() {
            assert.equal(opened, false);
            calls.push('items');
        },
        renderEntries() {
            assert.equal(opened, false);
            calls.push('render');
        },
        showStatus() {}
    };

    attachFsActions(fileExp);
    fileExp.syncOpenActionMenuTracking = () => calls.push('track');
    fileExp.scheduleOpenActionMenuPositionSettle = () => calls.push('position');

    fileExp.openActionMenu('/workspace/file.txt', { invalidate: true });
    assert.equal(calls.filter((entry) => entry === 'open').length, 1);
    assert.ok(calls.indexOf('readiness') < calls.indexOf('items'));
    assert.ok(calls.indexOf('items') < calls.indexOf('render'));
    assert.ok(calls.indexOf('render') < calls.indexOf('open'));
});

test('pointerdown on another action menu is left for its click toggle', () => {
    const firstContainer = { dataset: { actionMenu: 'true', entryPath: '/first' } };
    const secondContainer = { dataset: { actionMenu: 'true', entryPath: '/second' } };
    const secondTrigger = { dataset: { entryPath: '/second' } };
    let closeCalls = 0;
    let openedPath = '';
    const fileExp = {
        state: { openMenuPath: '/first' },
        element: {
            contains(node) {
                return node === firstContainer || node === secondContainer;
            },
            querySelector() {
                return firstContainer;
            }
        }
    };

    attachFsActions(fileExp);
    fileExp.closeActionMenu = () => {
        closeCalls += 1;
    };
    fileExp.openActionMenu = (path) => {
        openedPath = path;
    };

    fileExp.handleOutsideMenuClick({
        target: secondTrigger,
        composedPath() {
            return [secondTrigger, secondContainer];
        }
    });
    fileExp.toggleActionMenu(secondTrigger);

    assert.equal(closeCalls, 0);
    assert.equal(openedPath, '/second');
});

test('outside pointerdown closes the menu without consuming or replacing the clicked target', () => {
    const openContainer = { dataset: { actionMenu: 'true', entryPath: '/open' } };
    const outsideButton = { dataset: { localAction: 'runOutsideAction' } };
    const closeArguments = [];
    let prevented = false;
    let propagationStopped = false;
    const fileExp = {
        state: { openMenuPath: '/open' },
        element: {
            contains() { return false; },
            querySelector() { return openContainer; }
        }
    };

    attachFsActions(fileExp);
    fileExp.closeActionMenu = (shouldInvalidate) => {
        closeArguments.push(shouldInvalidate);
    };

    fileExp.handleOutsideMenuClick({
        target: outsideButton,
        composedPath() { return [outsideButton]; },
        preventDefault() { prevented = true; },
        stopPropagation() { propagationStopped = true; }
    });

    assert.deepEqual(closeArguments, [false]);
    assert.equal(prevented, false);
    assert.equal(propagationStopped, false);
});

test('closing an action menu always disposes its readiness observer', () => {
    let stopped = 0;
    const host = { state: { openMenuPath: null }, stopCodingReadiness: () => stopped++ };
    attachFsActions(host);
    assert.equal(host.closeActionMenu(false), false);
    assert.equal(stopped, 1);
    assert.equal(host.stopCodingReadiness, null);
    host.closeActionMenu(false);
    assert.equal(stopped, 1);
});
