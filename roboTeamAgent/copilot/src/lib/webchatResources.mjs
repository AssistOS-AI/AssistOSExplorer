import fs from 'node:fs';
import path from 'node:path';

const MAX_RESOURCE_BYTES = 128 * 1024;
const MAX_RESOURCE_TOTAL_BYTES = 384 * 1024;
const TEXT_LIKE_EXT_RE = /\.(txt|md|markdown|json|yaml|yml|csv|tsv|xml|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|hpp)$/i;
const REFERENCE_SECRET_RE = /(^|\/)[^/]*\.secrets(?:\/|$)/i;

function isTextLikeAttachment(mime, filename = '') {
    const normalized = String(mime || '').toLowerCase();
    if (normalized.startsWith('text/')) return true;
    if (/(json|xml|yaml|markdown|javascript|typescript)/.test(normalized)) return true;
    return TEXT_LIKE_EXT_RE.test(String(filename || ''));
}

function resolveSharedAttachmentPath(localPath, sharedRoot = '/shared') {
    const raw = String(localPath || '').trim().replace(/\\/g, '/');
    const normalized = raw.replace(/^\/+/, '');
    if (!normalized.startsWith('shared/')) {
        return null;
    }
    const id = path.basename(normalized);
    if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) {
        return null;
    }
    const root = path.resolve(sharedRoot || '/shared');
    const resolved = path.resolve(root, id);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    try {
        const realRoot = fs.realpathSync(root);
        const realResolved = fs.realpathSync(resolved);
        const realRelative = path.relative(realRoot, realResolved);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
            return null;
        }
        return realResolved;
    } catch {
        return null;
    }
}

function normalizeWorkspaceAttachmentPath(localPath) {
    const raw = String(localPath || '').trim();
    if (!raw || raw.includes('\0')) return null;
    const normalized = raw.replace(/\\+/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    if (segments.includes('.webchat-upload-metadata')) return null;
    if (REFERENCE_SECRET_RE.test(normalized)) return null;
    return normalized;
}

function resolveWorkspaceAttachmentPath(localPath, options = {}) {
    const baseDir = options.workingDir || options.workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '';
    if (!baseDir) return null;
    const normalizedPath = normalizeWorkspaceAttachmentPath(localPath);
    if (!normalizedPath) return null;
    const absoluteBase = path.resolve(baseDir);
    const resolved = path.resolve(absoluteBase, normalizedPath);
    const relative = path.relative(absoluteBase, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
        const real = fs.realpathSync(resolved);
        const realBase = fs.realpathSync(absoluteBase);
        const realRelative = path.relative(realBase, real);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
        return {
            absolutePath: real,
            workspacePath: normalizedPath,
        };
    } catch {
        return null;
    }
}

function resolveWebchatAttachmentPath(attachment, options = {}) {
    const sharedPath = resolveSharedAttachmentPath(
        attachment?.localPath,
        options.sharedRoot || process.env.PLOINKY_SHARED_DIR || '/shared'
    );
    if (sharedPath) {
        return { absolutePath: sharedPath, workspacePath: null };
    }
    return resolveWorkspaceAttachmentPath(attachment?.localPath, options);
}

function resolveWorkspaceReferencePath(reference, options = {}) {
    const baseDir = options.workingDir || options.workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '';
    if (!baseDir) return { status: 'unsafe' };
    const normalizedPath = String(reference?.path || '').replace(/\\+/g, '/').replace(/^\/+/, '');
    if (!normalizedPath) return { status: 'unsafe' };
    if (normalizedPath.split('/').some((segment) => segment === '..')) return { status: 'unsafe' };
    if (REFERENCE_SECRET_RE.test(normalizedPath)) return { status: 'unsafe' };
    const absoluteBase = path.resolve(baseDir);
    const resolved = path.resolve(absoluteBase, normalizedPath);
    const relative = path.relative(absoluteBase, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'unsafe' };
    if (!fs.existsSync(resolved)) return { status: 'missing' };
    try {
        const real = fs.realpathSync(resolved);
        const realBase = fs.realpathSync(absoluteBase);
        const realRelative = path.relative(realBase, real);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return { status: 'unsafe' };
        return { status: 'ok', absolutePath: real };
    } catch {
        return { status: 'missing' };
    }
}

export function materializeWorkspaceReferences(references = [], options = {}) {
    const resources = [];
    const paths = [];
    const warnings = [];
    let totalBytes = 0;
    for (const reference of Array.isArray(references) ? references : []) {
        if (!reference || typeof reference !== 'object') continue;
        if (reference.kind !== 'workspace-path') continue;
        const resolution = resolveWorkspaceReferencePath(reference, options);
        const label = reference.label || reference.path;
        if (resolution.status === 'unsafe') {
            warnings.push(`Reference '${label}' is not a safe workspace path and was not forwarded.`);
            continue;
        }
        if (resolution.status === 'missing') {
            warnings.push(`Reference '${label}' is no longer available on disk.`);
            continue;
        }
        const filePath = resolution.absolutePath;
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            warnings.push(`Reference '${label}' is no longer available on disk.`);
            continue;
        }
        if (stat.isDirectory()) {
            paths.push({
                path: reference.path,
                type: 'directory',
                label: reference.label || null,
            });
            continue;
        }
        if (!stat.isFile()) {
            warnings.push(`Reference '${label}' is not a regular file.`);
            continue;
        }
        if (stat.size > MAX_RESOURCE_BYTES) {
            warnings.push(`Reference '${label}' exceeds ${MAX_RESOURCE_BYTES} bytes and was not forwarded.`);
            continue;
        }
        if (totalBytes + stat.size > MAX_RESOURCE_TOTAL_BYTES) {
            warnings.push('Reference forwarding reached the total byte cap; remaining files were skipped.');
            break;
        }
        const buffer = fs.readFileSync(filePath);
        totalBytes += buffer.length;
        const textLike = isTextLikeAttachment('', filePath);
        resources.push({
            name: reference.path,
            mime: textLike ? 'text/plain' : 'application/octet-stream',
            size: buffer.length,
            workspacePath: reference.path,
            label: reference.label || null,
            ...(textLike
                ? { content: buffer.toString('utf8') }
                : { base64: buffer.toString('base64') })
        });
    }
    return { resources, paths, warnings };
}

