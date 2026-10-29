#!/usr/bin/env node
// G1 harness driver (plan g4-apparatus-target-plan, "Harness interface and evidence record").
//
//   harness.mjs identity  --run <12hex> --stage S0 --out <dir> --inputs <base64url JSON>
//   harness.mjs probe <ID> --run <12hex> --stage S0 --out <dir> [--clock <b64>] [--sentinel <b64>] [--stdin]
//   harness.mjs selfcheck --manifest <file> [--binding <file>] [--post --run <12hex>]
//
// probe: exit 0 means a record was written, whatever its verdict; exit 2 means a harness error (a NOT-RUN record is
// written when the identity is readable). Records and identity.json are created exclusively and never overwritten.
// selfcheck: exit 0 when every check holds, exit 2 otherwise (the operator tool then records the probe NOT-RUN).
// Stage 0 runs on I-0 (no keeper, no /opt/robo-work): the harness is delivered through the fixture directory and
// checked against its frozen manifest; the production-module binding (R1.6) applies from S1 and is empty at S0.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createScanner } from './lib/procScan.mjs';
import { buildRecord, canonicalJson, sha256, writeRecord } from './lib/record.mjs';
import { PROBES, STAGE_REQUIRED } from './probes/index.mjs';

const RUN_ID = /^[0-9a-f]{12}$/;
const here = path.dirname(fileURLToPath(import.meta.url));

export class HarnessError extends Error {}

export function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = { _: [] };
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === '--stdin' || arg === '--post') options[arg.slice(2)] = true;
        else if (arg.startsWith('--')) {
            if (i + 1 >= rest.length) throw new HarnessError(`option ${arg} needs a value`);
            options[arg.slice(2)] = rest[i += 1];
        } else options._.push(arg);
    }
    return { command, options };
}

function decodeJsonOption(value, name) {
    if (value === undefined) return null;
    try {
        return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw new HarnessError(`--${name} is not base64url JSON`);
    }
}

function requireRun(options) {
    if (!RUN_ID.test(options.run ?? '')) throw new HarnessError('--run must be 12 lowercase hex digits');
    return options.run;
}

function requireStage(options) {
    if (!Object.hasOwn(STAGE_REQUIRED, options.stage ?? '')) throw new HarnessError(`unknown stage ${options.stage}`);
    return options.stage;
}

function requireOut(options) {
    if (typeof options.out !== 'string' || !path.isAbsolute(options.out)) throw new HarnessError('--out must be an absolute path');
    return options.out;
}

function fileSha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function writeIdentity({ run, stage, out, inputs, now = new Date() }) {
    let execHash = null;
    try {
        execHash = fileSha256(process.execPath);
    } catch (error) {
        execHash = `unreadable: ${error.code}`;
    }
    const identity = {
        schema: 'robo-work-g1-identity/1',
        runId: run,
        stage,
        createdAt: now.toISOString(),
        node: { execPath: process.execPath, version: process.version, versions: process.versions, execSha256: execHash },
        platform: `${process.platform}-${process.arch}`,
        kernel: os.release(),
        // Stage 0 records the Node it finds; a QUALIFYING run needs I-1 and the M-8 reference hash (S1 and later).
        qualification: stage === 'S0' ? 'NON-QUALIFYING (Stage 0 records the I-0 Node only)' : 'evaluated per stage',
        provisionalBounds: inputs?.provisionalBounds ?? {},
        inputs: inputs ?? {},
    };
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const bytes = canonicalJson(identity);
    fs.writeFileSync(path.join(out, 'identity.json'), bytes, { flag: 'wx', mode: 0o600 });
    return sha256(bytes);
}

function readIdentitySha(out) {
    const file = path.join(out, 'identity.json');
    if (!fs.existsSync(file)) throw new HarnessError(`identity.json missing in ${out}`);
    return fileSha256(file);
}

