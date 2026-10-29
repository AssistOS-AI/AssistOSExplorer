import path from 'node:path';
import crypto from 'node:crypto';
import {
    canonicalText, digestOf, failure, isDigest, isOperationId, isRef, parseCanonicalTargetJson, success, validateQualificationRecord
} from './contract.mjs';

// Worker-owned qualification store: the eligibility trust anchor of the existing-agent terminal feature (plan section 5.6,
// erratum A10 for the proof-fixture bootstrap record).
//
// Authority model:
//   - Records are written only by trusted management: the operator tool (`tests/g7/tools/install-fixture-record.mjs`) or a
//     later reviewed production installer, after independent verification and after the helper started (the record binds
//     the exact containerId and helperIncarnation, which exist only then). A robot, project or target declaration has no
//     write path: the store is a private directory of the worker (mode 0700, files 0600, owned by the worker uid), is
//     refused when it lies inside any forbidden root (robot HOMEs, project grants, target-visible mounts), and is never
//     reachable through a descriptor, route or environment variable.
//   - Nothing is cached: every read re-opens the file without following links, re-checks owner and mode, re-parses the
//     canonical text, recomputes the digest and re-validates the record. A file that fails any step is treated as absent.
//   - The filesystem is injected, so this module imports no I/O module. `fs` must provide the synchronous API used below.
//
// File layout under `root`:
//   records/<sha256(ref)>.json    canonical {version, ref, recordDigest, record}
//   counters/<sha256(ref)>.json   canonical {version, ref, recordDigest, operationIds[]} (proof-fixture executions)

export const QUALIFICATION_STORE_ERROR_CODES = Object.freeze([
    'invalid_request', 'store_unsafe', 'record_invalid', 'class_not_allowed', 'scope_mismatch', 'exists', 'not_found',
    'capacity_exceeded', 'io_error'
]);

const RECORD_BYTES = 1 << 20;
const COUNTER_BYTES = 64 * 1024;
const MAX_RECORDS = 256;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

class StoreRefusal extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function need(condition, code) {
    if (!condition) throw new StoreRefusal(code);
}

function refName(ref) {
    return crypto.createHash('sha256').update(ref, 'utf8').digest('hex');
}

function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function run(check) {
    try {
        return success(check());
    } catch (error) {
        return failure(error instanceof StoreRefusal ? error.code : 'io_error');
    }
}

