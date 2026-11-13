#!/usr/bin/env node
// RoboTeam git credential helper. RoboWork copies this file into a robot home; git runs it for https://github.com.
// It holds no secret: on `get` it asks RoboWork over the robot's own socket and prints what RoboWork returns.
// Any failure prints nothing, so git falls back to its usual behavior. `store` and `erase` are ignored.
import http from 'node:http';

const SOCKET = process.env.ROBOTEAM_GIT_CREDENTIALS_SOCKET || '/workspace/roboteam-soul/git-credentials.sock';

async function readRequest() {
    let text = '';
    for await (const chunk of process.stdin) {
        text += chunk;
        if (text.length > 64 * 1024) break;
    }
    const fields = {};
    for (const line of text.split('\n')) {
        const index = line.indexOf('=');
        if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1).replace(/\r$/u, '');
    }
    return fields;
}

function ask(body) {
    return new Promise(resolve => {
        const req = http.request({ socketPath: SOCKET, path: '/credential', method: 'POST',
            headers: { 'content-type': 'application/json' }, timeout: 5000 }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { if (text.length < 64 * 1024) text += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(text)); } catch { resolve(null); }
            });
            res.on('error', () => resolve(null));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
        req.end(JSON.stringify(body));
    });
}

const line = value => typeof value === 'string' && value && !/[\r\n\0]/u.test(value);

async function main(operation = process.argv[2]) {
    // Reading the request first lets git finish writing it whatever the operation.
    const request = await readRequest();
    if (operation !== 'get') return;
    if (request.protocol !== 'https' || request.host !== 'github.com') return;
    const answer = await ask({ protocol: 'https', host: 'github.com' });
    if (!line(answer?.username) || !line(answer?.password)) return;
    process.stdout.write(`username=${answer.username}\npassword=${answer.password}\n`);
}

try { await main(); } catch { /* git continues without a credential. */ }
process.exitCode = 0;
