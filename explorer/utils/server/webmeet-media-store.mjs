import crypto from 'node:crypto';

import { createExplorerPrivateDataBoundary } from './private-data-boundary.mjs';
import { withClassifiedWorkspaceFile } from './protected-workspace-paths.mjs';

const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const BLOB_ID_RE = /^[a-f0-9]{48}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9_.:-]+$/;
const SAFE_AGENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (!Number.isFinite(length) || length < 2) break;
    offset += length + 2;
  }
  throw new Error('JPEG dimensions could not be read.');
}

function webpSize(buffer) {
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (kind === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  throw new Error('WebP dimensions could not be read.');
}

export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('The uploaded image is empty.');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('Files may not exceed 15 MB.');
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png', extension: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return { mimeType: 'image/gif', extension: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mimeType: 'image/jpeg', extension: 'jpg', ...jpegSize(buffer) };
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp', ...webpSize(buffer) };
  }
  throw new Error('Only PNG, JPEG, WebP, and GIF images are supported.');
}

function safeFilename(value) {
  const filename = String(value || '').replace(/\0/g, '').split(/[\\/]/).at(-1)?.trim() || '';
  const parsed = filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const extension = parsed.match(/\.([a-zA-Z0-9]{1,16})$/)?.[1]?.toLowerCase() || '';
  const stem = (extension ? parsed.slice(0, -(extension.length + 1)) : parsed)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 180) || 'file';
  return extension ? `${stem}.${extension}` : stem;
}

function safeFileExtension(path, filename) {
  const extension = String(path.extname(filename || '') || '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : '';
}

function mimeTypeForExtension(extension) {
  return ({
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
  })[extension] || 'application/octet-stream';
}

function inspectAsset(buffer, metadata, path) {
  let image = null;
  try {
    image = inspectImage(buffer);
  } catch (error) {
    if (buffer.length > MAX_ASSET_BYTES) throw error;
  }
  let filename = safeFilename(metadata?.filename);
  if (image) {
    const stem = filename.replace(/\.[a-zA-Z0-9]{1,16}$/, '') || 'image';
    filename = `${stem}.${image.extension}`;
    return { kind: 'image', filename, ...image };
  }
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    const stem = filename.replace(/\.[a-zA-Z0-9]{1,16}$/, '') || 'document';
    filename = `${stem}.pdf`;
  }
  const extension = safeFileExtension(path, filename);
  return {
    kind: 'file',
    filename,
    mimeType: mimeTypeForExtension(extension),
    extension,
  };
}

function safeId(value, label) {
  const id = String(value || '').trim();
  if (!id || !SAFE_ID_RE.test(id) || id.includes('..')) throw new Error(`Invalid ${label}.`);
  return id;
}

