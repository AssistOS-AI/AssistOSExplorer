const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

export function isOwnedLiveSessionUrl(value, agent) {
    if (typeof value !== 'string' || typeof agent !== 'string' || !AGENT_NAME.test(agent)
        || !value.startsWith('/') || value.startsWith('//') || /[\s\\?#]/.test(value)) return false;
    let decoded = value;
    for (let pass = 0; pass < 4; pass += 1) {
        if (/\\|\/\/|%2f|%5c|%2e/i.test(decoded)
            || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false;
        let next;
        try { next = decodeURIComponent(decoded); } catch { return false; }
        if (next === decoded) break;
        if (pass === 3 || /[\s?#\u0000-\u001f\u007f]/.test(next)) return false;
        decoded = next;
    }
    try {
        const url = new URL(value, 'http://h');
        if (url.origin !== 'http://h' || url.pathname !== value || url.search || url.hash) return false;
    } catch { return false; }
    const segments = value.split('/');
    if (segments[1] === agent) return segments.length >= 3 && Boolean(segments[2]);
    if (segments[1] !== 'base-agent-additional-server' || segments[2] !== agent
        || !/^[1-9][0-9]{0,4}$/.test(segments[3]) || Number(segments[3]) > 65535) return false;
    return segments.length >= 5 && Boolean(segments[4]);
}

export function normalizeLiveSessionSource(config, agent) {
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some((key) => !['version', 'base'].includes(key))
        || config.version !== 1 || !isOwnedLiveSessionUrl(config.base, agent)) return null;
    return Object.freeze({ version: 1, base: config.base.replace(/\/$/, '') });
}
