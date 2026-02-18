/**
 * Shared test data constants.
 */

export const TEST_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex
export const TEST_DASHBOARD_PASSWORD = 'test-password-123';
export const TEST_SCHEMA = 'soul_gateway_test';

export const FAMILY = {
  name: 'test-family',
  description: 'A test soul family',
  model_mapping: JSON.stringify({ 'gpt-4': 'axiologic-deep' }),
  allowed_models: JSON.stringify([]),
  rpm_limit: 100,
  tpm_limit: 200000,
};

export const MODEL = {
  name: 'test-model',
  display_name: 'Test Model',
  upstream_model: 'claude-opus-4.6',
  mode: 'deep',
  input_price: 5,
  output_price: 25,
};

export const MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, world!' },
];

export const CHAT_REQUEST = {
  model: 'test-model',
  messages: MESSAGES,
  stream: false,
};

export const CHAT_REQUEST_STREAMING = {
  model: 'test-model',
  messages: MESSAGES,
  stream: true,
};

export const NON_STREAM_RESPONSE = {
  id: 'chatcmpl-test-123',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'claude-opus-4.6',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hello! How can I help you today?' },
    finish_reason: 'stop',
  }],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
  },
};

export const STREAM_CHUNKS = [
  {
    id: 'chatcmpl-test-stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-opus-4.6',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-test-stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-opus-4.6',
    choices: [{ index: 0, delta: { content: 'Hello!' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-test-stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-opus-4.6',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  },
];

export const BLACKLIST_RULES = [
  { pattern: 'forbidden-exact', match_type: 'exact', description: 'Exact match test' },
  { pattern: 'bad-word', match_type: 'substring', description: 'Substring test' },
  { pattern: 'secret\\d+code', match_type: 'regex', description: 'Regex test' },
];
