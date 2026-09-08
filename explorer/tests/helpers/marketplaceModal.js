import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sourcePath = path.resolve(
    import.meta.dirname,
    '../../IDE-plugins/marketplace/components/marketplace-modal/marketplace-modal.js'
);

export async function loadMarketplaceModal() {
    const source = await fs.readFile(sourcePath, 'utf8');
    const withoutImports = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*/g, '');
    const visibilityUrl = pathToFileURL(path.join(path.dirname(sourcePath), 'marketplaceVisibility.js')).href;
    const dependencies = `
        import { getVisibleMarketplaceCatalog, marketplaceAgentRepositoryName, marketplaceRepositoryIdentity } from '${visibilityUrl}';
        const callExplorerTool = async () => ({});
        const parseToolResult = (value) => value;
        const buildAgentSettingsItems = () => [];
        const ensureSettingsComponentRegistered = async () => {};
        const resolvePluginSettingsUrl = () => '';
        const flattenPluginsByKey = () => [];
        const getCachedRuntimePlugins = () => null;
        const fetchMarketplaceProof = (...args) => globalThis.__marketplaceFetchMarketplaceProof(...args);
        const publishRuntimeStatusEvents = (...args) => globalThis.__marketplacePublishRuntimeStatusEvents?.(...args) || Promise.resolve();
        const isRetryableRuntimeStatusStreamError = (error) => !Number.isFinite(Number(error?.status)) || [502, 503, 504].includes(Number(error.status));
        const RUNTIME_STATUS_UPDATED_EVENT = 'ploinky:runtime-status-updated';
    `;
    const url = `data:text/javascript;base64,${Buffer.from(dependencies + withoutImports).toString('base64')}`;
    return import(url);
}
