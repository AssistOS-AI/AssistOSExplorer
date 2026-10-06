import { callExplorerTool, ensureSuccess, parseToolResult } from "../../../services/infrastructure/explorerApi.js";
import { requestDirectoryListing, take as takePrefetchedListing } from "../../../services/runtime/initialListingPrefetch.js";

export function createFileExpTooling() {
    const callTextTool = (name, args) => callExplorerTool(name, args);

    return {
        async readTextFile(path) {
            const text = await callTextTool('read_text_file', { path });
            return { text };
        },
        // `usePrefetch` lets the first load of a path use the listing requested while the file browser was
        // loading. The caller sets it only after its own cache and in-flight checks, and never for a refresh.
        async listDirectoryDetailed(path, { usePrefetch = false } = {}) {
            const prefetched = usePrefetch ? takePrefetchedListing(path) : null;
            if (prefetched) {
                try {
                    return await prefetched;
                } catch (_) {
                    // A failed prefetch is not an answer: ask again.
                }
            }
            return requestDirectoryListing(path);
        },
        async getFileInfo(path) {
            const raw = await callExplorerTool('get_file_info', { path }, { raw: true, withLoader: false });
            ensureSuccess(raw);
            const parsed = parseToolResult(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Invalid file info payload.');
            }
            return parsed;
        },
        writeFile(path, content) {
            return callTextTool('write_file', { path, content });
        }
    };
}
