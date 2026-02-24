import { sendJson } from '../utils/http-helpers.mjs';
import { listAgents, listSessions, getSessionLogs, getTreeData } from '../db/logs-dao.mjs';

export const handleAgents = {
  async list(req, res, query) {
    const agents = await listAgents({
      family_id: query?.family_id,
      api_key_id: query?.api_key_id,
    });
    sendJson(res, agents);
  },

  async sessions(req, res, query) {
    const sessions = await listSessions({
      api_key_id: query?.api_key_id,
      agent_name: query?.agent_name,
      family_id: query?.family_id,
      limit: query?.limit,
      offset: query?.offset,
    });
    sendJson(res, sessions);
  },

  async sessionLogs(req, res, params, query) {
    const logs = await getSessionLogs(params.id, {
      limit: query?.limit,
      offset: query?.offset,
      sort: query?.sort,
      order: query?.order,
    });
    sendJson(res, logs);
  },

  async tree(req, res) {
    const data = await getTreeData();
    sendJson(res, data);
  },
};