function safeRoomFolderPath(value, path) {
  const normalized = path.posix.normalize(`/${String(value || '').trim().replace(/^\/+/, '')}`);
  if (!/^\/WebMeet\/[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error('Invalid WebMeet room folder path.');
  return normalized;
}

function validateBlobRef(blobRef, expectedAgent) {
  const id = String(blobRef?.id || '').trim();
  const agent = String(blobRef?.agent || '').trim();
  const localPath = String(blobRef?.localPath || '').trim();
  if (!BLOB_ID_RE.test(id)) throw new Error('Invalid Explorer blob id.');
  if (!SAFE_AGENT_RE.test(expectedAgent) || expectedAgent === '.' || expectedAgent === '..') {
    throw new Error('Explorer blob storage requires a short agent name.');
  }
  if (!SAFE_AGENT_RE.test(agent) || agent === '.' || agent === '..') {
    throw new Error('The staged blob agent must be a short agent name.');
  }
  if (agent !== expectedAgent) throw new Error('The staged blob belongs to a different agent.');
  if (localPath !== `.data/${agent}/blobs/${id}`) throw new Error('The staged blob path does not match its id.');
  return { id, localPath };
}

export function createWebMeetMediaStore({
  fs,
  path,
  validatePath,
  workspaceRoot,
  agentName = process.env.PLOINKY_AGENT_NAME || process.env.AGENT_NAME || 'explorer'
}) {
  // Staged blobs live in this agent's own `.data/<agent>/blobs`, which the
  // user-facing `validatePath` refuses; they are reached through the private
  // data boundary instead.
  const stagedBlobs = createExplorerPrivateDataBoundary({ fs, path, workspaceRoot, agentName: String(agentName || 'explorer') });

  async function assetFolderPath(roomFolderPath, assetId) {
    const folderPath = safeRoomFolderPath(roomFolderPath, path);
    return validatePath(`${folderPath}/assets/${safeId(assetId, 'assetId')}`);
  }

  async function read({roomId, roomFolderPath, assetId}) {
    const folderPath = safeRoomFolderPath(roomFolderPath, path);
    const cleanRoomId = safeId(roomId, 'roomId');
    const cleanAssetId = safeId(assetId, 'assetId');
    const assetFolder = await assetFolderPath(folderPath, cleanAssetId);
    const entries = await fs.readdir(assetFolder, {withFileTypes: true});
    if (entries.length !== 1 || !entries[0].isFile() || entries[0].isSymbolicLink()) {
      throw new Error('A WebMeet asset must contain exactly one regular file.');
    }
    const filename = entries[0].name;
    if (safeFilename(filename) !== filename) throw new Error('The WebMeet asset filename is invalid.');
    const filePath = path.join(assetFolder, filename);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) {
      throw new Error('The WebMeet asset file is invalid.');
    }
    const content = await withClassifiedWorkspaceFile(filePath, (handle) => handle.readFile());
    const inspected = inspectAsset(content, {filename}, path);
    const asset = {
      assetId: cleanAssetId,
      roomId: cleanRoomId,
      ...inspected,
      size: stat.size,
      workspaceUrl: `${folderPath}/assets/${cleanAssetId}/${filename}`,
    };
    return asset;
  }

  async function commit({ roomId, roomFolderPath, blobRef }) {
    const cleanRoomId = safeId(roomId, 'roomId');
    const folderPath = safeRoomFolderPath(roomFolderPath, path);
    const staged = validateBlobRef(blobRef, String(agentName || 'explorer'));
    const blobPath = await stagedBlobs.resolveFile(['blobs', staged.id]);
    const blobMetaPath = await stagedBlobs.resolveFile(['blobs', `${staged.id}.json`]);
    const stat = await fs.lstat(blobPath);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error('Files may not exceed 15 MB.');
    const metadata = JSON.parse(await fs.readFile(blobMetaPath, 'utf8'));
    if (
      String(metadata?.id || '') !== staged.id
      || String(metadata?.agent || '') !== String(agentName || 'explorer')
      || String(metadata?.localPath || '') !== staged.localPath
    ) {
      throw new Error('The staged blob metadata does not match its reference.');
    }
    if (Number.isFinite(Number(metadata?.size)) && Number(metadata.size) !== stat.size) {
      throw new Error('The staged blob size does not match its metadata.');
    }
    const inspected = inspectAsset(await fs.readFile(blobPath), metadata, path);
    const assetId = `asset_${crypto.randomUUID()}`;
    const workspaceUrl = `${folderPath}/assets/${assetId}/${inspected.filename}`;
    const targetPath = await validatePath(workspaceUrl);
    await fs.mkdir(await assetFolderPath(folderPath, assetId), { recursive: true });
    try {
      await fs.rename(blobPath, targetPath);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await fs.copyFile(blobPath, targetPath);
      await fs.unlink(blobPath);
    }
    await fs.unlink(blobMetaPath).catch(() => {});
    const asset = {
      assetId, roomId: cleanRoomId, kind: inspected.kind,
      filename: inspected.filename,
      mimeType: inspected.mimeType, extension: inspected.extension, size: stat.size,
      workspaceUrl
    };
    if (inspected.kind === 'image') {
      asset.width = inspected.width;
      asset.height = inspected.height;
    }
    return asset;
  }

  return { commit, read };
}
