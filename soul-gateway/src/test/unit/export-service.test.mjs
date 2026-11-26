import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExportService } from '../../observability/export-service.mjs';

function createRecordingResponse() {
    return {
        status: 0,
        headers: null,
        body: '',
        ended: false,
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
        write(chunk) {
            this.body += chunk;
        },
        end() {
            this.ended = true;
        },
    };
}

function createPool(rows) {
    return { query: async () => ({ rows, rowCount: rows.length }) };
}

function headerValue(headers, name) {
    const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
}

describe('ExportService response headers', () => {
    it('marks the CSV export private and not storable', async () => {
        const res = createRecordingResponse();
        await new ExportService(createPool([])).exportCsv(res, {});
        assert.equal(res.status, 200);
        assert.equal(headerValue(res.headers, 'Cache-Control'), 'private, no-store');
        assert.equal(headerValue(res.headers, 'Content-Type'), 'text/csv; charset=utf-8');
        assert.ok(res.body.startsWith('log_id,request_id,'));
        assert.equal(res.ended, true);
    });

    it('marks the JSON export private and not storable', async () => {
        const res = createRecordingResponse();
        await new ExportService(createPool([{ log_id: 'l1' }])).exportJson(res, {});
        assert.equal(res.status, 200);
        assert.equal(headerValue(res.headers, 'Cache-Control'), 'private, no-store');
        assert.deepEqual(JSON.parse(res.body), [{ log_id: 'l1' }]);
        assert.equal(res.ended, true);
    });
});
