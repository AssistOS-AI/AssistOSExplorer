// Generates the journal differential vector from the Node oracle (robo-work/server/executionTarget/journalModel.mjs,
// imported read-only). SYNTHETIC identities only. Usage:
//   node gen-journal-differential.mjs <robo-work-dir> <output.json>
// The Rust test (tests/journal_differential.rs) replays every step against the file-backed journal and compares each
// result, the effects it produced and the journal size. robo-work/tests/executionTarget/journalDifferentialVector.test.mjs
// regenerates the vector and requires the committed file to be byte-identical.
//
// Excluded on purpose (documented differences, native tests cover them): a retried prepare of a stopped record that
// was never created; a refused input that opens a new cursor; non-object stop/release entries (the model throws).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Provenance only: the oracle module and its receipt helper. Behavioral drift anywhere (including contract.mjs and
// limits.mjs) changes the regenerated results, which the drift test compares byte for byte.
const MODULES = ['journalModel.mjs', 'receipts.mjs'];
const DAY7 = 604800000;

export async function buildVector(roboWork) {
    const moduleUrl = (name) => pathToFileURL(path.join(roboWork, 'server/executionTarget', name)).href;
    const { createTargetJournalModel } = await import(moduleUrl('journalModel.mjs'));
    const { targetDigest } = await import(moduleUrl('contract.mjs'));
    const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
    const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
    const sdg = (label) => sha(`synthetic-digest:${label}`);
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const JA = sid('journal-a');
    const JB = sid('journal-b');
    const H1 = sid('helper-1');
    const H2 = sid('helper-2');

    const key = (label) => ({ workspaceId: 'ws-synthetic', workerGeneration: sid('worker-gen'), executionId: sid('exec'), attemptId: sid('attempt'), operationId: sid(`op-${label}`) });
    const prep = (label, overrides = {}) => ({
        key: key(label), targetBindingDigest: sdg('binding'), reservationId: sid('reservation'), requestDigest: sdg(`request-${label}`),
        leaseId: sid(`lease-${label}`), journalStoreIdentity: JA,
        resources: [
            { resourceId: sid(`${label}-tree`), kind: 'process-tree', locatorDigest: sdg(`${label}-tree`) },
            { resourceId: sid(`${label}-gate`), kind: 'gate', locatorDigest: sdg(`${label}-gate`) }
        ],
        ...overrides
    });
    const commitFor = (request, receipt, overrides = {}) => ({
        key: request.key, targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId,
        preparedReceiptSequence: receipt.receiptSequence, preparedResourcesDigest: targetDigest(receipt.resources, { maxBytes: 1 << 20 }).value,
        workerCommitDigest: sdg(`commit-${request.requestDigest}`), ...overrides
    });
    const look = (request) => ({ key: request.key, targetBindingDigest: request.targetBindingDigest });
    const evidence = (request, kinds = {}) => ({
        key: request.key,
        evidence: { resources: request.resources.map((resource) => ({ resourceId: resource.resourceId, kind: kinds[resource.kind] ?? 'verified-absent', evidenceDigest: sdg(`absent-${resource.resourceId}`) })) }
    });
    const input = (request, connection, offset, label, byteLength) => ({ key: request.key, connectionId: sid(connection), offset, bytesDigest: sdg(label), byteLength });

    const scenarios = [];
    function scenario(name, options, script) {
        let clock = 1000;
        const limits = options.limits ?? {};
        const model = createTargetJournalModel({ journalStoreIdentity: JA, helperIncarnation: H1, now: () => clock, limits });
        const steps = [];
        let seen = 0;
        const api = {
            op(op, request) {
                const result = model[op](request);
                const all = model.effects();
                steps.push({ op, request: plain(request), result: plain(result), effects: plain(all.slice(seen)), size: model.size() });
                seen = all.length;
                return result;
            },
            advance(ms) { clock += ms; steps.push({ op: 'advance', ms }); },
            inject(fault) { model.inject(fault); steps.push({ op: 'inject', fault }); },
            loseJournal() { model.loseJournal(); steps.push({ op: 'loseJournal' }); },
            replaceJournal(identity) { model.replaceJournal(identity); steps.push({ op: 'replaceJournal', identity }); },
            recreateHelper(incarnation) { model.recreateHelper(incarnation); steps.push({ op: 'recreateHelper', incarnation }); }
        };
        script(api);
        scenarios.push({ name, options: { journalStoreIdentity: JA, helperIncarnation: H1, clockStart: 1000, limits }, steps });
    }

    scenario('lifecycle, dedupe, input cursors, retirement and tombstones', {}, (t) => {
        const r = prep('life');
        const prepared = t.op('prepare', r).value;
        t.op('prepare', r);
        const commit = commitFor(r, prepared);
        t.op('commit', commit);
        t.op('commit', commit);
        t.op('lookup', look(r));
        t.op('input', input(r, 'conn-1', '0', 'b0', 10));
        t.op('input', input(r, 'conn-1', '10', 'b1', 5));
        t.op('input', input(r, 'conn-1', '0', 'b0', 10));
        t.op('input', input(r, 'conn-1', '0', 'bX', 10));
        t.op('input', input(r, 'conn-1', '10', 'b1', 4));
        t.op('input', input(r, 'conn-1', '20', 'b2', 5));
        t.op('input', input(r, 'conn-2', '0', 'c0', 65536));
        t.op('input', input(r, 'conn-2', '65536', 'c1', 65537));
        t.op('input', input(r, 'conn-2', '65536', 'c1', 0));
        t.op('input', input(r, 'conn-2', '65536', 'c1', '5'));
        t.op('lookup', look(r));
        t.advance(5);
        t.op('stop', { key: r.key });
        t.op('stop', { key: r.key });
        t.op('observeExit', { key: r.key });
        t.op('release', evidence(r));
        t.advance(5);
        t.op('release', evidence(r));
        t.op('retire', { key: r.key, referenced: false });
        t.advance(DAY7);
        t.op('retire', { key: r.key, referenced: true });
        t.op('retire', { key: r.key, referenced: false });
        t.advance(1);
        t.op('lookup', look(r));
        t.op('prepare', r);
        t.op('prepare', { ...r, requestDigest: sdg('other-request') });
        t.op('commit', commit);
        t.op('input', input(r, 'conn-1', '15', 'b3', 1));
        t.op('observeExit', { key: r.key });
        t.op('stop', { key: r.key });
        t.op('release', evidence(r));
        t.op('retire', { key: r.key, referenced: false });
        t.op('lookup', { key: key('never'), targetBindingDigest: sdg('binding') });
    });

    scenario('JRN-02 conflicts and BND-02 binding revalidation', {}, (t) => {
        const r = prep('conf');
        const prepared = t.op('prepare', r).value;
        t.op('prepare', { ...r, requestDigest: sdg('changed-request') });
        t.op('prepare', { ...r, targetBindingDigest: sdg('changed-binding') });
        t.op('prepare', { ...r, reservationId: sid('changed-reservation') });
        t.op('prepare', { ...r, leaseId: sid('changed-lease') });
        const commit = commitFor(r, prepared);
        t.op('commit', { ...commit, targetBindingDigest: sdg('changed-binding') });
        t.op('commit', { ...commit, reservationId: sid('changed-reservation') });
        t.op('commit', { ...commit, workerCommitDigest: 'not-a-digest' });
        t.op('commit', { ...commit, preparedReceiptSequence: prepared.receiptSequence + 1 });
        t.op('commit', { ...commit, preparedResourcesDigest: sdg('wrong-resources') });
        t.op('commit', { ...commit, preparedReceiptSequence: String(prepared.receiptSequence) });
        t.op('commit', commit);
        t.op('commit', { ...commit, workerCommitDigest: sdg('another-commit') });
        t.op('commit', { ...commit, key: key('unknown') });
        t.op('stop', { key: r.key });
        t.op('commit', commit);
        const s = prep('stop-before-commit');
        const sp = t.op('prepare', s).value;
        t.op('stop', { key: s.key });
        t.op('commit', commitFor(s, sp));
        t.op('release', evidence(s));
    });

    scenario('ERR-01 faults: crash before/after durable writes, lost replies and unknown delivery', {}, (t) => {
        const r = prep('fault');
        t.inject('crash-before-durable');
        t.op('prepare', r);
        t.op('lookup', look(r));
        t.inject('crash-after-persist');
        t.op('prepare', r);
        t.op('lookup', look(r));
        const prepared = t.op('prepare', r).value;
        t.inject('crash-after-persist');
        t.op('prepare', r);
        t.op('prepare', r);
        const commit = commitFor(r, prepared);
        t.inject('crash-after-intent');
        t.op('commit', commit);
        t.op('lookup', look(r));
        t.op('commit', commit);
        t.inject('lost-reply');
        t.op('prepare', r);
        t.inject('lost-reply');
        t.op('input', input(r, 'fconn', '0', 'f0', 4));
        t.op('input', input(r, 'fconn', '4', 'f1', 4));
        t.op('lookup', look(r));
        t.op('input', input(r, 'fconn', '0', 'f0', 4));
        t.op('input', input(r, 'fconn', '4', 'f1', 4));
        t.inject('lost-reply');
        t.op('input', input(r, 'fconn', '0', 'f0', 4));
        t.op('input', input(r, 'fconn', '8', 'f2', 4));
        t.inject('lost-reply');
        t.op('stop', { key: r.key });
        t.op('stop', { key: r.key });
        t.inject('crash-after-persist');
        t.op('observeExit', { key: r.key });
        t.inject('crash-before-durable');
        t.op('release', evidence(r));
        t.op('lookup', look(r));
        t.op('release', evidence(r));
        t.inject('lost-reply');
        t.op('lookup', look(r));
        t.advance(DAY7);
        t.op('retire', { key: r.key, referenced: false });
        t.op('retire', { key: r.key, referenced: false });
        t.inject('crash-after-intent');
        const q = prep('fault-q');
        t.op('prepare', q);
        t.op('lookup', look(q));
    });

    scenario('JRN-03 lost and replaced journal: journal_unavailable, never absence; faults wait for an available journal', {}, (t) => {
        const r = prep('loss');
        const prepared = t.op('prepare', r).value;
        const commit = commitFor(r, prepared);
        t.op('commit', commit);
        t.loseJournal();
        t.op('prepare', r);
        t.op('commit', commit);
        t.op('lookup', look(r));
        t.op('input', input(r, 'lconn', '0', 'l0', 1));
        t.op('stop', { key: r.key });
        t.op('observeExit', { key: r.key });
        t.op('release', evidence(r));
        t.op('retire', { key: r.key, referenced: false });
        t.inject('crash-before-durable');
        t.op('prepare', r);
        t.op('lookup', look(r));
        t.replaceJournal(JB);
        t.op('lookup', look(r));
        t.op('prepare', r);
        t.op('prepare', r);
        t.op('commit', commit);
        t.op('stop', { key: r.key });
        const fresh = prep('after-replacement', { journalStoreIdentity: JB });
        t.op('prepare', fresh);
        t.op('lookup', look(r));
        t.op('lookup', look(fresh));
    });

    scenario('JRN-01-b recreating the helper never makes an old key new', {}, (t) => {
        const r = prep('incarnation');
        const prepared = t.op('prepare', r).value;
        t.recreateHelper(H2);
        t.op('prepare', r);
        t.op('commit', commitFor(r, prepared));
        t.op('commit', commitFor(r, prepared));
        const second = prep('incarnation-2');
        t.op('prepare', second);
        t.op('lookup', look(r));
        t.op('lookup', look(second));
    });

    scenario('CAP-01/CAP-02 entry and resource bounds: existing identical work reconciles at capacity', { limits: { journalEntries: 2, resourcesPerOperation: 2 } }, (t) => {
        const three = prep('cap-three');
        three.resources = [...three.resources, { resourceId: sid('cap-three-view'), kind: 'filtered-view', locatorDigest: sdg('cap-three-view') }];
        t.op('prepare', three);
        const a = prep('cap-a');
        const ap = t.op('prepare', a).value;
        t.op('prepare', prep('cap-b'));
        t.op('prepare', prep('cap-c'));
        t.op('prepare', a);
        t.op('lookup', look(prep('cap-c')));
        t.op('commit', commitFor(a, ap));
    });

    scenario('JRN-04 release needs verified absence or quarantine for every recorded resource', {}, (t) => {
        const r = prep('rel');
        const prepared = t.op('prepare', r).value;
        t.op('commit', commitFor(r, prepared));
        t.op('release', evidence(r));
        t.op('stop', { key: r.key });
        t.op('release', evidence(r, { 'process-tree': 'pid' }));
        t.op('release', evidence(r, { gate: 'inspect-404' }));
        t.op('release', evidence(r, { gate: 'name' }));
        t.op('release', { key: r.key, evidence: { resources: evidence(r).evidence.resources.slice(1) } });
        t.op('release', { key: r.key, evidence: { resources: [...evidence(r).evidence.resources, { resourceId: sid('extra'), kind: 'verified-absent', evidenceDigest: sdg('extra') }] } });
        t.op('release', { key: r.key, evidence: { resources: evidence(r).evidence.resources.map((entry) => ({ ...entry, evidenceDigest: 'short' })) } });
        t.op('release', { key: r.key, evidence: { resources: evidence(r).evidence.resources.map((entry) => ({ resourceId: entry.resourceId, kind: entry.kind })) } });
        t.op('release', evidence(r, { gate: 'quarantine' }));
        t.op('lookup', look(r));
        t.op('release', evidence(r));
        t.op('retire', { key: r.key, referenced: false });
        t.advance(DAY7);
        t.op('retire', { key: r.key, referenced: false });
        t.op('lookup', look(r));
        const d = prep('rel-dup');
        const dp = t.op('prepare', d).value;
        t.op('commit', commitFor(d, dp));
        t.op('observeExit', { key: d.key });
        const entries = evidence(d).evidence.resources;
        t.op('release', { key: d.key, evidence: { resources: [{ ...entries[0], kind: 'pid' }, ...entries] } });
        t.op('release', { key: d.key, evidence: { resources: [...entries, { ...entries[0], kind: 'pid' }] } });
    });

    scenario('request validation order and codes', {}, (t) => {
        const r = prep('val');
        t.op('prepare', { ...r, targetBindingDigest: 'x' });
        t.op('prepare', { ...r, leaseId: 'short' });
        t.op('prepare', { ...r, reservationId: sid('ok').slice(0, 21) + '=' });
        t.op('prepare', { ...r, targetBindingDigest: 'x', journalStoreIdentity: JB });
        t.op('prepare', { ...r, journalStoreIdentity: JB });
        t.op('prepare', { ...r, resources: 'nope' });
        t.op('prepare', { ...r, key: { ...r.key, extra: 1 } });
        t.op('prepare', { ...r, key: { ...r.key, operationId: 'bad' } });
        t.op('prepare', { ...r, key: { ...r.key, workspaceId: 'ws x' } });
        t.op('prepare', { ...r, key: { ...r.key, workerGeneration: 'AQEBAQEBAQEBAQEBAQEBAR' } });
        t.op('prepare', { ...r, resources: [r.resources[0], r.resources[0]] });
        t.op('prepare', { ...r, resources: [{ ...r.resources[0], kind: 'container' }] });
        t.op('prepare', { ...r, resources: [{ resourceId: r.resources[0].resourceId, kind: 'gate' }] });
        t.op('prepare', { ...r, resources: [] });
        t.op('commit', null);
        t.op('commit', { key: key('val') });
        t.op('lookup', { key: r.key, targetBindingDigest: 'bad' });
        t.op('lookup', { targetBindingDigest: sdg('binding') });
        t.op('lookup', null);
        t.op('input', input(r, 'vconn', '0', 'v0', 1));
        const live = prep('val-live');
        const lp = t.op('prepare', live).value;
        t.op('input', input(live, 'vconn', '0', 'v0', 1));
        t.op('commit', commitFor(live, lp));
        t.op('input', input(live, 'vconn', '0', 'v0', 1));
        t.op('input', { ...input(live, 'vconn', '1', 'v1', 1), connectionId: 'bad' });
        t.op('input', input(live, 'vconn', '01', 'v1', 1));
        t.op('input', { ...input(live, 'vconn', '1', 'v1', 1), bytesDigest: 'bad' });
        t.op('input', { ...input(live, 'vconn', '1', 'v1', 1), byteLength: -1 });
        t.op('input', input(live, 'vconn', '18446744073709551616', 'v1', 1));
        t.op('release', { key: live.key, evidence: [] });
        t.op('release', { key: live.key, evidence: { resources: 'x' } });
        t.op('release', { key: live.key });
        t.op('retire', { key: live.key, referenced: 'no' });
        t.op('retire', { key: live.key, referenced: false });
        t.op('retire', { key: key('val-unknown'), referenced: false });
        t.op('stop', { key: key('val-unknown') });
        t.op('observeExit', { key: key('val-unknown') });
        t.op('release', { key: key('val-unknown'), evidence: { resources: [] } });
    });

    scenario('a stop for a reserved, never-created operation sends nothing; exits and releases settle it', {}, (t) => {
        const r = prep('reserved-stop');
        t.inject('crash-after-persist');
        t.op('prepare', r);
        t.op('stop', { key: r.key });
        t.op('stop', { key: r.key });
        t.op('observeExit', { key: r.key });
        t.op('release', evidence(r));
        t.op('lookup', look(r));
    });

    scenario('exit before stop: later stop, commit and input do not reopen anything', {}, (t) => {
        const r = prep('exit');
        const prepared = t.op('prepare', r).value;
        const commit = commitFor(r, prepared);
        t.op('commit', commit);
        t.op('observeExit', { key: r.key });
        t.op('observeExit', { key: r.key });
        t.op('stop', { key: r.key });
        t.op('commit', commit);
        t.op('input', input(r, 'xconn', '0', 'x0', 1));
        t.op('release', evidence(r));
        t.op('observeExit', { key: r.key });
    });

    const oracleModules = {};
    for (const name of MODULES) {
        oracleModules[`robo-work/server/executionTarget/${name}`] = sha(fs.readFileSync(path.join(roboWork, 'server/executionTarget', name)));
    }
    return {
        version: 1,
        classification: 'PUBLIC SYNTHETIC TEST MATERIAL generated from the journal oracle; regenerate, never hand-edit',
        generator: 'robo-work/native/crates/target-helper/tests/vectors/gen-journal-differential.mjs',
        oracleModules,
        scenarios
    };
}

export function renderVector(vector) {
    return `${JSON.stringify(vector, null, 1)}\n`;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    const [roboWork, output] = process.argv.slice(2);
    if (!roboWork || !output) {
        console.error('usage: node gen-journal-differential.mjs <robo-work-dir> <output.json>');
        process.exit(64);
    }
    fs.writeFileSync(output, renderVector(await buildVector(path.resolve(roboWork))));
}
