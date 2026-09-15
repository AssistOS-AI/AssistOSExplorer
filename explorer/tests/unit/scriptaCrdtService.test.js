import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMarkdownCrdtStore } from '../../utils/server/markdown-crdt/markdown-crdt-store.mjs';
import { createScriptaCrdtService } from '../../utils/server/markdown-crdt/scripta-crdt-service.mjs';
import { normalizeOptionalTransportEnum } from '../../utils/server/schemas.mjs';
import {
    applyDocumentChanges,
    changeDocument,
    createDocument,
    getDocumentChanges,
    getDocumentChangesSince,
    getDocumentHeads,
    loadDocument,
    updateText,
} from '../../utils/server/markdown-crdt/automerge-adapter.mjs';

test('Explorer MCP manifests expose only canonical SCRIPTA mutation operations', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const collaborationTool = config.tools.find(({ name }) => name === 'scripta_collaboration_apply');
    const markdownMergeTool = config.tools.find(({ name }) => name === 'scripta_collaboration_merge_markdown');
    const mutationTool = config.tools.find(({ name }) => name === 'scripta_crdt_mutate');

    assert.deepEqual(collaborationTool?.inputSchema?.operation?.enum, ['p-variant-edit']);
    assert.equal(markdownMergeTool?.tags?.includes('internal'), true);
    assert.equal(config.tools.some(({ name }) => name === 'webmeet_scripta_write_markdown'), false);
    assert.deepEqual(mutationTool?.inputSchema?.operation?.enum, [
        'p-variant-add',
        'p-variant-vote',
        'p-variant-vote-withdraw',
        'p-variant-edit',
        'p-variant-delete',
        'p-variant-image-insert',
        'p-variant-image-replace',
        'p-variant-image-delete',
        'p-variant-image-layout',
        'chapter-add',
        'chapter-delete',
        'chapter-rename',
        'chapter-move',
        'paragraph-add',
        'paragraph-delete',
        'paragraph-move',
        'undo',
    ]);
    assert.deepEqual(mutationTool?.inputSchema?.args?.properties?.alignment?.enum, ['left', 'center', 'right']);
    assert.deepEqual(mutationTool?.inputSchema?.args?.properties?.aspectRatio?.enum, ['auto', '1:1', '4:3', '3:2', '16:9']);
    assert.equal(mutationTool?.inputSchema?.args?.properties?.showCaption?.type, 'boolean');
    assert.equal(mutationTool?.inputSchema?.args?.properties?.widthPercent?.type, 'number');
});

test('SCRIPTA transport treats empty optional enum values as omitted', () => {
    assert.equal(normalizeOptionalTransportEnum(''), undefined);
    assert.equal(normalizeOptionalTransportEnum(null), undefined);
    assert.equal(normalizeOptionalTransportEnum(undefined), undefined);
    assert.equal(normalizeOptionalTransportEnum('16:9'), '16:9');
    assert.equal(normalizeOptionalTransportEnum('cover'), 'cover');
    assert.equal(normalizeOptionalTransportEnum('right'), 'right');
});

