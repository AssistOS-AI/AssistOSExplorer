import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/keys-dao.mjs';

export const handleKeys = {
  async list(req, res, query) {
    const keys = await dao.listKeys(query?.family_id);
    sendJson(res, keys);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.family_id) return sendError(res, 400, 'family_id is required');
    const key = await dao.createKey(body);
    sendJson(res, key, 201);
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const updated = await dao.updateKey(params.id, body);
    if (!updated) return sendError(res, 404, 'API key not found');
    sendJson(res, updated);
  },

  async revoke(req, res, params) {
    const revoked = await dao.revokeKey(params.id);
    if (!revoked) return sendError(res, 404, 'API key not found');
    sendJson(res, { revoked: true });
  },
};
