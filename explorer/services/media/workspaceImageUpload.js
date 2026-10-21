import { isScriptaImageWorkspaceUrl } from '../../shared/document/scripta-state.js';
import { createSecureUuid } from '../../shared/libs/webskel/webskel.mjs';
import { buildMarkdownImageTarget, validateMarkdownImage } from '../../web-components/components/markdown-editor/markdown-editor-media.js';
import { callExplorerTool, ensureSuccess } from '../infrastructure/explorerApi.js';

export async function uploadWorkspaceImage(documentPath, file, {
    callTool = callExplorerTool,
    upload = globalThis.fetch,
    createId = createSecureUuid,
} = {}) {
    validateMarkdownImage(file);
    const id = createId();
    const assetId = `workspace-image-${id}`;
    const target = buildMarkdownImageTarget(documentPath, file, id);
    if (!isScriptaImageWorkspaceUrl(target.targetPath)) {
        throw new Error('Choose a Markdown document in a public workspace folder before inserting an image.');
    }
    ensureSuccess(await callTool('create_directory', { path: target.assetDirectory }, { raw: true, withLoader: false }));
    const response = await upload(`/upload?path=${encodeURIComponent(target.targetPath)}`, {
        method: 'POST', headers: { 'Content-Type': file.type }, body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
        throw new Error('The image could not be uploaded. Please try again.');
    }
    return { assetId, workspaceUrl: target.targetPath, alt: file.name || target.altText };
}
