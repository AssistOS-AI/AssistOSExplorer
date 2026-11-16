import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createMarkdownCrdtStore } from '../../utils/server/markdown-crdt/markdown-crdt-store.mjs';
import { createScriptaCrdtService } from '../../utils/server/markdown-crdt/scripta-crdt-service.mjs';
import {
    applyDocumentChanges,
    changeDocument,
    createDocument,
    getDocumentChanges,
    getDocumentHeads,
    loadDocument,
    saveDocument,
    updateText,
} from '../../utils/server/markdown-crdt/automerge-adapter.mjs';

async function createFixture(t, runtimeFs = fs) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-merge-authority-'));
    t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
    const validatePath = async (input) => {
        const candidate = String(input || '');
        const target = candidate.startsWith(`${workspaceRoot}${path.sep}`)
            ? path.resolve(candidate)
            : path.resolve(workspaceRoot, candidate.replace(/^\/+/, ''));
        if (!target.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error('Path outside workspace.');
        return target;
    };
    const makeRuntime = () => {
        const store = createMarkdownCrdtStore({
            fs: runtimeFs,
            path,
            workspaceRoot,
            validatePath,
            writeFileContent: (target, content) => runtimeFs.writeFile(target, content, 'utf8'),
            invalidateCachesForPath() {},
        });
        return {
            store,
            service: createScriptaCrdtService({
                fs: runtimeFs,
                path,
                workspaceRoot,
                validatePath,
                markdownCrdtStore: store,
            }),
        };
    };
    const { store, service } = makeRuntime();
    const participant = { id: 'owner', hash: 'participant-owner', label: 'Owner' };
    const args = {
        path: '/draft.md',
        resourceId: 'resource-draft',
        participant,
        viewerHash: participant.hash,
        view: { mode: 'document' },
    };
    const created = await service.create({ ...args, title: 'Draft', createdBy: participant.hash });
    const chapter = created.projection.chapters[0];
    const paragraph = chapter.paragraphs[0];
    const variantArgs = {
        chapterId: chapter.chapterId,
        paragraphId: paragraph.paragraphId,
        variantId: created.model.chapters[0].paragraphs[0].pluginState.scripta.activeVariantId,
    };
    const readArtifacts = async () => Promise.all([
        fs.readFile(path.join(workspaceRoot, 'draft.md')),
        fs.readFile(path.join(workspaceRoot, '.data/agents/explorer/automerge/documents', `${created.documentId}.automerge`)),
        fs.readFile(path.join(workspaceRoot, '.data/agents/explorer/automerge/scripta-collaboration', `${created.documentId}.automerge`)),
    ]);
    return { workspaceRoot, service, store, makeRuntime, args, variantArgs, readArtifacts };
}

function proposal(args, base, text) {
    return {
        ...args,
        baseStateBase64: base.stateBase64,
        markdown: `# Draft\n\n## Chapter 1\n\n${text}`,
    };
}

function currentText(result) {
    return result.projection.chapters[0].paragraphs[0].text;
}

test('SCRIPTA retries across Automerge timestamp seconds preserve accepted state after restore', async (t) => {
    const fixture = await createFixture(t);
    const { service, args, makeRuntime, readArtifacts } = fixture;
    const initial = await service.collaborationOpen(args);
    await service.collaborationMergeMarkdown(proposal(args, initial, 'Seed text'));
    const base = await service.collaborationOpen(args);
    const request = proposal(args, base, 'Seed text [accepted proposal]');
    const accepted = await service.collaborationMergeMarkdown(request);
    assert.equal(accepted.changed, true);
    const beforeRetry = await readArtifacts();

    // Use real time and real Automerge changes: a retry must survive a different
    // encoded change timestamp, not just a lucky same-second invocation.
    await delay(1100);
    const restored = makeRuntime();
    const repeated = await restored.service.collaborationMergeMarkdown(request);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.markdown, accepted.markdown);
    assert.equal(repeated.projection.documentRevision, accepted.projection.documentRevision);
    assert.deepEqual(repeated.heads, accepted.heads);
    assert.deepEqual(await readArtifacts(), beforeRetry);
});

