import fs from 'node:fs';
import http from 'node:http';

const ROOT = '/run/robo-work';
const SOCKET = `${ROOT}/channels/workflow-catalog/request.sock`;
const MAX_BYTES = 512 * 1024;
const ERRORS = new Set(['invalid_request', 'catalog_busy', 'catalog_timeout', 'catalog_unavailable', 'catalog_too_large', 'execution_ended']);
export const isWorker = () => fs.existsSync(ROOT);
const failure = (code = 'catalog_unavailable') => Object.assign(new Error(code), { code });

// No configurable destination, identity or tool: the execution's fixed socket serves one empty read.
export function readWorkerCatalog(input = '') {
    if (typeof input !== 'string' || input !== '') return Promise.reject(failure('invalid_request'));
    return new Promise((resolve, reject) => {
        let settled = false;
        let req;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => { finish(failure('catalog_timeout')); req?.destroy(); }, 32000);
        req = http.request({ socketPath: SOCKET, path: '/list-workflows', method: 'POST', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': '2' },
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BYTES) { finish(failure('catalog_too_large')); res.destroy(); }
                else chunks.push(chunk);
            });
            res.on('end', () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (res.statusCode !== 200 || result?.ok !== true || !Array.isArray(result.workflows)) {
                        finish(failure(ERRORS.has(result?.error) ? result.error : 'catalog_unavailable'));
                    } else finish(null, result);
                } catch { finish(failure()); }
            });
            res.on('aborted', () => finish(failure()));
            res.on('error', () => finish(failure()));
        });
        req.on('error', () => finish(failure()));
        req.end('{}');
    });
}
