import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolveAlaCommand } from '../../../server/ala-command.mjs';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const home = value('--home');
const cwd = value('--cwd');
const id = value('--session-id');
if (!args.includes('--ignore') || value('--ignore') !== path.resolve(cwd, '.roboteam')) {
    throw new Error('Missing private workspace directory mask.');
}
const backend = value('--ca');
if (args.includes('--ploinky-task')) throw new Error('Legacy Ploinky option was forwarded.');
const folder = args[args.indexOf('as') - 1];
if (value('--cwd') !== cwd) throw new Error('Missing canonical writable cwd');
if (args.includes('--external-workspace') || args.includes('--skill-catalog') || args.includes('--skill')) {
    throw new Error('Removed ALA skill options were forwarded.');
}
if (!folder || value('as') !== 'ploinky-runtime') throw new Error('Missing generic runtime mount.');
if (!(await fs.stat(path.join(folder, 'tasks.sock'))).isSocket()) throw new Error('Missing task notification socket.');
const prompt = await fs.readFile(value('--taskFile'), 'utf8');
const config = JSON.parse(await fs.readFile(value('--config'), 'utf8'));
// Record the conversation through ALA's own session modules, as ALA does.
const alaRoot = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
const { openSessionState } = await import(pathToFileURL(path.join(alaRoot, 'src', 'session-state.mjs')));
const { createTranscriptRecorder } = await import(pathToFileURL(path.join(alaRoot, 'src', 'transcript-recorder.mjs')));
if (!process.env.ALA_SESSIONS) throw new Error('Missing ALA_SESSIONS.');
const state = await openSessionState({ id, sessionsRoot: process.env.ALA_SESSIONS, resume: args.includes('--resume-session') });
const recorder = createTranscriptRecorder(state, value('--turn-id'));
await recorder.user(await fs.readFile(value('--user-message-file'), 'utf8'));
await state.save({ agent: backend, continuation: state.record.continuation
    || (backend === 'opencode' ? { sessionId: 'fixture-opencode' } : { threadId: 'fixture-thread' }) });
const emit = (event) => {
    recorder.observe(event);
    const line = `@@ALA_EVENT@@${JSON.stringify(event)}\n`;
    process.stderr.write(line.slice(0, 9));
    process.stderr.write(line.slice(9));
};
process.on('SIGINT', async () => { await state.close().catch(() => {}); process.exit(130); });
emit({ type: 'session-ready', sessionId: id });
emit({ type: 'coding-agent-selected', agent: backend, permissionMode: value('--permissions') });
emit({ type: 'coding-agent-message', agent: backend, message: 'Visible progress' });
if (prompt.includes('MALFORMED')) {
    process.stderr.write('@@ALA_EVENT@@{invalid\n');
    setInterval(() => {}, 1000);
} else {
    let choice = null;
    if (prompt.includes('APPROVAL')) {
        emit({ type: 'coding-agent-request', id: 'fixture-request', agent: backend, kind: 'permission',
            method: 'fixture/requestApproval', title: 'Fixture approval', message: 'Approve fixture?',
            options: [{ id: 'deny', label: 'Deny' }, { id: 'allow', label: 'Allow once' }] });
        const input = readline.createInterface({ input: process.stdin });
        for await (const line of input) {
            const response = JSON.parse(line);
            if (response.type !== 'interaction-response' || response.id !== 'fixture-request') process.exit(2);
            choice = response.cancelled ? 'cancelled' : response.optionId;
            emit({ type: 'coding-agent-request-resolved', id: response.id, reason: 'answered' });
            input.close();
            break;
        }
    }
    let openCodeModels = [];
    if (backend === 'opencode') {
        const { SoulGateway } = await import(pathToFileURL(path.join(home, '.config/opencode/plugins/soul-gateway.js')));
        const plugin = await SoulGateway();
        const providerConfig = {};
        try {
            await plugin.config(providerConfig);
            openCodeModels = Object.keys(providerConfig.provider['soul-gateway'].models);
        } finally { await plugin.dispose(); }
    }
    const output = JSON.stringify({ prompt, skill: args.includes('--skill') ? value('--skill') : null, choice, resumed: args.includes('--resume-session'), config,
        openCodeModels, folders: args.flatMap((value, index) => value === '--folder' ? [{ source: args[index + 1], alias: args[index + 2] === 'as' ? args[index + 3] : null }] : []),
        repositories: process.env.ALA_TASK_REPOSITORIES, model: args.includes('--model') ? value('--model') : null,
        credential: process.env.PLOINKY_AGENT_SECRET || process.env.SSO_ACCESS_TOKEN || null,
        privatePrompt: !args.some((arg) => arg.includes('PRIVATE_USER_PROMPT')) });
    if (prompt.includes('QUEUED_FOLLOWUP')) {
        emit({ type: 'message-accepted', id: 'queued-input', delivery: 'queued' });
        emit({ type: 'coding-agent-final', agent: backend, message: 'Initial result before queued follow-up' });
    }
    emit({ type: 'coding-agent-final', agent: backend, message: output });
    if (prompt.includes('NONZERO')) { process.stderr.write('Native provider failed.\n'); process.exitCode = 7; }
    await recorder.finish(prompt.includes('NONZERO') ? { status: 'failed', error: 'Native provider failed.' } : { result: output, status: 'completed' });
    await state.close();
    process.stdout.write(`${output}\n`);
    process.stdin.destroy();
}
