import { sendJson } from '../utils/http-helpers.mjs';
import { getLogsForExport } from '../db/logs-dao.mjs';

export async function handleExport(req, res, query) {
  const format = query.format || 'json';
  const rows = await getLogsForExport({
    family_id: query.family_id || query.family,
    from: query.from,
    to: query.to,
  });

  if (format === 'csv') {
    const csvHeaders = [
      'id', 'family_name', 'soul_id', 'requested_model', 'resolved_model',
      'status_code', 'latency_ms', 'prompt_tokens', 'completion_tokens',
      'total_tokens', 'total_cost', 'error_type', 'is_truncated', 'is_slow',
      'started_at', 'completed_at',
    ];

    let csv = csvHeaders.join(',') + '\n';
    for (const row of rows) {
      csv += csvHeaders.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(',') + '\n';
    }

    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="soul-gateway-logs.csv"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(csv);
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="soul-gateway-logs.json"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(rows, null, 2));
  }
}
