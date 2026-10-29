// A well-behaved ALA used as the "second execution" while a hostile one is attacking its own endpoint: it keeps asking
// for the inventory for a fixed time and reports whether every answer arrived.
//   node alaLoop.mjs <rounds> <interval_ms>
const [, , roundsText, intervalText] = process.argv;
const rounds = Number(roundsText);
const interval = Number(intervalText);
const result = { rounds, answered: 0, failure: null };
const waiting = new Map();
process.on('message', (message) => {
    if (message.type === 'failure') { result.failure = message.error?.message ?? 'failure'; return; }
    if (message.type === 'result') { waiting.get(message.id)?.(message); waiting.delete(message.id); }
});
await new Promise((resolve) => { process.send({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] }, resolve); });
for (let id = 1; id <= rounds && result.failure === null && process.connected; id += 1) {
    const answer = new Promise((resolve) => { waiting.set(id, resolve); setTimeout(() => resolve(null), 3000); });
    process.send({ type: 'inventory', id });
    if (await answer) result.answered += 1;
    await new Promise((resolve) => setTimeout(resolve, interval));
}
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