export async function runProbe({ probeId, run, stage, out, clock, sentinel, stdinJson, procRoot = '/proc', now = () => new Date() }) {
    if (!STAGE_REQUIRED[stage].includes(probeId)) throw new HarnessError(`${probeId} is not a ${stage} probe`);
    const probe = PROBES[probeId];
    const identitySha = readIdentitySha(out);
    const base = {
        probeId,
        planRefs: probe.planRefs,
        rows: probe.rows,
        stage,
        candidateIdentitySha256: identitySha,
        command: `harness.mjs probe ${probeId} --run ${run} --stage ${stage}`,
        startedAt: now().toISOString(),
        expected: probe.expected,
    };
    let record;
    try {
        const result = await probe.collect({ runId: run, marker: `g4rw-${run}`, stage, procRoot, clock, sentinel, stdinJson });
        record = buildRecord({ ...base, ...result }, probe.grade);
    } catch (error) {
        record = buildRecord({ ...base, harnessError: error.stack ?? String(error) }, probe.grade);
    }
    const written = writeRecord(out, record);
    return { record, written };
}

// The staged harness tree must equal its frozen manifest: every listed file matches and no unlisted code file exists.
export function checkManifest(manifestFile) {
    const problems = [];
    const root = path.dirname(manifestFile);
    const listed = new Map();
    for (const line of fs.readFileSync(manifestFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const match = /^([0-9a-f]{64}) {2}(?:\.\/)?(.+)$/.exec(line);
        if (!match || match[2].includes('..') || path.isAbsolute(match[2])) {
            problems.push(`malformed manifest line: ${line}`);
            continue;
        }
        listed.set(match[2], match[1]);
    }
    for (const [rel, expectedSha] of listed) {
        const file = path.join(root, rel);
        let actual = null;
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile()) problems.push(`${rel}: not a regular file`);
            else actual = fileSha256(file);
        } catch (error) {
            problems.push(`${rel}: ${error.code}`);
        }
        if (actual !== null && actual !== expectedSha) problems.push(`${rel}: sha256 ${actual} != manifest ${expectedSha}`);
    }
    (function walk(dir, relDir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else if (rel !== path.basename(manifestFile) && !listed.has(rel)) problems.push(`${rel}: not in the manifest`);
        }
    })(root, '');
    return { ok: problems.length === 0 && listed.size > 0, files: listed.size, problems };
}

// R1.6 binding: each production module resolves under the allowed prefix and hashes to its frozen manifest line.
// `binding` = { allowedPrefix, modules: [{ specifier, manifest, manifestPath }] }. Stage 0 passes no binding.
export function checkBinding(binding, { resolve = (specifier) => fileURLToPath(import.meta.resolve(specifier)) } = {}) {
    const problems = [];
    const results = [];
    const prefix = binding.allowedPrefix;
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) problems.push('allowedPrefix must end with /');
    const manifests = new Map();
    for (const module of binding.modules ?? []) {
        let file;
        try {
            file = resolve(module.specifier);
        } catch (error) {
            problems.push(`${module.specifier}: does not resolve (${error.message})`);
            continue;
        }
        const real = fs.realpathSync(file);
        if (!real.startsWith(prefix)) problems.push(`${module.specifier}: resolves to ${real}, outside ${prefix}`);
        if (!manifests.has(module.manifest)) {
            const lines = new Map();
            for (const line of fs.readFileSync(module.manifest, 'utf8').split('\n')) {
                const match = /^([0-9a-f]{64}) {2}(?:\.\/)?(.+)$/.exec(line);
                if (match) lines.set(match[2], match[1]);
            }
            manifests.set(module.manifest, lines);
        }
        const expectedSha = manifests.get(module.manifest).get(module.manifestPath);
        const actual = fileSha256(real);
        if (!expectedSha) problems.push(`${module.specifier}: ${module.manifestPath} not in ${module.manifest}`);
        else if (actual !== expectedSha) problems.push(`${module.specifier}: sha256 ${actual} != frozen ${expectedSha}`);
        results.push({ specifier: module.specifier, file: real, sha256: actual });
    }
    return { ok: problems.length === 0, modules: results, problems };
}

