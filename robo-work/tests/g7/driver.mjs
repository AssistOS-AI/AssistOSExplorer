#!/usr/bin/env node
// G7 proof-fixture scenario driver (slice P7: authenticated target admission end to end).
//
// A pure orchestrator: it imports no fixture or worker module and holds no authority. Every step runs a command named
// by the run configuration (the coordinator CLI inside the coordinator agent container, the same CLI inside an
// undeclared agent container, the read-only observation of the worker's count and admission records, and the operator
// commands that install a base-facts variant in the worker). It compares each answer with the expected outcome, checks
// that every refusal leaves the observation unchanged (no count, no admission record and, in a live configuration, no
// container or helper-journal change), and writes one result file. Exit 0 only when every case matched.
//
//   node driver.mjs p7 --config <run.json> --out <new dir>
//
// run.json:
//   environment        "live" (task Box, Ploinky private Router) or "local" (LOCAL Router stand-in; never live evidence)
//   provider           {route, port}: the worker's route key and declared coordinator-route port
//   coordinator        {command: [argv...], args: [argv...]}: runs the rwcoord coordinator CLI as the declared coordinator
//   rogue              {command, args}: the same CLI as an agent that is not a declared coordinator
//   observe            [argv...]: prints one JSON line (count, admissions, leftover intents, and in live runs containers and journal)
//   facts              {base, unprepared, noSourceUnprepared, ploinkySource}: [argv...] installing each base-facts variant
//   selections         {target, worker, roboteam, staleWorkerAlias, coordinator, shadow, unknown}
//   admissibleOrigins  [Id, Id]: origins whose derived operation IDs the installed record lists (operator plan)
//   expectedCallerDenial  the Router's code for an undeclared coordinator (default COORDINATOR_CALLER_DENIED)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STEP_TIMEOUT_MS = 60_000;

function run(argv, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === 'string')) {
            resolve({ code: null, stdout: '', stderr: 'invalid command', timedOut: false });
            return;
        }
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', (chunk) => { if (stdout.length < 1 << 20) stdout += chunk; });
        child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
        child.on('error', (error) => { stderr += String(error.message); });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr: stderr.slice(0, 4000), timedOut });
        });
    });
}

function lastJsonLine(text) {
    const lines = String(text).trim().split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            return JSON.parse(lines[index]);
        } catch {
            // not JSON, keep looking
        }
    }
    return null;
}

function freshOrigin() {
    return crypto.randomBytes(16).toString('base64url');
}

