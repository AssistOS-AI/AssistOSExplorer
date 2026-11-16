import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMarkdownCrdtStore } from '../../utils/server/markdown-crdt/markdown-crdt-store.mjs';

const policyViolation = { code: 'PLOINKY_AGENT_DATA_POLICY_VIOLATION' };

async function createFixture(t, wrapFs = (value) => value) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crdt-deletion-boundary-'));
    t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outsideRoot);
    const validatePath = async (value) => {
        const target = path.resolve(workspaceRoot, value);
        if (!target.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error('Outside workspace.');
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs: wrapFs(fs, outsideRoot),
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => fs.writeFile(target, content),
        invalidateCachesForPath() {},
        transactionStaleMs: 1,
    });
    const documentPath = path.join(workspaceRoot, 'document.md');
    await fs.writeFile(documentPath, '# Document\n\nKeep this content.\n');
    const opened = await store.open(documentPath);
    const storeRoot = path.join(workspaceRoot, '.data', 'agents', 'explorer', 'automerge', 'documents');
    const statePath = path.join(storeRoot, `${opened.documentId}.automerge`);
    const relatedPath = path.join(workspaceRoot, '.data', 'agents', 'explorer', 'automerge', 'scripta-collaboration', `${opened.documentId}.automerge`);
    await fs.mkdir(path.dirname(relatedPath), { recursive: true });
    await fs.writeFile(relatedPath, 'collaboration state');
    const originals = await Promise.all([documentPath, statePath, relatedPath].map((file) => fs.readFile(file)));
    return {
        workspaceRoot, outsideRoot, store, storeRoot, documentPath, statePath, relatedPath,
        args: {
            documentId: opened.documentId,
            path: documentPath,
            relatedArtifacts: [{ name: 'collaboration.automerge', path: relatedPath }],
        },
        async assertOriginalsUnchanged() {
            const actual = await Promise.all([documentPath, statePath, relatedPath].map((file) => fs.readFile(file)));
            assert.deepEqual(actual, originals);
        },
    };
}

test('prepare revalidates pending-deletions after initial recovery without moving original artifacts', async (t) => {
    const fixture = await createFixture(t);
    await fs.symlink(fixture.outsideRoot, path.join(fixture.storeRoot, 'pending-deletions'));

    await assert.rejects(fixture.store.prepareRemove(fixture.args), policyViolation);

    await fixture.assertOriginalsUnchanged();
    assert.deepEqual(await fs.readdir(fixture.outsideRoot), []);
});

test('prepare rejects a transaction directory replaced with a symlink while it is created', async (t) => {
    const fixture = await createFixture(t, (fsApi, outsideRoot) => new Proxy(fsApi, {
        get(target, property) {
            if (property !== 'mkdir') return target[property];
            return async (directory, options) => {
                if (path.basename(directory).startsWith('scripta-delete-')) {
                    return fs.symlink(outsideRoot, directory);
                }
                return fs.mkdir(directory, options);
            };
        },
    }));

    await assert.rejects(fixture.store.prepareRemove(fixture.args), policyViolation);

    await fixture.assertOriginalsUnchanged();
    assert.deepEqual(await fs.readdir(fixture.outsideRoot), []);
});

for (const fileName of ['transaction.json', 'document.md', 'document.automerge', 'collaboration.automerge']) {
    test(`prepare preflights a symlinked ${fileName} before moving any artifact`, async (t) => {
        const fixture = await createFixture(t, (fsApi, outsideRoot) => new Proxy(fsApi, {
            get(target, property) {
                if (property !== 'mkdir') return target[property];
                return async (directory, options) => {
                    const result = await fs.mkdir(directory, options);
                    if (path.basename(directory).startsWith('scripta-delete-')) {
                        await fs.symlink(path.join(outsideRoot, 'sentinel'), path.join(directory, fileName));
                    }
                    return result;
                };
            },
        }));
        await fs.writeFile(path.join(fixture.outsideRoot, 'sentinel'), 'untouched');

        await assert.rejects(fixture.store.prepareRemove(fixture.args), policyViolation);

        await fixture.assertOriginalsUnchanged();
        assert.deepEqual(await fs.readdir(fixture.outsideRoot), ['sentinel']);
        assert.equal(await fs.readFile(path.join(fixture.outsideRoot, 'sentinel'), 'utf8'), 'untouched');
    });
}

