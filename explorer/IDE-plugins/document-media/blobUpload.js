const DEFAULT_AGENT = 'explorer';

const getAgentSegment = () => {
    const fromWindow = (typeof window !== 'undefined' && (window.ASSISTOS_AGENT_ID || window.__ASSISTOS_AGENT_ID))
        ? (window.ASSISTOS_AGENT_ID || window.__ASSISTOS_AGENT_ID)
        : null;
    if (typeof fromWindow === 'string' && fromWindow.trim()) {
        return fromWindow.trim();
    }
    return DEFAULT_AGENT;
};

const normalizeAbsoluteUrl = (localPath, downloadUrl) => {
    if (typeof downloadUrl === 'string' && downloadUrl.trim()) {
        return downloadUrl;
    }
    if (typeof localPath !== 'string' || !localPath.trim()) {
        return '';
    }
    const basePath = localPath.startsWith('/') ? localPath : `/${localPath}`;
    if (typeof window !== 'undefined' && window.location) {
        try {
            return new URL(basePath, window.location.origin).href;
        } catch (_) {
            return basePath;
        }
    }
    return basePath;
};

export async function uploadBlobFile(file) {
    const hasName = file && typeof file.name === 'string';
    const hasSize = file && typeof file.size !== 'undefined';
    if (!hasName || !hasSize) {
        throw new Error('Invalid file payload.');
    }

    const agentSegment = getAgentSegment();
    const encodedAgent = encodeURIComponent(agentSegment);
    const uploadUrl = `/blobs/${encodedAgent}`;
    const mime = file.type || 'application/octet-stream';
    const headers = {
        'Content-Type': mime,
        'X-Mime-Type': mime,
        'X-File-Name': encodeURIComponent(file.name || 'file')
    };

    const response = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: file
    });
    if (!response.ok) {
        const reason = await response.text().catch(() => '');
        throw new Error(reason || `Upload failed (${response.status})`);
    }
    const data = await response.json().catch(() => ({}));
    const localPath = typeof data.localPath === 'string' ? data.localPath : null;
    const absoluteUrl = normalizeAbsoluteUrl(localPath, data.downloadUrl);
    return {
        id: data.id ?? null,
        filename: data.filename || file.name,
        localPath,
        downloadUrl: absoluteUrl,
        mime: data.mime ?? file.type ?? null,
        size: data.size ?? (Number.isFinite(file.size) ? file.size : null)
    };
}
