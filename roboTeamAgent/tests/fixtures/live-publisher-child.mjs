import readline from 'node:readline';
import { LivePublisher } from '../../copilot/src/lib/liveSessions/publisher.mjs';
import { webchatSignedArgs } from '../../copilot/src/lib/webchat/webchatEnvelope.mjs';

// A copilot-like process for the cross-process test. It receives a Router
// envelope on stdin, claims its owner with the raw signed values, publishes a
// turn and a delegated task, and reports every control it receives on stdout.
const [socketPath] = process.argv.slice(2);
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const publisher = new LivePublisher({ socketPath, log: (event, fields) => report({ log: event, ...fields }) });
const lines = readline.createInterface({ input: process.stdin });
let turn = null;
let task = null;
const finish = async () => {
    await publisher.close();
    report({ closed: true });
    lines.close();
};
lines.on('line', (line) => {
    const command = JSON.parse(line);
    if (command.op === 'publish') {
        const parsed = JSON.parse(command.envelope);
        const owner = publisher.claimOwner(parsed.invocation?.token, webchatSignedArgs(parsed));
        turn = publisher.startRun({ kind: 'copilot-turn', title: 'Copilot · cross-process', cwd: '/workspace/project', robot: 'default', owner,
            transcriptUrl: command.transcriptUrl,
            onControl: ({ action, message, requestId }) => {
                report({ control: action, message, requestId: typeof requestId === 'string' });
                if (action === 'stop') {
                    turn.end({ status: 'stopped', reason: 'stopped' });
                    void finish();
                }
                return 'delivered';
            } });
        task = publisher.startRun({ kind: 'copilot-task', title: 'Delegated task · cross-process', cwd: '/workspace/project', robot: 'default', owner,
            onControl: ({ action }) => {
                report({ taskControl: action });
                task.end({ status: 'stopped', reason: 'stopped' });
                return 'delivered';
            } });
        turn.output('hello from the copilot process\n', 'assistant');
        task.status('Delegated to otherAgent · long_job');
        publisher.releaseOwner(owner);
        report({ published: true });
    }
});
