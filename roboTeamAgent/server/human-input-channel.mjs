import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Private HTTP callback from one native execution into its owning RoboTeam process.
// It grants no access to the public HTTP API or to other workflow executions.
export async function createHumanInputChannel({ request, stop, graceMs = 10000 }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-human-'));
    await fs.chmod(directory, 0o700);
    const token = crypto.randomBytes(32).toString('hex');
    let timer;
    const server = http.createServer(async (req, res) => {
        const reply = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' });
            res.end(JSON.stringify(body));
        };
        const supplied = Buffer.from(String(req.headers['x-task-capability'] || ''));
        const expected = Buffer.from(token);
        if (req.method !== 'POST' || req.url !== '/require-human-input'
            || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return reply(403, { error: 'Invalid task callback' });
        try {
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 64 * 1024) throw Object.assign(new Error('Question is too large'), { statusCode: 413 });
                chunks.push(chunk);
            }
            let input;
            try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw Object.assign(new Error('Invalid question JSON'), { statusCode: 400 }); }
            const result = await request(input);
            // Give the native agent time to finish and save its turn. Enforce the
            // stop if it ignores the skill's instruction to end the execution.
            timer ||= setTimeout(() => { void Promise.resolve().then(stop).catch(() => {}); }, graceMs);
            reply(200, { ok: true, ...result, instruction: 'End this execution now. Wait for the user answer.' });
        } catch (error) { reply(error.statusCode || 500, { error: error.statusCode ? error.message : 'Could not save the human-input request' }); }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 15000;
    try {
        await fs.writeFile(path.join(directory, 'context.json'), JSON.stringify({ token }), { mode: 0o600 });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(directory, 'request.sock'), resolve); });
    } catch (error) { server.close(); await fs.rm(directory, { recursive: true, force: true }); throw error; }
    return { directory, async close() {
        clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    } };
}
