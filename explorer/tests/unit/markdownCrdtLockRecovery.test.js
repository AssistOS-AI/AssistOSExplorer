import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMarkdownCrdtStore } from '../../utils/server/markdown-crdt/markdown-crdt-store.mjs';

// A warm tool worker keeps the same pid across calls. A lock whose release failed must not block the
// next call on the same document until the 10 s lock timeout.
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crdt-lock-recovery-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'doc.md'), '# Doc\n');
    const makeStore = (failLockRm, { onDocumentRead } = {}) => {
        let failed = false;
        const wrapped = new Proxy(fs, {
            get(target, key) {
                if (key === 'rm' && failLockRm) {
                    return async (file, options) => {
                        if (!failed && String(file).includes(`${path.sep}.locks${path.sep}`)) {
                            failed = true;
                            throw Object.assign(new Error('EIO simulated'), { code: 'EIO' });
                        }
                        return target.rm(file, options);
                    };
                }
                if (key === 'readFile' && onDocumentRead) {
                    return async (file, ...rest) => {
                        if (String(file) === path.join(root, 'doc.md')) await onDocumentRead();
                        return target.readFile(file, ...rest);
                    };
                }
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        return createMarkdownCrdtStore({
            fs: wrapped, path, workspaceRoot: root,
            validatePath: async value => path.resolve(root, String(value).replace(/^\//, '')),
            writeFileContent: (file, content) => fs.writeFile(file, content),
            invalidateCachesForPath() {},
        });
    };
    return { root, makeStore };
}

test('a lock leaked by a failed release in the same live process is recovered immediately', async (t) => {
    const { root, makeStore } = await fixture(t);
    await makeStore(true).open('doc.md');
    const locks = path.join(root, '.data', 'explorer', 'automerge', 'documents', '.locks');
    assert.equal((await fs.readdir(locks)).length, 1, 'the failed release left its lock file behind');
    const started = Date.now();
    await makeStore(false).open('doc.md');
    assert.ok(Date.now() - started < 2000, `the next call waited ${Date.now() - started} ms`);
});

test('a lock held by a concurrent operation in the same process still excludes others', async (t) => {
    const { root, makeStore } = await fixture(t);
    const markEntered = {};
    // The proxy reports when a store reads the document and can stall that read inside the critical section.
    const gatedStore = (name, gate) => makeStore(false, {
        onDocumentRead: async () => {
            markEntered[name]?.();
            if (gate) await gate;
        },
    });
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const entered = { first: false, second: false };
    const firstEntered = new Promise((resolve) => { markEntered.first = () => { entered.first = true; resolve(); }; });
    markEntered.second = () => { entered.second = true; };
    const first = gatedStore('first', gate).open('doc.md');
    await firstEntered;
    const lockDirectory = path.join(root, '.data', 'explorer', 'automerge', 'documents', '.locks');
    const readToken = async () => {
        const [name] = await fs.readdir(lockDirectory);
        return JSON.parse(await fs.readFile(path.join(lockDirectory, name), 'utf8')).token;
    };
    const firstToken = await readToken();
    const second = gatedStore('second').open('doc.md');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(entered.second, false, 'the second store must not enter its critical section while the first holds the lock');
    assert.equal(await readToken(), firstToken, 'the lock file still carries the first holder token');
    openGate();
    await Promise.all([first, second]);
    assert.equal(entered.second, true);
});
