import { checkBlacklist } from '../pipeline/blacklist.mjs';

export default {
  name: 'blacklist-scanner',
  description: 'Scans request content against blacklist rules and blocks matching requests',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: { enabled: true },

  async before(ctx, settings) {
    if (!settings.enabled) return;
    try {
      await checkBlacklist(ctx.messages);
    } catch (err) {
      if (err.constructor.name === 'BlacklistError') {
        ctx.abort = true;
        ctx.abortStatus = 400;
        ctx.abortMessage = err.message;
        ctx.metadata.errorType = 'content_blocked';
        ctx.metadata.logFields = {
          blocked_by_blacklist: true,
          blacklist_rule_id: err.ruleId,
          blacklist_match: err.match,
        };
        return;
      }
      throw err;
    }
  },
};