test('SCRIPTA merges distinct concurrent proposals from one historical snapshot and converges', async (t) => {
    const { service, args, makeRuntime, variantArgs, readArtifacts } = await createFixture(t);
    await service.mutate({
        ...args,
        operation: 'p-variant-edit',
        args: { ...variantArgs, text: 'Seed text' },
    });
    const base = await service.collaborationOpen(args);
    const requests = [' [proposal A]', ' [proposal B]'].map((suffix) => proposal(args, base, `Seed text${suffix}`));
    const other = makeRuntime();
    const results = await Promise.all([
        service.collaborationMergeMarkdown(requests[0]),
        other.service.collaborationMergeMarkdown(requests[1]),
    ]);
    assert.ok(results.every((result) => result.changed));
    const restored = makeRuntime();
    const opened = await restored.service.collaborationOpen(args);
    assert.match(currentText(opened), /\[proposal A\]/);
    assert.match(currentText(opened), /\[proposal B\]/);
    assert.equal(opened.projection.documentRevision, base.projection.documentRevision + 2);
    const browser = loadDocument(Buffer.from(base.stateBase64, 'base64'));
    const pull = await service.collaborationPull({ ...args, knownHeads: base.heads });
    assert.equal(pull.resetRequired, false);
    const converged = applyDocumentChanges(browser, pull.changesBase64.map((change) => Buffer.from(change, 'base64')));
    assert.deepEqual(getDocumentHeads(converged), opened.heads);
    assert.deepEqual(JSON.parse(JSON.stringify(converged)), JSON.parse(JSON.stringify(
        loadDocument(Buffer.from(opened.stateBase64, 'base64')),
    )));
    const artifacts = await readArtifacts();
    const retries = await Promise.all(requests.map((request) => restored.service.collaborationMergeMarkdown(request)));
    assert.ok(retries.every((result) => result.changed === false));
    assert.deepEqual(await readArtifacts(), artifacts);
});

test('SCRIPTA duplicate delivery retains generated structure once and cannot replay an undone proposal', async (t) => {
    const { service, args, makeRuntime, readArtifacts } = await createFixture(t);
    const base = await service.collaborationOpen(args);
    const request = proposal(args, base, 'First paragraph\n\nSecond paragraph\n\n## Added chapter\n\nThird paragraph');
    const other = makeRuntime();
    const results = await Promise.all([
        service.collaborationMergeMarkdown(request),
        other.service.collaborationMergeMarkdown(request),
    ]);
    assert.deepEqual(results.map((result) => result.changed).sort(), [false, true]);
    const accepted = results.find((result) => result.changed);
    assert.equal(accepted.projection.documentRevision, base.projection.documentRevision + 1);
    assert.equal(accepted.projection.chapters.length, 2);
    assert.equal(accepted.projection.chapters.flatMap((chapter) => chapter.paragraphs).length, 3);
    const artifacts = await readArtifacts();
    const canonical = loadDocument(artifacts[1]);
    assert.equal(Object.keys(canonical.scriptaMarkdownProposals).length, 1);
    assert.equal(canonical.scriptaUndoSnapshots.length, 1);
    assert.equal('scriptaMarkdownProposals' in canonical.scriptaUndoSnapshots[0].beforeModel, false);
    assert.equal('scriptaMarkdownProposals' in loadDocument(artifacts[2]), false);
    assert.doesNotMatch(artifacts[0].toString(), /scriptaMarkdownProposals/);

    const restored = makeRuntime();
    const retry = await restored.service.collaborationMergeMarkdown(request);
    assert.equal(retry.changed, false);
    assert.deepEqual(retry.projection, accepted.projection);
    assert.deepEqual(await readArtifacts(), artifacts);

    await restored.service.mutate({ ...args, operation: 'undo', args: {} });
    const undone = await restored.service.collaborationOpen(args);
    assert.equal(undone.projection.chapters.length, 1);
    assert.equal(currentText(undone), '');
    const afterUndo = await readArtifacts();
    const replay = await makeRuntime().service.collaborationMergeMarkdown(request);
    assert.equal(replay.changed, false);
    assert.equal(replay.markdown, undone.markdown);
    assert.deepEqual(await readArtifacts(), afterUndo);

    const newProposal = await restored.service.collaborationMergeMarkdown(proposal(args, undone,
        'First paragraph\n\nSecond paragraph\n\n## Added chapter\n\nThird paragraph'));
    assert.equal(newProposal.changed, true, 'A new base permits a new intentional proposal after undo.');
    assert.equal(newProposal.projection.chapters.length, 2);
});