// The P7 scenario. `who`: coordinator or rogue. `expect`: {admitted, replayed, usedDelta} for an admission,
// {code} for a front refusal, {routerStatus, routerCode} for a Router refusal. `facts`: the variant installed first.
export function p7Cases(config) {
    const s = config.selections;
    const [first, second] = config.admissibleOrigins;
    const denial = config.expectedCallerDenial ?? 'COORDINATOR_CALLER_DENIED';
    return [
        { id: 'P7-01', oracle: 'A42 actual-instance admission; A10 activation', title: 'declared coordinator admits the qualified, source-protected target', facts: 'base', who: 'coordinator', selection: s.target, origin: first, expect: { admitted: true, replayed: false, usedDelta: 1 } },
        { id: 'P7-02', oracle: 'idempotent admission', title: 'retry of the same origin returns the recorded admission without counting', who: 'coordinator', selection: s.target, origin: first, expect: { admitted: true, replayed: true, usedDelta: 0 } },
        { id: 'P7-03', oracle: 'operation conflict', title: 'another body under the same origin conflicts', who: 'coordinator', selection: s.unknown, origin: first, expect: { code: 'operation_conflict' } },
        { id: 'P7-04', oracle: 'A35(1) forged/undeclared principal', title: 'an agent that is not a declared coordinator is refused by the Router', who: 'rogue', selection: s.target, origin: second, expect: { routerStatus: 403, routerCode: denial } },
        { id: 'P7-05', oracle: 'A42 owning worker excluded', title: 'owning worker by canonical principal', who: 'coordinator', selection: s.worker, origin: freshOrigin(), expect: { code: 'target_excluded' } },
        { id: 'P7-06', oracle: 'T0 §3 RoboTeam excluded', title: 'RoboTeam by canonical principal (unresolved)', who: 'coordinator', selection: s.roboteam, origin: freshOrigin(), expect: { code: 'target_excluded' } },
        { id: 'P7-07', oracle: 'A42 stale selection', title: 'stale saved worker spelling', who: 'coordinator', selection: s.staleWorkerAlias, origin: freshOrigin(), expect: { code: 'target_excluded' } },
        { id: 'P7-08', oracle: 'RoboTeam stand-in', title: 'the calling coordinator itself', who: 'coordinator', selection: s.coordinator, origin: freshOrigin(), expect: { code: 'target_excluded' } },
        { id: 'P7-09', oracle: 'A42 replacement/alias by runtime identity', title: 'an entry resolving to the worker runtime instance', who: 'coordinator', selection: s.shadow, origin: freshOrigin(), expect: { code: 'target_excluded' } },
        { id: 'P7-10', oracle: 'A50 missing selected target', title: 'unknown target', who: 'coordinator', selection: s.unknown, origin: freshOrigin(), expect: { code: 'target_missing' } },
        { id: 'P7-11', oracle: 'T0 §3 terminal-only', title: 'non-terminal Environment surface', who: 'coordinator', selection: s.target, surface: 'browser', origin: freshOrigin(), expect: { code: 'environment_not_terminal' } },
        { id: 'P7-12', oracle: 'T0 §3 malformed selection', title: 'malformed selection', who: 'coordinator', selection: 'not a ref', origin: freshOrigin(), expect: { code: 'invalid_selection' } },
        { id: 'P7-13', oracle: 'A10 operation scope', title: 'origin whose operation the record does not list', who: 'coordinator', selection: s.target, origin: freshOrigin(), expect: { code: 'qualification_scope' } },
        { id: 'P7-14', oracle: 'A50 missing preparation', title: 'unprepared target', facts: 'unprepared', who: 'coordinator', selection: s.target, origin: freshOrigin(), expect: { code: 'target_unprepared' } },
        { id: 'P7-15', oracle: 'A1.7 precedence 8 before 9', title: 'no source record and unprepared: source protection wins', facts: 'noSourceUnprepared', who: 'coordinator', selection: s.target, origin: freshOrigin(), expect: { code: 'source_unavailable' } },
        { id: 'P7-16', oracle: 'A50 source protection', title: 'record from Ploinky source protection (no protected record exists)', facts: 'ploinkySource', who: 'coordinator', selection: s.target, origin: second, expect: { code: 'source_unavailable' } },
        { id: 'P7-17', oracle: 'no cached decision', title: 'base facts restored: the second admissible origin admits', facts: 'base', who: 'coordinator', selection: s.target, origin: second, expect: { admitted: true, replayed: false, usedDelta: 1 } }
    ];
}

function invocation(config, testCase) {
    const side = config[testCase.who];
    return [...side.command, 'admit', '--provider', config.provider.route, '--port', String(config.provider.port), '--selection', testCase.selection,
        '--origin-request-id', testCase.origin, ...(testCase.surface ? ['--surface', testCase.surface] : []), ...(side.args ?? [])];
}

function judge(testCase, outcome, before, after) {
    const reasons = [];
    const line = outcome.line;
    const expect = testCase.expect;
    if (expect.admitted) {
        if (outcome.code !== 0 || line?.status !== 200 || line?.answer?.ok !== true) reasons.push('not admitted');
        if (line?.answer?.replayed !== expect.replayed) reasons.push(`replayed ${line?.answer?.replayed}`);
        const used = (value) => (Number.isSafeInteger(value?.executionsUsed) ? value.executionsUsed : null);
        if (used(before) === null || used(after) === null || used(after) - used(before) !== expect.usedDelta) reasons.push(`count delta ${used(after)} - ${used(before)}`);
        if (expect.usedDelta === 0 && JSON.stringify(after) !== JSON.stringify(before)) reasons.push('observation changed on a replay');
    } else {
        if (outcome.code !== 3) reasons.push(`exit ${outcome.code}`);
        if (expect.code !== undefined && (line?.answer?.ok !== false || line?.answer?.code !== expect.code)) reasons.push(`code ${line?.answer?.code ?? 'none'}`);
        if (expect.routerStatus !== undefined && (line?.status !== expect.routerStatus || !JSON.stringify(line?.answer ?? null).includes(expect.routerCode))) {
            reasons.push(`router answer ${line?.status} ${JSON.stringify(line?.answer ?? null).slice(0, 200)}`);
        }
        if (JSON.stringify(after) !== JSON.stringify(before)) reasons.push('observation changed on a refusal');
    }
    if (before === null || after === null) reasons.push('observation unavailable');
    return reasons;
}

