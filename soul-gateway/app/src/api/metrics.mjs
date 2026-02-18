import { sendJson } from '../utils/http-helpers.mjs';
import * as metricsDao from '../db/metrics-dao.mjs';

export const handleMetrics = {
  async costs(req, res, query) {
    const [byFamily, byModel, trend] = await Promise.all([
      metricsDao.getCostsByFamily(query),
      metricsDao.getCostsByModel(query),
      metricsDao.getCostTrend({ ...query, granularity: query.granularity || 'day' }),
    ]);
    sendJson(res, { by_family: byFamily, by_model: byModel, trend });
  },

  async errors(req, res, query) {
    const [rates, summary] = await Promise.all([
      metricsDao.getErrorRates(query),
      metricsDao.getErrorSummary(query),
    ]);
    sendJson(res, { rates, summary });
  },

  async tokens(req, res, query) {
    const trend = await metricsDao.getTokenTrend(query);
    sendJson(res, { trend });
  },
};
