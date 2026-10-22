import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function requireHumanInput(input, { directory = '/workspace/roboflow-human-input' } = {}) {
    if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8000
        || !Array.isArray(input.options) || input.options.length !== 3
        || input.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 2000)
        || new Set(input.options.map(option => option.trim())).size !== 3) throw new Error('Provide a question and exactly three distinct nonempty options.');
    let context;
    try { context = JSON.parse(await fs.readFile(path.join(directory, 'context.json'), 'utf8')); }
    catch { throw new Error('Human input is not enabled for this execution.'); }
    const payload = JSON.stringify({ question: input.question, options: input.options });
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(directory, 'request.sock'), path: '/require-human-input', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-task-capability': context.token } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(new Error('Invalid callback response')); });
            res.on('error', reject);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (res.statusCode !== 200 || result.ok !== true) throw new Error(result.error || 'Human-input request failed');
                    resolve(result);
                } catch (error) { reject(error); }
            });
        });
        req.setTimeout(20000, () => req.destroy(new Error('Human-input acknowledgement timed out. Do not continue working.')));
        req.on('error', reject);
        req.end(payload);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const { values } = parseArgs({ options: { input: { type: 'string' } }, allowPositionals: false });
        console.log(JSON.stringify(await requireHumanInput(JSON.parse(values.input))));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
