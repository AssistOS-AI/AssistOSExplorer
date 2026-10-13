import {
    callAgentTool,
    ensureSuccess,
    extractToolText,
    parseToolResult,
    ToolError
} from "../../../services/infrastructure/explorerApi.js";
import {
    DPU_AUDIT_PATH,
    DPU_MY_SPACE_PATH,
    DPU_RESEARCH_DATA_PATH,
    DPU_JOBS_PATH,
    DPU_ROOT_PATH,
    DPU_SECRETS_PATH,
    DPU_SHARED_PATH,
    isDpuSecretPath as isAnyDpuSecretPath,
    isDpuVirtualPath as isAnyDpuVirtualPath,
    normalizeDpuPath,
    resolveDpuSecretKey
} from "../../../services/dpu/dpuPaths.js";
import { annotateSharedEntries, resolveDpuConfidentialNodeAtPath } from "../../../services/dpu/dpuPathResolver.js";
import {
    isDpuFileType,
    isDpuFolderType,
    normalizeDpuObjectType,
    toExplorerEntryType
} from "../../../services/dpu/dpuTypes.js";
import {
    renderCodePreview
} from "./file-exp-utils.js";

export {
    DPU_AUDIT_PATH,
    DPU_ROOT_PATH,
    DPU_MY_SPACE_PATH,
    DPU_SHARED_PATH,
    DPU_SECRETS_PATH
    ,DPU_RESEARCH_DATA_PATH
    ,DPU_JOBS_PATH
};

function isSecretsRootPath(path) {
    return normalizeDpuPath(path) === DPU_SECRETS_PATH;
}

function normalizeSecretDisplayNameForCreate(name) {
    const displayName = String(name || '').trim();
    if (!displayName) {
        throw new ToolError('invalid_secret_name', 'Secret name is required.');
    }
    if (displayName.includes('\0')) {
        throw new ToolError('invalid_secret_name', 'Secret name contains an invalid null byte.');
    }
    if (/[\\/]/.test(displayName)) {
        throw new ToolError('invalid_secret_name', 'Secret name cannot contain path separators.');
    }
    return displayName;
}

function deriveSecretKeyFromDisplayName(displayName) {
    let key = String(displayName || '')
        .trim()
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!key) {
        key = 'SECRET';
    }
    if (/^[0-9]/.test(key)) {
        key = `_${key}`;
    }
    return key;
}

function hasDpuClient() {
    return Boolean(window.webSkel?.appServices?.getClient?.('dpuAgent'));
}

async function ensureDpuCommentsComponentRegistered() {
    const ensureComponentRegistered = window.assistOS?.webSkel?.ensureComponentRegistered;
    if (typeof ensureComponentRegistered !== 'function') {
        return;
    }
    await ensureComponentRegistered('dpu-comments-popover');
}

function getDpuCache(fileExp) {
    if (!fileExp.__dpuVirtualState) {
        fileExp.__dpuVirtualState = {
            roots: null,
            nodesByPath: new Map()
        };
    }
    return fileExp.__dpuVirtualState;
}

function normalizeManagedPath(fileExp, input) {
    return normalizeDpuPath(fileExp.normalizePath(String(input || '')));
}

function makeEntry(name, type, extra = {}) {
    return {
        name,
        type,
        size: null,
        modified: null,
        virtualProvider: 'dpu',
        ...extra
    };
}

function indexNode(fileExp, path, node) {
    const cache = getDpuCache(fileExp);
    cache.nodesByPath.set(normalizeManagedPath(fileExp, path), {
        ...node,
        path: normalizeManagedPath(fileExp, path),
        virtualProvider: 'dpu'
    });
}

function resetDpuCache(fileExp) {
    fileExp.__dpuVirtualState = {
        roots: null,
        nodesByPath: new Map()
    };
}

function invalidateTreeViewBranches(fileExp, affectedPaths = []) {
    const treeViewState = fileExp?.treeViewState;
    if (!treeViewState?.childrenCache || !treeViewState?.loadingPaths) {
        return;
    }
    const normalizedTargets = affectedPaths
        .map((targetPath) => normalizeManagedPath(fileExp, targetPath))
        .filter(Boolean);
    if (!normalizedTargets.length) {
        return;
    }
    for (const cachedPath of Array.from(treeViewState.childrenCache.keys())) {
        const normalizedCachedPath = normalizeManagedPath(fileExp, cachedPath);
        const shouldInvalidate = normalizedTargets.some((targetPath) => (
            normalizedCachedPath === targetPath
            || normalizedCachedPath.startsWith(`${targetPath}/`)
            || targetPath.startsWith(`${normalizedCachedPath}/`)
        ));
        if (shouldInvalidate) {
            treeViewState.childrenCache.delete(cachedPath);
            treeViewState.loadingPaths.delete(cachedPath);
        }
    }
}

function getIndexedNode(fileExp, path) {
    const cache = getDpuCache(fileExp);
    return cache.nodesByPath.get(normalizeManagedPath(fileExp, path)) || null;
}

