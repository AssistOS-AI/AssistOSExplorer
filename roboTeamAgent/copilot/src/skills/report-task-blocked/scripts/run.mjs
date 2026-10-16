import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function reportTaskBlocked(input, { directory = '/workspace/roboteam-task-failure' } = {}) {
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000)
        throw new Error('Provide a nonempty message of at most 8000 characters.');
    let context;
    try { context = JSON.parse(await fs.readFile(path.join(directory, 'context.json'), 'utf8')); }
    catch { throw new Error('Task failure reporting is not available for this execution.'); }
    const payload = JSON.stringify({ message: input.message });
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(directory, 'request.sock'), path: '/report-task-blocked', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-task-capability': context.token } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(new Error('Invalid callback response')); });
            res.on('error', reject);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (res.statusCode !== 200 || result.ok !== true) throw new Error(result.error || 'Task-failure request failed');
                    resolve(result);
                } catch (error) { reject(error); }
            });
        });
        req.setTimeout(20000, () => req.destroy(new Error('Task-failure acknowledgement timed out. Do not continue working.')));
        req.on('error', reject);
        req.end(payload);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const { values } = parseArgs({ options: { input: { type: 'string' } }, allowPositionals: false });
        console.log(JSON.stringify(await reportTaskBlocked(JSON.parse(values.input))));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
