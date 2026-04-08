import { providerPlugin as openaiProviderPlugin } from './openai-api.provider.mjs';

const manifest = {
    ...openaiProviderPlugin.manifest,
    key: 'gemini-openai',
    authStrategy: 'oauth',
    displayName: 'Google Gemini (OAuth)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    oauthAdapterKey: 'google-gemini',
    // openai-api is a hidden dispatcher; this is a distinct OAuth
    // vendor offering with no preset, so it must surface in the dropdown.
    hidden: false,
};

export const providerPlugin = {
    ...openaiProviderPlugin,
    manifest,
};
