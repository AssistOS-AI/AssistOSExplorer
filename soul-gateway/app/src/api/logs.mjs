import { sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/logs-dao.mjs';

export const handleLogs = {
  async list(req, res, query) {
    const result = await dao.queryLogs({
      soul_id: query.soul_id,
      model: query.model,
      from: query.from,
      to: query.to,
      status: query.status,
      error_type: query.error_type,
      keyword: query.keyword,
      agent_name: query.agent_name,
      api_key_id: query.api_key_id,
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      order: query.order,
    });
    sendJson(res, result);
  },

  async get(req, res, params) {
    const log = await dao.getLogById(params.id);
    if (!log) return sendError(res, 404, 'Log entry not found');
    sendJson(res, log);
  },
};
