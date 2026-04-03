/**
 * Request validation.
 *
 * Validates the normalized request (after format normalization)
 * to ensure it contains all required fields and that message shapes
 * are well-formed.
 */

import { ValidationError } from '../core/errors.mjs';

/**
 * Validate a normalized request object.
 * Throws ValidationError with a specific message on failure.
 *
 * @param {object} parsed - normalized request from format-normalizer
 * @param {string} parsed.model
 * @param {Array} parsed.messages
 */
export function validateNormalizedRequest(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new ValidationError('Parsed request must be an object');
  }

  // model is required and must be a non-empty string
  if (!parsed.model || typeof parsed.model !== 'string') {
    throw new ValidationError('model is required and must be a non-empty string');
  }

  if (parsed.model.trim().length === 0) {
    throw new ValidationError('model must not be empty or whitespace-only');
  }

  // messages is required and must be a non-empty array
  if (!Array.isArray(parsed.messages)) {
    throw new ValidationError('messages is required and must be an array');
  }

  if (parsed.messages.length === 0) {
    throw new ValidationError('messages must contain at least one message');
  }

  // Validate each message
  for (let i = 0; i < parsed.messages.length; i++) {
    validateMessage(parsed.messages[i], i);
  }

  // Validate optional numeric parameters
  if (parsed.temperature != null) {
    if (typeof parsed.temperature !== 'number' || parsed.temperature < 0 || parsed.temperature > 2) {
      throw new ValidationError('temperature must be a number between 0 and 2');
    }
  }

  if (parsed.top_p != null) {
    if (typeof parsed.top_p !== 'number' || parsed.top_p < 0 || parsed.top_p > 1) {
      throw new ValidationError('top_p must be a number between 0 and 1');
    }
  }

  if (parsed.max_tokens != null) {
    if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens < 1 || !Number.isInteger(parsed.max_tokens)) {
      throw new ValidationError('max_tokens must be a positive integer');
    }
  }
}

// ── Message validation ──────────────────────────────────────────────

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'function']);

function validateMessage(msg, index) {
  if (!msg || typeof msg !== 'object') {
    throw new ValidationError(`messages[${index}] must be an object`);
  }

  // Role is required
  if (!msg.role || typeof msg.role !== 'string') {
    throw new ValidationError(`messages[${index}].role is required and must be a string`);
  }

  if (!VALID_ROLES.has(msg.role)) {
    throw new ValidationError(`messages[${index}].role must be one of: ${[...VALID_ROLES].join(', ')}`);
  }

  // Content or tool_calls must be present
  const hasContent = msg.content !== undefined && msg.content !== null;
  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

  if (!hasContent && !hasToolCalls) {
    throw new ValidationError(
      `messages[${index}] must have content or tool_calls`
    );
  }

  // If content is present, validate its type
  if (hasContent) {
    const validContentType = typeof msg.content === 'string' || Array.isArray(msg.content);
    if (!validContentType) {
      throw new ValidationError(
        `messages[${index}].content must be a string or an array of content parts`
      );
    }
  }

  // Tool messages require tool_call_id
  if (msg.role === 'tool' && !msg.tool_call_id) {
    throw new ValidationError(`messages[${index}] with role 'tool' must have a tool_call_id`);
  }
}
