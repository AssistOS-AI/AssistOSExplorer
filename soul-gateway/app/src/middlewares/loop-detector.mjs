import {
  resolveTrackingId,
  recordRequest,
  recordResponse,
  checkLoop,
  markIntervention,
} from '../pipeline/loop-detector.mjs';

export default {
  name: 'loop-detector',
  description: 'Detects agent loops by analyzing response similarity and conversation growth patterns. Modes: intervene (inject warning), block (429), log (observe only).',
  version: '2.0.0',
  type: 'both',
  supportsStreaming: true,
  defaultSettings: {
    enabled: true,
    mode: 'intervene',
    similarityThreshold: 5,
    similarityWindow: 7,
    growthTokenThreshold: 50000,
    interventionMessage: '[Soul Gateway] Loop detected: your last several responses followed the same pattern. Stop the current approach and try something different.',
  },

  async before(ctx, settings) {
    if (!settings.enabled) return;

    const trackingId = resolveTrackingId(ctx.sessionId, ctx.authCtx?.api_key_id, ctx.agentName);
    ctx.metadata._loopTrackingId = trackingId;

    // Record request growth
    recordRequest(trackingId, ctx.messages);

    // Check for loop
    const result = checkLoop(trackingId, {
      similarityThreshold: settings.similarityThreshold,
      similarityWindow: settings.similarityWindow,
      growthTokenThreshold: settings.growthTokenThreshold,
    });

    if (!result.detected) return;

    ctx.metadata.loopDetected = true;
    ctx.metadata.loopReason = result.reason;

    if (settings.mode === 'block') {
      ctx.abort = true;
      ctx.abortStatus = 429;
      ctx.abortMessage = `Agent loop detected (${result.reason}): repeated response pattern over ${settings.similarityWindow} requests`;
      ctx.metadata.errorType = 'loop_detected';
      return;
    }

    if (settings.mode === 'intervene') {
      // Inject a system message to help the LLM break out of the loop
      ctx.messages = [
        { role: 'system', content: settings.interventionMessage },
        ...ctx.messages,
      ];
      markIntervention(trackingId);
      return;
    }

    // mode === 'log': do nothing, just log (already logged by checkLoop)
  },

  async after(ctx, settings) {
    if (!settings.enabled || !ctx.response) return;

    const trackingId = ctx.metadata._loopTrackingId;
    if (!trackingId) return;

    // Record response fingerprint for future loop detection
    recordResponse(trackingId, ctx.response, settings.similarityWindow);
  },
};