export async function runP7(config, { log = () => {} } = {}) {
    for (const key of ['provider', 'coordinator', 'rogue', 'observe', 'facts', 'selections', 'admissibleOrigins']) {
        if (config[key] === undefined) throw new Error(`run configuration lacks ${key}`);
    }
    if (!['live', 'local'].includes(config.environment)) throw new Error('environment must be live or local');
    if (!Array.isArray(config.admissibleOrigins) || config.admissibleOrigins.length < 2) throw new Error('two admissible origins are required');
    // A live run never goes through the LOCAL Router stand-in.
    if (config.environment === 'live' && [config.coordinator, config.rogue].some((side) => [...(side.command ?? []), ...(side.args ?? [])]
        .some((item) => typeof item === 'string' && /--local-(router|caller)|localRouter/.test(item)))) {
        throw new Error('a live run must not name the LOCAL Router stand-in');
    }
    const results = [];
    for (const testCase of p7Cases(config)) {
        let factsOutcome = null;
        if (testCase.facts) {
            factsOutcome = await run(config.facts[testCase.facts]);
            if (factsOutcome.code !== 0) {
                results.push({ ...testCase, pass: false, reasons: [`facts variant ${testCase.facts} not installed`], factsStderr: factsOutcome.stderr });
                continue;
            }
        }
        const before = lastJsonLine((await run(config.observe)).stdout);
        const outcome = await run(invocation(config, testCase));
        const line = lastJsonLine(outcome.stdout);
        const after = lastJsonLine((await run(config.observe)).stdout);
        const reasons = judge(testCase, { code: outcome.code, line }, before, after);
        // Every live answer must have travelled through Ploinky's private Router.
        if (config.environment === 'live' && line?.transport !== 'ploinky-private-router') reasons.push(`transport ${line?.transport ?? 'none'}`);
        const entry = {
            id: testCase.id, oracle: testCase.oracle, title: testCase.title, facts: testCase.facts ?? null, who: testCase.who, selection: testCase.selection,
            surface: testCase.surface ?? 'terminal', origin: testCase.origin, expect: testCase.expect, exit: outcome.code, timedOut: outcome.timedOut, answer: line,
            stderr: outcome.code === 0 || outcome.code === 3 ? undefined : outcome.stderr, observationBefore: before, observationAfter: after,
            pass: reasons.length === 0, reasons
        };
        results.push(entry);
        log(entry);
    }
    // Leave the worker on the base facts whatever happened.
    await run(config.facts.base);
    const passed = results.filter((entry) => entry.pass).length;
    return { scenario: 'p7', environment: config.environment, label: config.label ?? null, cases: results.length, passed, failed: results.length - passed, results };
}

async function main(argv) {
    const [scenario, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 2) options[rest[index]] = rest[index + 1];
    if (scenario !== 'p7' || typeof options['--config'] !== 'string' || typeof options['--out'] !== 'string') {
        throw new Error('usage: driver.mjs p7 --config <run.json> --out <new dir>');
    }
    const config = JSON.parse(fs.readFileSync(options['--config'], 'utf8'));
    const out = path.resolve(options['--out']);
    fs.mkdirSync(out, { mode: 0o700 });
    const report = await runP7(config, { log: (entry) => process.stdout.write(`${entry.pass ? 'PASS' : 'FAIL'} ${entry.id} ${entry.title}${entry.pass ? '' : ` (${entry.reasons.join('; ')})`}\n`) });
    report.config = config;
    fs.writeFileSync(path.join(out, 'p7-results.json'), `${JSON.stringify(report, null, 1)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ scenario: report.scenario, environment: report.environment, cases: report.cases, passed: report.passed, failed: report.failed })}\n`);
    return report.failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`driver: ${String(error.message).slice(0, 300)}\n`);
        process.exitCode = 2;
    });
}
