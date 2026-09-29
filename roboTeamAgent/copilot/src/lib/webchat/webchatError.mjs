import { fileURLToPath } from 'node:url';

const STACK_FRAME_RE = /(?:\(|\s)(file:\/\/\/[^)\s]+|\/[^)\s]+):(\d+):(\d+)\)?$/;

function parseStackFrame(line) {
    const match = STACK_FRAME_RE.exec(String(line || '').trim());
    if (!match) return null;
    let filePath = match[1];
    if (filePath.startsWith('file:///')) {
        try {
            filePath = fileURLToPath(filePath);
        } catch {
            return null;
        }
    }
    return {
        filePath: filePath.replace(/\\+/g, '/'),
        line: Number.parseInt(match[2], 10),
        column: Number.parseInt(match[3], 10),
    };
}

function mapSourceFrame(frame) {
    const agentLibMarker = '/node_modules/achillesAgentLib/';
    const agentLibIndex = frame.filePath.lastIndexOf(agentLibMarker);
    if (agentLibIndex >= 0) {
        const relativeModulePath = frame.filePath.slice(agentLibIndex + agentLibMarker.length);
        return {
            ...frame,
            label: `achillesAgentLib/${relativeModulePath}`,
            workspacePath: `ploinky/node_modules/achillesAgentLib/${relativeModulePath}`,
        };
    }

    const codeMarker = '/code/';
    const codeIndex = frame.filePath.indexOf(codeMarker);
    if (codeIndex >= 0) {
        const relativeModulePath = frame.filePath.slice(codeIndex + codeMarker.length);
        return {
            ...frame,
            label: `AchillesCLI/roboTeamAgent/${relativeModulePath}`,
            workspacePath: `.ploinky/repos/AchillesCLI/roboTeamAgent/${relativeModulePath}`,
        };
    }

    const agentRuntimeMarker = '/Agent/';
    const agentRuntimeIndex = frame.filePath.indexOf(agentRuntimeMarker);
    if (agentRuntimeIndex >= 0) {
        const relativeModulePath = frame.filePath.slice(agentRuntimeIndex + agentRuntimeMarker.length);
        return {
            ...frame,
            label: `ploinky/Agent/${relativeModulePath}`,
            workspacePath: `ploinky/Agent/${relativeModulePath}`,
        };
    }

    return null;
}

function findSourceFrame(error) {
    const stackLines = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1) : [];
    for (const line of stackLines) {
        const frame = parseStackFrame(line);
        const mapped = frame ? mapSourceFrame(frame) : null;
        if (mapped) return mapped;
    }
    return null;
}

function normalizePublicBaseUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
            return parsed.origin;
        }
    } catch {
    }
    return '';
}

function workspaceFileUrl(workspacePath, publicBaseUrl = '') {
    const encodedPath = workspacePath
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    return `${normalizePublicBaseUrl(publicBaseUrl)}/workspace-files/${encodedPath}`;
}

export function formatWebchatError(error, { publicBaseUrl = '' } = {}) {
    const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim()
        : String(error || 'Unknown error.');
    const lines = [`[error] ${message}`];
    const source = findSourceFrame(error);
    if (source) {
        const location = `${source.label}:${source.line}:${source.column}`;
        lines.push(`Source: [${location}](${workspaceFileUrl(source.workspacePath, publicBaseUrl)})`);
    }
    return lines.join('\n');
}

export const __testables = {
    findSourceFrame,
    mapSourceFrame,
    parseStackFrame,
    workspaceFileUrl,
};
