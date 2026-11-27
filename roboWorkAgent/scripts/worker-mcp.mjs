import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

// MCP stdio transport. The endpoint is a private mount, not a TCP address or a bearer credential.
export function request(message, socketPath = '/run/robowork-worker/control.sock') {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: '/rpc', method: 'POST', timeout: 18000,
            headers: { 'content-type': 'application/json' } }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 262144) req.destroy(new Error('Response too large')); });
            res.on('end', () => {
                try {
                    if (res.statusCode === 204) return resolve(null);
                    if (res.statusCode !== 200) throw new Error('Worker MCP unavailable');
                    resolve(JSON.parse(body));
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Worker MCP timed out')));
        req.end(JSON.stringify(message));
    });
}

// Native extension bridge for clients without a built-in MCP client.
export default async function extension(api) {
    let nextId = 1;
    await request({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'robowork-extension', version: '1.0.0' } } });
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await request({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' });
    for (const tool of listed.result.tools) api.registerTool({ name: tool.name, label: tool.name,
        description: tool.description, parameters: tool.inputSchema,
        async execute(_id, args) {
            const response = await request({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool.name, arguments: args } });
            if (response.error) throw new Error(response.error.message);
            return response.result;
        } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const lines = readline.createInterface({ input: process.stdin });
    const active = new Set();
    async function handle(line) {
        let input;
        try {
            input = JSON.parse(line);
            const output = await request(input, process.argv[2]);
            if (output) process.stdout.write(JSON.stringify(output) + '\n');
        } catch { if (input?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: input.id,
            error: { code: -32603, message: 'Worker control unavailable' } }) + '\n'); }
    }
    for await (const line of lines) {
        if (Buffer.byteLength(line) > 16384 || active.size >= 16) { process.exitCode = 1; break; }
        const operation = handle(line).finally(() => active.delete(operation));
        active.add(operation);
    }
    await Promise.allSettled(active);
}
