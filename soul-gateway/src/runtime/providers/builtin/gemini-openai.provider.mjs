import { providerPlugin as openaiProviderPlugin } from './openai-api.provider.mjs';

const manifest = {
  ...openaiProviderPlugin.manifest,
  key: 'gemini-openai',
  authStrategy: 'oauth',
  displayName: 'Google Gemini (OAuth)',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  oauthAdapterKey: 'google-gemini',
};

export const providerPlugin = {
  ...openaiProviderPlugin,
  manifest,
};
