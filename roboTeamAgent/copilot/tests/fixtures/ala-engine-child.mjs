import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const home = value('--home');
const cwd = value('--cwd');
const id = value('--session-id');
const backend = value('--ca');
if (args.includes('--ploinky-task')) throw new Error('Legacy Ploinky option was forwarded.');
const folder = value('--folder');
if (!folder || value('as') !== 'ploinky-runtime') throw new Error('Missing generic runtime mount.');
if (!(await fs.stat(path.join(folder, 'tasks.sock'))).isSocket()) throw new Error('Missing task notification socket.');
const prompt = await fs.readFile(value('--taskFile'), 'utf8');
const config = JSON.parse(await fs.readFile(value('--config'), 'utf8'));
const nativeRoot = path.join(home, '.ala', 'sessions');
const nativeFile = path.join(nativeRoot, `${id}.json`);
await fs.mkdir(nativeRoot, { recursive: true, mode: 0o700 });
const native = args.includes('--resume-session') ? JSON.parse(await fs.readFile(nativeFile, 'utf8'))
    : { version: 1, id, home, workspace: cwd, agent: backend, continuation: { threadId: 'fixture-thread' } };
await fs.writeFile(nativeFile, JSON.stringify(native), { mode: 0o600 });
const emit = (event) => {
    const line = `@@ALA_EVENT@@${JSON.stringify(event)}\n`;
    process.stderr.write(line.slice(0, 9));
    process.stderr.write(line.slice(9));
};
process.on('SIGINT', () => process.exit(130));
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
    const output = JSON.stringify({ prompt, skill: args.includes('--skill') ? value('--skill') : null, choice, resumed: args.includes('--resume-session'), config,
        repositories: process.env.ALA_TASK_REPOSITORIES, model: args.includes('--model') ? value('--model') : null,
        credential: process.env.PLOINKY_AGENT_SECRET || process.env.SSO_ACCESS_TOKEN || null,
        privatePrompt: !args.some((arg) => arg.includes('PRIVATE_USER_PROMPT')) });
    if (prompt.includes('QUEUED_FOLLOWUP')) {
        emit({ type: 'message-accepted', id: 'queued-input', delivery: 'queued' });
        emit({ type: 'coding-agent-final', agent: backend, message: 'Initial result before queued follow-up' });
    }
    emit({ type: 'coding-agent-final', agent: backend, message: output });
    if (prompt.includes('NONZERO')) { process.stderr.write('Native provider failed.\n'); process.exitCode = 7; }
    process.stdout.write(`${output}\n`);
    process.stdin.destroy();
}
