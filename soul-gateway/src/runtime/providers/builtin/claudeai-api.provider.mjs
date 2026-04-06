import { providerPlugin as anthropicProviderPlugin } from './anthropic-api.provider.mjs';

const manifest = {
  ...anthropicProviderPlugin.manifest,
  key: 'claudeai-api',
  authStrategy: 'oauth',
  displayName: 'Anthropic Claude.ai',
  defaultBaseUrl: 'https://api.anthropic.com',
  oauthAdapterKey: 'anthropic-claudeai',
  // anthropic-api is a hidden dispatcher; this is a distinct OAuth
  // vendor offering with no preset, so it must surface in the dropdown.
  hidden: false,
};

export const providerPlugin = {
  ...anthropicProviderPlugin,
  manifest,
};
