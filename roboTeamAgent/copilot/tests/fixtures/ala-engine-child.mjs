import fs from 'node:fs/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolveAlaCommand } from '../../../server/ala-command.mjs';

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const home = value('--home');
const cwd = value('--cwd');
const id = value('--session-id');
if (!args.includes('--ignore') || value('--ignore') !== path.resolve(cwd, '.roboteam')) {
    throw new Error('Missing private workspace directory mask.');
}
if (args.includes('--ploinky-task')) throw new Error('Legacy Ploinky option was forwarded.');
const folder = args[args.indexOf('as') - 1];
if (value('--cwd') !== cwd) throw new Error('Missing canonical writable cwd');
if (args.includes('--external-workspace') || args.includes('--skill-catalog') || args.includes('--skill')) {
    throw new Error('Removed ALA skill options were forwarded.');
}
if (!folder || value('as') !== 'ploinky-runtime') throw new Error('Missing generic runtime mount.');
if (!(await fs.stat(path.join(folder, 'tasks.sock'))).isSocket()) throw new Error('Missing task notification socket.');
if (args.includes('--taskFile') || args.includes('--user-message-file')) throw new Error('The turn prompt must arrive on stdin.');
// Like ALA with --control-stdin: the first control record is the turn prompt.
const stdinLines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = JSON.parse((await stdinLines.next()).value);
if (first.type !== 'prompt' || typeof first.prompt !== 'string') throw new Error('Missing turn prompt record.');
const prompt = first.prompt;
if (args.includes('--config')) throw new Error('RoboTeam must use robot home plus CLI overrides, not a generated config.');
const alaRoot = path.dirname(path.dirname(await fs.realpath(resolveAlaCommand())));
// Like ALA: read the robot home, then apply per-invocation CLI overrides.
const { loadConfig, applyCodingAgentOverrides } = await import(pathToFileURL(path.join(alaRoot, 'src', 'config.mjs')));
const config = await loadConfig(path.join(home, '.ala', 'config.json'));
// Record the conversation through ALA's own session modules, as ALA does.
const { openSessionState } = await import(pathToFileURL(path.join(alaRoot, 'src', 'session-state.mjs')));
const { createTranscriptRecorder } = await import(pathToFileURL(path.join(alaRoot, 'src', 'transcript-recorder.mjs')));
if (!process.env.ALA_SESSIONS) throw new Error('Missing ALA_SESSIONS.');
const state = await openSessionState({ id, sessionsRoot: process.env.ALA_SESSIONS, resume: args.includes('--resume-session') });
// Like ALA, a resumed session continues on its own agent when no --ca is given.
const backend = value('--ca') || (args.includes('--resume-session') && state.record.agent) || config.codingAgent || 'codex';
Object.assign(config, applyCodingAgentOverrides(config, { agent: backend, model: value('--model'), effort: value('--effort') }));
const recorder = createTranscriptRecorder(state, value('--turn-id'));
await recorder.user(first.displayText || first.prompt);
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
// A turn can complete without any visible coding-agent output.
if (!prompt.includes('NO_VISIBLE_MESSAGES')) emit({ type: 'coding-agent-message', agent: backend, message: 'Visible progress' });
if (prompt.includes('FORCED_FAILURE')) {
    const { reportTaskBlocked } = await import('../../src/skills/report-task-blocked/scripts/run.mjs');
    const directory = args[args.indexOf('roboteam-task-failure') - 2];
    await reportTaskBlocked({ message: 'Stopped at deployment: required access is unavailable.' }, { directory });
    setInterval(() => {}, 1000);
} else if (prompt.includes('LIVE_CONTROL')) {
    // Live Sessions messages arrive as control records after the prompt. The
    // display text says how to answer: accept, reject, or exit without a receipt.
    const records = [];
    emit({ type: 'coding-agent-message', agent: backend, message: 'READY', outputKind: 'assistant', outputComplete: true });
    for (let next = await stdinLines.next(); !next.done; next = await stdinLines.next()) {
        const record = JSON.parse(next.value);
        records.push(record);
        if (record.type !== 'message') continue;
        if (record.displayText === 'accept') {
            emit({ type: 'message-accepted', id: 'unrelated-id', delivery: 'delivered' });
            emit({ type: 'message-accepted', id: record.id, delivery: 'delivered' });
        } else if (record.displayText === 'reject') {
            emit({ type: 'message-rejected', id: record.id, error: 'Fixture rejected the message.' });
        } else if (record.displayText === 'exit') break;
    }
    const output = JSON.stringify({ records });
    emit({ type: 'coding-agent-final', agent: backend, message: output });
    await recorder.finish({ result: output, status: 'completed' });
    await state.close();
    process.stdout.write(`${output}\n`);
    process.stdin.destroy();
} else if (prompt.includes('MALFORMED')) {
    process.stderr.write('@@ALA_EVENT@@{invalid\n');
    setInterval(() => {}, 1000);
} else {
    let choice = null;
    if (prompt.includes('APPROVAL')) {
        emit({ type: 'coding-agent-request', id: 'fixture-request', agent: backend, kind: 'permission',
            method: 'fixture/requestApproval', title: 'Fixture approval', message: 'Approve fixture?',
            options: [{ id: 'deny', label: 'Deny' }, { id: 'allow', label: 'Allow once' }] });
        for (let next = await stdinLines.next(); !next.done; next = await stdinLines.next()) {
            const line = next.value;
            const response = JSON.parse(line);
            if (response.type !== 'interaction-response' || response.id !== 'fixture-request') process.exit(2);
            choice = response.cancelled ? 'cancelled' : response.optionId;
            emit({ type: 'coding-agent-request-resolved', id: response.id, reason: 'answered' });
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
        openCodeModels, folders: args.flatMap((value, index) => value === '--folder' ? [{ source: args[index + 1], alias: args[index + 2] === 'as' ? args[index + 3] : null,
            ...(args[index + 2] === 'at' ? { target: args[index + 3], expose: args[index + 4] === 'expose' } : {}) }] : []),
        effortOverride: value('--effort') ?? null, repositories: process.env.ALA_TASK_REPOSITORIES, model: value('--model') || config.models[backend] || null, modelOverride: value('--model') || null, ca: value('--ca') || null,
        credential: process.env.PLOINKY_AGENT_SECRET || process.env.SSO_ACCESS_TOKEN || null,
        livePublish: process.env.ROBOTEAM_LIVE_PUBLISH ?? null,
        privatePrompt: !args.some((arg) => arg.includes('PRIVATE_USER_PROMPT')) });
    if (prompt.includes('LIVE_TASK')) {
        // A delegated task notification through the turn's task socket, sent
        // without waiting for its acknowledgement: RoboTeam observes the task
        // while the turn is ending.
        const { eventToken } = JSON.parse(await fs.readFile(path.join(folder, 'context.json'), 'utf8'));
        const socket = net.connect(path.join(folder, 'tasks.sock'));
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        socket.on('error', () => {});
        socket.write(`${JSON.stringify({ token: eventToken, id: randomUUID(), event: { type: 'task-started',
            task: { agentName: 'otherAgent', taskId: 'remote-live-task', toolName: 'long_job' } } })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The child exits without waiting for the acknowledgement.
        socket.unref();
    }
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
