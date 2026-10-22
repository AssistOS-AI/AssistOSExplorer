import { backendModule as anthropicBackend } from './anthropic-api.backend.mjs';

const manifest = {
    ...anthropicBackend.manifest,
    key: 'claudeai-api',
    authStrategy: 'oauth',
    displayName: 'Anthropic Claude.ai',
    defaultBaseUrl: 'https://api.anthropic.com',
    oauthAdapterKey: 'anthropic-claudeai',
    // anthropic-api is a hidden dispatcher; this is a distinct OAuth
    // vendor offering with no preset, so it must surface in the dropdown.
    hidden: false,
};

export const backendModule = {
    ...anthropicBackend,
    manifest,
};
