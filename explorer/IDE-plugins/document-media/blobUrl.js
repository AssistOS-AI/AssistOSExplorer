const DEFAULT_AGENT = "explorer";

export function buildBlobUrl(id, agent = DEFAULT_AGENT) {
    if (!id) return "";
    if (typeof window === "undefined" || !window.location?.origin) return "";
    const safeId = encodeURIComponent(String(id).trim());
    const safeAgent = encodeURIComponent(String(agent || DEFAULT_AGENT).trim() || DEFAULT_AGENT);
    const origin = window.location.origin;
    return `${origin}/blobs/${safeAgent}/${safeId}`;
}
