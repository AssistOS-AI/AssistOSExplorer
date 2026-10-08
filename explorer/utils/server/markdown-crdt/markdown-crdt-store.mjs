import crypto from 'node:crypto';
import os from 'node:os';

import { generateId } from '../../../services/document/idUtils.js';
import {
  changeDocument,
  changeDocumentAtHeads,
  createText,
  createDocument,
  documentHasHeads,
  getDocumentHeads,
  loadDocument,
  mergeDocuments,
  saveDocument,
  viewDocumentAtHeads
} from './automerge-adapter.mjs';
import {
  materializeMarkdownModel,
  parseMarkdownState,
  serializeMarkdownState,
  updateMarkdownModelInDraft,
  writeMarkdownModelToDraft
} from './markdown-crdt-model.mjs';
import { createExplorerPrivateDataBoundary } from '../private-data-boundary.mjs';

const STORE_ROOT = ['.data', 'explorer', 'automerge', 'documents'];
const DELETION_ROOT = 'pending-deletions';
const STORE_LOCK_DIRECTORY = '.locks';
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_RETRY_MS = 20;
const MAX_SCRIPTA_UNDO_STEPS = 5;
const TRANSACTION_STALE_MS = 5 * 60_000;
const PROCESS_INSTANCE_ID = crypto.randomUUID();
// Tokens of document locks currently held by a live operation in this process. A lock file that names this
// process but carries a token outside this set was leaked (for example by a failed release in a warm tool
// worker, where the pid stays alive) and is stale.
const HELD_LOCK_TOKENS = new Set();
// Set when a lock release could not be confirmed (the lock file may remain). A warm tool worker keeps its
// pid alive, so other workers would see a live owner; the worker adapter reads this process-wide flag and
// asks the pool to recycle the worker after the call. A Symbol.for key keeps it independent of module identity.
export const UNCONFIRMED_LOCK_RELEASE_KEY = Symbol.for('assistos.explorer.unconfirmedLockRelease');
const PROCESS_STARTED_AT_MS = Date.now() - Math.max(0, Number(process.uptime?.() || 0) * 1_000);

function isMarkdownPath(filePath, pathApi) {
  return pathApi.extname(String(filePath || '')).toLowerCase() === '.md';
}

