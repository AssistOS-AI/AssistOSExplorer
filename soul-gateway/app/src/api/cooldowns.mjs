import { sendJson, sendError } from '../utils/http-helpers.mjs';
import { getCooldownStatus, clearCooldown, clearAllCooldowns } from '../pipeline/model-cooldown.mjs';

export const handleCooldowns = {
  async list(req, res) {
    sendJson(res, getCooldownStatus());
  },

  async clear(req, res, params) {
    const model = decodeURIComponent(params.model);
    const cleared = clearCooldown(model);
    if (!cleared) return sendError(res, 404, 'Model not in cooldown');
    sendJson(res, { cleared: true, model });
  },

  async clearAll(req, res) {
    const count = clearAllCooldowns();
    sendJson(res, { cleared: count });
  },
};
