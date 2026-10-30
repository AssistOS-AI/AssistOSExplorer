#!/usr/bin/env node
// OPERATOR-ONLY tool (P6a). Installs one proof-fixture qualification record into the worker-owned qualification store,
// after the operator verified the G7 package and its review (erratum A10: the record's g7EvidenceDigest binds the
// authorized pre-run G7 package digest, independentVerificationDigest its review digest) and after the target helper
// started, so the observed containerId and helperIncarnation can be bound. It installs no production record, reads no
// environment variable, and nothing imports it. Run it as the worker uid, never from a target, robot or project path.
//
//   node install-fixture-record.mjs --store-root <abs> --record-file <abs> --ref <Repo/agent>
//        --container-id <64 hex> --helper-incarnation <id> [--forbidden-root <abs>]... [--replace] [--create]
import fs from 'node:fs';
import path from 'node:path';
import { parseCanonicalTargetJson } from '../server/executionTarget/contract.mjs';
import { createQualificationStore } from '../server/executionTarget/qualificationStore.mjs';

const RECORD_FILE_BYTES = 1 << 20;

// Programmatic form, used by the tests. Returns {ok: true, value: {ref, recordDigest}} or {ok: false, error: {code}}.
export function installFixtureRecord({ fs: fsApi, uid, storeRoot, forbiddenRoots = [], create = false, ref, recordText, expectedLive, replace = false }) {
    const opened = createQualificationStore({ fs: fsApi, root: storeRoot, uid, forbiddenRoots, create });
    if (!opened.ok) return opened;
    const parsed = parseCanonicalTargetJson(recordText, { maxBytes: RECORD_FILE_BYTES });
    if (!parsed.ok) return { ok: false, error: { code: 'record_invalid' } };
    return opened.value.install({ ref, record: parsed.value, expectedLive, allowedClasses: ['proof-fixture'], replace });
}

function parseArguments(argv) {
    const options = { forbiddenRoots: [], replace: false, create: false };
    const valued = { '--store-root': 'storeRoot', '--record-file': 'recordFile', '--ref': 'ref', '--container-id': 'containerId', '--helper-incarnation': 'helperIncarnation' };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--replace') options.replace = true;
        else if (flag === '--create') options.create = true;
        else if (flag === '--forbidden-root' && index + 1 < argv.length) options.forbiddenRoots.push(argv[++index]);
        else if (Object.hasOwn(valued, flag) && index + 1 < argv.length) options[valued[flag]] = argv[++index];
        else return null;
    }
    return ['storeRoot', 'recordFile', 'ref', 'containerId', 'helperIncarnation'].every((key) => typeof options[key] === 'string') ? options : null;
}

function main(argv) {
    const options = parseArguments(argv);
    if (options === null || !path.isAbsolute(options.recordFile)) {
        process.stderr.write('usage: install-fixture-record.mjs --store-root <abs> --record-file <abs> --ref <Repo/agent> --container-id <id> --helper-incarnation <id> [--forbidden-root <abs>]... [--replace] [--create]\n');
        return 2;
    }
    let recordText;
    try {
        const stat = fs.lstatSync(options.recordFile);
        if (!stat.isFile() || stat.size > RECORD_FILE_BYTES) throw new Error('not a bounded regular file');
        recordText = fs.readFileSync(options.recordFile);
    } catch {
        process.stderr.write('refused: record file unreadable\n');
        return 1;
    }
    const result = installFixtureRecord({
        fs, uid: process.getuid(), storeRoot: options.storeRoot, forbiddenRoots: options.forbiddenRoots, create: options.create,
        ref: options.ref, recordText, expectedLive: { containerId: options.containerId, helperIncarnation: options.helperIncarnation }, replace: options.replace
    });
    if (!result.ok) {
        process.stderr.write(`refused: ${result.error.code}\n`);
        return 1;
    }
    process.stdout.write(`installed ${result.value.ref} ${result.value.recordDigest}\n`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) process.exitCode = main(process.argv.slice(2));
