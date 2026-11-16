import { callDpuTool } from './file-exp-dpu-provider.js';
// Downloads stay on the authenticated Router origin and use the browser's
// native download manager, not an in-memory Blob or a navigation of Explorer.
import { isDpuVirtualPath, isDpuDataPath } from "../../../services/dpu/dpuPaths.js";

export function isDownloadablePath(entryPath) {
    const parts = String(entryPath || '').replace(/^\/+/, '').split('/');
    return Boolean(parts[0]) && !isDpuVirtualPath(entryPath) && !parts.some(part => !part || part === '.' || part === '..'
        || part.includes('\\') || part.includes('\0') || part === '.data'
        || part === '.secrets' || part.endsWith('.secrets'))
        && !parts.some((part, index) => part === '.ploinky' && parts[index + 1] !== 'repos');
}

export function buildDownloadUrl(entryPath) {
    if (!isDownloadablePath(entryPath)) throw new Error('This item cannot be downloaded.');
    const relative = String(entryPath).replace(/^\/+/, '');
    return '/workspace-files/' + relative.split('/').map(encodeURIComponent).join('/') + '?download=1';
}

export function attachDownloadActions(fileExp) {
    const pending = new Map();
    let disposed = false;
    fileExp.registerCleanup(() => {
        disposed = true;
        for (const controller of pending.values()) controller.abort();
        pending.clear();
    });
    fileExp.downloadEntry = async element => {
        fileExp.closeActionMenu(false);
        const entryPath = element?.dataset?.entryPath || '';
        const type = element?.dataset?.type;
        if (disposed || pending.has(entryPath)) return false;
        const controller = new AbortController();
        pending.set(entryPath, controller);
        try {
            if (!['file', 'directory'].includes(type)) throw new Error('Unsupported download item.');
            if (isDpuDataPath(entryPath)) {
                if (type !== 'file') throw new Error('Only individual data files can be downloaded.');
                const chunks = [];
                let offset = 0;
                do {
                    const result = await callDpuTool('dpu_data_download', { path: entryPath.slice('/.data/'.length), offset });
                    if (disposed || controller.signal.aborted) return false;
                    if (result.item.size > 64 * 1024 * 1024) throw new Error('Data downloads are limited to 64 MiB.');
                    chunks.push(Uint8Array.from(atob(result.content), character => character.charCodeAt(0)));
                    if (result.eof) break;
                    if (result.nextOffset <= offset) throw new Error('File changed during download.');
                    offset = result.nextOffset;
                } while (true);
                const url = URL.createObjectURL(new Blob(chunks));
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = entryPath.split('/').pop();
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                fileExp.showStatus('Download started.');
                return true;
            }
            const url = buildDownloadUrl(entryPath);
            fileExp.showStatus(type === 'directory' ? 'Preparing folder download…' : 'Preparing download…');
            const response = await fetch(url, {
                method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal
            });
            if (disposed || controller.signal.aborted) return false;
            if (!response.ok) {
                throw new Error(response.status === 401 || response.status === 403
                    ? 'Download denied. Check your access or sign in again.'
                    : response.status === 404 ? 'The item is no longer available.' : 'Could not prepare the download.');
            }
            if (!/^attachment(?:;|$)/i.test(response.headers.get('Content-Disposition') || '')) {
                throw new Error('Downloads are unavailable on this server version.');
            }
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = entryPath.split('/').pop() + (type === 'directory' ? '.zip' : '');
            anchor.hidden = true;
            document.body.appendChild(anchor);
            try {
                anchor.click();
            } finally {
                anchor.remove();
            }
            fileExp.showStatus('Download started. Follow its progress in your browser downloads.');
            return true;
        } catch (error) {
            if (!disposed && !controller.signal.aborted) fileExp.showStatus(error.message || 'Download failed.', true);
            return false;
        } finally {
            pending.delete(entryPath);
        }
    };
}
