import { stdin, stdout, env, exit } from 'node:process';
import { actorContext, authInfoFromEnvelope } from './invocation-context.mjs';

const chunks = [];
for await (const chunk of stdin) {
    chunks.push(chunk);
}
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

function unwrapArguments(envelope) {
    let current = envelope;
    for (let index = 0; index < 4; index += 1) {
        if (current?.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
        } else if (current?.args && typeof current.args === 'object') {
            current = current.args;
        } else if (current?.input && typeof current.input === 'object') {
            current = current.input;
        } else if (current?.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
        } else {
            break;
        }
    }
    return current && typeof current === 'object' ? current : {};
}

const name = env.TOOL_NAME || payload.name || payload.toolName;
const args = unwrapArguments(payload);
const context = actorContext(await authInfoFromEnvelope(payload));

const port = Number(env.USERPERSISTO_SERVICE_PORT || 7000);
const response = await fetch(`http://127.0.0.1:${port}/internal/tool`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-UserPersisto-Runtime-Secret': env.USERPERSISTO_RUNTIME_SECRET || ''
    },
    body: JSON.stringify({ name, arguments: args, context })
});
const data = await response.json().catch(() => ({}));
if (!response.ok || data.ok === false) {
    stdout.write(JSON.stringify({ error: data.error || `tool failed (${response.status})` }));
    exit(1);
}
stdout.write(JSON.stringify(data.result ?? {}));