function normalizeDocumentId(value = '') {
  const id = String(value || '').trim();
  if (!id) return '';
  return id.replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function pathExists(fsApi, filePath) {
  try {
    await fsApi.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function getVersionKey(stats) {
  if (!stats) return '';
  return `${Math.round(stats.mtimeMs)}:${stats.size}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== 'updatedAt')
      .sort()
      .map((key) => [key, canonicalJson(value[key])])
  );
}

function modelDigest(model) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(model))).digest('hex');
}

function ensureDocumentId(model) {
  return materializeMarkdownModel(model || {});
}

function modelFromMarkdown(markdown) {
  return parseMarkdownState(String(markdown ?? '')).model;
}

function markdownFromModel(model) {
  return serializeMarkdownState(model);
}

function markdownFromDocument(document) {
  return serializeMarkdownState(document);
}

function documentIdFromState(document) {
  return normalizeDocumentId(document?.documentId || document?.metadata?.id || document?.id);
}

function applyTextDelta(baseText, change) {
  const base = String(baseText ?? '');
  const from = Math.max(0, Math.min(base.length, Number.parseInt(String(change.from ?? 0), 10) || 0));
  const deleteCount = Math.max(0, Number.parseInt(String(change.deleteCount ?? 0), 10) || 0);
  const end = Math.min(base.length, from + deleteCount);
  return `${base.slice(0, from)}${String(change.insertText ?? '')}${base.slice(end)}`;
}

function stripEmbeddedMetadataComments(value = '') {
  return String(value ?? '').replace(/<!--[\s\S]*?achilles-ide-(?:document|chapter|paragraph|toc|references)[\s\S]*?-->\s*/g, '');
}

function normalizePosition(list, position) {
  const items = Array.isArray(list) ? list : [];
  if (position === null || typeof position === 'undefined') return items.length;
  const parsed = Number.parseInt(String(position), 10);
  if (!Number.isFinite(parsed)) return items.length;
  return Math.max(0, Math.min(items.length, parsed));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeMetadata(base = {}, patch = {}) {
  const result = {
    ...(isPlainObject(base) ? cloneJson(base) : {})
  };
  if (!isPlainObject(patch)) {
    return result;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeMetadata(result[key], value);
    } else {
      result[key] = cloneJson(value);
    }
  }
  return result;
}

function applyMetadataPatch(target, patch = {}, id = '') {
  if (!target || !isPlainObject(patch)) {
    return;
  }
  target.metadata = mergeMetadata(target.metadata || {}, patch);
  if (id) {
    target.metadata.id = id;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(target[key])) {
      target[key] = mergeMetadata(target[key], value);
    } else {
      target[key] = cloneJson(value);
    }
  }
}

function findChapter(model, chapterId) {
  return (model.chapters || []).find((chapter) => chapter.id === chapterId) || null;
}

function findParagraph(model, chapterId, paragraphId) {
  const chapter = findChapter(model, chapterId);
  if (!chapter) return { chapter: null, paragraph: null, index: -1 };
  const index = (chapter.paragraphs || []).findIndex((paragraph) => paragraph.id === paragraphId);
  return {
    chapter,
    paragraph: index >= 0 ? chapter.paragraphs[index] : null,
    index
  };
}

function copyModelToDraft(draft, model) {
  updateMarkdownModelInDraft(draft, model);
}

function copyMarkdownToDraft(draft, markdown, existingState = null) {
  const text = String(markdown ?? '');
  const { model, warnings, ignoredStructuralIdChanges } = parseMarkdownState(text, existingState);
  copyModelToDraft(draft, model);
  draft.warnings = warnings;
  draft.ignoredStructuralIdChanges = ignoredStructuralIdChanges;
}

function updateModelMetadata(model, patch = {}) {
  const currentId = normalizeDocumentId(model.documentId || model.id || model.metadata?.id) || generateId('doc');
  const metadataPatch = {
    ...(patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : patch)
  };
  delete metadataPatch.type;
  delete metadataPatch.operation;
  delete metadataPatch.documentId;
  delete metadataPatch.path;
  delete metadataPatch.changeJson;
  delete metadataPatch.chapterId;
  delete metadataPatch.paragraphId;
  delete metadataPatch.position;
  delete metadataPatch.refreshVariables;
  delete metadataPatch.id;
  applyMetadataPatch(model, metadataPatch, currentId);
  if (typeof patch.title === 'string') {
    model.metadata.title = patch.title;
  }
  if (typeof patch.infoText === 'string') {
    model.metadata.infoText = patch.infoText;
  }
  model.documentId = currentId;
  model.id = model.documentId;
}

function applySemanticOperation(model, change) {
  const type = String(change.type || '');
  if (type === 'replaceDocumentFromMarkdown') {
    return modelFromMarkdown(change.markdown ?? '');
  }
  if (type === 'replaceDocumentModel') {
    return ensureDocumentId(change.model && typeof change.model === 'object' ? change.model : model);
  }
  if (type === 'updateDocument' || type === 'updateDocumentMetadata') {
    updateModelMetadata(model, change);
    return model;
  }
  if (type === 'addChapter') {
    const chapter = cloneJson(change.chapter || {});
    if (!chapter.id) chapter.id = chapter.metadata?.id || generateId('chapter');
    chapter.metadata = { ...(chapter.metadata || {}), id: chapter.id };
    chapter.paragraphs = Array.isArray(chapter.paragraphs) ? chapter.paragraphs : [];
    const position = normalizePosition(model.chapters, change.position);
    model.chapters.splice(position, 0, chapter);
    return model;
  }
  if (type === 'deleteChapter') {
    const index = model.chapters.findIndex((chapter) => chapter.id === change.chapterId);
    if (index < 0) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
    model.chapters.splice(index, 1);
    return model;
  }
  if (type === 'reorderChapter') {
    const index = model.chapters.findIndex((chapter) => chapter.id === change.chapterId);
    if (index < 0) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
    const [chapter] = model.chapters.splice(index, 1);
    model.chapters.splice(normalizePosition(model.chapters, change.position), 0, chapter);
    return model;
  }
  if (type === 'updateChapter') {
    const chapter = findChapter(model, change.chapterId);
    if (!chapter) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
    if (change.patch && typeof change.patch === 'object') {
      const patch = cloneJson(change.patch);
      const { metadata, ...fields } = patch;
      Object.assign(chapter, fields);
      if (metadata && typeof metadata === 'object') {
        applyMetadataPatch(chapter, metadata, chapter.id);
      }
    }
    if (typeof change.title === 'string') {
      applyMetadataPatch(chapter, { title: change.title }, chapter.id);
      chapter.heading = { ...(chapter.heading || {}), text: change.title };
    }
    if (typeof change.commands === 'string') {
      chapter.commands = change.commands;
      applyMetadataPatch(chapter, { commands: change.commands }, chapter.id);
    }
    if (change.comments && typeof change.comments === 'object') {
      chapter.comments = cloneJson(change.comments);
      applyMetadataPatch(chapter, { comments: change.comments }, chapter.id);
    }
    if (change.metadata && typeof change.metadata === 'object') {
      applyMetadataPatch(chapter, change.metadata, chapter.id);
    }
    return model;
  }
  if (type === 'addParagraph') {
    const chapter = findChapter(model, change.chapterId);
    if (!chapter) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
    chapter.paragraphs = Array.isArray(chapter.paragraphs) ? chapter.paragraphs : [];
    const paragraph = cloneJson(change.paragraph || {});
    if (!paragraph.id) paragraph.id = paragraph.metadata?.id || generateId('paragraph');
    paragraph.metadata = { ...(paragraph.metadata || {}), id: paragraph.id };
    chapter.paragraphs.splice(normalizePosition(chapter.paragraphs, change.position), 0, paragraph);
    return model;
  }
  if (type === 'deleteParagraph') {
    const { chapter, index } = findParagraph(model, change.chapterId, change.paragraphId);
    if (!chapter || index < 0) throw new Error(`Paragraph ${change.paragraphId || ''} not found.`);
    chapter.paragraphs.splice(index, 1);
    return model;
  }
  if (type === 'reorderParagraph') {
    const { chapter, index } = findParagraph(model, change.chapterId, change.paragraphId);
    if (!chapter || index < 0) throw new Error(`Paragraph ${change.paragraphId || ''} not found.`);
    const [paragraph] = chapter.paragraphs.splice(index, 1);
    chapter.paragraphs.splice(normalizePosition(chapter.paragraphs, change.position), 0, paragraph);
    return model;
  }
  if (type === 'updateParagraph') {
    const { paragraph } = findParagraph(model, change.chapterId, change.paragraphId);
    if (!paragraph) throw new Error(`Paragraph ${change.paragraphId || ''} not found.`);
    if (change.patch && typeof change.patch === 'object') {
      const patch = cloneJson(change.patch);
      const { metadata, ...fields } = patch;
      Object.assign(paragraph, fields);
      if (metadata && typeof metadata === 'object') {
        applyMetadataPatch(paragraph, metadata, paragraph.id);
      }
    }
    if (typeof change.text === 'string') {
      paragraph.text = stripEmbeddedMetadataComments(change.text);
    }
    if (typeof change.commands === 'string') {
      paragraph.commands = change.commands;
      applyMetadataPatch(paragraph, { commands: change.commands }, paragraph.id);
    }
    if (change.comments && typeof change.comments === 'object') {
      paragraph.comments = cloneJson(change.comments);
      applyMetadataPatch(paragraph, { comments: change.comments }, paragraph.id);
    }
    if (change.metadata && typeof change.metadata === 'object') {
      applyMetadataPatch(paragraph, change.metadata, paragraph.id);
    }
    return model;
  }
  if (type === 'updateMetadata') {
    if (change.target === 'chapter') {
      const chapter = findChapter(model, change.chapterId);
      if (!chapter) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
      applyMetadataPatch(chapter, change.metadata || {}, chapter.id);
      return model;
    }
    if (change.target === 'paragraph') {
      const { paragraph } = findParagraph(model, change.chapterId, change.paragraphId);
      if (!paragraph) throw new Error(`Paragraph ${change.paragraphId || ''} not found.`);
      applyMetadataPatch(paragraph, change.metadata || {}, paragraph.id);
      return model;
    }
    updateModelMetadata(model, change.metadata || {});
    return model;
  }
  throw new Error(`Unsupported Markdown CRDT change type '${type}'.`);
}

function makeDraftParagraphFromChange(paragraph = {}) {
  const id = normalizeDocumentId(paragraph.id || paragraph.metadata?.id) || generateId('paragraph');
  return {
    id,
    metadata: {
      ...(paragraph.metadata && typeof paragraph.metadata === 'object' ? cloneJson(paragraph.metadata) : {}),
      id
    },
    leading: createText(paragraph.leading || ''),
    text: createText(paragraph.text || ''),
    trailing: createText(paragraph.trailing || '\n\n'),
    hasMetadata: true
  };
}

function makeDraftChapterFromChange(chapter = {}) {
  const id = normalizeDocumentId(chapter.id || chapter.metadata?.id) || generateId('chapter');
  const metadata = {
    ...(chapter.metadata && typeof chapter.metadata === 'object' ? cloneJson(chapter.metadata) : {}),
    id
  };
  return {
    id,
    metadata,
    heading: {
      ...(chapter.heading && typeof chapter.heading === 'object' ? cloneJson(chapter.heading) : {}),
      level: chapter.heading?.level || 2,
      text: createText(chapter.heading?.text || metadata.title || 'Chapter')
    },
    leading: createText(chapter.leading || ''),
    paragraphs: Array.isArray(chapter.paragraphs)
      ? chapter.paragraphs.map(makeDraftParagraphFromChange)
      : []
  };
}

export function createMarkdownCrdtStore({
  fs,
  path,
  workspaceRoot,
  validatePath,
  writeFileContent,
  invalidateCachesForPath,
  transactionStaleMs = TRANSACTION_STALE_MS
}) {
  const storeRoot = path.join(workspaceRoot, ...STORE_ROOT);
  const privateData = createExplorerPrivateDataBoundary({ fs, path, workspaceRoot });
  const localLocks = new Map();
  let recoveryPromise = null;

  function lockPathForScope(scope) {
    const digest = crypto.createHash('sha256').update(String(scope || '')).digest('hex');
    return path.join(storeRoot, STORE_LOCK_DIRECTORY, `${digest}.lock`);
  }

  function pathLockScope(validPath) {
    return `path:${validPath}`;
  }

  async function lockScopeForPath(inputPath) {
    const validPath = await validatePath(inputPath);
    return pathLockScope(validPath);
  }

  async function lockScopeForDocumentId(documentId) {
    const normalized = normalizeDocumentId(documentId);
    if (!normalized) throw new Error('Invalid Markdown CRDT document id.');
    const document = await readAutomergeState(normalized);
    if (!document?.path) {
      throw new Error(`Markdown CRDT document '${normalized}' was not found.`);
    }
    return lockScopeForPath(document.path);
  }

  async function lockScopeForArgs(args = {}) {
    if (args.path) return lockScopeForPath(args.path);
    if (args.documentId) return lockScopeForDocumentId(args.documentId);
    throw new Error('A Markdown CRDT lock requires documentId or path.');
  }

  function isLockOwnerAlive(owner) {
    if (String(owner?.hostname || '') !== os.hostname()) return null;
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) {
      if (owner?.instanceId && owner.instanceId !== PROCESS_INSTANCE_ID) return false;
      if (owner?.instanceId && !HELD_LOCK_TOKENS.has(String(owner?.token || ''))) return false;
      const acquiredAt = Date.parse(owner?.acquiredAt || '');
      if (!owner?.instanceId && Number.isFinite(acquiredAt) && acquiredAt < PROCESS_STARTED_AT_MS - 1_000) {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  async function readDocumentLock(lockPath) {
    try {
      const [raw, stats] = await Promise.all([
        fs.readFile(lockPath, 'utf8'),
        fs.stat(lockPath)
      ]);
      const owner = JSON.parse(raw);
      const acquiredAt = Date.parse(owner?.acquiredAt || '');
      return {
        exists: true,
        owner,
        stats,
        ageMs: Date.now() - stats.mtimeMs,
        acquiredAgeMs: Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Date.now() - stats.mtimeMs
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false };
      const stats = await fs.stat(lockPath).catch(() => null);
      return {
        exists: Boolean(stats),
        owner: null,
        stats,
        ageMs: stats ? Date.now() - stats.mtimeMs : 0
      };
    }
  }

  function sameDocumentLock(left, right) {
    return Boolean(left?.exists && right?.exists
      && left.stats?.dev === right.stats?.dev
      && left.stats?.ino === right.stats?.ino
      && left.stats?.mtimeMs === right.stats?.mtimeMs
      && String(left.owner?.token || '') === String(right.owner?.token || ''));
  }

  async function removeStaleDocumentLock(lockPath, observed) {
    const latest = await readDocumentLock(lockPath);
    if (!sameDocumentLock(observed, latest)) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  }

  async function acquireDocumentLock(scope) {
    const lexicalLockPath = lockPathForScope(scope);
    const lockPath = await privateData.resolveFile(
      ['automerge', 'documents', STORE_LOCK_DIRECTORY, path.basename(lexicalLockPath)],
      { createParent: true }
    );
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    HELD_LOCK_TOKENS.add(token);
    try {
      return await acquireDocumentLockWithToken(lockPath, token, startedAt);
    } catch (error) {
      HELD_LOCK_TOKENS.delete(token);
      throw error;
    }
  }

  async function acquireDocumentLockWithToken(lockPath, token, startedAt) {
    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({
            token,
            instanceId: PROCESS_INSTANCE_ID,
            hostname: os.hostname(),
            pid: process.pid,
            acquiredAt: new Date().toISOString()
          }));
        } finally {
          await handle.close();
        }
        return { token, lockPath };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const lock = await readDocumentLock(lockPath);
        if (!lock.exists) continue;
        const ownerAlive = isLockOwnerAlive(lock.owner);
        if (ownerAlive === false || (lock.ageMs > STORE_LOCK_STALE_MS && ownerAlive !== true)) {
          if (await removeStaleDocumentLock(lockPath, lock).catch(() => false)) continue;
        }
        if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
          throw new Error('Timed out waiting for the Markdown CRDT document lock.');
        }
        await new Promise((resolve) => setTimeout(resolve, STORE_LOCK_RETRY_MS));
      }
    }
  }

  async function releaseDocumentLock(lock) {
    if (!lock?.token) return;
    try {
      await releaseDocumentLockFile(lock);
    } finally {
      HELD_LOCK_TOKENS.delete(lock.token);
    }
  }

  async function releaseDocumentLockFile(lock) {
    try {
      const current = await readDocumentLock(lock.lockPath);
      if (!current.exists) return;
      if (current.owner === null) {
        // The lock file exists but could not be read, so its release cannot be confirmed.
        globalThis[UNCONFIRMED_LOCK_RELEASE_KEY] = true;
        return;
      }
      if (current.owner?.token !== lock.token) return;
      await fs.rm(lock.lockPath, { force: true });
    } catch {
      // A later call can recover a stale lock if this process is interrupted, and a warm worker is recycled.
      globalThis[UNCONFIRMED_LOCK_RELEASE_KEY] = true;
    }
  }

  function startDocumentLockHeartbeat(lock) {
    if (!lock?.lockPath) return () => {};
    const interval = setInterval(async () => {
      try {
        const current = await readDocumentLock(lock.lockPath);
        if (current.owner?.token !== lock.token) return;
        const now = new Date();
        await fs.utimes(lock.lockPath, now, now);
      } catch {
        // Release/recovery owns the final decision when the operation completes.
      }
    }, Math.max(1_000, Math.floor(STORE_LOCK_STALE_MS / 3)));
    interval.unref?.();
    return () => clearInterval(interval);
  }

  async function withCrdtLock(scope, operation) {
    const key = String(scope || '');
    if (!key) throw new Error('A Markdown CRDT lock scope is required.');
    const previous = localLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    localLocks.set(key, current);
    await previous;
    let documentLock = null;
    let stopHeartbeat = () => {};
    try {
      documentLock = await acquireDocumentLock(key);
      stopHeartbeat = startDocumentLockHeartbeat(documentLock);
      return await operation();
    } finally {
      stopHeartbeat();
      await releaseDocumentLock(documentLock);
      release();
      if (localLocks.get(key) === current) localLocks.delete(key);
    }
  }

  function statePathForDocumentId(documentId) {
    const safeId = normalizeDocumentId(documentId);
    if (!safeId) throw new Error('Invalid Markdown CRDT document id.');
    return path.join(storeRoot, `${safeId}.automerge`);
  }

  async function readAutomergeState(documentId) {
    const statePath = await privateData.resolveFile([
      'automerge',
      'documents',
      path.basename(statePathForDocumentId(documentId))
    ]);
    if (!await pathExists(fs, statePath)) return null;
    const binary = await fs.readFile(statePath);
    return loadDocument(binary);
  }

  async function readAutomergeStateByPath(validPath) {
    const safeStoreRoot = await privateData.resolveDirectory(['automerge', 'documents']);
    if (!await pathExists(fs, safeStoreRoot)) return null;
    const entries = await fs.readdir(safeStoreRoot);
    for (const entry of entries) {
      if (!entry.endsWith('.automerge')) continue;
      const statePath = await privateData.resolveFile(['automerge', 'documents', entry]);
      const document = loadDocument(await fs.readFile(statePath));
      if (document?.path === validPath) {
        return document;
      }
    }
    return null;
  }

  async function writeAutomergeState(document) {
    const statePath = await privateData.resolveFile([
      'automerge',
      'documents',
      path.basename(statePathForDocumentId(document.documentId))
    ], { createParent: true });
    const temporary = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, Buffer.from(saveDocument(document)));
      await fs.rename(temporary, statePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  function compactDocument(document, model, undoSnapshots = []) {
    let staged = changeDocument(document, (draft) => {
      delete draft.scriptaHistory;
      delete draft.scriptaUndoHeads;
      copyModelToDraft(draft, model);
      draft.scriptaUndoSnapshots = cloneJson(undoSnapshots.slice(-MAX_SCRIPTA_UNDO_STEPS));
      draft.updatedAt = new Date().toISOString();
    });
    const compactState = cloneJson(staged);
    delete compactState.scriptaHistory;
    delete compactState.scriptaUndoHeads;
    staged = createDocument(compactState);
    return staged;
  }

  async function migrateLegacyScriptaHistory(document) {
    if (
      !Object.prototype.hasOwnProperty.call(document || {}, 'scriptaHistory')
      && !Object.prototype.hasOwnProperty.call(document || {}, 'scriptaUndoHeads')
    ) {
      return document;
    }
    const compacted = compactDocument(
      document,
      materializeMarkdownModel(document),
      Array.isArray(document.scriptaUndoSnapshots) ? document.scriptaUndoSnapshots : []
    );
    await writeAutomergeState(compacted);
    return compacted;
  }

  async function readMarkdownFile(validPath) {
    const raw = await fs.readFile(validPath, 'utf8');
    const stats = await fs.stat(validPath);
    return { raw, stats, versionKey: getVersionKey(stats) };
  }

  async function initializeDocument(validPath) {
    const { raw } = await readMarkdownFile(validPath);
    const { model, warnings, ignoredStructuralIdChanges } = parseMarkdownState(raw);
    let document = createDocument({});
    document = changeDocument(document, (draft) => {
      writeMarkdownModelToDraft(draft, model);
      draft.path = validPath;
      draft.fileVersionKey = '';
      draft.lastSavedMarkdown = '';
      draft.reviewItems = [];
      draft.warnings = warnings;
      draft.ignoredStructuralIdChanges = ignoredStructuralIdChanges;
      draft.updatedAt = new Date().toISOString();
    });
    const markdown = markdownFromDocument(document);
    const statePath = await privateData.resolveFile([
      'automerge',
      'documents',
      path.basename(statePathForDocumentId(document.documentId))
    ], { createParent: true });
    const previousState = await fs.readFile(statePath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    try {
      await writeFileContent(validPath, markdown);
      invalidateCachesForPath(validPath);
      const stats = await fs.stat(validPath);
      document = changeDocument(document, (draft) => {
        draft.fileVersionKey = getVersionKey(stats);
        draft.lastSavedMarkdown = markdown;
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(document);
      return document;
    } catch (error) {
      const rollbackErrors = [];
      try {
        await writeFileContent(validPath, raw);
        invalidateCachesForPath(validPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        if (previousState) {
          await fs.mkdir(path.dirname(statePath), { recursive: true });
          await fs.writeFile(statePath, previousState);
        } else {
          await fs.rm(statePath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Markdown CRDT initialization failed and could not be rolled back completely.'
        );
      }
      throw error;
    }
  }

  async function loadByPath(inputPath) {
    const validPath = await validatePath(inputPath);
    if (!isMarkdownPath(validPath, path)) {
      throw new Error('Markdown CRDT tools only support .md files.');
    }
    const { raw, versionKey } = await readMarkdownFile(validPath);
    const parsed = parseMarkdownState(raw).model;
    let document = await readAutomergeState(parsed.metadata.id) || await readAutomergeStateByPath(validPath);
    if (!document) {
      return await initializeDocument(validPath);
    }
    if (document.schemaVersion !== 2 || !Array.isArray(document.blocks)) {
      return await initializeDocument(validPath);
    }
    document = await migrateLegacyScriptaHistory(document);
    if (document.path !== validPath || document.fileVersionKey !== versionKey) {
      document = await syncFromMarkdown(document, validPath, raw, versionKey);
    }
    return document;
  }

  async function loadByDocumentId(documentId) {
    let document = await readAutomergeState(documentId);
    if (!document) {
      throw new Error(`Markdown CRDT document '${documentId}' was not found.`);
    }
    document = await migrateLegacyScriptaHistory(document);
    return document;
  }

  async function syncFromMarkdown(document, validPath, markdown, versionKey) {
    const currentMarkdown = markdownFromDocument(document);
    const lastSavedMarkdown = String(document.lastSavedMarkdown ?? currentMarkdown);
    if (markdown === currentMarkdown || markdown === lastSavedMarkdown) {
      const synced = changeDocument(document, (draft) => {
        draft.path = validPath;
        draft.fileVersionKey = versionKey;
        draft.lastSavedMarkdown = markdown;
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(synced);
      return synced;
    }

    if (currentMarkdown === lastSavedMarkdown) {
      const imported = changeDocument(document, (draft) => {
        copyMarkdownToDraft(draft, markdown, document);
        draft.path = validPath;
        draft.fileVersionKey = versionKey;
        draft.lastSavedMarkdown = markdown;
        draft.reviewItems = [];
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(imported);
      return imported;
    }

    const reviewItem = {
      id: generateId('markdown-review'),
      type: 'external-file-change',
      path: validPath,
      versionKey,
      markdown,
      createdAt: new Date().toISOString()
    };
    const marked = changeDocument(document, (draft) => {
      draft.path = validPath;
      draft.fileVersionKey = versionKey;
      draft.reviewItems = [...(draft.reviewItems || []), reviewItem];
      draft.updatedAt = new Date().toISOString();
    });
    await writeAutomergeState(marked);
    return marked;
  }

  function responseFor(document, extra = {}) {
    const model = ensureDocumentId(document);
    return {
      ok: true,
      documentId: model.documentId,
      path: document.path,
      markdown: markdownFromDocument(document),
      model,
      heads: getDocumentHeads(document),
      versionKey: document.fileVersionKey || '',
      reviewItems: cloneJson(document.reviewItems || []),
      warnings: cloneJson(document.warnings || []),
      ignoredStructuralIdChanges: cloneJson(document.ignoredStructuralIdChanges || {
        document: 0,
        chapter: 0,
        paragraph: 0,
        duplicate: 0
      }),
      ...extra
    };
  }

  async function open(inputPath) {
    const document = await loadByPath(inputPath);
    return responseFor(document);
  }

  async function create(args) {
    const validPath = await validatePath(args.path);
    if (!isMarkdownPath(validPath, path)) {
      throw new Error('Markdown CRDT tools only support .md files.');
    }
    if (await pathExists(fs, validPath)) {
      throw new Error('A document already exists at the selected path.');
    }
    await fs.mkdir(path.dirname(validPath), { recursive: true });
    const temporaryPrefix = `${path.basename(validPath)}.`;
    for (const entry of await fs.readdir(path.dirname(validPath), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.startsWith(temporaryPrefix) || !entry.name.endsWith('.scripta-create.tmp')) {
        continue;
      }
      const stalePath = path.join(path.dirname(validPath), entry.name);
      const stats = await fs.stat(stalePath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > transactionStaleMs) {
        await fs.rm(stalePath, { force: true });
      }
    }
    const model = ensureDocumentId(args.model || {});
    const documentId = documentIdFromState(model);
    const statePath = await privateData.resolveFile([
      'automerge',
      'documents',
      path.basename(statePathForDocumentId(documentId))
    ], { createParent: true });
    const temporaryMarkdown = `${validPath}.${process.pid}.${crypto.randomUUID()}.scripta-create.tmp`;
    let response = null;
    try {
      await fs.writeFile(temporaryMarkdown, markdownFromModel(model), 'utf8');
      await fs.rename(temporaryMarkdown, validPath);
      invalidateCachesForPath(validPath);
      response = responseFor(await initializeDocument(validPath), { status: 'created' });
      if (typeof args.onCompleted === 'function') {
        await args.onCompleted(response);
      }
      return response;
    } catch (error) {
      const rollbackErrors = [];
      if (typeof args.onRollback === 'function') {
        try {
          await args.onRollback(response || {
            documentId,
            path: validPath,
            model
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await fs.rm(validPath, { force: true });
        await fs.rm(statePath, { force: true });
        invalidateCachesForPath(validPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'SCRIPTA creation failed and could not be rolled back completely.'
        );
      }
      throw error;
    } finally {
      await fs.rm(temporaryMarkdown, { force: true }).catch(() => {});
    }
  }

  async function applyChange(args) {
    const documentId = normalizeDocumentId(args.documentId);
    const change = args.change && typeof args.change === 'object' ? args.change : {};
    let document = await loadByDocumentId(documentId);
    if (change.type === 'replaceTextRange') {
      const baseHeads = Array.isArray(args.baseHeads)
        ? args.baseHeads.map((head) => String(head || '').trim()).filter(Boolean)
        : [];
      if (!baseHeads.length) {
        throw new Error('replaceTextRange requires baseHeads from open_markdown_crdt_document.');
      }
      if (!documentHasHeads(document, baseHeads)) {
        throw new Error('The Markdown CRDT edit base is no longer available. Reopen the document before editing.');
      }
      const baseDocument = viewDocumentAtHeads(document, baseHeads);
      const nextMarkdown = applyTextDelta(markdownFromDocument(baseDocument), change);
      const changed = changeDocumentAtHeads(document, baseHeads, (draft) => {
        copyMarkdownToDraft(draft, nextMarkdown, baseDocument);
        draft.updatedAt = new Date().toISOString();
      });
      document = changed.newDoc;
      await writeAutomergeState(document);
      return responseFor(document, { changeHeads: changed.newHeads || baseHeads });
    }
    if (change.type === 'addParagraph') {
      document = changeDocument(document, (draft) => {
        const chapterIndex = (draft.chapters || []).findIndex((chapter) => chapter.id === change.chapterId);
        if (chapterIndex < 0) throw new Error(`Chapter ${change.chapterId || ''} not found.`);
        const chapter = draft.chapters[chapterIndex];
        if (!Array.isArray(chapter.paragraphs)) chapter.paragraphs = [];
        const position = normalizePosition(chapter.paragraphs, change.position);
        chapter.paragraphs.splice(position, 0, makeDraftParagraphFromChange(change.paragraph || {}));
        draft.blocks = materializeMarkdownModel(draft).blocks;
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(document);
      return responseFor(document);
    }
    if (change.type === 'addChapter') {
      document = changeDocument(document, (draft) => {
        if (!Array.isArray(draft.chapters)) draft.chapters = [];
        const position = normalizePosition(draft.chapters, change.position);
        draft.chapters.splice(position, 0, makeDraftChapterFromChange(change.chapter || {}));
        draft.blocks = materializeMarkdownModel(draft).blocks;
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(document);
      return responseFor(document);
    }
    const next = applySemanticOperation(ensureDocumentId(document), change);
    document = changeDocument(document, (draft) => {
      copyModelToDraft(draft, next);
      draft.updatedAt = new Date().toISOString();
    });
    await writeAutomergeState(document);
    return responseFor(document);
  }

  async function mergeState(args) {
    const documentId = normalizeDocumentId(args.documentId);
    if (!documentId) {
      throw new Error('merge_markdown_crdt_document requires documentId.');
    }
    const local = await loadByDocumentId(documentId);
    let remote = null;
    if (typeof args.remoteStateBase64 === 'string' && args.remoteStateBase64.trim()) {
      remote = loadDocument(Buffer.from(args.remoteStateBase64.trim(), 'base64'));
    } else if (args.remoteDocumentId) {
      remote = await loadByDocumentId(args.remoteDocumentId);
    } else {
      throw new Error('merge_markdown_crdt_document requires remoteDocumentId or remoteStateBase64.');
    }

    const remoteDocumentId = documentIdFromState(remote);
    if (!remoteDocumentId) {
      throw new Error('Cannot merge a Markdown CRDT state without documentId.');
    }
    if (remoteDocumentId !== documentId) {
      throw new Error(`Cannot merge Markdown CRDT document '${remoteDocumentId}' into '${documentId}'.`);
    }

    let document = mergeDocuments(local, remote);
    document = changeDocument(document, (draft) => {
      draft.documentId = documentId;
      draft.id = documentId;
      draft.metadata = {
        ...(draft.metadata || {}),
        id: documentId
      };
      draft.path = draft.path || local.path || remote.path || '';
      draft.blocks = materializeMarkdownModel(draft).blocks;
      draft.updatedAt = new Date().toISOString();
    });
    await writeAutomergeState(document);
    if (document.path) {
      invalidateCachesForPath(document.path);
    }
    return responseFor(document, {
      status: 'merged'
    });
  }

  async function commitDocument(document, validPath, { onCommitted } = {}) {
    if (!isMarkdownPath(validPath, path)) {
      throw new Error('Markdown CRDT tools only support .md files.');
    }
    const statePath = await privateData.resolveFile([
      'automerge',
      'documents',
      path.basename(statePathForDocumentId(document.documentId))
    ], { createParent: true });
    const [previousMarkdown, previousState] = await Promise.all([
      fs.readFile(validPath, 'utf8'),
      fs.readFile(statePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    ]);
    const markdown = markdownFromDocument(document);
    const saveWarnings = cloneJson(document.warnings || []);
    const saveIgnoredStructuralIdChanges = cloneJson(document.ignoredStructuralIdChanges || {
      document: 0,
      chapter: 0,
      paragraph: 0,
      duplicate: 0
    });
    try {
      await writeFileContent(validPath, markdown);
      invalidateCachesForPath(validPath);
      const stats = await fs.stat(validPath);
      const versionKey = getVersionKey(stats);
      document = changeDocument(document, (draft) => {
        draft.path = validPath;
        draft.fileVersionKey = versionKey;
        draft.lastSavedMarkdown = markdown;
        draft.warnings = [];
        draft.ignoredStructuralIdChanges = {
          document: 0,
          chapter: 0,
          paragraph: 0,
          duplicate: 0
        };
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(document);
      const response = responseFor(document, {
        status: 'saved',
        versionKey,
        warnings: saveWarnings,
        ignoredStructuralIdChanges: saveIgnoredStructuralIdChanges
      });
      if (typeof onCommitted === 'function') await onCommitted(response);
      return response;
    } catch (error) {
      const rollbackErrors = [];
      try {
        await writeFileContent(validPath, previousMarkdown);
        invalidateCachesForPath(validPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        if (previousState) {
          const restored = loadDocument(previousState);
          await writeAutomergeState(restored);
        } else {
          await fs.rm(statePath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Markdown CRDT commit failed and could not be rolled back completely.'
        );
      }
      throw error;
    }
  }

  async function save(args) {
    if (!args.documentId && !args.path) {
      throw new Error('save_markdown_crdt_document requires documentId or path.');
    }
    const document = args.documentId
      ? await loadByDocumentId(args.documentId)
      : await loadByPath(args.path);
    const validPath = args.path ? await validatePath(args.path) : document.path;
    return commitDocument(document, validPath);
  }

  async function mutateAndSave(args, mutateModel) {
    const scope = await lockScopeForArgs(args);
    return withCrdtLock(scope, async () => {
      let document = args.documentId
        ? await loadByDocumentId(args.documentId)
        : await loadByPath(args.path);
      const current = responseFor(document);
      const history = cloneJson(document.scriptaUndoSnapshots || []);
      let nextModel;
      if (args.historyAction === 'undo') {
        const undoEntry = history.at(-1);
        if (
          !undoEntry
          || !undoEntry.beforeModel
          || typeof undoEntry.beforeModel !== 'object'
        ) {
          throw new Error('There is no SCRIPTA operation to undo.');
        }
        if (
          typeof undoEntry.afterModelHash !== 'string'
          || !undoEntry.afterModelHash
          || modelDigest(current.model) !== undoEntry.afterModelHash
        ) {
          const error = new Error(
            'SCRIPTA undo cannot be applied because the document changed after that operation.'
          );
          error.code = 'scripta_undo_conflict';
          throw error;
        }
        history.pop();
        nextModel = cloneJson(undoEntry.beforeModel);
      } else {
        nextModel = await mutateModel(cloneJson(current.model), current, {
          proposalAlreadyApplied: Boolean(
            args.scriptaProposalId && document.scriptaMarkdownProposals?.[args.scriptaProposalId]
          )
        });
      }
      if (nextModel === null || nextModel === undefined) {
        if (typeof args.onCompleted === 'function') await args.onCompleted(current);
        return current;
      }
      if (args.scriptaProposalId) {
        // Keep retry receipts in canonical private state, outside the public
        // replica and undo snapshots. Commit/rollback includes this receipt.
        document = changeDocument(document, (draft) => {
          draft.scriptaMarkdownProposals ||= {};
          draft.scriptaMarkdownProposals[args.scriptaProposalId] = true;
        });
      }
      if (args.historyAction === 'push') {
        history.push({
          beforeModel: cloneJson(current.model),
          afterModelHash: modelDigest(ensureDocumentId(nextModel))
        });
        if (history.length > MAX_SCRIPTA_UNDO_STEPS) {
          history.splice(0, history.length - MAX_SCRIPTA_UNDO_STEPS);
        }
      }
      if (args.historyAction) {
        document = compactDocument(document, nextModel, history);
      } else {
        document = changeDocument(document, (draft) => {
          delete draft.scriptaHistory;
          delete draft.scriptaUndoHeads;
          copyModelToDraft(draft, nextModel);
          draft.updatedAt = new Date().toISOString();
        });
      }
      return commitDocument(document, current.path, {
        onCommitted: args.onCompleted || args.onCommitted
      });
    });
  }

  async function inspect(args, operation) {
    const scope = await lockScopeForArgs(args);
    return withCrdtLock(scope, async () => {
      const document = args.documentId
        ? await loadByDocumentId(args.documentId)
        : await loadByPath(args.path);
      return operation(responseFor(document));
    });
  }

  function deletionSegments(transactionId) {
    const safeId = normalizeDocumentId(transactionId);
    if (!safeId || safeId !== String(transactionId || '')) {
      throw new Error('Invalid SCRIPTA deletion transaction id.');
    }
    return ['automerge', 'documents', DELETION_ROOT, safeId];
  }

  function deletionDirectory(transactionId, options) {
    return privateData.resolveDirectory(deletionSegments(transactionId), options);
  }

  function deletionFile(transactionId, fileName) {
    return privateData.resolveFile([...deletionSegments(transactionId), fileName]);
  }

  async function validateDeletionFiles(transactionId, relatedArtifacts = []) {
    for (const fileName of ['transaction.json', 'document.md', 'document.automerge', ...relatedArtifacts.map(({ name }) => name)]) {
      await deletionFile(transactionId, fileName);
    }
  }

  async function removeDeletionDirectory(transactionId, relatedArtifacts = []) {
    const expectedNames = new Set(['transaction.json', 'document.md', 'document.automerge', ...relatedArtifacts.map(({ name }) => name)]);
    const entries = await fs.readdir(await deletionDirectory(transactionId));
    for (const entry of entries) {
      if (!expectedNames.has(entry)) throw new Error('Unexpected SCRIPTA deletion artifact.');
      await deletionFile(transactionId, entry);
    }
    await fs.rm(await deletionDirectory(transactionId), { recursive: true, force: true });
  }

  function normalizeRelatedArtifact(artifact = {}) {
    const name = String(artifact.name || '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || ['.', '..', 'transaction.json', 'document.md', 'document.automerge'].includes(name)) {
      throw new Error('Invalid related SCRIPTA artifact name.');
    }
    const sourcePath = path.resolve(String(artifact.path || ''));
    const relative = path.relative(privateData.privateRoot, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Related SCRIPTA artifacts must be inside Explorer private data.');
    }
    return {
      name,
      sourcePath,
      optional: artifact.optional === true
    };
  }

  function relatedArtifactFile(artifact, options) {
    return privateData.resolveFile(path.relative(privateData.privateRoot, artifact.sourcePath).split(path.sep), options);
  }

  async function prepareRemove(args) {
    const scope = await lockScopeForArgs(args);
    return withCrdtLock(scope, async () => {
      await privateData.resolveDirectory(['automerge', 'documents', DELETION_ROOT]);
      const document = args.documentId
        ? await loadByDocumentId(args.documentId)
        : await loadByPath(args.path);
      const documentId = normalizeDocumentId(document.documentId);
      const validPath = await validatePath(document.path);
      const transactionId = normalizeDocumentId(generateId('scripta-delete'));
      const stateSegments = [
        'automerge',
        'documents',
        path.basename(statePathForDocumentId(documentId))
      ];
      await privateData.resolveFile(stateSegments, { createParent: true });
      const relatedArtifacts = (Array.isArray(args.relatedArtifacts) ? args.relatedArtifacts : [])
        .map(normalizeRelatedArtifact);
      if (new Set(relatedArtifacts.map(({ name }) => name)).size !== relatedArtifacts.length) {
        throw new Error('Duplicate related SCRIPTA artifact name.');
      }
      for (const artifact of relatedArtifacts) await relatedArtifactFile(artifact);
      if (await pathExists(fs, await deletionDirectory(transactionId))) {
        throw new Error('SCRIPTA deletion transaction already exists.');
      }
      await deletionDirectory(transactionId, { create: true });
      await validateDeletionFiles(transactionId, relatedArtifacts);
      let markdownMoved = false;
      let stateMoved = false;
      const movedRelatedArtifacts = [];
      try {
        await fs.rename(validPath, await deletionFile(transactionId, 'document.md'));
        markdownMoved = true;
        await fs.rename(await privateData.resolveFile(stateSegments), await deletionFile(transactionId, 'document.automerge'));
        stateMoved = true;
        for (const artifact of relatedArtifacts) {
          const exists = await pathExists(fs, await relatedArtifactFile(artifact));
          if (!exists && !artifact.optional) {
            throw new Error(`Required SCRIPTA artifact '${artifact.name}' was not found.`);
          }
          if (!exists) continue;
          await fs.rename(await relatedArtifactFile(artifact), await deletionFile(transactionId, artifact.name));
          movedRelatedArtifacts.push({
            name: artifact.name,
            sourcePath: artifact.sourcePath
          });
        }
        await fs.writeFile(await deletionFile(transactionId, 'transaction.json'), JSON.stringify({
          transactionId,
          documentId,
          path: validPath,
          preparedAt: new Date().toISOString(),
          relatedArtifacts: movedRelatedArtifacts
        }), { flag: 'wx' });
      } catch (error) {
        let restored = true;
        for (const artifact of [...movedRelatedArtifacts].reverse()) {
          try {
            await fs.rename(await deletionFile(transactionId, artifact.name), await relatedArtifactFile(artifact, { createParent: true }));
          } catch { restored = false; }
        }
        if (stateMoved) {
          try {
            await fs.rename(await deletionFile(transactionId, 'document.automerge'), await privateData.resolveFile(stateSegments));
          } catch { restored = false; }
        }
        if (markdownMoved) {
          try {
            await fs.rename(await deletionFile(transactionId, 'document.md'), await validatePath(validPath));
          } catch { restored = false; }
        }
        if (restored) await removeDeletionDirectory(transactionId, relatedArtifacts).catch(() => {});
        throw error;
      }
      invalidateCachesForPath(validPath);
      return { ok: true, documentId, transactionId, status: 'prepared' };
    });
  }

  async function readDeletionTransaction(transactionId) {
    const raw = await fs.readFile(await deletionFile(transactionId, 'transaction.json'), 'utf8');
    const transaction = JSON.parse(raw);
    if (transaction?.transactionId !== transactionId) throw new Error('Mismatched SCRIPTA deletion transaction id.');
    transaction.relatedArtifacts = (Array.isArray(transaction.relatedArtifacts) ? transaction.relatedArtifacts : [])
      .map((artifact) => normalizeRelatedArtifact({ ...artifact, path: artifact.sourcePath }));
    await validateDeletionFiles(transactionId, transaction.relatedArtifacts);
    return { transactionDir: await deletionDirectory(transactionId), transaction };
  }

  async function commitRemove(args) {
    const initial = await readDeletionTransaction(args.transactionId);
    const scope = await lockScopeForPath(initial.transaction.path);
    return withCrdtLock(scope, async () => {
      const { transaction } = await readDeletionTransaction(args.transactionId);
      await removeDeletionDirectory(args.transactionId, transaction.relatedArtifacts);
      return {
        ok: true,
        documentId: transaction.documentId,
        transactionId: args.transactionId,
        status: 'deleted'
      };
    });
  }

  async function rollbackRemove(args) {
    const initial = await readDeletionTransaction(args.transactionId);
    const scope = await lockScopeForPath(initial.transaction.path);
    return withCrdtLock(scope, async () => {
      const { transaction } = await readDeletionTransaction(args.transactionId);
      const validPath = await validatePath(transaction.path);
      const statePath = await privateData.resolveFile([
        'automerge',
        'documents',
        path.basename(statePathForDocumentId(transaction.documentId))
      ], { createParent: true });
      if (await pathExists(fs, validPath) || await pathExists(fs, statePath)) {
        throw new Error('Cannot roll back SCRIPTA deletion because the destination already exists.');
      }
      for (const artifact of transaction.relatedArtifacts) {
        if (await pathExists(fs, await relatedArtifactFile(artifact))) {
          throw new Error(`Cannot restore SCRIPTA artifact '${artifact.name}' because the destination exists.`);
        }
      }
      await fs.mkdir(path.dirname(validPath), { recursive: true });
      await fs.rename(await deletionFile(args.transactionId, 'document.md'), await validatePath(validPath));
      try {
        const destination = await privateData.resolveFile(['automerge', 'documents', path.basename(statePath)]);
        await fs.rename(await deletionFile(args.transactionId, 'document.automerge'), destination);
      } catch (error) {
        await deletionFile(args.transactionId, 'document.md')
          .then((stagedPath) => fs.rename(validPath, stagedPath)).catch(() => {});
        throw error;
      }
      const restoredRelatedArtifacts = [];
      try {
        for (const artifact of transaction.relatedArtifacts) {
          const destination = await relatedArtifactFile(artifact, { createParent: true });
          await fs.rename(await deletionFile(args.transactionId, artifact.name), destination);
          restoredRelatedArtifacts.push(artifact);
        }
      } catch (error) {
        for (const artifact of [...restoredRelatedArtifacts].reverse()) {
          await deletionFile(args.transactionId, artifact.name)
            .then(async (stagedPath) => fs.rename(await relatedArtifactFile(artifact), stagedPath)).catch(() => {});
        }
        await deletionFile(args.transactionId, 'document.automerge')
          .then(async (stagedPath) => fs.rename(await privateData.resolveFile(['automerge', 'documents', path.basename(statePath)]), stagedPath)).catch(() => {});
        await deletionFile(args.transactionId, 'document.md')
          .then((stagedPath) => fs.rename(validPath, stagedPath)).catch(() => {});
        throw error;
      }
      await removeDeletionDirectory(args.transactionId, transaction.relatedArtifacts);
      invalidateCachesForPath(validPath);
      return {
        ok: true,
        documentId: transaction.documentId,
        transactionId: args.transactionId,
        status: 'restored'
      };
    });
  }

  async function recoverPendingDeletions() {
    const staleAfterMs = Math.max(0, Number(transactionStaleMs) || TRANSACTION_STALE_MS);
    const safeDeletionRoot = await privateData.resolveDirectory(
      ['automerge', 'documents', DELETION_ROOT]
    );
    const entries = await fs.readdir(safeDeletionRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const transactionId = entry.name;
      const prepared = await readDeletionTransaction(transactionId).catch((error) => {
        if (error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION') throw error;
        return null;
      });
      if (!prepared) continue;
      const preparedAt = Date.parse(prepared.transaction?.preparedAt || '');
      const stats = await fs.stat(await deletionDirectory(transactionId)).catch(() => null);
      const ageMs = Number.isFinite(preparedAt)
        ? Date.now() - preparedAt
        : stats ? Date.now() - stats.mtimeMs : 0;
      if (ageMs <= staleAfterMs) continue;
      await rollbackRemove({ transactionId }).catch((error) => {
        if (error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION') throw error;
        // A live owner or an occupied destination means recovery must be
        // retried by a later process rather than deleting staged data.
      });
    }
  }

  async function ensureRecovered() {
    await privateData.resolveDirectory(['automerge', 'documents'], { create: true });
    if (!recoveryPromise) recoveryPromise = recoverPendingDeletions();
    return recoveryPromise;
  }

  async function syncFromFile(args) {
    const validPath = await validatePath(args.path);
    if (!isMarkdownPath(validPath, path)) {
      throw new Error('Markdown CRDT tools only support .md files.');
    }
    const { raw, versionKey } = await readMarkdownFile(validPath);
    const parsed = modelFromMarkdown(raw);
    let document = await readAutomergeState(parsed.metadata.id) || await readAutomergeStateByPath(validPath);
    if (!document) {
      document = await initializeDocument(validPath);
    } else {
      document = changeDocument(document, (draft) => {
        copyMarkdownToDraft(draft, raw, document);
        draft.path = validPath;
        draft.fileVersionKey = versionKey;
        draft.lastSavedMarkdown = raw;
        draft.reviewItems = [];
        draft.updatedAt = new Date().toISOString();
      });
      await writeAutomergeState(document);
    }
    return responseFor(document, {
      status: 'synced'
    });
  }

  return {
    open: async (inputPath) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForPath(inputPath), () => open(inputPath));
    },
    create: async (args) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForPath(args.path), () => create(args));
    },
    applyChange: async (args) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForArgs(args), () => applyChange(args));
    },
    merge: async (args) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForArgs(args), () => mergeState(args));
    },
    save: async (args) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForArgs(args), () => save(args));
    },
    mutateAndSave: async (args, mutateModel) => {
      await ensureRecovered();
      return mutateAndSave(args, mutateModel);
    },
    prepareRemove: async (args) => {
      await ensureRecovered();
      return prepareRemove(args);
    },
    commitRemove: async (args) => {
      await ensureRecovered();
      return commitRemove(args);
    },
    rollbackRemove: async (args) => {
      await ensureRecovered();
      return rollbackRemove(args);
    },
    inspect: async (args, operation) => {
      await ensureRecovered();
      return inspect(args, operation);
    },
    cleanupTransactions: recoverPendingDeletions,
    syncFromFile: async (args) => {
      await ensureRecovered();
      return withCrdtLock(await lockScopeForPath(args.path), () => syncFromFile(args));
    }
  };
}