// `fs`: injected synchronous file API (the operator tool and the worker pass node:fs). `uid`: the worker's numeric uid.
// `forbiddenRoots`: absolute paths of every robot HOME, project root and target-visible mount root; the store root must not
// be inside one of them (and is compared by real path). `create`: create a missing root and subdirectories (0700).
export function createQualificationStore({ fs, root, uid, forbiddenRoots = [], create = false } = {}) {
    if (!fs || typeof fs.lstatSync !== 'function' || !Number.isSafeInteger(uid) || uid < 0
        || typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || root.includes('\0')
        || !Array.isArray(forbiddenRoots) || forbiddenRoots.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
        return failure('invalid_request');
    }
    const opened = run(() => {
        const dirs = [root, path.join(root, 'records'), path.join(root, 'counters')];
        for (const dir of dirs) {
            if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: DIR_MODE });
        }
        const real = fs.realpathSync(root);
        need(real === root, 'store_unsafe');
        for (const entry of forbiddenRoots) {
            const forbidden = fs.existsSync(entry) ? fs.realpathSync(entry) : entry;
            need(!isInside(real, forbidden) && !isInside(forbidden, real), 'store_unsafe');
        }
        for (const dir of dirs) assertPrivateDirectory(dir);
        return true;
    });
    if (!opened.ok) return opened;

    function assertPrivateDirectory(dir) {
        const stat = fs.lstatSync(dir);
        need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0, 'store_unsafe');
    }

    function syncDirectory(dir) {
        const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    // temp file, fsync, rename, fsync of the directory: a reader sees the old or the new file, never a partial one.
    function writeAtomic(dir, name, text, exclusive) {
        assertPrivateDirectory(dir);
        const target = path.join(dir, name);
        if (exclusive) need(!fs.existsSync(target), 'exists');
        const temp = path.join(dir, `.tmp-${crypto.randomBytes(12).toString('hex')}`);
        const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE);
        try {
            fs.writeSync(fd, Buffer.from(text, 'utf8'));
            fs.fsyncSync(fd);
        } catch (error) {
            fs.closeSync(fd);
            fs.unlinkSync(temp);
            throw error;
        }
        fs.closeSync(fd);
        try {
            fs.renameSync(temp, target);
        } catch (error) {
            fs.unlinkSync(temp);
            throw error;
        }
        syncDirectory(dir);
    }

    // Reads one private file without following links. undefined: the file does not exist (ENOENT, the only "absent").
    // null: anything else (open error, link, wrong owner or mode, too large, read error); callers treat it as unusable.
    function readPrivate(dir, name, maxBytes) {
        let fd;
        try {
            fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error) {
            return error && error.code === 'ENOENT' ? undefined : null;
        }
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) return null;
            return fs.readFileSync(fd);
        } catch {
            return null;
        } finally {
            fs.closeSync(fd);
        }
    }

    function readRecord(ref) {
        assertPrivateDirectory(path.join(root, 'records'));
        const bytes = readPrivate(path.join(root, 'records'), `${refName(ref)}.json`, RECORD_BYTES + 4096);
        if (bytes === undefined || bytes === null) return null;
        const parsed = parseCanonicalTargetJson(bytes, { maxBytes: RECORD_BYTES + 4096 });
        if (!parsed.ok) return null;
        const envelope = parsed.value;
        if (envelope === null || typeof envelope !== 'object' || Object.keys(envelope).sort().join() !== 'record,recordDigest,ref,version'
            || envelope.version !== 1 || envelope.ref !== ref || !isDigest(envelope.recordDigest)) return null;
        const checked = validateQualificationRecord(envelope.record);
        if (!checked.ok) return null;
        if (digestOf(checked.value, RECORD_BYTES) !== envelope.recordDigest) return null;
        if (checked.value.scope.agentPrincipal !== `agent:${ref}`) return null;
        return { record: checked.value, recordDigest: envelope.recordDigest };
    }

    function readCounter(ref, recordDigest) {
        const bytes = readPrivate(path.join(root, 'counters'), `${refName(ref)}.json`, COUNTER_BYTES);
        if (bytes === undefined) return [];
        // Only a missing counter file is zero; any unreadable counter exhausts the fixture and is never overwritten.
        if (bytes === null) return null;
        const parsed = parseCanonicalTargetJson(bytes, { maxBytes: COUNTER_BYTES });
        if (!parsed.ok) return null;
        const counter = parsed.value;
        if (counter === null || typeof counter !== 'object' || Object.keys(counter).sort().join() !== 'operationIds,recordDigest,ref,version'
            || counter.version !== 1 || counter.ref !== ref || !Array.isArray(counter.operationIds) || !counter.operationIds.every(isOperationId)) return null;
        // A counter for another record (a replaced record) does not apply; an unreadable counter must not look like zero.
        return counter.recordDigest === recordDigest ? counter.operationIds : [];
    }

    function listRefs() {
        assertPrivateDirectory(path.join(root, 'records'));
        const names = fs.readdirSync(path.join(root, 'records')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
        need(names.length <= MAX_RECORDS, 'capacity_exceeded');
        return names;
    }

    const store = {
        // Installs one record after verification by the caller. `expectedLive` is what the operator observed from the
        // started helper ({containerId, helperIncarnation}); the record scope must equal it. `allowedClasses` restricts
        // the tool (the fixture tool passes ['proof-fixture']). An existing record is replaced only with `replace`.
        install({ ref, record, expectedLive, allowedClasses, replace = false } = {}) {
            return run(() => {
                need(isRef(ref) && Array.isArray(allowedClasses) && allowedClasses.length > 0 && typeof replace === 'boolean'
                    && expectedLive !== null && typeof expectedLive === 'object', 'invalid_request');
                const checked = validateQualificationRecord(record);
                need(checked.ok, 'record_invalid');
                const value = checked.value;
                need(allowedClasses.includes(value.qualificationClass), 'class_not_allowed');
                need(value.scope.agentPrincipal === `agent:${ref}`, 'scope_mismatch');
                need(value.scope.containerId === expectedLive.containerId && value.scope.helperIncarnation === expectedLive.helperIncarnation, 'scope_mismatch');
                need(listRefs().length < MAX_RECORDS || fs.existsSync(path.join(root, 'records', `${refName(ref)}.json`)), 'capacity_exceeded');
                const recordDigest = digestOf(value, RECORD_BYTES);
                const text = canonicalText({ version: 1, ref, recordDigest, record: value }, RECORD_BYTES + 4096);
                writeAtomic(path.join(root, 'records'), `${refName(ref)}.json`, text, !replace);
                return { ref, recordDigest };
            });
        },

        // The record for one ref, re-read and re-validated now: {record, recordDigest}.
        get(ref) {
            return run(() => {
                need(isRef(ref), 'invalid_request');
                const found = readRecord(ref);
                need(found !== null, 'not_found');
                return found;
            });
        },

        // The `qualifications` fact of availability.mjs: {records, trustedAcceptances, executionsUsed}. Records that fail
        // any check are omitted (the target then refuses qualification_missing). Installation by the trusted tool is the
        // acceptance act, so a record's `acceptedBy` is trusted exactly while its record is installed here.
        facts() {
            return run(() => {
                const records = {};
                const trustedAcceptances = new Set();
                const executionsUsed = {};
                for (const name of listRefs()) {
                    const bytes = readPrivate(path.join(root, 'records'), name, RECORD_BYTES + 4096);
                    if (bytes === undefined || bytes === null) continue;
                    const parsed = parseCanonicalTargetJson(bytes, { maxBytes: RECORD_BYTES + 4096 });
                    const ref = parsed.ok && parsed.value !== null && typeof parsed.value === 'object' ? parsed.value.ref : undefined;
                    if (!isRef(ref) || `${refName(ref)}.json` !== name) continue;
                    const found = readRecord(ref);
                    if (found === null) continue;
                    records[ref] = found.record;
                    trustedAcceptances.add(found.record.acceptedBy);
                    if (found.record.qualificationClass === 'proof-fixture') {
                        const used = readCounter(ref, found.recordDigest);
                        // An unreadable counter exhausts the fixture rather than resetting it.
                        executionsUsed[ref] = used === null ? found.record.fixture.maxExecutions : used.length;
                    }
                }
                return { records, trustedAcceptances: [...trustedAcceptances].sort(), executionsUsed };
            });
        },

        // Durably counts one proof-fixture execution, deduplicated by operationId. Single worker writer; refuses past the
        // record's maxExecutions. Returns {used, counted} where counted is false for an operationId already counted.
        consumeExecution(ref, operationId) {
            return run(() => {
                need(isRef(ref) && isOperationId(operationId), 'invalid_request');
                const found = readRecord(ref);
                need(found !== null, 'not_found');
                need(found.record.qualificationClass === 'proof-fixture', 'class_not_allowed');
                need(found.record.fixture.operationIds.includes(operationId), 'scope_mismatch');
                const used = readCounter(ref, found.recordDigest);
                need(used !== null, 'capacity_exceeded');
                if (used.includes(operationId)) return { used: used.length, counted: false };
                need(used.length < found.record.fixture.maxExecutions, 'capacity_exceeded');
                const next = [...used, operationId].sort();
                writeAtomic(path.join(root, 'counters'), `${refName(ref)}.json`,
                    canonicalText({ version: 1, ref, recordDigest: found.recordDigest, operationIds: next }, COUNTER_BYTES), false);
                return { used: next.length, counted: true };
            });
        }
    };
    return Object.freeze({ ok: true, value: Object.freeze(store) });
}
