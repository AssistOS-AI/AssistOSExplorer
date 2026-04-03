import { providerPlugin as anthropicProviderPlugin } from './anthropic-api.provider.mjs';

const manifest = {
  ...anthropicProviderPlugin.manifest,
  key: 'claudeai-api',
  authStrategy: 'oauth',
  displayName: 'Anthropic Claude.ai',
  defaultBaseUrl: 'https://api.anthropic.com',
  oauthAdapterKey: 'anthropic-claudeai',
};

export const providerPlugin = {
  ...anthropicProviderPlugin,
  manifest,
};
