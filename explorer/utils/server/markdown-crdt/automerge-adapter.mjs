import * as Automerge from '../../../shared/vendor/automerge/dist/mjs/entrypoints/fullfat_node.js';

export function createDocument(initialState = {}) {
  return Automerge.from(initialState);
}

export function loadDocument(binary, options = undefined) {
  if (!binary || binary.length === 0) {
    return createDocument();
  }
  return Automerge.load(binary, options);
}

export function saveDocument(document) {
  return Automerge.save(document);
}

export function changeDocument(document, callback) {
  return Automerge.change(document, callback);
}

export function changeDocumentAtHeads(document, heads, callback) {
  // Resolve editor offsets against its historical view before merging the fork.
  const fork = Automerge.clone(Automerge.view(document, heads));
  const changedFork = Automerge.change(fork, callback);
  const previousHeads = Automerge.getHeads(fork);
  const newHeads = Automerge.getHeads(changedFork);
  return {
    newDoc: Automerge.merge(document, changedFork),
    newHeads: previousHeads.length === newHeads.length
      && previousHeads.every((head, index) => head === newHeads[index])
      ? null
      : newHeads
  };
}

export function getDocumentHeads(document) {
  return Automerge.getHeads(document);
}

export function viewDocumentAtHeads(document, heads = []) {
  return Automerge.view(document, heads);
}

export function documentHasHeads(document, heads = []) {
  return Automerge.hasHeads(document, heads);
}

export function documentHasActorChanges(document, actor) {
  const actorDocument = Automerge.clone(document, { actor });
  return Boolean(Automerge.getLastLocalChange(actorDocument));
}

export function mergeDocuments(local, remote) {
  return Automerge.merge(local, remote);
}

export function applyDocumentChanges(document, changes = []) {
  return Automerge.applyChanges(document, changes)[0];
}

export function getDocumentChanges(previous, current) {
  return Automerge.getChanges(previous, current);
}

export function getDocumentChangesSince(document, heads = []) {
  return Automerge.getChangesSince(document, heads);
}

export function createText(value = '') {
  return String(value ?? '');
}

export function spliceText(document, path, index, deleteCount, insertText = '') {
  return Automerge.splice(document, path, index, deleteCount, String(insertText ?? ''));
}

export function updateText(document, path, value = '') {
  return Automerge.updateText(document, path, String(value ?? ''));
}

export const load = loadDocument;
export const save = saveDocument;
export const change = changeDocument;
export const merge = mergeDocuments;
export const getHeads = getDocumentHeads;
export const view = viewDocumentAtHeads;
export const hasHeads = documentHasHeads;
export const applyChanges = applyDocumentChanges;
export const getChanges = getDocumentChanges;
export const getChangesSince = getDocumentChangesSince;
