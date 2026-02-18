import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/families-dao.mjs';

export const handleSoulFamilies = {
  async list(req, res) {
    const families = await dao.listFamilies();
    sendJson(res, families);
  },

  async get(req, res, params) {
    const family = await dao.getFamilyById(params.id);
    if (!family) return sendError(res, 404, 'Soul family not found');
    sendJson(res, family);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name) return sendError(res, 400, 'name is required');
    try {
      const family = await dao.createFamily(body);
      sendJson(res, family, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Family name already exists');
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const family = await dao.updateFamily(params.id, body);
    if (!family) return sendError(res, 404, 'Soul family not found');
    sendJson(res, family);
  },

  async remove(req, res, params) {
    const deleted = await dao.deleteFamily(params.id);
    if (!deleted) return sendError(res, 404, 'Soul family not found');
    sendJson(res, { deleted: true });
  },
};