function ancestors(scanner, pid) {
    const chain = [];
    let current = pid;
    for (let depth = 0; depth < 64 && current > 1; depth += 1) {
        chain.push(current);
        const status = scanner.status(current);
        const parent = status ? Number(status.fields.PPid) : 0;
        if (!Number.isInteger(parent) || parent <= 0) break;
        current = parent;
    }
    return chain;
}

// Post-condition: no process outside this selfcheck's own chain carries the run marker, and no task file remains in
// the runtime-root candidates.
export function checkPost({ run, procRoot = '/proc', selfPid = process.pid, roots = ['/tmp', '/dev/shm', '/run'] }) {
    const scanner = createScanner({ procRoot });
    const marker = `g4rw-${run}`;
    const exclude = ancestors(scanner, selfPid);
    const survivors = scanner.markerScan(marker, { exclude });
    const leftovers = [];
    for (const root of roots) {
        let names = [];
        try { names = fs.readdirSync(root); } catch { continue; }
        for (const name of names) if (name.startsWith(marker)) leftovers.push(path.join(root, name));
    }
    const problems = [];
    if (survivors.length) problems.push(`processes with ${marker}: ${survivors.map((entry) => entry.pid).join(', ')}`);
    if (leftovers.length) problems.push(`leftover task files: ${leftovers.join(', ')}`);
    if (scanner.unreadable.length) problems.push(`unreadable: ${scanner.unreadable.map((entry) => entry.path).join(', ')}`);
    return { ok: problems.length === 0, survivors, leftovers, unreadable: scanner.unreadable, problems };
}

async function readStdinJson() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HarnessError('stdin is not JSON');
    }
}

export async function main(argv) {
    const { command, options } = parseArgs(argv);
    if (command === 'identity') {
        const sha = writeIdentity({ run: requireRun(options), stage: requireStage(options), out: requireOut(options), inputs: decodeJsonOption(options.inputs, 'inputs') });
        process.stdout.write(`${JSON.stringify({ identitySha256: sha })}\n`);
        return 0;
    }
    if (command === 'probe') {
        const probeId = options._[0];
        if (!Object.hasOwn(PROBES, probeId ?? '')) throw new HarnessError(`unknown probe ${probeId}`);
        const stdinJson = options.stdin ? await readStdinJson() : null;
        const { record, written } = await runProbe({
            probeId, run: requireRun(options), stage: requireStage(options), out: requireOut(options),
            clock: decodeJsonOption(options.clock, 'clock'), sentinel: decodeJsonOption(options.sentinel, 'sentinel'), stdinJson,
        });
        process.stdout.write(`${JSON.stringify({ probeId, verdict: record.verdict, reasons: record.verdictReasons, sha256: written.sha256 })}\n`);
        return record.verdict === 'NOT-RUN' ? 2 : 0;
    }
    if (command === 'selfcheck') {
        if (typeof options.manifest !== 'string') throw new HarnessError('--manifest is required');
        const report = { manifest: checkManifest(options.manifest) };
        if (options.binding) report.binding = checkBinding(JSON.parse(fs.readFileSync(options.binding, 'utf8')));
        if (options.post) report.post = checkPost({ run: requireRun(options) });
        const ok = Object.values(report).every((part) => part.ok);
        process.stdout.write(`${JSON.stringify({ ok, ...report })}\n`);
        return ok ? 0 : 2;
    }
    throw new HarnessError('usage: harness.mjs identity|probe <ID>|selfcheck …');
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`harness: ${error instanceof HarnessError ? error.message : error.stack}\n`);
        process.exitCode = 2;
    });
}
export { here as harnessDir };