test('collaboration open initializes plain Markdown with the authenticated viewer as variant owner', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-collaboration-open-'));
    const validatePath = async (input) => {
        const target = path.resolve(workspaceRoot, String(input || '').replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const service = createScriptaCrdtService({
        fs,
        path,
        workspaceRoot,
        validatePath,
        markdownCrdtStore: store,
    });

    try {
        await fs.mkdir(path.join(workspaceRoot, 'documents'), { recursive: true });
        await fs.writeFile(
            path.join(workspaceRoot, 'documents', 'plain.md'),
            '# Plain document\n\nParagraph without SCRIPTA metadata.\n',
            'utf8',
        );
        const args = {
            path: '/documents/plain.md',
            resourceId: 'resource-plain',
            viewerHash: 'participant-owner',
            view: { mode: 'document' },
        };
        const opened = await service.collaborationOpen(args);
        const publicDocument = loadDocument(Buffer.from(opened.stateBase64, 'base64'));
        const publicVariant = publicDocument.chapters[0].paragraphs[0].pluginState.scripta.variants[0];
        assert.equal(publicVariant.text, 'Paragraph without SCRIPTA metadata.');
        assert.equal(Object.hasOwn(publicVariant, 'createdBy'), false);

        const persisted = await fs.readFile(path.join(workspaceRoot, 'documents', 'plain.md'), 'utf8');
        assert.match(persisted, /"createdBy":"participant-owner"/);
        const reopened = await service.collaborationOpen(args);
        const reopenedDocument = loadDocument(Buffer.from(reopened.stateBase64, 'base64'));
        assert.equal(
            reopenedDocument.chapters[0].paragraphs[0].pluginState.scripta.variants[0].id,
            publicVariant.id,
        );
        await assert.rejects(
            service.collaborationOpen({ ...args, viewerHash: '' }),
            /authenticated viewer identity/,
        );
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('Markdown proposals sharing a base merge independently and retries remain no-ops after restart', async (t) => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-proposal-retry-'));
    t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
    const validatePath = async (input) => {
        const candidate = String(input || '');
        const target = candidate.startsWith(`${workspaceRoot}${path.sep}`)
            ? path.resolve(candidate)
            : path.resolve(workspaceRoot, candidate.replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const openService = () => createScriptaCrdtService({
        fs, path, workspaceRoot, validatePath,
        markdownCrdtStore: createMarkdownCrdtStore({
            fs, path, workspaceRoot, validatePath,
            writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
            invalidateCachesForPath() {},
        }),
    });
    const participant = { id: 'user-1', hash: 'participant-user-1', label: 'User' };
    const args = { path: '/notes.md', participant, viewerHash: participant.hash, resourceId: 'notes' };
    const service = openService();
    await service.create({ ...args, title: 'Notes', template: 'general', createdBy: participant.hash });
    const base = await service.collaborationOpen(args);
    const firstRequest = {
        ...args, baseStateBase64: base.stateBase64,
        markdown: '# Notes\n\n## Chapter 1\n\nShared notes\n\n## First addition\n\nFirst proposal details',
    };
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const first = await service.collaborationMergeMarkdown(firstRequest);
    assert.equal(first.changed, true);
    assert.match(first.markdown, /First proposal details/);
    t.mock.timers.tick(2000);
    const second = await service.collaborationMergeMarkdown({
        ...firstRequest,
        markdown: '# Notes\n\n## Chapter 1\n\nShared notes\n\n## Second addition\n\nSecond proposal details',
    });
    assert.equal(second.changed, true);
    assert.match(second.markdown, /First proposal details/);
    assert.match(second.markdown, /Second proposal details/);
    const committed = await fs.readFile(path.join(workspaceRoot, 'notes.md'), 'utf8');
    const restarted = openService();
    t.mock.timers.tick(2000);
    const retry = await restarted.collaborationMergeMarkdown(firstRequest);
    assert.equal(retry.changed, false);
    assert.equal(retry.markdown, second.markdown);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes.md'), 'utf8'), committed);
});

test('SCRIPTA mutations use the Explorer Automerge authority and persist the winning variant', async (t) => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-crdt-'));
    const validatePath = async (input) => {
        const candidate = String(input || '');
        const target = path.isAbsolute(candidate) && candidate.startsWith(`${workspaceRoot}${path.sep}`)
            ? path.resolve(candidate)
            : path.resolve(workspaceRoot, candidate.replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const service = createScriptaCrdtService({
        fs,
        path,
        workspaceRoot,
        validatePath,
        markdownCrdtStore: store,
    });
    const participant = { id: 'user-1', hash: 'participant-user-1', label: 'User' };

    try {
        await service.ensureFolder({ folderPath: '/WebMeet/room-1234' });
        const created = await service.create({
            path: '/WebMeet/room-1234/draft.md',
            title: 'Draft',
            template: 'general',
            createdBy: participant.hash,
            resourceId: 'resource-1',
            viewerHash: participant.hash,
        });
        const chapter = created.projection.chapters[0];
        const paragraph = chapter.paragraphs[0];
        const beforeAlternative = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        const initialCollaborationDocument = loadDocument(
            Buffer.from(beforeAlternative.stateBase64, 'base64')
        );
        const initialVariant = initialCollaborationDocument.chapters[0].paragraphs[0]
            .pluginState.scripta.variants[0];
        assert.equal(Object.hasOwn(initialVariant, 'text'), true);
        assert.equal(initialVariant.text, '');
        assert.equal(Object.hasOwn(initialVariant, 'createdBy'), false);
        assert.deepEqual(
            initialCollaborationDocument.chapters[0].paragraphs[0].pluginState.scripta.reactionsByVariant,
            {},
        );
        const alternative = await service.mutate({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'p-variant-add',
            args: { chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId, text: 'Alternative text' },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        const alternativePull = await service.collaborationPull({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            knownHeads: beforeAlternative.heads,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        assert.equal(alternativePull.resetRequired, false);
        assert.equal('stateBase64' in alternativePull, false);
        assert.equal('projection' in alternativePull, false);
        assert.ok(
            alternativePull.changesBase64.reduce(
                (total, change) => total + Buffer.from(change, 'base64').byteLength,
                0
            ) < 16 * 1024,
            'A small variant mutation must not retransmit the complete collaboration document.'
        );
        const variantId = alternative.projection.paragraph.variants[1].id;
        const voted = await service.mutate({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'p-variant-vote',
            args: { chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId, variantId, type: 'like' },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });

        assert.equal(voted.projection.paragraph.currentText, 'Alternative text');
        assert.equal(voted.projection.paragraph.activeVariantId, variantId);
        assert.match(await fs.readFile(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md'), 'utf8'), /Alternative text/);
        const collaborationAfterVote = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        const publicDocumentAfterVote = loadDocument(
            Buffer.from(collaborationAfterVote.stateBase64, 'base64')
        );
        const publicScriptaAfterVote = publicDocumentAfterVote.chapters[0].paragraphs[0]
            .pluginState.scripta;
        assert.ok(publicScriptaAfterVote.variants.every(
            (variant) => !Object.hasOwn(variant, 'createdBy')
        ));
        assert.deepEqual(publicScriptaAfterVote.reactionsByVariant, {});
        const restartedService = createScriptaCrdtService({
            fs,
            path,
            workspaceRoot,
            validatePath,
            markdownCrdtStore: store,
        });
        const undone = await restartedService.mutate({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'undo',
            args: {},
            participant,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        assert.notEqual(undone.projection.paragraph.activeVariantId, variantId);
        assert.equal((await store.open('/WebMeet/room-1234/draft.md')).documentId, created.documentId);

        const collaboration = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        const browserDocument = loadDocument(
            Buffer.from(collaboration.stateBase64, 'base64'),
            { actor: crypto.randomBytes(16).toString('hex') }
        );
        const browserEdited = changeDocument(browserDocument, (draft) => {
            const target = draft.chapters[0].paragraphs[0].pluginState.scripta.variants
                .find((variant) => variant.id === draft.chapters[0].paragraphs[0].pluginState.scripta.activeVariantId);
            target.text = 'Edited in the browser replica';
        });
        const activeVariantId = browserDocument.chapters[0].paragraphs[0].pluginState.scripta.activeVariantId;
        const applied = await service.collaborationApply({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'p-variant-edit',
            changesBase64: getDocumentChanges(browserDocument, browserEdited)
                .map((change) => Buffer.from(change).toString('base64')),
            baseHeads: collaboration.heads,
            args: {
                chapterId: chapter.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: activeVariantId,
                text: 'Edited in the browser replica',
            },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        assert.equal(applied.projection.paragraph.currentText, 'Edited in the browser replica');
        assert.match(await fs.readFile(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md'), 'utf8'), /Edited in the browser replica/);
        assert.equal('stateBase64' in applied, false);
        const browserAfterApply = applyDocumentChanges(
            browserEdited,
            applied.changesBase64.map((change) => Buffer.from(change, 'base64'))
        );
        assert.equal('path' in browserAfterApply, false);
        assert.deepEqual(getDocumentHeads(browserAfterApply), applied.heads);
        const unauthorizedBrowserEdit = changeDocument(browserAfterApply, (draft) => {
            const target = draft.chapters[0].paragraphs[0].pluginState.scripta.variants
                .find((variant) => variant.id === activeVariantId);
            target.text = 'Unauthorized edit';
        });
        const otherParticipant = {
            id: 'user-2',
            hash: 'participant-user-2',
            label: 'Other user',
        };
        await assert.rejects(
            service.collaborationApply({
                path: '/WebMeet/room-1234/draft.md',
                resourceId: 'resource-1',
                operation: 'p-variant-edit',
                changesBase64: getDocumentChanges(browserAfterApply, unauthorizedBrowserEdit)
                    .map((change) => Buffer.from(change).toString('base64')),
                baseHeads: applied.heads,
                args: {
                    chapterId: chapter.chapterId,
                    paragraphId: paragraph.paragraphId,
                    variantId: activeVariantId,
                    text: 'Unauthorized edit',
                },
                participant: otherParticipant,
                viewerHash: otherParticipant.hash,
                view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
            }),
            (error) => error?.code === 'scripta_variant_forbidden'
        );

        const concurrentTextBase = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        const concurrentBrowserDocument = loadDocument(
            Buffer.from(concurrentTextBase.stateBase64, 'base64'),
            { actor: crypto.randomBytes(16).toString('hex') },
        );
        const concurrentParagraph = concurrentBrowserDocument.chapters[0].paragraphs[0];
        const concurrentVariantId = concurrentParagraph.pluginState.scripta.activeVariantId;
        const concurrentVariantIndex = concurrentParagraph.pluginState.scripta.variants
            .findIndex((variant) => variant.id === concurrentVariantId);
        const concurrentBaseText = concurrentParagraph.pluginState.scripta.variants[concurrentVariantIndex].text;
        const browserConcurrentText = `${concurrentBaseText} [browser addition]`;
        const concurrentBrowserEdited = changeDocument(concurrentBrowserDocument, (draft) => {
            updateText(draft, [
                'chapters', 0, 'paragraphs', 0,
                'pluginState', 'scripta', 'variants', concurrentVariantIndex, 'text',
            ], browserConcurrentText);
        });
        await service.collaborationApply({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'p-variant-edit',
            changesBase64: getDocumentChanges(concurrentBrowserDocument, concurrentBrowserEdited)
                .map((change) => Buffer.from(change).toString('base64')),
            baseHeads: concurrentTextBase.heads,
            args: {
                chapterId: chapter.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: concurrentVariantId,
                text: browserConcurrentText,
            },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        const concurrentTextMerged = await service.collaborationMergeMarkdown({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            markdown: `# Draft\n\n## Chapter 1\n\n${concurrentBaseText} [agent addition]`,
            baseStateBase64: concurrentTextBase.stateBase64,
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        assert.match(concurrentTextMerged.markdown, /\[browser addition\]/);
        assert.match(concurrentTextMerged.markdown, /\[agent addition\]/);

        const meetingNotesBase = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        await service.mutate({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'paragraph-add',
            args: { chapterId: chapter.chapterId, text: 'Manual note added while the agent was working' },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
        const meetingNotesMerged = await service.collaborationMergeMarkdown({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            markdown: '# Reconciled meeting\n\n## Chapter 1\n\nAgent cumulative notes',
            baseStateBase64: meetingNotesBase.stateBase64,
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        assert.equal(meetingNotesMerged.changed, true);
        assert.match(meetingNotesMerged.markdown, /^# Draft/m);
        assert.match(meetingNotesMerged.markdown, /Agent cumulative notes/);
        assert.match(meetingNotesMerged.markdown, /Manual note added while the agent was working/);
        const savedMeetingNotes = await fs.readFile(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md'), 'utf8');
        assert.match(savedMeetingNotes, /achilles-ide-document/);
        assert.match(savedMeetingNotes, /Agent cumulative notes/);
        assert.match(savedMeetingNotes, /Manual note added while the agent was working/);
        t.mock.timers.tick(2000);
        const repeatedMeetingNotesMerge = await service.collaborationMergeMarkdown({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            markdown: '# Reconciled meeting\n\n## Chapter 1\n\nAgent cumulative notes',
            baseStateBase64: meetingNotesBase.stateBase64,
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        assert.equal(repeatedMeetingNotesMerge.changed, false);
        assert.equal(repeatedMeetingNotesMerge.markdown, meetingNotesMerged.markdown);
        t.mock.timers.reset();
        assert.equal(
            await fs.readFile(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md'), 'utf8'),
            savedMeetingNotes,
        );
        const canonicalState = loadDocument(await fs.readFile(path.join(
            workspaceRoot,
            '.data/explorer/automerge/documents',
            `${created.documentId}.automerge`
        )));
        assert.equal('scriptaHistory' in canonicalState, false);
        assert.equal('scriptaUndoHeads' in canonicalState, false);
        assert.ok(Array.isArray(canonicalState.scriptaUndoSnapshots));
        assert.ok(canonicalState.scriptaUndoSnapshots.length <= 5);
        assert.ok(canonicalState.scriptaUndoSnapshots.every((entry) => (
            entry.beforeModel
            && typeof entry.beforeModel === 'object'
            && typeof entry.afterModelHash === 'string'
            && entry.afterModelHash.length > 0
        )));
        assert.ok(getDocumentChangesSince(canonicalState, []).length <= 3);

        const secondStore = createMarkdownCrdtStore({
            fs,
            path,
            workspaceRoot,
            validatePath,
            writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
            invalidateCachesForPath() {},
        });
        const secondService = createScriptaCrdtService({
            fs,
            path,
            workspaceRoot,
            validatePath,
            markdownCrdtStore: secondStore,
        });
        await Promise.all([
            service.mutate({
                path: '/WebMeet/room-1234/draft.md',
                resourceId: 'resource-1',
                operation: 'p-variant-add',
                args: { chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId, text: 'Concurrent A' },
                participant,
                viewerHash: participant.hash,
                view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
            }),
            secondService.mutate({
                path: '/WebMeet/room-1234/draft.md',
                resourceId: 'resource-1',
                operation: 'p-variant-add',
                args: { chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId, text: 'Concurrent B' },
                participant,
                viewerHash: participant.hash,
                view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
            }),
        ]);
        const concurrentProjection = await service.open({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: chapter.chapterId, paragraphId: paragraph.paragraphId },
        });
        assert.ok(concurrentProjection.projection.paragraph.variants.some((variant) => variant.text === 'Concurrent A'));
        assert.ok(concurrentProjection.projection.paragraph.variants.some((variant) => variant.text === 'Concurrent B'));

        const beforeStructuralChange = await service.collaborationOpen({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        const unrelatedDocument = changeDocument(createDocument({}), (draft) => {
            draft.unrelated = true;
        });
        const unrelatedPull = await service.collaborationPull({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            knownHeads: getDocumentHeads(unrelatedDocument),
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        assert.equal(unrelatedPull.resetRequired, true);
        assert.deepEqual(unrelatedPull.changesBase64, []);
        const staleBrowserDocument = loadDocument(Buffer.from(beforeStructuralChange.stateBase64, 'base64'));
        const addedChapter = await service.mutate({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'chapter-add',
            args: {},
            participant,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        const pulled = await service.collaborationPull({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            knownHeads: beforeStructuralChange.heads,
            viewerHash: participant.hash,
            view: { mode: 'document' },
        });
        assert.equal(pulled.resetRequired, false);
        assert.equal('stateBase64' in pulled, false);
        assert.equal('projection' in pulled, false);
        const pulledBrowserDocument = applyDocumentChanges(
            staleBrowserDocument,
            pulled.changesBase64.map((change) => Buffer.from(change, 'base64'))
        );
        assert.deepEqual(getDocumentHeads(pulledBrowserDocument).sort(), [...pulled.heads].sort());
        const newChapterId = addedChapter.focusTarget.chapterId;
        const newParagraphId = addedChapter.focusTarget.paragraphId;
        const pulledChapter = pulledBrowserDocument.chapters.find((entry) => entry.id === newChapterId);
        const pulledParagraph = pulledChapter.paragraphs.find((entry) => entry.id === newParagraphId);
        const pulledVariantId = pulledParagraph.pluginState.scripta.activeVariantId;
        const browserAfterFirstVariantEdit = changeDocument(pulledBrowserDocument, (draft) => {
            draft.chapters.find((entry) => entry.id === newChapterId)
                .paragraphs.find((entry) => entry.id === newParagraphId)
                .pluginState.scripta.variants.find((entry) => entry.id === pulledVariantId)
                .text = 'First variant after structural pull';
        });
        const structuralEdit = await service.collaborationApply({
            path: '/WebMeet/room-1234/draft.md',
            resourceId: 'resource-1',
            operation: 'p-variant-edit',
            changesBase64: getDocumentChanges(pulledBrowserDocument, browserAfterFirstVariantEdit)
                .map((change) => Buffer.from(change).toString('base64')),
            baseHeads: pulled.heads,
            args: {
                chapterId: newChapterId,
                paragraphId: newParagraphId,
                variantId: pulledVariantId,
                text: 'First variant after structural pull',
            },
            participant,
            viewerHash: participant.hash,
            view: { mode: 'paragraph', chapterId: newChapterId, paragraphId: newParagraphId },
        });
        assert.equal(structuralEdit.projection.paragraph.currentText, 'First variant after structural pull');

        await store.mutateAndSave({
            path: '/WebMeet/room-1234/draft.md',
        }, (model) => ({
            ...model,
            preface: 'Advanced Editor change after the SCRIPTA operation',
        }));
        await assert.rejects(
            service.mutate({
                path: '/WebMeet/room-1234/draft.md',
                resourceId: 'resource-1',
                operation: 'undo',
                args: {},
                participant,
                viewerHash: participant.hash,
                view: { mode: 'paragraph', chapterId: newChapterId, paragraphId: newParagraphId },
            }),
            (error) => error?.code === 'scripta_undo_conflict'
        );
        assert.equal(
            (await store.open('/WebMeet/room-1234/draft.md')).model.preface,
            'Advanced Editor change after the SCRIPTA operation'
        );

        const rollbackPrepared = await service.remove({
            phase: 'prepare',
            documentId: created.documentId,
            path: '/WebMeet/room-1234/draft.md'
        });
        assert.ok(rollbackPrepared.transactionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const recoveryStore = createMarkdownCrdtStore({
            fs,
            path,
            workspaceRoot,
            validatePath,
            writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
            invalidateCachesForPath() {},
            transactionStaleMs: 1,
        });
        await recoveryStore.open('/WebMeet/room-1234/draft.md');
        assert.equal((await fs.stat(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md'))).isFile(), true);
        const collaborationPath = path.join(
            workspaceRoot,
            '.data/explorer/automerge/scripta-collaboration',
            `${created.documentId}.automerge`
        );
        assert.equal((await fs.stat(collaborationPath)).isFile(), true);

        const commitPrepared = await service.remove({
            phase: 'prepare',
            documentId: created.documentId,
            path: '/WebMeet/room-1234/draft.md'
        });
        await service.remove({ phase: 'commit', transactionId: commitPrepared.transactionId });
        await assert.rejects(fs.stat(path.join(workspaceRoot, 'WebMeet/room-1234/draft.md')), /ENOENT/);
        await assert.rejects(fs.stat(collaborationPath), /ENOENT/);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('SCRIPTA creation removes every artifact when the collaboration replica cannot be created', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-create-rollback-'));
    const controlledFs = new Proxy(fs, {
        get(target, property) {
            if (property !== 'rename') return target[property];
            return async (source, destination) => {
                if (String(destination).includes(`${path.sep}scripta-collaboration${path.sep}`)) {
                    throw new Error('public replica unavailable');
                }
                return target.rename(source, destination);
            };
        },
    });
    const validatePath = async (input) => {
        const target = path.resolve(workspaceRoot, String(input || '').replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => controlledFs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const service = createScriptaCrdtService({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        markdownCrdtStore: store,
    });

    try {
        await service.ensureFolder({ folderPath: '/WebMeet/create-rollback' });
        await assert.rejects(service.create({
            path: '/WebMeet/create-rollback/draft.md',
            title: 'Draft',
            template: 'general',
            createdBy: 'participant-user-1',
            resourceId: 'resource-1',
            viewerHash: 'participant-user-1',
        }), /public replica unavailable/);
        await assert.rejects(
            fs.stat(path.join(workspaceRoot, 'WebMeet/create-rollback/draft.md')),
            /ENOENT/
        );
        const canonicalFiles = await fs.readdir(path.join(
            workspaceRoot,
            '.data/explorer/automerge/documents'
        )).catch(() => []);
        const collaborationFiles = await fs.readdir(path.join(
            workspaceRoot,
            '.data/explorer/automerge/scripta-collaboration'
        )).catch(() => []);
        assert.equal(canonicalFiles.filter((name) => name.endsWith('.automerge')).length, 0);
        assert.equal(collaborationFiles.filter((name) => name.endsWith('.automerge')).length, 0);
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('SCRIPTA creation and open share one path lock after the document id becomes visible', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-lock-'));
    let releaseReplica;
    let replicaWriteStarted;
    const replicaGate = new Promise((resolve) => { releaseReplica = resolve; });
    const replicaStarted = new Promise((resolve) => { replicaWriteStarted = resolve; });
    let holdReplica = true;
    const controlledFs = new Proxy(fs, {
        get(target, property) {
            if (property !== 'rename') return target[property];
            return async (source, destination) => {
                if (
                    holdReplica
                    && String(destination).includes(`${path.sep}scripta-collaboration${path.sep}`)
                ) {
                    replicaWriteStarted();
                    await replicaGate;
                    holdReplica = false;
                }
                return target.rename(source, destination);
            };
        },
    });
    const validatePath = async (input) => {
        const target = path.resolve(workspaceRoot, String(input || '').replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const makeStore = () => createMarkdownCrdtStore({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => controlledFs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const service = createScriptaCrdtService({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        markdownCrdtStore: makeStore(),
    });
    const secondStore = makeStore();

    try {
        await service.ensureFolder({ folderPath: '/WebMeet/lock' });
        const creation = service.create({
            path: '/WebMeet/lock/draft.md',
            title: 'Draft',
            template: 'general',
            createdBy: 'participant-user-1',
            resourceId: 'resource-1',
            viewerHash: 'participant-user-1',
        });
        await replicaStarted;
        let openSettled = false;
        const opening = secondStore.open('/WebMeet/lock/draft.md').finally(() => {
            openSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(openSettled, false);
        releaseReplica();
        const [created, opened] = await Promise.all([creation, opening]);
        assert.equal(opened.documentId, created.documentId);
    } finally {
        releaseReplica();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('Markdown CRDT recovers a recent lock left by a restarted process instance', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-restart-lock-'));
    const validatePath = async (input) => {
        const target = path.resolve(workspaceRoot, String(input || '').replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const documentPath = path.join(workspaceRoot, 'restart.md');
    const lockRoot = path.join(workspaceRoot, '.data/explorer/automerge/documents/.locks');
    const scope = `path:${documentPath}`;
    const lockPath = path.join(lockRoot, `${crypto.createHash('sha256').update(scope).digest('hex')}.lock`);

    try {
        await fs.writeFile(documentPath, '# Restart\n', 'utf8');
        await store.open('/restart.md');
        await fs.mkdir(lockRoot, { recursive: true });
        await fs.writeFile(lockPath, JSON.stringify({
            token: crypto.randomUUID(),
            instanceId: 'previous-explorer-process',
            hostname: os.hostname(),
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
        }), 'utf8');

        const startedAt = Date.now();
        const opened = await store.open('/restart.md');
        assert.ok(opened.documentId);
        assert.ok(Date.now() - startedAt < 1_000, 'restart lock should be recovered without waiting for its TTL');
        await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('SCRIPTA mutation rolls back canonical state when public replica commit fails', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-scripta-rollback-'));
    let failPublicCommit = false;
    const controlledFs = new Proxy(fs, {
        get(target, property) {
            if (property !== 'rename') return target[property];
            return async (source, destination) => {
                if (
                    failPublicCommit
                    && String(destination).includes(`${path.sep}scripta-collaboration${path.sep}`)
                ) {
                    throw new Error('public replica unavailable');
                }
                return target.rename(source, destination);
            };
        },
    });
    const validatePath = async (input) => {
        const target = path.resolve(workspaceRoot, String(input || '').replace(/^\/+/, ''));
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
            throw new Error('Path outside workspace.');
        }
        return target;
    };
    const store = createMarkdownCrdtStore({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        writeFileContent: (target, content) => controlledFs.writeFile(target, content, 'utf8'),
        invalidateCachesForPath() {},
    });
    const service = createScriptaCrdtService({
        fs: controlledFs,
        path,
        workspaceRoot,
        validatePath,
        markdownCrdtStore: store,
    });
    const documentPath = '/WebMeet/rollback/draft.md';
    const participant = { id: 'user-1', hash: 'participant-user-1', label: 'User' };

    try {
        await service.ensureFolder({ folderPath: '/WebMeet/rollback' });
        const created = await service.create({
            path: documentPath,
            title: 'Draft',
            template: 'general',
            createdBy: participant.hash,
            resourceId: 'resource-1',
            viewerHash: participant.hash,
        });
        const chapter = created.projection.chapters[0];
        const paragraph = chapter.paragraphs[0];
        failPublicCommit = true;

        await assert.rejects(
            service.mutate({
                path: documentPath,
                resourceId: 'resource-1',
                operation: 'p-variant-add',
                args: {
                    chapterId: chapter.chapterId,
                    paragraphId: paragraph.paragraphId,
                    text: 'Must not survive',
                },
                participant,
                viewerHash: participant.hash,
                view: {
                    mode: 'paragraph',
                    chapterId: chapter.chapterId,
                    paragraphId: paragraph.paragraphId,
                },
            }),
            /public replica unavailable/
        );

        failPublicCommit = false;
        const reopened = await service.open({
            path: documentPath,
            resourceId: 'resource-1',
            viewerHash: participant.hash,
            view: {
                mode: 'paragraph',
                chapterId: chapter.chapterId,
                paragraphId: paragraph.paragraphId,
            },
        });
        assert.equal(reopened.projection.documentRevision, created.projection.documentRevision);
        assert.equal(reopened.projection.paragraph.variants.length, 1);
        assert.doesNotMatch(
            await fs.readFile(path.join(workspaceRoot, 'WebMeet/rollback/draft.md'), 'utf8'),
            /Must not survive/
        );
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});
