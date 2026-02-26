import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/blacklist-dao.mjs';

export const handleBlacklist = {
  async list(req, res, query) {
    const rules = await dao.listRules();
    sendJson(res, rules);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.pattern || !body?.match_type) {
      return sendError(res, 400, 'pattern and match_type are required');
    }
    if (!['exact', 'substring', 'regex'].includes(body.match_type)) {
      return sendError(res, 400, 'match_type must be exact, substring, or regex');
    }
    const rule = await dao.createRule(body);
    sendJson(res, rule, 201);
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const rule = await dao.updateRule(params.id, body);
    if (!rule) return sendError(res, 404, 'Blacklist rule not found');
    sendJson(res, rule);
  },

  async remove(req, res, params) {
    const deleted = await dao.deleteRule(params.id);
    if (!deleted) return sendError(res, 404, 'Blacklist rule not found');
    sendJson(res, { deleted: true });
  },
};