test('prepare rejects a late symlink in the related artifact parent before moving Markdown', async (t) => {
    const fixture = await createFixture(t);
    const relatedRoot = path.dirname(fixture.relatedPath);
    await fs.rename(relatedRoot, path.join(fixture.outsideRoot, 'original'));
    await fs.symlink(path.join(fixture.outsideRoot, 'original'), relatedRoot);

    await assert.rejects(fixture.store.prepareRemove(fixture.args), policyViolation);

    await fixture.assertOriginalsUnchanged();
});

for (const operation of ['commitRemove', 'rollbackRemove', 'cleanupTransactions']) {
    for (const targetName of ['directory', 'transaction.json', 'document.md', 'document.automerge', 'collaboration.automerge']) {
        test(`${operation} rejects a late symlinked transaction ${targetName} and preserves staged data`, async (t) => {
            const fixture = await createFixture(t);
            const prepared = await fixture.store.prepareRemove(fixture.args);
            const transactionDir = path.join(fixture.storeRoot, 'pending-deletions', prepared.transactionId);
            const manifestPath = path.join(transactionDir, 'transaction.json');
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            manifest.preparedAt = '2000-01-01T00:00:00.000Z';
            await fs.writeFile(manifestPath, JSON.stringify(manifest));
            const artifactNames = ['transaction.json', 'document.md', 'document.automerge', 'collaboration.automerge'];
            const originals = await Promise.all(artifactNames.map((file) => fs.readFile(path.join(transactionDir, file))));
            const replacedPath = targetName === 'directory' ? transactionDir : path.join(transactionDir, targetName);
            const movedPath = path.join(fixture.outsideRoot, targetName);
            await fs.rename(replacedPath, movedPath);
            await fs.symlink(movedPath, replacedPath);

            await assert.rejects(fixture.store[operation]({ transactionId: prepared.transactionId }), policyViolation);

            assert.equal((await fs.lstat(replacedPath)).isSymbolicLink(), true);
            const actual = await Promise.all(artifactNames.map((file) => fs.readFile(path.join(transactionDir, file))));
            assert.deepEqual(actual, originals);
            await assert.rejects(fs.access(fixture.documentPath), { code: 'ENOENT' });
            await assert.rejects(fs.access(fixture.statePath), { code: 'ENOENT' });
            await assert.rejects(fs.access(fixture.relatedPath), { code: 'ENOENT' });
        });
    }
}

test('failed prepare preserves staged Markdown if its rollback cannot restore the original', async (t) => {
    let failRestoration = false;
    const fixture = await createFixture(t, (fsApi) => new Proxy(fsApi, {
        get(target, property) {
            if (property !== 'rename') return target[property];
            return async (source, destination) => {
                if (path.basename(destination) === 'document.automerge') {
                    failRestoration = true;
                    throw new Error('injected stage failure');
                }
                if (failRestoration && path.basename(source) === 'document.md') {
                    throw new Error('injected restoration failure');
                }
                return fs.rename(source, destination);
            };
        },
    }));

    await assert.rejects(fixture.store.prepareRemove(fixture.args), /injected stage failure/);

    const [transactionId] = await fs.readdir(path.join(fixture.storeRoot, 'pending-deletions'));
    assert.ok(transactionId);
    const stagedMarkdown = await fs.readFile(path.join(fixture.storeRoot, 'pending-deletions', transactionId, 'document.md'), 'utf8');
    assert.match(stagedMarkdown, /Keep this content/);
    assert.equal((await fs.stat(fixture.statePath)).isFile(), true);
    assert.equal((await fs.stat(fixture.relatedPath)).isFile(), true);
});