export function materializeWebchatAttachments(attachments = [], options = {}) {
    const resources = [];
    const paths = [];
    const warnings = [];
    let totalBytes = 0;
    let totalLimitWarningEmitted = false;
    const sharedRoot = options.sharedRoot || process.env.PLOINKY_SHARED_DIR || '/shared';
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (!attachment || typeof attachment !== 'object') {
            continue;
        }
        const resolution = resolveWebchatAttachmentPath(attachment, {
            sharedRoot,
            workingDir: options.workingDir || options.workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || '',
            workspaceRoot: options.workspaceRoot || '',
        });
        const filename = String(attachment.filename || attachment.id || 'attachment').trim() || 'attachment';
        const mime = String(attachment.mime || 'application/octet-stream').trim() || 'application/octet-stream';
        if (!resolution) {
            warnings.push(`Attachment '${filename}' is not a safe file in the active WebChat working directory and was not forwarded.`);
            continue;
        }
        const filePath = resolution.absolutePath;
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            warnings.push(`Attachment '${filename}' is no longer available on disk.`);
            continue;
        }
        if (!stat.isFile()) {
            warnings.push(`Attachment '${filename}' is not a regular file.`);
            continue;
        }
        if (stat.size > MAX_RESOURCE_BYTES) {
            if (resolution.workspacePath) {
                paths.push({
                    path: resolution.workspacePath,
                    type: 'file',
                    label: filename,
                });
                warnings.push(`Attachment '${filename}' exceeds the ${MAX_RESOURCE_BYTES}-byte inline limit and remains available at path '${resolution.workspacePath}'.`);
            } else {
                warnings.push(`Attachment '${filename}' exceeds the ${MAX_RESOURCE_BYTES}-byte inline limit and was not inlined.`);
            }
            continue;
        }
        if (totalBytes + stat.size > MAX_RESOURCE_TOTAL_BYTES) {
            if (resolution.workspacePath) {
                paths.push({
                    path: resolution.workspacePath,
                    type: 'file',
                    label: filename,
                });
            }
            if (!totalLimitWarningEmitted) {
                warnings.push('Attachment inlining reached the total byte cap; remaining workspace files are still available by path.');
                totalLimitWarningEmitted = true;
            }
            continue;
        }
        const buffer = fs.readFileSync(filePath);
        totalBytes += buffer.length;
        const textLike = isTextLikeAttachment(mime, filename);
        resources.push({
            name: filename,
            mime,
            size: buffer.length,
            downloadUrl: attachment.downloadUrl || null,
            localPath: resolution.workspacePath || attachment.localPath || null,
            ...(textLike
                ? { content: buffer.toString('utf8') }
                : { base64: buffer.toString('base64') })
        });
    }
    return { resources, paths, warnings };
}

export function materializeWebchatContext(normalizedMessage = {}, options = {}) {
    const referenceWorkingDir = options.workingDir || process.env.PLOINKY_WORKSPACE_ROOT || '';
    const {
        resources: attachmentResources,
        paths: attachmentPaths,
        warnings: attachmentWarnings,
    } = materializeWebchatAttachments(
        normalizedMessage.attachments || [],
        { workingDir: referenceWorkingDir, workspaceRoot: options.workspaceRoot || '' }
    );
    const { resources: referenceResources, paths: referencePaths, warnings: referenceWarnings } = materializeWorkspaceReferences(
        normalizedMessage.references || [],
        { workingDir: referenceWorkingDir, workspaceRoot: options.workspaceRoot || '' }
    );
    return {
        resources: [...attachmentResources, ...referenceResources],
        paths: [...attachmentPaths, ...referencePaths],
        warnings: [...attachmentWarnings, ...referenceWarnings],
    };
}