test('SCRIPTA browser and Markdown proposals preserve the voted winner and keep retry receipts private', async (t) => {
    const { service, args, variantArgs, makeRuntime, readArtifacts } = await createFixture(t);
    const view = { mode: 'paragraph', chapterId: variantArgs.chapterId, paragraphId: variantArgs.paragraphId };
    const alternative = await service.mutate({
        ...args,
        view,
        operation: 'p-variant-add',
        args: { ...variantArgs, text: 'Winner' },
    });
    const winnerId = alternative.projection.paragraph.variants[1].id;
    await service.mutate({
        ...args,
        view,
        operation: 'p-variant-vote',
        args: { ...variantArgs, variantId: winnerId, type: 'like' },
    });
    const base = await service.collaborationOpen({ ...args, view });
    const browser = loadDocument(Buffer.from(base.stateBase64, 'base64'));
    const textPath = ['chapters', 0, 'paragraphs', 0, 'pluginState', 'scripta', 'variants', 1, 'text'];
    const edited = changeDocument(browser, (draft) => updateText(draft, textPath, 'Winner [browser]'));
    await service.collaborationApply({
        ...args,
        view,
        operation: 'p-variant-edit',
        args: { ...variantArgs, variantId: winnerId, text: 'Winner [browser]' },
        changesBase64: getDocumentChanges(browser, edited).map((change) => Buffer.from(change).toString('base64')),
        baseHeads: base.heads,
    });
    const request = proposal({ ...args, view }, base, 'Winner [agent]');
    const accepted = await service.collaborationMergeMarkdown(request);
    assert.match(accepted.projection.paragraph.currentText, /\[browser\]/);
    assert.match(accepted.projection.paragraph.currentText, /\[agent\]/);
    assert.equal(accepted.projection.paragraph.activeVariantId, winnerId);
    const winner = accepted.projection.paragraph.variants.find((variant) => variant.id === winnerId);
    assert.equal(winner.canEdit, true);
    assert.equal(winner.likes, 1);
    assert.equal(accepted.projection.paragraph.variants[0].text, '');
    const artifacts = await readArtifacts();
    assert.match(artifacts[0].toString(), /\[browser\]/);
    assert.match(artifacts[0].toString(), /\[agent\]/);
    const publicDocument = loadDocument(artifacts[2]);
    assert.equal('scriptaMarkdownProposals' in publicDocument, false);
    const publicState = publicDocument.chapters[0].paragraphs[0].pluginState.scripta;
    assert.ok(publicState.variants.every((variant) => !Object.hasOwn(variant, 'createdBy')));
    assert.deepEqual(publicState.reactionsByVariant, {});
    const forged = changeDocument(publicDocument, (draft) => {
        updateText(draft, textPath, 'Forged receipt');
        draft.scriptaMarkdownProposals = { ['a'.repeat(64)]: true };
    });
    await assert.rejects(service.collaborationApply({
        ...args,
        view,
        operation: 'p-variant-edit',
        args: { ...variantArgs, variantId: winnerId, text: 'Forged receipt' },
        changesBase64: getDocumentChanges(publicDocument, forged).map((change) => Buffer.from(change).toString('base64')),
        baseHeads: accepted.heads,
    }), /outside the selected variant text/);
    assert.deepEqual(await readArtifacts(), artifacts);
    const retry = await makeRuntime().service.collaborationMergeMarkdown(request);
    assert.equal(retry.changed, false);
    assert.deepEqual(retry.projection, accepted.projection);
    assert.deepEqual(await readArtifacts(), artifacts);
});