export async function callDpuTool(toolName, args = {}) {
    const raw = await callAgentTool('dpuAgent', toolName, args, { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw);
    if (!parsed || typeof parsed !== 'object') {
        const detail = extractToolText(raw).trim();
        throw new ToolError(
            'invalid_dpu_response',
            detail ? `Invalid DPU response for ${toolName}: ${detail}` : `Invalid DPU response for ${toolName}.`
        );
    }
    if (parsed.ok === false) {
        throw new ToolError('dpu_error', parsed.error || `DPU call failed: ${toolName}`, parsed);
    }
    return parsed;
}

export async function readDpuCurrentItemState(fileExp, targetPath) {
    const normalizedPath = normalizeManagedPath(fileExp, targetPath);
    const node = await resolveDpuNode(fileExp, normalizedPath);
    if (!node) {
        throw new Error(`Confidential resource not found: ${normalizedPath}`);
    }

    if (node.kind === 'secret') {
        const parsed = await callDpuTool('dpu_secret_get', { key: node.key });
        return {
            kind: 'secret',
            path: normalizedPath,
            secret: parsed.secret || {}
        };
    }

    if (node.kind === 'confidential' || node.kind === 'shared-object') {
        const parsed = await callDpuTool('dpu_confidential_get', { id: node.objectId });
        return {
            kind: 'confidential',
            path: normalizedPath,
            object: parsed.object || {}
        };
    }

    throw new Error(`Unsupported confidential resource: ${normalizedPath}`);
}

async function getDpuRoots(fileExp) {
    const cache = getDpuCache(fileExp);
    if (cache.roots) {
        return cache.roots;
    }
    const parsed = await callDpuTool('dpu_workspace_roots');
    cache.roots = parsed.roots || {};
    indexNode(fileExp, DPU_ROOT_PATH, {
        kind: 'root',
        type: 'directory',
        canWrite: false,
        canCreateChildren: false,
        immutableRoot: true
    });
    indexNode(fileExp, DPU_MY_SPACE_PATH, {
        kind: 'my-space-root',
        type: 'directory',
        objectId: cache.roots?.mySpace?.id || '',
        canWrite: true,
        canCreateChildren: true,
        immutableRoot: true
    });
    indexNode(fileExp, DPU_SHARED_PATH, {
        kind: 'shared-root',
        type: 'directory',
        canWrite: false,
        canCreateChildren: false,
        immutableRoot: true
    });
    indexNode(fileExp, DPU_SECRETS_PATH, {
        kind: 'secrets-root',
        type: 'directory',
        canWrite: true,
        canCreateChildren: false,
        canCreateFiles: true,
        canCreateDirectories: false,
        immutableRoot: true
    });
    for (const [researchPath, kind] of [[DPU_RESEARCH_DATA_PATH, 'research-root'], [DPU_JOBS_PATH, 'jobs-root']]) {
        indexNode(fileExp, researchPath, { kind, type: 'directory', canWrite: false, canCreateChildren: false, immutableRoot: true });
    }
    if (cache.roots?.audit?.path === DPU_AUDIT_PATH) {
        indexNode(fileExp, DPU_AUDIT_PATH, {
            kind: 'audit-root',
            type: 'directory',
            canWrite: false,
            canCreateChildren: false,
            canCreateFiles: false,
            canCreateDirectories: false,
            immutableRoot: true
        });
    }
    return cache.roots;
}

function createRootEntries(fileExp, roots = {}) {
    indexNode(fileExp, DPU_MY_SPACE_PATH, {
        kind: 'my-space-root',
        type: 'directory',
        objectId: roots?.mySpace?.id || '',
        canWrite: true,
        canCreateChildren: true,
        immutableRoot: true
    });
    indexNode(fileExp, DPU_SHARED_PATH, {
        kind: 'shared-root',
        type: 'directory',
        canWrite: false,
        canCreateChildren: false,
        immutableRoot: true
    });
    indexNode(fileExp, DPU_SECRETS_PATH, {
        kind: 'secrets-root',
        type: 'directory',
        canWrite: true,
        canCreateChildren: false,
        canCreateFiles: true,
        canCreateDirectories: false,
        immutableRoot: true
    });
    const entries = [
        {
            ...makeEntry('My Space', 'directory'),
            dpuCanWrite: true,
            dpuCanCreateChildren: true,
            dpuCanCreateFiles: true,
            dpuCanCreateDirectories: true,
            dpuCanRename: false,
            dpuCanDelete: false,
            dpuImmutableRoot: true,
            path: DPU_MY_SPACE_PATH
        },
        {
            ...makeEntry('Shared with me', 'directory'),
            dpuCanWrite: false,
            dpuCanCreateChildren: false,
            dpuCanCreateFiles: false,
            dpuCanCreateDirectories: false,
            dpuCanRename: false,
            dpuCanDelete: false,
            dpuImmutableRoot: true,
            path: DPU_SHARED_PATH
        },
        {
            ...makeEntry('Secrets', 'directory'),
            dpuCanWrite: true,
            dpuCanCreateChildren: false,
            dpuCanCreateFiles: true,
            dpuCanCreateDirectories: false,
            dpuCanRename: false,
            dpuCanDelete: false,
            dpuImmutableRoot: true,
            path: DPU_SECRETS_PATH
        },
        {
            ...makeEntry('Research Data', 'directory'), path: DPU_RESEARCH_DATA_PATH,
            dpuCanWrite: false, dpuCanCreateChildren: false, dpuCanRename: false, dpuCanDelete: false, dpuImmutableRoot: true
        },
        {
            ...makeEntry('Jobs', 'directory'), path: DPU_JOBS_PATH,
            dpuCanWrite: false, dpuCanCreateChildren: false, dpuCanRename: false, dpuCanDelete: false, dpuImmutableRoot: true
        }
    ];
    if (roots?.audit?.path === DPU_AUDIT_PATH) {
        indexNode(fileExp, DPU_AUDIT_PATH, {
            kind: 'audit-root',
            type: 'directory',
            canWrite: false,
            canCreateChildren: false,
            canCreateFiles: false,
            canCreateDirectories: false,
            immutableRoot: true
        });
        entries.push({
            ...makeEntry('Audit', 'directory'),
            dpuCanWrite: false,
            dpuCanCreateChildren: false,
            dpuCanCreateFiles: false,
            dpuCanCreateDirectories: false,
            dpuCanRename: false,
            dpuCanDelete: false,
            dpuImmutableRoot: true,
            path: DPU_AUDIT_PATH
        });
    }
    return entries;
}

function createSecretEntry(fileExp, secret) {
    const entryPath = fileExp.joinPath(DPU_SECRETS_PATH, secret.key);
    const displayName = String(secret.displayName || secret.key || '').trim() || secret.key;
    indexNode(fileExp, entryPath, {
        kind: 'secret',
        type: 'file',
        key: secret.key,
        displayName,
        secretId: secret.id,
        ownerId: secret.ownerId || '',
        role: secret.role || '',
        updatedAt: secret.updatedAt || '',
        canWrite: Boolean(secret.canWrite),
        canDelete: Boolean(secret.canWrite),
        canRename: false,
        canCreateChildren: false,
        canCreateFiles: false,
        canCreateDirectories: false,
        immutableRoot: false
    });
    return {
        ...makeEntry(displayName, 'file', {
            modified: secret.updatedAt || null,
            dpuCanWrite: Boolean(secret.canWrite),
            dpuCanRename: false,
            dpuCanDelete: Boolean(secret.canWrite),
            dpuCanCreateChildren: false,
            dpuCanCreateFiles: false,
            dpuCanCreateDirectories: false,
            dpuImmutableRoot: false
        }),
        path: entryPath
    };
}

function createConfidentialEntry(fileExp, basePath, objectRecord, kind = 'confidential', options = {}) {
    const objectType = normalizeDpuObjectType(objectRecord.type);
    const entryName = String(options.virtualName || objectRecord.name || '').trim();
    const entryPath = fileExp.joinPath(basePath, entryName);
    const canWrite = Boolean(objectRecord.canWrite);
    indexNode(fileExp, entryPath, {
        kind,
        type: objectType,
        objectId: objectRecord.id,
        ownerId: objectRecord.ownerId || '',
        role: objectRecord.role || '',
        updatedAt: objectRecord.updatedAt || '',
        name: entryName,
        actualName: objectRecord.name,
        canWrite,
        canCreateChildren: isDpuFolderType(objectType) && canWrite,
        canCreateFiles: isDpuFolderType(objectType) && canWrite,
        canCreateDirectories: isDpuFolderType(objectType) && canWrite,
        immutableRoot: false
    });
    return {
        ...makeEntry(entryName, toExplorerEntryType(objectType), {
            modified: objectRecord.updatedAt || null,
            dpuCanWrite: canWrite,
            dpuCanCreateChildren: isDpuFolderType(objectType) && canWrite,
            dpuCanCreateFiles: isDpuFolderType(objectType) && canWrite,
            dpuCanCreateDirectories: isDpuFolderType(objectType) && canWrite,
            dpuCanRename: canWrite,
            dpuCanDelete: canWrite,
            dpuImmutableRoot: false
        }),
        path: entryPath
    };
}

function createAuditEntry(fileExp, auditItem) {
    const entryName = String(auditItem?.name || '').trim();
    const entryPath = fileExp.joinPath(DPU_AUDIT_PATH, entryName);
    indexNode(fileExp, entryPath, {
        kind: 'audit-file',
        type: 'file',
        name: entryName,
        updatedAt: auditItem?.updatedAt || '',
        canWrite: false,
        canDelete: false,
        canRename: false,
        canCreateChildren: false,
        canCreateFiles: false,
        canCreateDirectories: false,
        immutableRoot: false
    });
    return {
        ...makeEntry(entryName, 'file', {
            modified: auditItem?.updatedAt || null,
            dpuCanWrite: false,
            dpuCanRename: false,
            dpuCanDelete: false,
            dpuCanCreateChildren: false,
            dpuCanCreateFiles: false,
            dpuCanCreateDirectories: false,
            dpuImmutableRoot: false
        }),
        path: entryPath
    };
}

async function resolveMySpaceNode(fileExp, normalizedPath) {
    const cached = getIndexedNode(fileExp, normalizedPath);
    if (cached) return cached;

    if (normalizedPath === DPU_MY_SPACE_PATH) {
        return getIndexedNode(fileExp, DPU_MY_SPACE_PATH);
    }

    const objectRecord = await resolveDpuConfidentialNodeAtPath(normalizedPath, {
        getRoots: async () => getDpuRoots(fileExp),
        listConfidential: async (args) => callDpuTool('dpu_confidential_list', args)
    });
    if (!objectRecord) {
        return null;
    }
    createConfidentialEntry(fileExp, fileExp.parentPath(normalizedPath) || DPU_MY_SPACE_PATH, objectRecord);
    return getIndexedNode(fileExp, normalizedPath);
}

async function resolveSharedNode(fileExp, normalizedPath) {
    const cached = getIndexedNode(fileExp, normalizedPath);
    if (cached) return cached;

    if (normalizedPath === DPU_SHARED_PATH) {
        await getDpuRoots(fileExp);
        return getIndexedNode(fileExp, DPU_SHARED_PATH);
    }

    const objectRecord = await resolveDpuConfidentialNodeAtPath(normalizedPath, {
        getRoots: async () => getDpuRoots(fileExp),
        listConfidential: async (args) => callDpuTool('dpu_confidential_list', args)
    });
    if (!objectRecord) {
        return null;
    }
    createConfidentialEntry(
        fileExp,
        fileExp.parentPath(normalizedPath) || DPU_SHARED_PATH,
        objectRecord,
        'shared-object',
        normalizedPath === fileExp.joinPath(DPU_SHARED_PATH, objectRecord.virtualName || '')
            ? { virtualName: objectRecord.virtualName }
            : {}
    );
    return getIndexedNode(fileExp, normalizedPath);
}

async function resolveSecretNode(fileExp, normalizedPath) {
    const cached = getIndexedNode(fileExp, normalizedPath);
    if (cached) return cached;

    if (normalizedPath === DPU_SECRETS_PATH) {
        await getDpuRoots(fileExp);
        return getIndexedNode(fileExp, DPU_SECRETS_PATH);
    }

    const secretKey = resolveDpuSecretKey(normalizedPath);
    if (!secretKey) {
        return null;
    }
    const secrets = await callDpuTool('dpu_secret_list');
    const secret = Array.isArray(secrets.secrets)
        ? secrets.secrets.find((item) => item?.key === secretKey)
        : null;
    if (!secret) {
        return null;
    }
    createSecretEntry(fileExp, secret);
    return getIndexedNode(fileExp, normalizedPath);
}

async function resolveAuditNode(fileExp, normalizedPath) {
    const cached = getIndexedNode(fileExp, normalizedPath);
    if (cached) return cached;
    if (normalizedPath === DPU_AUDIT_PATH) {
        await getDpuRoots(fileExp);
        return getIndexedNode(fileExp, DPU_AUDIT_PATH);
    }
    const fileName = normalizedPath.slice(`${DPU_AUDIT_PATH}/`.length);
    if (!fileName) {
        return null;
    }
    const parsed = await callDpuTool('dpu_audit_list');
    const item = Array.isArray(parsed.items)
        ? parsed.items.find((entry) => entry?.name === fileName)
        : null;
    if (!item) {
        return null;
    }
    createAuditEntry(fileExp, item);
    return getIndexedNode(fileExp, normalizedPath);
}

export function isDpuVirtualPath(path) {
    return isAnyDpuVirtualPath(path);
}

export function isDpuSecretPath(path) {
    return isAnyDpuSecretPath(path);
}

export function isDpuManagedPath(path) {
    return isDpuVirtualPath(path);
}

export function shouldExposeDpuRoot() {
    return hasDpuClient();
}

export async function mergeDpuRootEntry(fileExp, entries = []) {
    if (!shouldExposeDpuRoot()) {
        return Array.isArray(entries) ? entries : [];
    }
    const filtered = (Array.isArray(entries) ? entries : []).filter((entry) => String(entry?.name || '') !== 'Confidential');
    return [
        ...filtered,
        {
            ...makeEntry('Confidential', 'directory'),
            path: DPU_ROOT_PATH
        }
    ];
}

export async function resolveDpuNode(fileExp, path) {
    const normalizedPath = normalizeManagedPath(fileExp, path);
    if (!isDpuVirtualPath(normalizedPath)) {
        return null;
    }

    if (normalizedPath === DPU_ROOT_PATH) {
        await getDpuRoots(fileExp);
        return getIndexedNode(fileExp, DPU_ROOT_PATH);
    }
    if (normalizedPath === DPU_MY_SPACE_PATH || normalizedPath.startsWith(`${DPU_MY_SPACE_PATH}/`)) {
        return resolveMySpaceNode(fileExp, normalizedPath);
    }
    if (normalizedPath === DPU_SHARED_PATH || normalizedPath.startsWith(`${DPU_SHARED_PATH}/`)) {
        return resolveSharedNode(fileExp, normalizedPath);
    }
    if (normalizedPath === DPU_SECRETS_PATH || normalizedPath.startsWith(`${DPU_SECRETS_PATH}/`)) {
        return resolveSecretNode(fileExp, normalizedPath);
    }
    if (normalizedPath === DPU_RESEARCH_DATA_PATH || normalizedPath === DPU_JOBS_PATH) {
        await getDpuRoots(fileExp);
        return getIndexedNode(fileExp, normalizedPath);
    }
    if (normalizedPath.startsWith(`${DPU_RESEARCH_DATA_PATH}/`) || normalizedPath.startsWith(`${DPU_JOBS_PATH}/`)) {
        let node = getIndexedNode(fileExp, normalizedPath);
        if (!node) {
            await listDpuDirectory(fileExp, normalizedPath.startsWith(`${DPU_RESEARCH_DATA_PATH}/`) ? DPU_RESEARCH_DATA_PATH : DPU_JOBS_PATH);
            node = getIndexedNode(fileExp, normalizedPath);
        }
        return node;
    }
    if (normalizedPath === DPU_AUDIT_PATH || normalizedPath.startsWith(`${DPU_AUDIT_PATH}/`)) {
        return resolveAuditNode(fileExp, normalizedPath);
    }

    return null;
}

export async function listDpuDirectory(fileExp, path) {
    const normalizedPath = normalizeManagedPath(fileExp, path);
    const roots = await getDpuRoots(fileExp);

    if (normalizedPath === DPU_ROOT_PATH) {
        return createRootEntries(fileExp, roots);
    }

    if (normalizedPath === DPU_SECRETS_PATH) {
        const parsed = await callDpuTool('dpu_secret_list');
        return (Array.isArray(parsed.secrets) ? parsed.secrets : [])
            .map((secret) => createSecretEntry(fileExp, secret));
    }

    if (normalizedPath === DPU_RESEARCH_DATA_PATH) {
        const parsed = await callDpuTool('dpu_resource_list');
        return (Array.isArray(parsed.items) ? parsed.items : []).map((resource) => {
            const name = `${String(resource.name || resource.externalId || resource.id).replaceAll('/', '／')} — ${resource.id.slice(0, 8)}.json`;
            const itemPath = `${DPU_RESEARCH_DATA_PATH}/${name}`;
            indexNode(fileExp, itemPath, { kind: 'research-resource', type: 'file', resourceId: resource.id, resource });
            return { ...makeEntry(name, 'file'), path: itemPath, dpuCanWrite: false, dpuCanDelete: false, dpuCanRename: false };
        });
    }

    if (normalizedPath === DPU_JOBS_PATH) {
        const parsed = await callDpuTool('dpu_job_list');
        return (Array.isArray(parsed.items) ? parsed.items : []).map((job) => {
            const name = `${job.type} — ${job.id}.json`;
            const itemPath = `${DPU_JOBS_PATH}/${name}`;
            indexNode(fileExp, itemPath, { kind: 'research-job', type: 'file', jobId: job.id, job });
            return { ...makeEntry(name, 'file'), path: itemPath, dpuCanWrite: false, dpuCanDelete: false, dpuCanRename: false };
        });
    }

    if (normalizedPath === DPU_AUDIT_PATH) {
        const parsed = await callDpuTool('dpu_audit_list');
        return (Array.isArray(parsed.items) ? parsed.items : [])
            .map((item) => createAuditEntry(fileExp, item));
    }

    if (normalizedPath === DPU_SHARED_PATH) {
        const parsed = await callDpuTool('dpu_confidential_list', { scope: 'shared' });
        return annotateSharedEntries(parsed.items)
            .map((item) => createConfidentialEntry(fileExp, DPU_SHARED_PATH, item, 'shared-object', {
                virtualName: item.virtualName
            }));
    }

    if (normalizedPath.startsWith(`${DPU_SHARED_PATH}/`)) {
        const parentNode = await resolveSharedNode(fileExp, normalizedPath);
        if (!parentNode || !isDpuFolderType(parentNode.type) || !parentNode.objectId) {
            return [];
        }
        const parsed = await callDpuTool('dpu_confidential_list', {
            scope: 'my-space',
            parentId: parentNode.objectId
        });
        return (Array.isArray(parsed.items) ? parsed.items : [])
            .map((item) => createConfidentialEntry(fileExp, normalizedPath, item, 'shared-object'));
    }

    const parentNode = await resolveMySpaceNode(fileExp, normalizedPath);
    if (!parentNode || !isDpuFolderType(parentNode.type) || !parentNode.objectId) {
        return [];
    }
    const parsed = await callDpuTool('dpu_confidential_list', {
        scope: 'my-space',
        parentId: parentNode.objectId
    });
    return (Array.isArray(parsed.items) ? parsed.items : [])
        .map((item) => createConfidentialEntry(fileExp, normalizedPath, item));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function researchStateType(value) {
    const state = String(value || '').toLowerCase();
    if (['local', 'shared', 'available', 'succeeded'].includes(state)) return 'success';
    if (['blocked', 'failed', 'cancelled'].includes(state)) return 'error';
    return '';
}

function buildResearchFields(fields) {
    return fields.map(([label, value]) => `
        <div class="dpu-research-field">
            <span class="dpu-research-field-label">${escapeHtml(label)}</span>
            <span class="dpu-research-field-value">${escapeHtml(value || '—')}</span>
        </div>
    `).join('');
}

function buildResearchProvenance(events, unavailable = false) {
    const items = Array.isArray(events) ? events : [];
    const countLabel = unavailable ? 'Unavailable' : `${items.length} event${items.length === 1 ? '' : 's'}`;
    const content = unavailable
        ? '<div class="settings-empty-state">Provenance could not be loaded. Reopen the resource to retry.</div>'
        : items.length
            ? items.map((event) => `
                <div class="dpu-provenance-event">
                    <div class="dpu-research-header">
                        <div class="dpu-research-field-label">${escapeHtml(event.relation || 'event')}</div>
                        <span class="settings-card-meta">${escapeHtml(event.timestamp || '')}</span>
                    </div>
                    <div class="dpu-research-fields">
                        ${buildResearchFields([
                            ['Job', event.jobId],
                            ['Source', event.sourceId],
                            ['Revision', event.revision],
                            ['Checksum entries', Array.isArray(event.fileManifest) ? event.fileManifest.length : 0]
                        ])}
                    </div>
                </div>
            `).join('')
            : '<div class="settings-empty-state">No provenance events recorded.</div>';
    return `
        <details class="settings-card settings-card-static dpu-research-card dpu-research-provenance">
            <summary class="dpu-research-provenance-summary">
                <span class="settings-card-title">Provenance</span>
                <span class="settings-card-meta">${escapeHtml(countLabel)}</span>
            </summary>
            <div class="dpu-research-provenance-content">${content}</div>
        </details>
    `;
}

function buildResearchResourcePreview(record, { files = [], backends = [], provenanceEvents = [], provenanceUnavailable = false } = {}) {
    const state = record.effectiveState || record.accessState || 'unknown';
    const canAcquire = record.accessState === 'available' && !['local', 'shared'].includes(record.effectiveState);
    const canRequestAccess = ['pending', 'blocked'].includes(record.accessState);
    const federatedBackend = backends.find((backend) => backend.type === 'nvflare' && backend.available);
    const secureBackend = backends.find((backend) => backend.type === 'secure' && backend.available);
    const actions = `
        <div class="settings-card-actions dpu-research-actions" aria-label="Resource actions">
            <button type="button" class="general-button secondary" data-local-action="askDpuResearchAgent ${escapeHtml(encodeURIComponent(String(record.id || '')))}">Ask about this resource</button>
            ${canAcquire ? `<button type="button" class="general-button" data-local-action="acquireDpuResearchResource ${escapeHtml(record.id)}">Acquire</button>` : ''}
            ${canRequestAccess ? `<button type="button" class="general-button" data-local-action="requestDpuResearchAccess ${escapeHtml(record.id)}">Request Access</button>` : ''}
            ${record.canWrite ? '<button type="button" class="general-button secondary" data-local-action="showDpuResearchPermissions">Manage access</button>' : ''}
            ${record.executionMode === 'federated' && federatedBackend ? `<button type="button" class="general-button" data-local-action="runDpuFederatedExperiment" data-backend-id="${escapeHtml(federatedBackend.id)}">Run Federated</button>` : ''}
            ${record.executionMode === 'secure' && secureBackend ? `<button type="button" class="general-button" data-local-action="runDpuSecureExecution" data-backend-id="${escapeHtml(secureBackend.id)}">Run Secure</button>` : ''}
        </div>
    `;
    const identityFields = [
        ['Persistent identity', record.persistentId || record.externalId],
        ['Provider', record.provider],
        ['Exact version', record.revision || record.version],
        ['Owner / role', `${record.ownerId || '—'} / ${record.role || '—'}`]
    ];
    const policyFields = [
        ['Access state', record.accessState],
        ['Execution mode', record.executionMode],
        ['Visibility', record.visibility],
        ['Licence', record.licence],
        ['Intended use', record.intendedUse],
        ['Expiry', record.expiresAt]
    ];
    const restrictions = Array.isArray(record.securityRestrictions) && record.securityRestrictions.length
        ? record.securityRestrictions.map((item) => `<span class="settings-chip">${escapeHtml(item)}</span>`).join('')
        : '<span class="settings-card-meta">No execution restrictions reported.</span>';
    const fair = record.fair || {};
    const fairFields = [
        ['Persistent identifier', fair.persistentIdentifier],
        ['Metadata available', fair.metadataAvailable ? 'Yes' : 'No'],
        ['Licence available', fair.licenceAvailable ? 'Yes' : 'No'],
        ['Citation available', fair.citationAvailable ? 'Yes' : 'No'],
        ['Machine-readable formats', Array.isArray(fair.machineReadableFormats) ? fair.machineReadableFormats.join(', ') : '']
    ];
    const encodedResourceId = encodeURIComponent(String(record.id || ''));
    const fileRows = files.length
        ? files.map((file) => {
            const isFile = file.type === 'file';
            const verifyAction = `verifyDpuResearchFileRead ${encodedResourceId} ${encodeURIComponent(String(file.path || ''))}`;
            return `<div class="dpu-research-field dpu-research-file">
                <span class="dpu-research-field-label">${escapeHtml(file.path)}</span>
                <span class="dpu-research-field-value">${escapeHtml(isFile ? `${file.size || 0} bytes · ${file.mimeType || 'application/octet-stream'}` : 'Directory')}</span>
                ${isFile ? `<button type="button" class="gray-button" data-local-action="${escapeHtml(verifyAction)}">Verify read</button>` : ''}
            </div>`;
        }).join('')
        : '<div class="settings-card-meta">No local verified files are available.</div>';
    return `
        <section class="dpu-research-view">
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="dpu-research-header">
                    <div>
                        <div class="settings-card-title">${escapeHtml(record.name || record.externalId || record.id)}</div>
                        <div class="settings-card-meta">${escapeHtml(record.resourceType || 'dataset')} · ${escapeHtml(record.externalId || '')}</div>
                    </div>
                    <span class="status-badge ${researchStateType(state)}">${escapeHtml(state)}</span>
                </div>
                ${actions}
            </article>
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">Identity and version</div>
                <div class="dpu-research-fields">${buildResearchFields(identityFields)}</div>
            </article>
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">Access and use</div>
                <div class="dpu-research-fields">${buildResearchFields(policyFields)}</div>
            </article>
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">FAIR evidence</div>
                <div class="dpu-research-fields">${buildResearchFields(fairFields)}</div>
            </article>
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">Verified files</div>
                <div class="dpu-research-fields">${fileRows}</div>
            </article>
            ${buildResearchProvenance(provenanceEvents, provenanceUnavailable)}
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">Security restrictions</div>
                <div class="dpu-research-chips">${restrictions}</div>
            </article>
        </section>
    `;
}

function buildResearchJobPreview(record) {
    const active = ['queued', 'awaiting-confirmation', 'running'].includes(record.state);
    const fields = [
        ['Operation', record.type],
        ['State', record.state],
        ['Resource', record.resourceId],
        ['Source', record.sourceId],
        ['Progress', `${record.progress || 0}%`],
        ['Created', record.createdAt],
        ['Started', record.startedAt],
        ['Completed', record.completedAt],
        ['Error', record.error]
    ];
    return `
        <section class="dpu-research-view">
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="dpu-research-header">
                    <div>
                        <div class="settings-card-title">${escapeHtml(record.type || 'DPU job')}</div>
                        <div class="settings-card-meta">${escapeHtml(record.id || '')}</div>
                    </div>
                    <span class="status-badge ${researchStateType(record.state)}">${escapeHtml(record.state || 'unknown')}</span>
                </div>
                ${active ? '<div class="settings-card-actions dpu-research-actions"><button type="button" class="gray-button" data-local-action="cancelDpuResearchJob">Cancel Job</button></div>' : ''}
            </article>
            <article class="settings-card settings-card-static dpu-research-card">
                <div class="settings-card-title">Job details</div>
                <div class="dpu-research-fields">${buildResearchFields(fields)}</div>
            </article>
        </section>
    `;
}

function formatSecretTimestamp(fileExp, value) {
    const raw = String(value || '').trim();
    if (!raw) return '—';
    try {
        return escapeHtml(fileExp.formatDate ? fileExp.formatDate(raw) : raw);
    } catch (_) {
        return escapeHtml(raw);
    }
}

function createSecretPreviewState(secret) {
    const valueVisible = Boolean(secret?.valueVisible);
    return {
        key: String(secret?.key || ''),
        ownerId: String(secret?.ownerId || ''),
        role: String(secret?.role || ''),
        createdAt: String(secret?.createdAt || ''),
        updatedAt: String(secret?.updatedAt || ''),
        canRead: valueVisible,
        canWrite: Boolean(secret?.canWrite),
        valueMaskedByPolicy: Boolean(secret?.valueMasked) && !valueVisible,
        masked: true,
        editing: false,
        value: valueVisible ? String(secret?.value ?? '') : '',
        draft: valueVisible ? String(secret?.value ?? '') : ''
    };
}

export function buildSecretPreviewMarkup(fileExp, secretState) {
    const owner = escapeHtml(secretState?.ownerId || '—');
    const role = escapeHtml(secretState?.role || '—');
    const createdAt = formatSecretTimestamp(fileExp, secretState?.createdAt);
    const updatedAt = formatSecretTimestamp(fileExp, secretState?.updatedAt);
    const canRead = Boolean(secretState?.canRead);
    const canWrite = Boolean(secretState?.canWrite);
    const editing = Boolean(secretState?.editing && canWrite);
    const masked = Boolean(secretState?.masked);
    const displayValue = String(secretState?.value ?? '');
    const draftValue = String(secretState?.draft ?? displayValue);
    const revealLabel = masked ? 'Reveal value' : 'Mask value';
    const revealIcon = masked ? '/explorer/assets/icons/eye.svg' : '/explorer/assets/icons/eye-edit.svg';
    const maskedPreview = '&bull;'.repeat(Math.max(12, Math.min(32, displayValue.length || 20)));
    const readOnlyMessage = secretState?.valueMaskedByPolicy
        ? 'Value is hidden. You have access to this secret, but not read permission.'
        : 'Value is unavailable.';
    const valueBody = editing
        ? `
            <div class="dpu-secret-editor">
                <textarea class="dpu-secret-editor-input" spellcheck="false">${escapeHtml(draftValue)}</textarea>
                <div class="dpu-secret-editor-actions">
                    <button type="button" class="secondary" data-local-action="cancelDpuSecretInlineEdit">Cancel</button>
                    <button type="button" data-local-action="saveDpuSecretInlineEdit">Save</button>
                </div>
            </div>
        `
        : canRead
            ? `
                <div
                    class="dpu-secret-value${canWrite ? ' is-actionable' : ''}${masked ? ' is-masked' : ''}"
                    ${canWrite ? 'tabindex="0" data-local-action="beginDpuSecretInlineEdit"' : ''}
                    title="${canWrite ? 'Click to edit secret value' : 'Secret value'}"
                >${masked ? maskedPreview : escapeHtml(displayValue || ' ')}</div>
            `
            : `
                <div class="dpu-secret-message${canWrite ? ' is-actionable' : ''}" ${canWrite ? 'tabindex="0" data-local-action="beginDpuSecretInlineEdit" title="Click to set a new secret value"' : ''}>
                    ${escapeHtml(canWrite ? 'Value is hidden. Click to replace it with a new value.' : readOnlyMessage)}
                </div>
            `;

    return `
        <section class="dpu-secret-card">
            <div class="dpu-secret-meta">
                <div class="dpu-secret-meta-item">
                    <span class="dpu-secret-meta-label">Created</span>
                    <span class="dpu-secret-meta-value">${createdAt}</span>
                </div>
                <div class="dpu-secret-meta-item">
                    <span class="dpu-secret-meta-label">Owner</span>
                    <span class="dpu-secret-meta-value">${owner}</span>
                </div>
                <div class="dpu-secret-meta-item">
                    <span class="dpu-secret-meta-label">Role</span>
                    <span class="dpu-secret-meta-value">${role}</span>
                </div>
                <div class="dpu-secret-meta-item">
                    <span class="dpu-secret-meta-label">Updated</span>
                    <span class="dpu-secret-meta-value">${updatedAt}</span>
                </div>
            </div>
            <div class="dpu-secret-section">
                <div class="dpu-secret-section-header">
                    <span class="dpu-secret-section-title">Value</span>
                    <div class="dpu-secret-section-actions">
                        ${canRead ? `
                            <button type="button" class="dpu-secret-visibility-toggle" data-local-action="toggleDpuSecretMask" title="${revealLabel}" aria-label="${revealLabel}">
                                <img src="${revealIcon}" alt="">
                            </button>
                        ` : ''}
                    </div>
                </div>
                ${valueBody}
            </div>
        </section>
    `;
}

export async function openDpuFile(fileExp, filePath, { invalidate = true } = {}) {
    const normalizedPath = normalizeManagedPath(fileExp, filePath);
    const node = await resolveDpuNode(fileExp, normalizedPath);
    if (!node) {
        throw new Error(`Confidential resource not found: ${normalizedPath}`);
    }

    if (node.kind === 'research-resource' || node.kind === 'research-job') {
        let files = [];
        let backends = [];
        let provenanceEvents = [];
        let provenanceUnavailable = false;
        const parsed = node.kind === 'research-resource'
            ? await callDpuTool('dpu_resource_get', { id: node.resourceId })
            : await callDpuTool('dpu_job_get', { id: node.jobId });
        if (node.kind === 'research-resource') {
            const [fileResult, backendResult, provenanceResult] = await Promise.all([
                parsed.resource?.effectiveState === 'local'
                    ? callDpuTool('dpu_resource_file_list', { id: node.resourceId }).catch(() => ({ items: [] }))
                    : Promise.resolve({ items: [] }),
                callDpuTool('dpu_compute_backend_list').catch(() => ({ items: [] })),
                callDpuTool('dpu_resource_get_provenance', { id: node.resourceId })
                    .catch(() => ({ events: [], unavailable: true }))
            ]);
            files = Array.isArray(fileResult.items) ? fileResult.items : [];
            backends = Array.isArray(backendResult.items) ? backendResult.items : [];
            provenanceEvents = Array.isArray(provenanceResult.events) ? provenanceResult.events : [];
            provenanceUnavailable = provenanceResult.unavailable === true;
        }
        const record = parsed.resource || parsed.job || {};
        const fileContent = JSON.stringify(record, null, 2);
        const previewContent = node.kind === 'research-resource'
            ? buildResearchResourcePreview(record, { files, backends, provenanceEvents, provenanceUnavailable })
            : buildResearchJobPreview(record);
        fileExp.setPreviewState({ fileContent, previewContent, selectedIsMarkdown: false, previewMode: 'dpu-research', mediaType: null, fileLoadInfo: null, markdownTextView: false, documentId: null, dpuSelectedObjectId: null, dpuSelectedCanWrite: false, dpuResearchResourceId: node.resourceId || null, dpuResearchJobId: node.jobId || null, dpuResearchRecord: record, dpuResearchIdempotencyKey: fileExp.state?.dpuResearchResourceId === node.resourceId ? (fileExp.state.dpuResearchIdempotencyKey || '') : '', hasUnsavedChanges: false, isEditing: false });
        if (invalidate) fileExp.invalidate(); else fileExp.refreshPreviewUi();
        return;
    }

    if (node.kind === 'secret') {
        const snapshot = await readDpuCurrentItemState(fileExp, normalizedPath);
        const secret = snapshot.secret || {};
        const secretState = createSecretPreviewState(secret);
        fileExp.setPreviewState({
            fileContent: secretState.value,
            previewContent: buildSecretPreviewMarkup(fileExp, secretState),
            selectedIsMarkdown: false,
            previewMode: 'dpu-secret',
            mediaType: null,
            fileLoadInfo: null,
            markdownTextView: false,
            documentId: null,
            dpuSelectedObjectId: null,
            dpuSelectedCanWrite: Boolean(secret.canWrite),
            dpuSelectedUpdatedAt: String(secret.updatedAt || ''),
            dpuSelectedCanComment: false,
            dpuSelectedCommentCount: 0,
            dpuSelectedComments: [],
            dpuCommentsOpen: false,
            dpuSecretState: secretState,
            hasUnsavedChanges: false,
            isEditing: false
        });
        if (invalidate) {
            fileExp.invalidate();
        } else {
            fileExp.refreshPreviewUi();
        }
        return;
    }

    if (node.kind === 'confidential' || node.kind === 'shared-object') {
        await ensureDpuCommentsComponentRegistered();
        const snapshot = await readDpuCurrentItemState(fileExp, normalizedPath);
        const objectRecord = snapshot.object || {};
        const objectType = normalizeDpuObjectType(objectRecord.type, node.type);
        if (!isDpuFileType(objectType)) {
            throw new Error(`Confidential object is not a file: ${normalizedPath}`);
        }
        const content = String(objectRecord.content ?? '');
        const canRead = Boolean(objectRecord.contentVisible);
        const comments = Array.isArray(objectRecord.comments) ? objectRecord.comments : [];
        const fileContent = canRead
            ? content
            : [
                `File: ${objectRecord.name}`,
                `Owner: ${objectRecord.ownerId || '—'}`,
                `Role: ${objectRecord.role || '—'}`,
                '',
                'Content is hidden.',
                'You have access to this file, but not read permission.'
            ].join('\n');
        const previewContent = renderCodePreview(fileContent, objectRecord.name || '');

        fileExp.setPreviewState({
            fileContent,
            previewContent,
            selectedIsMarkdown: false,
            previewMode: 'code',
            mediaType: null,
            fileLoadInfo: null,
            markdownTextView: false,
            documentId: null,
            dpuSelectedObjectId: objectRecord.id || null,
            dpuSelectedCanWrite: Boolean(objectRecord.canWrite),
            dpuSelectedUpdatedAt: String(objectRecord.updatedAt || ''),
            dpuSelectedCanComment: Boolean(objectRecord.canComment),
            dpuSelectedCommentCount: Number.parseInt(String(objectRecord.commentCount || 0), 10) || 0,
            dpuSelectedComments: comments,
            dpuCommentsOpen: false,
            dpuSecretState: null,
            hasUnsavedChanges: false,
            isEditing: false
        });
        if (invalidate) {
            fileExp.invalidate();
        } else {
            fileExp.refreshPreviewUi();
        }
        return;
    }

    if (node.kind === 'audit-file') {
        const parsed = await callDpuTool('dpu_audit_get', { name: node.name });
        const item = parsed.item || {};
        const fileContent = String(item.content || '');
        fileExp.setPreviewState({
            fileContent,
            previewContent: renderCodePreview(fileContent, item.name || node.name || 'audit.jsonl'),
            selectedIsMarkdown: false,
            previewMode: 'code',
            mediaType: null,
            fileLoadInfo: null,
            markdownTextView: false,
            documentId: null,
            dpuSelectedObjectId: null,
            dpuSelectedCanWrite: false,
            dpuSelectedUpdatedAt: String(item.updatedAt || ''),
            dpuSelectedCanComment: false,
            dpuSelectedCommentCount: 0,
            dpuSelectedComments: [],
            dpuCommentsOpen: false,
            dpuSecretState: null,
            hasUnsavedChanges: false,
            isEditing: false
        });
        if (invalidate) {
            fileExp.invalidate();
        } else {
            fileExp.refreshPreviewUi();
        }
        return;
    }

    throw new Error(`Unsupported confidential resource: ${normalizedPath}`);
}

export async function getDpuPathCapabilities(fileExp, path) {
    const normalizedPath = normalizeManagedPath(fileExp, path);
    if (!isDpuManagedPath(normalizedPath)) {
        return {
            isDpu: false,
            canWrite: true,
            canCreateChildren: true,
            canRename: true,
            canDelete: true,
            canUpload: true
        };
    }

    const node = await resolveDpuNode(fileExp, normalizedPath);
    if (!node) {
        return {
            isDpu: true,
            canWrite: false,
            canCreateChildren: false,
            canRename: false,
            canDelete: false,
            canUpload: false
        };
    }

    const immutableRoot = Boolean(node.immutableRoot);
    const canWrite = Boolean(node.canWrite);
    const canCreateChildren = Boolean(node.canCreateChildren);
    const canCreateFiles = Object.prototype.hasOwnProperty.call(node, 'canCreateFiles')
        ? Boolean(node.canCreateFiles)
        : canCreateChildren;
    const canCreateDirectories = Object.prototype.hasOwnProperty.call(node, 'canCreateDirectories')
        ? Boolean(node.canCreateDirectories)
        : canCreateChildren;
    const canRename = Object.prototype.hasOwnProperty.call(node, 'canRename')
        ? Boolean(node.canRename)
        : (canWrite && !immutableRoot);
    const canDelete = Object.prototype.hasOwnProperty.call(node, 'canDelete')
        ? Boolean(node.canDelete)
        : (canWrite && !immutableRoot);

    return {
        isDpu: true,
        node,
        canWrite,
        canCreateChildren,
        canCreateFiles,
        canCreateDirectories,
        canRename,
        canDelete,
        canUpload: canCreateChildren
    };
}

function invalidateDpuMutationState(fileExp, affectedPaths = []) {
    resetDpuCache(fileExp);
    invalidateTreeViewBranches(fileExp, affectedPaths);
    for (const targetPath of affectedPaths) {
        if (!targetPath) continue;
        fileExp.caches.dirListing.invalidate(fileExp, targetPath);
        fileExp.caches.filePreview.invalidateForPath(targetPath);
    }
}

export function invalidateDpuState(fileExp, affectedPaths = []) {
    invalidateDpuMutationState(fileExp, affectedPaths);
}

async function ensureDpuWritableDirectory(fileExp, path) {
    const capabilities = await getDpuPathCapabilities(fileExp, path);
    if (!capabilities.isDpu) {
        throw new Error('Not a DPU path.');
    }
    if (!capabilities.canCreateChildren || !isDpuFolderType(capabilities.node?.type)) {
        throw new Error('This Confidential folder is not writable.');
    }
    return capabilities.node;
}

async function ensureDpuWritableEntry(fileExp, path) {
    const capabilities = await getDpuPathCapabilities(fileExp, path);
    if (!capabilities.isDpu) {
        throw new Error('Not a DPU path.');
    }
    if (!capabilities.canWrite) {
        throw new Error('You do not have write permission for this Confidential item.');
    }
    return capabilities.node;
}

export async function createDpuDirectory(fileExp, parentPath, name) {
    const parentNode = await ensureDpuWritableDirectory(fileExp, parentPath);
    const created = await callDpuTool('dpu_confidential_create', {
        parentId: parentNode.objectId,
        type: 'folder',
        name
    });
    invalidateDpuMutationState(fileExp, [parentPath]);
    if (!isDpuFolderType(created.object?.type)) {
        throw new Error('DPU returned an invalid object type for folder creation.');
    }
    return created.object || null;
}

export async function createDpuFile(fileExp, parentPath, name, { content = '', mimeType = '' } = {}) {
    if (isSecretsRootPath(parentPath)) {
        const displayName = normalizeSecretDisplayNameForCreate(name);
        const normalizedKey = deriveSecretKeyFromDisplayName(displayName);
        await callDpuTool('dpu_secret_put', {
            key: normalizedKey,
            displayName,
            value: String(content ?? '')
        });
        invalidateDpuMutationState(fileExp, [DPU_SECRETS_PATH, fileExp.joinPath(DPU_SECRETS_PATH, normalizedKey)]);
        return {
            key: normalizedKey,
            name: displayName,
            path: fileExp.joinPath(DPU_SECRETS_PATH, normalizedKey),
            type: 'file'
        };
    }
    const parentNode = await ensureDpuWritableDirectory(fileExp, parentPath);
    const created = await callDpuTool('dpu_confidential_create', {
        parentId: parentNode.objectId,
        type: 'file',
        name,
        content,
        mimeType
    });
    invalidateDpuMutationState(fileExp, [parentPath]);
    if (!isDpuFileType(created.object?.type)) {
        throw new Error('DPU returned an invalid object type for file creation.');
    }
    return created.object || null;
}

export async function renameDpuEntry(fileExp, sourcePath, newName) {
    const sourceNode = await ensureDpuWritableEntry(fileExp, sourcePath);
    if (sourceNode?.kind === 'secret') {
        throw new Error('Secret keys cannot be renamed.');
    }
    const updated = await callDpuTool('dpu_confidential_update', {
        id: sourceNode.objectId,
        name: newName
    });
    invalidateDpuMutationState(fileExp, [sourcePath, fileExp.parentPath(sourcePath) || '/']);
    return updated.object || null;
}

export async function deleteDpuEntry(fileExp, targetPath) {
    const targetNode = await ensureDpuWritableEntry(fileExp, targetPath);
    if (targetNode?.kind === 'secret' && targetNode?.key) {
        await callDpuTool('dpu_secret_delete', { key: targetNode.key });
        invalidateDpuMutationState(fileExp, [targetPath, DPU_SECRETS_PATH]);
        return true;
    }
    await callDpuTool('dpu_confidential_delete', { id: targetNode.objectId });
    invalidateDpuMutationState(fileExp, [targetPath, fileExp.parentPath(targetPath) || '/']);
    return true;
}

export async function updateDpuFile(fileExp, targetPath, { content, mimeType } = {}) {
    const targetNode = await ensureDpuWritableEntry(fileExp, targetPath);
    if (!isDpuFileType(targetNode?.type)) {
        throw new Error('This Confidential item is not a file.');
    }
    const payload = {
        id: targetNode.objectId,
        content: String(content ?? '')
    };
    if (mimeType !== undefined) {
        payload.mimeType = String(mimeType || '');
    }
    const updated = await callDpuTool('dpu_confidential_update', payload);
    if (!isDpuFileType(updated.object?.type, targetNode?.type)) {
        throw new Error('DPU returned an invalid object type for file update.');
    }
    invalidateDpuMutationState(fileExp, [targetPath, fileExp.parentPath(targetPath) || '/']);
    return updated.object || null;
}

export async function updateDpuSecret(fileExp, targetPath, { value } = {}) {
    const normalizedPath = normalizeManagedPath(fileExp, targetPath);
    const node = await resolveDpuNode(fileExp, normalizedPath);
    if (!node || node.kind !== 'secret' || !node.key) {
        throw new Error('This DPU item is not a secret.');
    }
    const updated = await callDpuTool('dpu_secret_put', {
        key: node.key,
        value: String(value ?? '')
    });
    invalidateDpuMutationState(fileExp, [normalizedPath, DPU_SECRETS_PATH]);
    return updated.secret || null;
}


function isSupportedConfidentialTextUpload(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    return [
        '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
        '.html', '.css', '.xml', '.yml', '.yaml', '.toml',
        '.ini', '.env', '.log'
    ].some((suffix) => name.endsWith(suffix));
}

function encodeArrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export async function readConfidentialUploadPayload(file) {
    const isTextUpload = isSupportedConfidentialTextUpload(file);
    if (isTextUpload) {
        return {
            content: await file.text(),
            mimeType: file.type || 'text/plain',
            isBinary: false
        };
    }

    const buffer = await file.arrayBuffer();
    return {
        content: encodeArrayBufferToBase64(buffer),
        mimeType: file.type || 'application/octet-stream',
        isBinary: true
    };
}

export async function uploadDpuFiles(fileExp, parentPath, files = []) {
    const parentNode = await ensureDpuWritableDirectory(fileExp, parentPath);
    const created = [];
    for (const file of files) {
        const payload = await readConfidentialUploadPayload(file);
        const response = await callDpuTool('dpu_confidential_create', {
            parentId: parentNode.objectId,
            type: 'file',
            name: file.name,
            content: payload.content,
            mimeType: payload.mimeType
        });
        created.push(response.object || null);
    }
    invalidateDpuMutationState(fileExp, [parentPath]);
    return created;
}

export async function getDpuPermissionsTarget(fileExp, targetPath) {
    const normalizedPath = normalizeManagedPath(fileExp, targetPath);
    const node = await resolveDpuNode(fileExp, normalizedPath);
    if (!node) {
        throw new Error('Confidential resource not found.');
    }
    if (node.immutableRoot) {
        throw new Error('Permissions are not available on this Confidential root.');
    }
    if (!node.canWrite) {
        throw new Error('Permissions are visible only for users with write access.');
    }
    if (node.kind === 'secret') {
        return {
            kind: 'secret',
            key: node.key,
            id: '',
            path: normalizedPath,
            name: node.key || normalizedPath.split('/').pop() || ''
        };
    }
    if (node.kind === 'confidential' || node.kind === 'shared-object') {
        return {
            kind: 'confidential',
            key: '',
            id: node.objectId || '',
            path: normalizedPath,
            name: node.name || normalizedPath.split('/').pop() || ''
        };
    }
    throw new Error('Permissions are not available for this item.');
}
