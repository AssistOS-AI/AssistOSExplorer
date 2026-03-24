import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('model-cooldown');

/**
 * In-memory cooldown store.
 * Key: modelConfigName (e.g. "kiro-claude-sonnet-4.5")
 * Value: { expiresAt, errorType, message, cooledAt }
 */
const cooldowns = new Map();

/**
 * Check if a model is currently in cooldown.
 * Auto-removes expired entries.
 */
export function isModelInCooldown(modelName) {
  const entry = cooldowns.get(modelName);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    cooldowns.delete(modelName);
    return false;
  }
  return true;
}

/**
 * Put a model in cooldown for `config.cooldownDurationMs`.
 */
export function putModelInCooldown(modelName, errorType, message) {
  const durationMs = config.cooldownDurationMs;
  const expiresAt = Date.now() + durationMs;
  cooldowns.set(modelName, {
    expiresAt,
    errorType,
    message,
    cooledAt: new Date().toISOString(),
  });
  log.warn('Model put in cooldown', {
    model: modelName,
    errorType,
    durationMs,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

/**
 * Check if an error classification should trigger a cooldown.
 */
export function shouldTriggerCooldown(errorClassification) {
  if (!errorClassification?.type) return false;
  return config.cooldownTriggers.includes(errorClassification.type);
}

/**
 * Get all active cooldowns for dashboard/API.
 */
export function getCooldownStatus() {
  const now = Date.now();
  const result = [];
  for (const [model, entry] of cooldowns) {
    if (now >= entry.expiresAt) {
      cooldowns.delete(model);
      continue;
    }
    result.push({
      model,
      errorType: entry.errorType,
      message: entry.message,
      cooledAt: entry.cooledAt,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      remainingMs: entry.expiresAt - now,
    });
  }
  return result;
}

/**
 * Clear cooldown for a specific model.
 */
export function clearCooldown(modelName) {
  const existed = cooldowns.delete(modelName);
  if (existed) {
    log.info('Cooldown cleared', { model: modelName });
  }
  return existed;
}

/**
 * Clear all cooldowns.
 */
export function clearAllCooldowns() {
  const count = cooldowns.size;
  cooldowns.clear();
  if (count > 0) {
    log.info('All cooldowns cleared', { count });
  }
  return count;
}

// Periodic cleanup of expired entries (every 5 minutes)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [model, entry] of cooldowns) {
    if (now >= entry.expiresAt) {
      cooldowns.delete(model);
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();
