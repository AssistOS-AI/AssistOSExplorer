import { sendJson } from '../utils/http-helpers.mjs';
import * as metricsDao from '../db/metrics-dao.mjs';

export const handleMetrics = {
  async costs(req, res, query) {
    const [byModel, trend] = await Promise.all([
      metricsDao.getCostsByModel(query),
      metricsDao.getCostTrend({ ...query, granularity: query.granularity || 'day' }),
    ]);
    sendJson(res, { by_model: byModel, trend });
  },

  async errors(req, res, query) {
    const [rates, summary, breakdown, models] = await Promise.all([
      metricsDao.getErrorRates(query),
      metricsDao.getErrorSummary(query),
      metricsDao.getErrorBreakdown(query),
      metricsDao.getErrorModels(query),
    ]);
    sendJson(res, { rates, summary, breakdown, models });
  },

  async usage(req, res, query) {
    const [dailyByModel, total, models, modelRequests] = await Promise.all([
      metricsDao.getDailyCostByModel(query),
      metricsDao.getMonthTotal(query),
      metricsDao.getDistinctModels(query),
      metricsDao.getModelRequestStats(query),
    ]);
    sendJson(res, { daily_by_model: dailyByModel, total, models, model_requests: modelRequests });
  },

  async activity(req, res, query) {
    const [byKey, trend] = await Promise.all([
      metricsDao.getCostsByKey(query),
      metricsDao.getKeyTrend(query),
    ]);
    sendJson(res, { by_key: byKey, trend });
  },

  async tokens(req, res, query) {
    const trend = await metricsDao.getTokenTrend(query);
    sendJson(res, { trend });
  },
};