test('SCRIPTA failed public commits roll back proposal receipts and allow a restored retry', async (t) => {
    let failPublicCommit = false;
    const controlledFs = new Proxy(fs, {
        get(target, property) {
            if (property !== 'rename') return target[property];
            return async (source, destination) => {
                if (failPublicCommit && String(destination).includes(`${path.sep}scripta-collaboration${path.sep}`)) {
                    throw new Error('public replica unavailable');
                }
                return target.rename(source, destination);
            };
        },
    });
    const { service, args, makeRuntime, readArtifacts } = await createFixture(t, controlledFs);
    const base = await service.collaborationOpen(args);
    const request = proposal(args, base, 'Retry after failed commit');
    const artifacts = await readArtifacts();
    failPublicCommit = true;
    await assert.rejects(service.collaborationMergeMarkdown(request), /public replica unavailable/);
    assert.deepEqual(await readArtifacts(), artifacts);
    failPublicCommit = false;
    const restored = makeRuntime();
    const retry = await restored.service.collaborationMergeMarkdown(request);
    assert.equal(retry.changed, true);
    assert.equal(currentText(retry), 'Retry after failed commit');
    assert.equal(retry.projection.documentRevision, base.projection.documentRevision + 1);
    const acceptedArtifacts = await readArtifacts();
    assert.equal(Object.keys(loadDocument(acceptedArtifacts[1]).scriptaMarkdownProposals).length, 1);
    const repeated = await makeRuntime().service.collaborationMergeMarkdown(request);
    assert.equal(repeated.changed, false);
    assert.deepEqual(await readArtifacts(), acceptedArtifacts);
});

test('SCRIPTA proposal receipts outlive the five-entry undo history and repeated compaction', async (t) => {
    const { service, args, variantArgs, makeRuntime, readArtifacts } = await createFixture(t);
    const base = await service.collaborationOpen(args);
    const request = proposal(args, base, 'Original proposal');
    await service.collaborationMergeMarkdown(request);
    for (let index = 0; index < 7; index += 1) {
        await service.mutate({
            ...args,
            operation: 'p-variant-add',
            args: { ...variantArgs, text: `Later variant ${index}` },
        });
    }
    const opened = await service.collaborationOpen(args);
    assert.equal(opened.projection.documentRevision, base.projection.documentRevision + 8);
    const artifacts = await readArtifacts();
    const canonical = loadDocument(artifacts[1]);
    assert.equal(canonical.scriptaUndoSnapshots.length, 5);
    assert.equal(Object.keys(canonical.scriptaMarkdownProposals).length, 1);
    const restored = makeRuntime();
    const retry = await restored.service.collaborationMergeMarkdown(request);
    assert.equal(retry.changed, false);
    assert.deepEqual(retry.projection, opened.projection);
    assert.deepEqual(retry.heads, opened.heads);
    assert.deepEqual(await readArtifacts(), artifacts);
});

test('SCRIPTA validates foreign document identity and history even when a receipt is present', async (t) => {
    const { service, args, workspaceRoot, readArtifacts } = await createFixture(t);
    const base = await service.collaborationOpen(args);
    const foreignBases = [
        createDocument({ documentId: 'document-foreign' }),
        createDocument({ documentId: base.documentId }),
    ];
    const requests = foreignBases.map((document) => proposal(args, {
        stateBase64: Buffer.from(saveDocument(document)).toString('base64'),
    }, 'Must not be accepted'));
    const canonicalPath = path.join(workspaceRoot, '.data/agents/explorer/automerge/documents', `${base.documentId}.automerge`);
    const canonical = loadDocument(await fs.readFile(canonicalPath));
    // Seed real private state with matching receipts to prove that a positive
    // receipt lookup cannot bypass document/history validation.
    const seeded = changeDocument(canonical, (draft) => {
        draft.scriptaMarkdownProposals = {};
        foreignBases.forEach((document, index) => {
            const id = crypto.createHash('sha256').update(JSON.stringify([
                document.documentId,
                getDocumentHeads(document).sort(),
                requests[index].markdown.trim(),
                args.participant.hash,
            ])).digest('hex');
            draft.scriptaMarkdownProposals[id] = true;
        });
    });
    await fs.writeFile(canonicalPath, saveDocument(seeded));
    const artifacts = await readArtifacts();
    await assert.rejects(service.collaborationMergeMarkdown(requests[0]), /belongs to another document/);
    await assert.rejects(service.collaborationMergeMarkdown(requests[1]), /not part of the current document history/);
    assert.deepEqual(await readArtifacts(), artifacts);
});
