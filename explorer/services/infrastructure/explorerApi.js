import { callTool, callToolWithLoader } from '../../utils/globalLoader.js';
import { getWorkspaceRoot } from '../../utils/workspaceRoot.js';

export class ToolError extends Error {
    constructor(code, message, data = null) {
        super(message);
        this.name = 'ToolError';
        this.code = code;
        this.data = data;
    }
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const EMPTY_TEXT_SENTINEL = '__ASSISTOS_EXPLORER_EMPTY_TEXT__';
const MCP_ERROR_TEXT = /^MCP error(?:\s|$)/i;
let sessionPromptActive = false;
let cachedWorkspaceRootAbs = '';
let workspaceRootPromise = null;

const isAgentMcpReturnTo = (returnTo) => /^\/[^/]+\/mcp(?:$|[?#])/.test(returnTo);

const extractAuthErrorPayload = (error) => {
    const message = error?.message || error?.toString?.() || '';
    if (typeof message !== 'string' || !message.includes('HTTP 401')) {
        return null;
    }
    const jsonStart = message.indexOf('{');
    if (jsonStart === -1) {
        return null;
    }
    try {
        const parsed = JSON.parse(message.slice(jsonStart));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
};

const normalizeLoginRedirectUrl = (candidate) => {
    const fallback = buildLoginRedirectUrl();
    const raw = String(candidate || '').trim();
    if (!raw) return fallback;
    try {
        const url = new URL(raw, window.location.origin);
        const returnTo = url.searchParams.get('returnTo') || '';
        if (isAgentMcpReturnTo(returnTo)) {
            return fallback;
        }
        return url.pathname + (url.search || '') + (url.hash || '');
    } catch {
        return fallback;
    }
};

const isAuthenticationExpiredError = (error) => {
    const payload = extractAuthErrorPayload(error);
    return payload?.error === 'not_authenticated';
};

const buildLoginRedirectUrl = () => {
    if (typeof window === 'undefined' || !window.location) {
        return '/auth/login';
    }
    const returnTo = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}` || '/';
    return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
};

const handleAuthenticationExpired = async (error = null) => {
    if (sessionPromptActive) return;
    sessionPromptActive = true;
    try {
        const payload = extractAuthErrorPayload(error);
        const loginUrl = normalizeLoginRedirectUrl(payload?.login);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert('Your session has expired. Redirecting to the login page.');
        }
        if (typeof window !== 'undefined' && window.location) {
            window.location.assign(loginUrl);
        }
    } finally {
        setTimeout(() => {
            sessionPromptActive = false;
        }, 500);
    }
};

export function parseToolResult(payload) {
    if (!payload) return null;
    if (typeof payload !== 'string') {
        if (Object.prototype.hasOwnProperty.call(payload, 'json')) {
            return payload.json;
        }
        const blocks = Array.isArray(payload.content) ? payload.content : null;
        if (blocks) {
            const jsonBlock = blocks.find((block) => block?.type === 'json' && block.json !== undefined);
            if (jsonBlock) return jsonBlock.json;
            const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
            if (textBlock?.text === EMPTY_TEXT_SENTINEL) {
                return '';
            }
            if (textBlock?.text) {
                try {
                    return JSON.parse(textBlock.text);
                } catch {
                    return null;
                }
            }
        }
        if (typeof payload.text === 'string') {
            const trimmed = payload.text.trim();
            if (trimmed) {
                try {
                    return JSON.parse(trimmed);
                } catch {
                    return null;
                }
            }
        }
        return payload;
    }

    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

export function extractToolText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload === EMPTY_TEXT_SENTINEL ? '' : payload;
    const blocks = Array.isArray(payload.content) ? payload.content : null;
    if (blocks) {
        const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
        if (textBlock?.text) return textBlock.text === EMPTY_TEXT_SENTINEL ? '' : textBlock.text;
    }
    if (typeof payload.text === 'string') {
        return payload.text === EMPTY_TEXT_SENTINEL ? '' : payload.text;
    }
    return '';
}

export function ensureSuccess(payload) {
    if (payload && typeof payload === 'object' && payload.isError === true) {
        const text = extractToolText(payload).trim();
        throw new ToolError('tool_error', text || 'Tool execution failed', { payload });
    }
    const text = extractToolText(payload);
    if (isNonEmptyString(text)) {
        const normalizedText = text.trim();
        if (normalizedText.startsWith('Error:') || MCP_ERROR_TEXT.test(normalizedText)) {
            throw new ToolError('tool_error', normalizedText.replace(/^Error:\s*/i, ''), { payload });
        }
    }
    const parsed = parseToolResult(payload);
    if (parsed && typeof parsed === 'object') {
        const ok = Object.prototype.hasOwnProperty.call(parsed, 'ok') ? parsed.ok : null;
        if (ok === false) {
            const message = isNonEmptyString(parsed.error) ? parsed.error : 'Tool execution failed';
            throw new ToolError('tool_error', message, parsed);
        }
    }
}

function splitLines(value) {
    if (!isNonEmptyString(value)) return [];
    return value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

async function resolveWorkspaceRootAbs() {
    if (cachedWorkspaceRootAbs) return cachedWorkspaceRootAbs;
    if (workspaceRootPromise) return workspaceRootPromise;
    workspaceRootPromise = (async () => {
        const hintedRoot = String(getWorkspaceRoot() || '').trim();
        if (hintedRoot.startsWith('/') && hintedRoot !== '/') {
            cachedWorkspaceRootAbs = hintedRoot.replace(/\/+$/g, '');
            return cachedWorkspaceRootAbs;
        }
        try {
            const result = await callTool('explorer', 'list_allowed_directories', {});
            const text = extractToolText(result);
            const roots = splitLines(text).filter((entry) => !/^allowed directories:?$/i.test(entry));
            const firstRoot = roots.find((entry) => entry.startsWith('/'));
            if (firstRoot) {
                cachedWorkspaceRootAbs = firstRoot.replace(/\/+$/g, '');
            }
        } catch {
            // ignore and fall through with empty root
        }
        return cachedWorkspaceRootAbs;
    })().finally(() => {
        workspaceRootPromise = null;
    });
    return workspaceRootPromise;
}

function toAbsoluteWorkspacePath(input, workspaceRootAbs) {
    const raw = String(input || '').trim();
    if (!raw) return raw;
    if (raw.startsWith('/.ploinky/')) {
        if (!workspaceRootAbs) return '';
        return `${workspaceRootAbs}${raw}`;
    }
    if (raw.startsWith('.ploinky/')) {
        if (!workspaceRootAbs) return '';
        return `${workspaceRootAbs}/${raw}`;
    }
    return raw;
}

export async function resolveExplorerPathToFilesystemPath(input) {
    const raw = String(input || '').trim();
    if (!raw) return raw;
    if (!raw.startsWith('/')) return raw;
    const workspaceRootAbs = await resolveWorkspaceRootAbs();
    if (!workspaceRootAbs) return raw;
    if (raw === '/') return workspaceRootAbs;
    return `${workspaceRootAbs}${raw}`;
}

async function normalizeAgentArgs(agentName, toolName, args) {
    const needsResolve = (() => {
        const check = (value) => typeof value === 'string' && (value.startsWith('/.ploinky/') || value.startsWith('.ploinky/'));
        if (check(args?.path) || check(args?.repoPath) || check(args?.backlogPath)) return true;
        if (Array.isArray(args?.repoPaths) && args.repoPaths.some(check)) return true;
        return false;
    })();
    const next = { ...(args || {}) };
    const workspaceRootAbs = needsResolve ? await resolveWorkspaceRootAbs() : '';
    const resolvedFieldNames = new Set();

    if (typeof next.path === 'string') {
        const resolved = needsResolve ? toAbsoluteWorkspacePath(next.path, workspaceRootAbs) : next.path;
        if (resolved !== next.path) resolvedFieldNames.add('path');
        next.path = resolved;
    }
    if (typeof next.repoPath === 'string') {
        const resolved = needsResolve ? toAbsoluteWorkspacePath(next.repoPath, workspaceRootAbs) : next.repoPath;
        if (resolved !== next.repoPath) resolvedFieldNames.add('repoPath');
        next.repoPath = resolved;
    }
    if (typeof next.backlogPath === 'string') {
        const resolved = needsResolve ? toAbsoluteWorkspacePath(next.backlogPath, workspaceRootAbs) : next.backlogPath;
        if (resolved !== next.backlogPath) resolvedFieldNames.add('backlogPath');
        next.backlogPath = resolved;
    }
    if (Array.isArray(next.repoPaths)) {
        const originalRepoPaths = next.repoPaths;
        next.repoPaths = needsResolve
            ? next.repoPaths.map((entry) => toAbsoluteWorkspacePath(entry, workspaceRootAbs))
            : next.repoPaths;
        if (next.repoPaths.some((entry, index) => entry !== originalRepoPaths[index])) {
            resolvedFieldNames.add('repoPaths');
        }
    }

    const checkAbsolute = (value) => typeof value === 'string' && value.startsWith('/');
    if (resolvedFieldNames.has('path') && next.path && !checkAbsolute(next.path)) {
        throw new ToolError('invalid_path', 'Path must be an absolute filesystem path.');
    }
    if (resolvedFieldNames.has('repoPath') && next.repoPath && !checkAbsolute(next.repoPath)) {
        throw new ToolError('invalid_path', 'repoPath must be an absolute filesystem path.');
    }
    if (resolvedFieldNames.has('backlogPath') && next.backlogPath && !checkAbsolute(next.backlogPath)) {
        throw new ToolError('invalid_path', 'backlogPath must be an absolute filesystem path.');
    }
    if (resolvedFieldNames.has('repoPaths') && Array.isArray(next.repoPaths) && next.repoPaths.some((entry) => entry && !checkAbsolute(entry))) {
        throw new ToolError('invalid_path', 'repoPaths must be absolute filesystem paths.');
    }

    return next;
}

export async function callExplorerTool(name, args, { raw = false, withLoader = true } = {}) {
    try {
        const result = withLoader
            ? await callToolWithLoader('explorer', name, args)
            : await callTool('explorer', name, args);
        if (raw) {
            return result;
        }
        ensureSuccess(result);
        return extractToolText(result);
    } catch (error) {
        if (isAuthenticationExpiredError(error)) {
            error.sessionExpiredHandled = true;
            await handleAuthenticationExpired(error);
        }
        throw error;
    }
}

export async function callAgentTool(agentName, name, args, { raw = false } = {}) {
    const client = window.webSkel?.appServices?.getClient?.(agentName);
    if (!client || typeof client.callTool !== 'function') {
        throw new ToolError('client_unavailable', `Agent client not available: ${agentName}`);
    }
    try {
        const normalizedArgs = await normalizeAgentArgs(agentName, name, args || {});
        const result = await client.callTool(name, normalizedArgs || {});
        if (raw) {
            return result;
        }
        ensureSuccess(result);
        return extractToolText(result);
    } catch (error) {
        if (isAuthenticationExpiredError(error)) {
            error.sessionExpiredHandled = true;
            await handleAuthenticationExpired(error);
        }
        throw error;
    }
}
