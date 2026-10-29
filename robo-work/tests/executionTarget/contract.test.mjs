// SYNTHETIC contract vectors for robo-work/server/executionTarget/contract.mjs and limits.mjs. Every identity, digest
// and key below is synthetic; nothing here is a qualified target or a production record.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    CONTRACT_ERROR_CODES, canonicalTargetJson, parseCanonicalTargetJson, targetDigest, validateChannelManifest,
    validateDescriptorManifest, validateInputManifest, validateQualificationRecord, validateSourceClosure, validateSourceOperation,
    validateSourceProtectionRecord, validateSourceSelection, validateStartOutcome, validateTargetBinding, validateTargetReceipt,
    validateWritableReservation
} from '../../server/executionTarget/contract.mjs';
import {
    INTERLOCK_LIMITS_V1, LIMITS_ERROR_CODES, TARGET_LIMITS_V1, TARGET_POLICY_V1, combineTargetLimits, validateTargetLimits
} from '../../server/executionTarget/limits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, 'fixtures', 'contracts-v1.json');
const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const fsId = (label, fileType = 'directory') => ({ filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: String(5000 + sha(label).charCodeAt(0) * 13 + label.length), fileType });

const DOCUMENT_VALIDATORS = {
    sourceProtectionRecord: validateSourceProtectionRecord,
    sourceSelection: validateSourceSelection,
    sourceClosure: validateSourceClosure,
    writableReservation: validateWritableReservation
};
const OPERATION_TYPES = ['reserveRequest', 'reserveResult', 'transitionRequest', 'transitionResult', 'releaseRequest', 'releaseResult',
    'acknowledgeRequest', 'acknowledgeResult', 'advanceRequest', 'advanceResult'];
function validatorFor(type) {
    if (DOCUMENT_VALIDATORS[type]) return DOCUMENT_VALIDATORS[type];
    assert.ok(OPERATION_TYPES.includes(type), `unknown fixture type ${type}`);
    return (value) => validateSourceOperation(type, value);
}

// An independent canonical encoder (recursive key sort over JSON.stringify), to cross-check the module's bytes.
function referenceCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${referenceCanonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function assertRefused(result, code, label) {
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok'], label);
    assert.equal(result.ok, false, label);
    assert.deepEqual(result.error, { code }, label);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.error), label);
}

function assertDeepFrozen(value, label) {
    if (value !== null && typeof value === 'object') {
        assert.ok(Object.isFrozen(value), label);
        for (const key of Object.keys(value)) assertDeepFrozen(value[key], label);
    }
}

// Every plain-object position in a JSON document, as a path of keys.
function objectPaths(value, prefix = []) {
    const paths = [];
    if (Array.isArray(value)) value.forEach((entry, index) => paths.push(...objectPaths(entry, [...prefix, index])));
    else if (value !== null && typeof value === 'object') {
        paths.push(prefix);
        for (const key of Object.keys(value)) paths.push(...objectPaths(value[key], [...prefix, key]));
    }
    return paths;
}

function at(value, keys) {
    return keys.reduce((node, key) => node[key], value);
}

// ENC-01 at every object level and ENC-02 at every versioned object level, with no mutation of the input.
function checkEveryLevel(validate, base, label) {
    for (const keys of objectPaths(base)) {
        const value = clone(base);
        at(value, keys).unexpectedKey = true;
        const before = clone(value);
        assertRefused(validate(value), 'invalid_request', `ENC-01 ${label} ${keys.join('.')}`);
        assert.deepEqual(value, before, 'validator does not mutate');
        assert.equal(Object.isFrozen(value), false, 'validator does not freeze the caller object');
        if (Object.hasOwn(at(base, keys), 'version')) {
            for (const mutation of [0, 2, '1', undefined]) {
                const versioned = clone(base);
                if (mutation === undefined) delete at(versioned, keys).version;
                else at(versioned, keys).version = mutation;
                assertRefused(validate(versioned), 'unsupported_version', `ENC-02 ${label} ${keys.join('.')} ${String(mutation)}`);
            }
        }
    }
}

// ---- Synthetic builders ------------------------------------------------------------------------------------------

function scope(overrides = {}) {
    return {
        workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: 'agent:SyntheticRepo/worker',
        workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
        agentPrincipal: 'agent:SyntheticRepo/target', containerId: 'c'.repeat(64), runtimeInstanceId: 'target-instance-1',
        enableGeneration: 'target-enable-1', helperIncarnation: sid('helper-1'), ...overrides
    };
}

function sourceBinding() {
    return {
        repositorySourceMode: 'prod', sourceRepositoryIdentity: 'https://example.invalid/synthetic/target.git',
        sourceRevision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }, sourceProtectionEpoch: 3, sourceSelectionDigest: sdg('selection'),
        sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1'
    };
}

function binding() {
    return {
        version: 1, scope: scope(), source: sourceBinding(), targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'),
        contractVersion: 1, contractDigest: sdg('contract'), inventoryDigest: sdg('inventory'), profileDigest: sdg('profile'),
        limitsDigest: sdg('limits'), qualificationRecordDigest: sdg('qualification'), effectiveSecurityDigest: sdg('security'),
        journalStoreIdentity: sid('journal'), robotId: sid('robot'), executionId: sid('exec'), attemptId: sid('attempt'), configRevision: 2,
        grantPolicyDigest: sdg('grants'), inputManifestDigest: sdg('input'), skillViewManifestDigest: sdg('skills'),
        nativeConfigProjectionDigest: sdg('native'), channelManifestDigest: sdg('channels'), homeCompatibilityDigest: sdg('home')
    };
}

const DENY_ALL = {
    workerStore: 'deny', otherRobotHomes: 'deny', qualificationRecords: 'deny', sourceAcceptanceRecords: 'deny', executionReceipts: 'deny',
    helperJournal: 'deny', mailbox: 'deny', credentials: 'deny', robotProcAndDescriptors: 'deny', workloadChannels: 'deny'
};

function qualification(qualificationClass = 'production') {
    return {
        version: 1, qualificationClass, scope: scope(),
        fixture: qualificationClass === 'production' ? null : {
            coordinatorPrincipal: 'agent:SyntheticRepo/coordinator', fixtureId: sid('fixture'), authorizationDigest: sdg('authorization'),
            operationIds: [sid('op-a'), sid('op-b')].sort(), maxExecutions: 8, notBeforeMs: 1000, notAfterMs: 1000 + 86400000
        },
        source: sourceBinding(), targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractDigest: sdg('contract'),
        inventoryDigest: sdg('inventory'), profileDigest: sdg('profile'), effectiveSecurityDigest: sdg('security'), limitsDigest: sdg('limits'),
        inputSchemaDigest: sdg('input-schema'), channelSchemaDigest: sdg('channel-schema'),
        platform: {
            hostPlatform: 'linux-amd64', kernelRelease: '6.8.0-synthetic', kernelBuildDigest: sdg('kernel'), runtimeName: 'podman',
            runtimeVersion: '5.0.0-synthetic', runtimeConfigDigest: sdg('runtime'), uidMappingDigest: sdg('uid'), gidMappingDigest: sdg('gid'),
            boxPolicyDigest: sdg('box'), targetProcBaselineDigest: sdg('proc'), workloadProcPolicyDigest: sdg('workload-proc')
        },
        peerTrustInventory: [
            { classId: 'helper', executableClosureDigest: sdg('helper-closure'), trustClass: 'existing-management', existingTrustEvidenceDigest: sdg('helper-trust'),
                access: { ...DENY_ALL, helperJournal: 'existing-management', mailbox: 'existing-management' } },
            { classId: 'target-service', executableClosureDigest: sdg('target-closure'), trustClass: 'untrusted-peer', existingTrustEvidenceDigest: null, access: { ...DENY_ALL } }
        ],
        homeCompatibility: {
            version: 1, homeIdentity: 'home-synthetic-1',
            transitions: [
                { backendId: 'claude', fromInventoryDigest: sdg('inv-target'), toInventoryDigest: sdg('inv-worker'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-1') },
                { backendId: 'claude', fromInventoryDigest: sdg('inv-worker'), toInventoryDigest: sdg('inv-target'), continuation: 'preserved', loginState: 'preserved', modelState: 'preserved', rollback: true, evidenceDigest: sdg('ev-2') }
            ].sort((l, r) => (`${l.fromInventoryDigest}` < `${r.fromInventoryDigest}` ? -1 : 1))
        },
        evidence: { candidateManifestDigest: sdg('candidate'), g7EvidenceDigest: sdg('g7'), independentVerificationDigest: sdg('verification') },
        acceptedBy: 'acceptance-record-synthetic-1', acceptedAtMs: 1700000000000
    };
}

function inputManifest() {
    const entries = [
        { path: 'config.toml', contentDigest: sdg('config'), mode: '0444' },
        { path: 'nested/settings.json', contentDigest: sdg('settings'), mode: '0400' }
    ];
    return {
        version: 1, executionId: sid('exec'), attemptId: sid('attempt'), configRevision: 2,
        home: { descriptorId: sid('d-home'), identity: fsId('home'), destination: '/home/robot', access: 'write' },
        grants: [
            { grantId: 'alpha', descriptorId: sid('d-alpha'), identity: fsId('alpha'), destination: '/projects/alpha', access: 'write', filterPolicyDigest: sdg('filter-a') },
            { grantId: 'beta', descriptorId: sid('d-beta'), identity: fsId('beta'), destination: '/environment/shared-state', access: 'read', filterPolicyDigest: sdg('filter-b') }
        ],
        skillOverlay: {
            descriptorId: sid('d-skill'), identity: fsId('skill'), destination: '/run/robo-work/skills', access: 'read', semantics: 'live-source',
            selectionDigest: sdg('skill-selection'), policyDigest: sdg('skill-policy'), viewStructureDigest: sdg('skill-view'),
            roots: [{ grantId: 'skills-main', identity: fsId('skills-main'), bindingChainDigest: sdg('skill-chain'), required: true }],
            requiredSelectionIds: ['skill:review', 'skill:test']
        },
        nativeConfigView: {
            descriptorId: sid('d-native'), identity: fsId('native'), destination: '/run/robo-work/config/native', access: 'read',
            semantics: 'immutable-backed', configRevision: 2, projectionDigest: targetDigest(entries).value, entries
        }
    };
}

const HANDLERS = { model: 'model-adapter', broker: 'execution-broker', mcp: 'execution-mcp', 'human-input': 'execution-human-input', 'task-failure': 'execution-task-failure' };
const TOKENS = { model: 'ROBOWORK_MODEL_TOKEN', broker: 'ROBOWORK_BROKER_TOKEN', mcp: 'ROBOWORK_MCP_TOKEN', 'human-input': 'ROBOWORK_HUMAN_INPUT_TOKEN', 'task-failure': 'ROBOWORK_TASK_FAILURE_TOKEN' };
function channelManifest(disabled = []) {
    return {
        version: 1, executionId: sid('exec'), attemptId: sid('attempt'), limitsDigest: sdg('limits'),
        channels: ['model', 'broker', 'mcp', 'human-input', 'task-failure'].map((kind) => (disabled.includes(kind)
            ? { channelId: kind, kind, enabled: false, required: false, endpoint: null, handler: null, policyDigest: null, finalExecTokenName: null }
            : {
                channelId: kind, kind, enabled: true, required: true,
                endpoint: kind === 'mcp' ? { transport: 'tcp', host: '127.0.0.1', port: 40123 } : { transport: 'unix', path: `/run/robo-work/channels/${kind}.sock` },
                handler: HANDLERS[kind], policyDigest: sdg(`policy-${kind}`), finalExecTokenName: TOKENS[kind]
            }))
    };
}

function descriptors() {
    const manifest = inputManifest();
    return [
        { slot: 0, descriptorId: manifest.home.descriptorId, role: 'home', kind: 'directory', access: 'write', identity: fsId('home'), destination: '/home/robot', resourceId: sid('r-home') },
        { slot: 1, descriptorId: manifest.grants[0].descriptorId, role: 'grant-root', kind: 'directory', access: 'write', identity: fsId('alpha'), destination: '/projects/alpha', resourceId: sid('r-alpha') },
        { slot: 2, descriptorId: manifest.skillOverlay.descriptorId, role: 'skill-overlay', kind: 'directory', access: 'read', identity: fsId('skill'), destination: '/run/robo-work/skills', resourceId: sid('r-skill') },
        { slot: 3, descriptorId: manifest.nativeConfigView.descriptorId, role: 'native-config-view', kind: 'directory', access: 'read', identity: fsId('native'), destination: '/run/robo-work/config/native', resourceId: sid('r-native') },
        { slot: 4, descriptorId: sid('d-stream'), role: 'connected-stream', kind: 'connected-stream', access: 'duplex', identity: { socketCookie: '12345' }, destination: null, resourceId: sid('r-stream') }
    ];
}

function key() {
    return { workspaceId: 'ws-synthetic', workerGeneration: sid('worker-gen'), executionId: sid('exec'), attemptId: sid('attempt'), operationId: sid('op-start') };
}

function receipt(overrides = {}) {
    return {
        version: 1, key: key(), targetBindingDigest: sdg('binding'), reservationId: sid('reservation'), requestDigest: sdg('request'),
        journalStoreIdentity: sid('journal'), helperIncarnation: sid('helper-1'), leaseId: sid('lease'), state: 'running', receiptSequence: 3,
        gateReleased: true,
        resources: [
            { resourceId: sid('res-a'), kind: 'process-tree', locatorDigest: sdg('loc-a'), identityDigest: sdg('id-a'), state: 'committed', absenceEvidenceDigest: null },
            { resourceId: sid('res-b'), kind: 'listener', locatorDigest: sdg('loc-b'), identityDigest: null, state: 'reserved', absenceEvidenceDigest: null }
        ].sort((l, r) => (l.resourceId < r.resourceId ? -1 : 1)),
        inputCursors: [{ connectionId: sid('conn-1'), acceptedThrough: '4096', delivery: 'acknowledged' }],
        observedAtMs: 1700000002000, ...overrides
    };
}

// ---- Common fixture --------------------------------------------------------------------------------------------------

test('common fixture: exact layout, 2-space JSON with trailing newline, every type and code enumerated', () => {
    assert.deepEqual(Object.keys(FIXTURE), ['version', 'canonical', 'parseRejections', 'documents', 'rejections']);
    assert.equal(FIXTURE.version, 1);
    assert.equal(FIXTURE_BYTES.toString('utf8'), `${JSON.stringify(FIXTURE, null, 2)}\n`);
    for (const entry of FIXTURE.canonical) assert.deepEqual(Object.keys(entry), ['id', 'value', 'canonicalJson', 'sha256']);
    for (const entry of FIXTURE.parseRejections) assert.deepEqual(Object.keys(entry), ['id', 'text', 'code']);
    for (const entry of FIXTURE.documents) assert.deepEqual(Object.keys(entry), ['id', 'type', 'value', 'canonicalJson', 'sha256']);
    for (const entry of FIXTURE.rejections) assert.deepEqual(Object.keys(entry), ['id', 'type', 'value', 'code']);
    const ids = [...FIXTURE.canonical, ...FIXTURE.parseRejections, ...FIXTURE.documents, ...FIXTURE.rejections].map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'vector IDs are unique');
    const types = new Set(FIXTURE.documents.map((entry) => entry.type));
    for (const type of [...Object.keys(DOCUMENT_VALIDATORS), ...OPERATION_TYPES]) assert.ok(types.has(type), `positive ${type}`);
    for (const entry of [...FIXTURE.parseRejections, ...FIXTURE.rejections]) assert.ok(CONTRACT_ERROR_CODES.includes(entry.code), entry.id);
    assert.ok(Object.isFrozen(CONTRACT_ERROR_CODES));
});

test('common fixture: canonical bytes and digests agree with an independent encoder and the parser', () => {
    for (const vector of FIXTURE.canonical) {
        const encoded = canonicalTargetJson(vector.value);
        assert.equal(encoded.ok, true, vector.id);
        assert.equal(encoded.value, vector.canonicalJson, vector.id);
        assert.equal(referenceCanonical(vector.value), vector.canonicalJson, `${vector.id} reference`);
        assert.equal(sha(Buffer.from(vector.canonicalJson, 'utf8')), vector.sha256, vector.id);
        assert.deepEqual(targetDigest(vector.value), { ok: true, value: vector.sha256 }, vector.id);
        const parsed = parseCanonicalTargetJson(vector.canonicalJson);
        assert.equal(parsed.ok, true, vector.id);
        assert.deepEqual(parsed.value, vector.value, vector.id);
        assert.deepEqual(parseCanonicalTargetJson(Buffer.from(vector.canonicalJson, 'utf8')).value, vector.value, `${vector.id} bytes`);
    }
});

test('common fixture: ENC-03 and ENC-05 parse rejections', () => {
    for (const vector of FIXTURE.parseRejections) {
        assertRefused(parseCanonicalTargetJson(vector.text), vector.code, vector.id);
        if (vector.text.isWellFormed()) assertRefused(parseCanonicalTargetJson(Buffer.from(vector.text, 'utf8')), vector.code, `${vector.id} bytes`);
    }
});

test('common fixture: positive documents validate, are deep-frozen copies and round-trip byte-identically', () => {
    for (const vector of FIXTURE.documents) {
        const validate = validatorFor(vector.type);
        const result = validate(vector.value);
        assert.equal(result.ok, true, `${vector.id}: ${JSON.stringify(result.error)}`);
        assert.deepEqual(Object.keys(result).sort(), ['ok', 'value']);
        assert.deepEqual(result.value, vector.value, vector.id);
        assert.notEqual(result.value, vector.value, `${vector.id} returns a copy`);
        assertDeepFrozen(result.value, vector.id);
        const bound = vector.type === 'sourceClosure' ? { maxBytes: 64 * 1024 * 1024 } : undefined;
        assert.equal(canonicalTargetJson(vector.value, bound).value, vector.canonicalJson, vector.id);
        assert.equal(referenceCanonical(vector.value), vector.canonicalJson, `${vector.id} reference`);
        assert.equal(sha(vector.canonicalJson), vector.sha256, vector.id);
        const parsed = parseCanonicalTargetJson(vector.canonicalJson, bound);
        assert.equal(parsed.ok, true, vector.id);
        assert.equal(validate(parsed.value).ok, true, `${vector.id} parsed`);
    }
});

test('common fixture: rejection vectors refuse with their code and leave the input unchanged', () => {
    for (const vector of FIXTURE.rejections) {
        const value = clone(vector.value);
        assertRefused(validatorFor(vector.type)(value), vector.code, vector.id);
        assert.deepEqual(value, vector.value, `${vector.id} input unchanged`);
    }
});

test('common fixture: ENC-01/ENC-02 at every object level of every positive document', () => {
    for (const vector of FIXTURE.documents) checkEveryLevel(validatorFor(vector.type), vector.value, vector.id);
});

test('validateSourceOperation selects the request or result form by operation name and refuses unknown kinds', () => {
    const byType = Object.fromEntries(FIXTURE.documents.map((vector) => [`${vector.type}:${vector.id}`, vector]));
    for (const vector of Object.values(byType)) {
        if (!OPERATION_TYPES.includes(vector.type)) continue;
        const operation = vector.type.replace(/(Request|Result)$/, '');
        assert.equal(validateSourceOperation(operation, vector.value).ok, true, vector.id);
    }
    assertRefused(validateSourceOperation('delete', {}), 'invalid_request', 'unknown kind');
    assertRefused(validateSourceOperation('reserve', null), 'invalid_request', 'non-object');
});

test('SRC-09-b (A5.3) a secret reference naming a path that is also a content entry is invalid_request', () => {
    const base = FIXTURE.documents.find((vector) => vector.id === 'DOC-closure-ENC-06-bound').value;
    assert.equal(validateSourceClosure(base).ok, true);
    for (const entry of base.entries) {
        const value = clone(base);
        value.secretReferences = [{ rootId: entry.rootId, path: entry.path, secretHandleId: 'secret-handle-synthetic-1', revisionId: 'rev-1' }];
        assertRefused(validateSourceClosure(value), 'invalid_request', `overlap ${entry.path}`);
    }
    const disjoint = clone(base);
    disjoint.secretReferences = [{ rootId: base.entries[0].rootId, path: 'bin/run.secret', secretHandleId: 'secret-handle-synthetic-1', revisionId: 'rev-1' }];
    assert.equal(validateSourceClosure(disjoint).ok, true, 'a disjoint reference');
});

// ---- Encoding (ENC-03, ENC-05) beyond the shared vectors ------------------------------------------------------------

test('ENC-03 invalid UTF-8, overlong encodings and BOM bytes are noncanonical_encoding', () => {
    for (const bytes of [
        Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d]),
        Buffer.from([0x22, 0xc0, 0xaf, 0x22]),
        Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
        Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
    ]) assertRefused(parseCanonicalTargetJson(bytes), 'noncanonical_encoding', bytes.toString('hex'));
    assertRefused(canonicalTargetJson({ a: '\ud800' }), 'noncanonical_encoding', 'lone surrogate value');
    assertRefused(canonicalTargetJson({ '\u00e9': 1 }), 'noncanonical_encoding', 'non-ASCII key');
});

test('ENC-05 non-JSON values, -0, fractions, unsafe integers, accessors and inherited properties are invalid_request', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true });
    const hidden = {};
    Object.defineProperty(hidden, 'a', { value: 1, enumerable: false });
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const extended = [1];
    extended.extra = 2;
    class Custom { constructor() { this.a = 1; } }
    for (const [label, value] of [
        ['-0', { a: -0 }], ['fraction', { a: 0.5 }], ['unsafe', { a: 2 ** 53 }], ['NaN', { a: Number.NaN }], ['infinity', { a: Infinity }],
        ['undefined', { a: undefined }], ['function', { a: () => 1 }], ['bigint', { a: 1n }], ['symbol key', { [Symbol('s')]: 1 }],
        ['accessor', accessor], ['non-enumerable', hidden], ['sparse', sparse], ['array extra key', extended], ['class instance', new Custom()],
        ['date', new Date(0)], ['depth 17', JSON.parse(`${'['.repeat(17)}${']'.repeat(17)}`)]
    ]) assertRefused(canonicalTargetJson(value), 'invalid_request', label);
    assert.equal(canonicalTargetJson(JSON.parse(`${'['.repeat(16)}${']'.repeat(16)}`)).ok, true, 'depth 16');
    // Counter overflow never wraps: a positive counter at MAX_SAFE_INTEGER is valid, one more is refused.
    const top = binding();
    top.configRevision = Number.MAX_SAFE_INTEGER;
    assert.equal(validateTargetBinding(top).ok, true);
    top.configRevision = Number.MAX_SAFE_INTEGER + 1;
    assertRefused(validateTargetBinding(top), 'invalid_request', 'MAX_SAFE_INTEGER+1');
    for (const bad of [-1, 0, 1.5, -0]) {
        const value = binding();
        value.configRevision = bad;
        assertRefused(validateTargetBinding(value), 'invalid_request', `configRevision ${bad}`);
    }
});

test('ENC-06 and CAP-01 the object size bound: 64 KiB accepted, one byte over refused', () => {
    const text = (n) => JSON.stringify('x'.repeat(n - 2));
    assert.equal(parseCanonicalTargetJson(text(65536)).ok, true);
    assertRefused(parseCanonicalTargetJson(text(65537)), 'capacity_exceeded', 'parse 64 KiB + 1');
    assert.equal(canonicalTargetJson('x'.repeat(65534)).ok, true);
    assertRefused(canonicalTargetJson('x'.repeat(65535)), 'capacity_exceeded', 'encode 64 KiB + 1');
    assert.equal(parseCanonicalTargetJson(text(65537), { maxBytes: 70000 }).ok, true, 'explicit larger bound');
    assertRefused(canonicalTargetJson('x', { maxBytes: 64 * 1024 * 1024 + 1 }), 'invalid_request', 'bound above 64 MiB');
});

// ---- Binding, qualification and manifests ---------------------------------------------------------------------------

test('TargetBinding: positive, ENC-01/ENC-02 at every level, ENC-04 identifiers and contract version', () => {
    const result = validateTargetBinding(binding());
    assert.equal(result.ok, true);
    assertDeepFrozen(result.value, 'binding');
    checkEveryLevel(validateTargetBinding, binding(), 'binding');
    const cases = [
        ['ENC-04 empty id', (v) => { v.robotId = ''; }, 'invalid_request'],
        ['ENC-04 overlong id', (v) => { v.robotId = `${v.robotId}A`; }, 'invalid_request'],
        ['ENC-04 noncanonical base64url', (v) => { v.executionId = 'AAAAAAAAAAAAAAAAAAAAAB'; }, 'invalid_request'],
        ['ENC-04 uppercase digest', (v) => { v.contractDigest = v.contractDigest.toUpperCase(); }, 'invalid_request'],
        ['ENC-04 image tag', (v) => { v.targetImageDigest = 'docker.io/synthetic/image:latest'; }, 'invalid_request'],
        ['ENC-04 container id uppercase', (v) => { v.scope.containerId = 'C'.repeat(64); }, 'invalid_request'],
        ['ENC-04 principal component', (v) => { v.scope.agentPrincipal = 'agent:repo/..'; }, 'invalid_request'],
        ['ENC-04 opaque control', (v) => { v.scope.runtimeInstanceId = 'inst\u0000'; }, 'invalid_request'],
        ['revision algorithm', (v) => { v.source.sourceRevision = { algorithm: 'git-sha1', value: 'a'.repeat(64) }; }, 'invalid_request'],
        ['source mode', (v) => { v.source.repositorySourceMode = 'staging'; }, 'invalid_request'],
        ['epoch zero', (v) => { v.source.sourceProtectionEpoch = 0; }, 'invalid_request'],
        ['contract version 2', (v) => { v.contractVersion = 2; }, 'unsupported_version']
    ];
    for (const [label, mutate, code] of cases) {
        const value = binding();
        mutate(value);
        assertRefused(validateTargetBinding(value), code, label);
    }
});

test('QualificationRecord: production and proof-fixture positives, class/fixture rules, QUA-04 and QUA-05', () => {
    for (const cls of ['production', 'proof-fixture']) {
        assert.equal(validateQualificationRecord(qualification(cls)).ok, true, cls);
        checkEveryLevel(validateQualificationRecord, qualification(cls), cls);
    }
    const cases = [
        ['production with fixture', 'production', (v) => { v.fixture = qualification('proof-fixture').fixture; }, 'invalid_request'],
        ['fixture without fixture object', 'proof-fixture', (v) => { v.fixture = null; }, 'invalid_request'],
        ['fixture window over 24 h', 'proof-fixture', (v) => { v.fixture.notAfterMs += 1; }, 'invalid_request'],
        ['fixture maxExecutions 9', 'proof-fixture', (v) => { v.fixture.maxExecutions = 9; }, 'invalid_request'],
        ['CAP-01 fixture 65 operation IDs', 'proof-fixture', (v) => { v.fixture.operationIds = Array.from({ length: 65 }, (_, i) => sid(`op-${i}`)).sort(); }, 'capacity_exceeded'],
        ['fixture operation IDs unsorted', 'proof-fixture', (v) => { v.fixture.operationIds.reverse(); }, 'invalid_request'],
        ['platform host', 'production', (v) => { v.platform.hostPlatform = 'windows-amd64'; }, 'invalid_request'],
        ['runtime name', 'production', (v) => { v.platform.runtimeName = 'containerd'; }, 'invalid_request'],
        ['kernel release 129 bytes', 'production', (v) => { v.platform.kernelRelease = 'k'.repeat(129); }, 'invalid_request'],
        ['peer inventory empty', 'production', (v) => { v.peerTrustInventory = []; }, 'invalid_request'],
        ['peer inventory unsorted', 'production', (v) => { v.peerTrustInventory.reverse(); }, 'invalid_request'],
        ['untrusted peer with evidence', 'production', (v) => { v.peerTrustInventory[1].existingTrustEvidenceDigest = sdg('x'); }, 'invalid_request'],
        ['QUA-04 management relabel without evidence', 'production', (v) => { v.peerTrustInventory[1].trustClass = 'existing-management'; }, 'peer_trust_unaccepted'],
        ['HOM compatibility value', 'production', (v) => { v.homeCompatibility.transitions[0].loginState = 'reset'; }, 'invalid_request'],
        ['HOM duplicate pair', 'production', (v) => { v.homeCompatibility.transitions[1] = clone(v.homeCompatibility.transitions[0]); }, 'invalid_request'],
        ['HOM unsorted pairs', 'production', (v) => { v.homeCompatibility.transitions.reverse(); }, 'invalid_request']
    ];
    for (const [label, cls, mutate, code] of cases) {
        const value = qualification(cls);
        mutate(value);
        assertRefused(validateQualificationRecord(value), code, label);
    }
    for (const cell of Object.keys(DENY_ALL)) {
        const value = qualification();
        value.peerTrustInventory[1].access[cell] = 'existing-management';
        assertRefused(validateQualificationRecord(value), 'peer_authority_exposed', `QUA-05 ${cell}`);
    }
});

test('InputManifest: positive, every level, grant and native-config bounds (CAP-01, ENC-06)', () => {
    assert.equal(validateInputManifest(inputManifest()).ok, true);
    checkEveryLevel(validateInputManifest, inputManifest(), 'input');
    const grant = (index) => ({ grantId: `g${String(index).padStart(2, '0')}`, descriptorId: sid(`dg-${index}`), identity: fsId(`g-${index}`), destination: `/projects/g${String(index).padStart(2, '0')}`, access: 'read', filterPolicyDigest: sdg('f') });
    const nativeEntries = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${String(i).padStart(3, '0')}`, contentDigest: sdg(`c${i}`), mode: '0444' }));
    const at32 = inputManifest();
    at32.grants = Array.from({ length: 32 }, (_, i) => grant(i));
    assert.equal(validateInputManifest(at32).ok, true, 'CAP-01 32 grants');
    const nativeAt128 = inputManifest();
    nativeAt128.nativeConfigView.entries = nativeEntries(128);
    nativeAt128.nativeConfigView.projectionDigest = targetDigest(nativeAt128.nativeConfigView.entries).value;
    assert.equal(validateInputManifest(nativeAt128).ok, true, 'CAP-01 128 native files');
    const cases = [
        ['CAP-01 33 grants', (v) => { v.grants = Array.from({ length: 33 }, (_, i) => grant(i)); }, 'capacity_exceeded'],
        ['CAP-01 129 native files', (v) => { v.nativeConfigView.entries = nativeEntries(129); }, 'capacity_exceeded'],
        ['CAP-01 129 skill roots', (v) => { v.skillOverlay.roots = Array.from({ length: 129 }, (_, i) => ({ grantId: `s${String(i).padStart(3, '0')}`, identity: fsId('s'), bindingChainDigest: sdg('c'), required: false })); }, 'capacity_exceeded'],
        ['grant destination of another grant', (v) => { v.grants[0].destination = '/projects/other'; }, 'invalid_request'],
        ['grant destination host path', (v) => { v.grants[1].destination = '/var/lib/synthetic'; }, 'invalid_request'],
        ['grant ID grammar', (v) => { v.grants[0].grantId = 'Alpha'; }, 'invalid_request'],
        ['grant ID 65 bytes', (v) => { v.grants[0].grantId = 'a'.repeat(65); v.grants[0].destination = `/projects/${'a'.repeat(65)}`; }, 'invalid_request'],
        ['duplicate descriptor ID', (v) => { v.grants[1].descriptorId = v.home.descriptorId; }, 'invalid_request'],
        ['home destination', (v) => { v.home.destination = '/root'; }, 'invalid_request'],
        ['home read-only', (v) => { v.home.access = 'read'; }, 'invalid_request'],
        ['skill semantics snapshot', (v) => { v.skillOverlay.semantics = 'snapshot'; }, 'invalid_request'],
        ['selection ID 513 bytes', (v) => { v.skillOverlay.requiredSelectionIds = ['s'.repeat(513)]; }, 'invalid_request'],
        ['native mode writable', (v) => { v.nativeConfigView.entries[0].mode = '0644'; }, 'invalid_request'],
        ['native projection digest', (v) => { v.nativeConfigView.projectionDigest = sdg('other'); }, 'invalid_request'],
        ['native config revision', (v) => { v.nativeConfigView.configRevision = 3; }, 'invalid_request'],
        ['ENC-06 native path component 256 bytes', (v) => { v.nativeConfigView.entries[1].path = `nested/${'é'.repeat(128)}`; }, 'capacity_exceeded'],
        ['home identity not a directory', (v) => { v.home.identity.fileType = 'regular'; }, 'descriptor_identity']
    ];
    for (const [label, mutate, code] of cases) {
        const value = inputManifest();
        mutate(value);
        assertRefused(validateInputManifest(value), code, label);
    }
});

test('ChannelManifest: all five channel kinds, disabled forms, CHN-02 required channel missing', () => {
    assert.equal(validateChannelManifest(channelManifest()).ok, true, 'all enabled');
    assert.equal(validateChannelManifest(channelManifest(['human-input', 'task-failure'])).ok, true, 'optional disabled');
    checkEveryLevel(validateChannelManifest, channelManifest(), 'channels');
    assert.equal(validateChannelManifest(channelManifest(), { requiredKinds: ['model', 'broker', 'mcp', 'human-input', 'task-failure'] }).ok, true);
    const disabledRequired = channelManifest(['broker']);
    disabledRequired.channels[1].required = true;
    assertRefused(validateChannelManifest(disabledRequired), 'required_channel_missing', 'CHN-02 required and disabled');
    assertRefused(validateChannelManifest(channelManifest(['human-input']), { requiredKinds: ['human-input'] }), 'required_channel_missing', 'CHN-02 workflow capability admitted');
    const cases = [
        ['order', (v) => { v.channels.reverse(); }],
        ['four entries', (v) => { v.channels.pop(); }],
        ['channel ID differs from kind', (v) => { v.channels[0].channelId = 'broker'; }],
        ['handler', (v) => { v.channels[0].handler = 'execution-broker'; }],
        ['unix path', (v) => { v.channels[1].endpoint.path = '/tmp/broker.sock'; }],
        ['mcp host', (v) => { v.channels[2].endpoint.host = '0.0.0.0'; }],
        ['mcp port 1023', (v) => { v.channels[2].endpoint.port = 1023; }],
        ['mcp port 65536', (v) => { v.channels[2].endpoint.port = 65536; }],
        ['worker destination in manifest', (v) => { v.channels[2].endpoint.workerHost = '10.0.0.1'; }],
        ['token of another kind', (v) => { v.channels[0].finalExecTokenName = 'ROBOWORK_MCP_TOKEN'; }],
        ['token value', (v) => { v.channels[0].finalExecTokenName = 'synthetic-token-value'; }],
        ['disabled with endpoint', (v) => { Object.assign(v.channels[4], { enabled: false, required: false, finalExecTokenName: null, handler: null, policyDigest: null }); }]
    ];
    for (const [label, mutate] of cases) {
        const value = channelManifest();
        mutate(value);
        assertRefused(validateChannelManifest(value), 'invalid_request', label);
    }
});

test('DescriptorManifest: every role, FD-01 slot and count rules, FD-02 forbidden roles', () => {
    assert.equal(validateDescriptorManifest(descriptors()).ok, true);
    assert.equal(validateDescriptorManifest([]).ok, true, 'no descriptors');
    const nine = Array.from({ length: 9 }, (_, slot) => ({ ...descriptors()[4], slot, descriptorId: sid(`s-${slot}`) }));
    assert.equal(validateDescriptorManifest(nine.slice(0, 8)).ok, true, 'CAP-01 8 descriptors');
    assertRefused(validateDescriptorManifest(nine), 'capacity_exceeded', 'CAP-01 9 descriptors');
    const cases = [
        ['FD-01 duplicate slot', (v) => { v[1].slot = 0; }, 'descriptor_count'],
        ['FD-01 gapped slot', (v) => { v[2].slot = 3; }, 'descriptor_count'],
        ['FD-01 non-integer slot', (v) => { v[0].slot = '0'; }, 'descriptor_count'],
        ['FD-02 namespace role', (v) => { v[0].role = 'namespace'; }, 'descriptor_role'],
        ['FD-02 listener role', (v) => { v[4].role = 'listener'; }, 'descriptor_role'],
        ['FD-02 listener kind', (v) => { v[4].kind = 'listener'; }, 'descriptor_role'],
        ['FD-02 unconnected socket kind', (v) => { v[4].kind = 'socket'; }, 'descriptor_role'],
        ['FD-02 worker-store parent destination', (v) => { v[1].destination = '/var/lib/robo-work'; }, 'descriptor_role'],
        ['home with read access', (v) => { v[0].access = 'read'; }, 'descriptor_role'],
        ['skill overlay writable', (v) => { v[2].access = 'write'; }, 'descriptor_role'],
        ['connected stream with destination', (v) => { v[4].destination = '/run/x'; }, 'descriptor_role'],
        ['directory identity not a directory', (v) => { v[1].identity.fileType = 'regular'; }, 'descriptor_identity'],
        ['duplicate descriptor ID', (v) => { v[1].descriptorId = v[0].descriptorId; }, 'invalid_request'],
        ['unknown key', (v) => { v[3].handle = 7; }, 'invalid_request']
    ];
    for (const [label, mutate, code] of cases) {
        const value = descriptors();
        mutate(value);
        assertRefused(validateDescriptorManifest(value), code, label);
    }
});

test('TargetReceipt and StartOutcome: positives, every level, state and evidence rules, CAP-01 resources', () => {
    assert.equal(validateTargetReceipt(receipt()).ok, true);
    checkEveryLevel(validateTargetReceipt, receipt(), 'receipt');
    const many = (n) => Array.from({ length: n }, (_, i) => ({ resourceId: sid(`bulk-${i}`), kind: 'descriptor', locatorDigest: sdg(`l${i}`), identityDigest: sdg(`i${i}`), state: 'committed', absenceEvidenceDigest: null }))
        .sort((l, r) => (l.resourceId < r.resourceId ? -1 : 1));
    assert.equal(validateTargetReceipt(receipt({ resources: many(512) })).ok, true, 'CAP-01 512 resources');
    assertRefused(validateTargetReceipt(receipt({ resources: many(513) })), 'capacity_exceeded', 'CAP-01 513 resources');
    const cases = [
        ['prepared with gate released', { state: 'prepared', gateReleased: true }],
        ['running without gate release', { state: 'running', gateReleased: false }],
        ['state unknown', { state: 'lost' }],
        ['sequence zero', { receiptSequence: 0 }],
        ['cursor offset not U64', { inputCursors: [{ connectionId: sid('conn-1'), acceptedThrough: '-1', delivery: 'acknowledged' }] }],
        ['cursor delivery', { inputCursors: [{ connectionId: sid('conn-1'), acceptedThrough: '1', delivery: 'resend' }] }]
    ];
    for (const [label, overrides] of cases) assertRefused(validateTargetReceipt(receipt(overrides)), 'invalid_request', label);
    const resourceCases = [
        ['committed without identity', { state: 'committed', identityDigest: null }],
        ['released without absence evidence', { state: 'released', absenceEvidenceDigest: null }],
        ['quarantined with absence evidence', { state: 'quarantined', absenceEvidenceDigest: sdg('x') }],
        ['resource kind', { kind: 'container' }]
    ];
    for (const [label, change] of resourceCases) {
        const value = receipt();
        Object.assign(value.resources[0], change);
        assertRefused(validateTargetReceipt(value), 'invalid_request', label);
    }
    const outcomes = [
        { version: 1, outcome: 'refused-before-create', key: key(), requestDigest: sdg('request'), code: 'binding_mismatch', absenceEvidenceDigest: sdg('absence') },
        { version: 1, outcome: 'committed-or-reconciled', key: key(), requestDigest: sdg('request'), receipt: receipt() },
        { version: 1, outcome: 'outcome-unknown', key: key(), requestDigest: sdg('request'), reservationId: sid('reservation'), lastReceiptSequence: 0 }
    ];
    for (const outcome of outcomes) {
        assert.equal(validateStartOutcome(outcome).ok, true, outcome.outcome);
        checkEveryLevel(validateStartOutcome, outcome, outcome.outcome);
    }
    assertRefused(validateStartOutcome({ ...outcomes[0], absenceEvidenceDigest: null }), 'invalid_request', 'refused without absence proof');
    assertRefused(validateStartOutcome({ ...outcomes[1], requestDigest: sdg('other') }), 'invalid_request', 'receipt of another request');
    assertRefused(validateStartOutcome({ ...outcomes[2], outcome: 'nothing-started' }), 'invalid_request', 'unknown outcome kind');
});

// ---- Limits (A1.4, A2.4; CAP-01, CAP-03) ---------------------------------------------------------------------------

test('limits: frozen v1 objects with the A1.4/A2.3 key split', () => {
    for (const value of [TARGET_LIMITS_V1, TARGET_POLICY_V1, INTERLOCK_LIMITS_V1, LIMITS_ERROR_CODES]) assert.ok(Object.isFrozen(value));
    assert.equal(Object.keys(TARGET_LIMITS_V1).length, 31);
    assert.deepEqual(TARGET_POLICY_V1, { settledReceiptRetentionMs: 604800000 });
    assert.deepEqual(INTERLOCK_LIMITS_V1, { writableReservations: 4096, sourceStateBytes: 33554432, operationReceipts: 65536, lockWaitMs: 5000 });
    assert.equal(Object.hasOwn(INTERLOCK_LIMITS_V1, 'retiredWorkerGenerations'), false, 'removed by A2.3');
    assert.equal(validateTargetLimits(TARGET_LIMITS_V1).ok, true);
});

test('CAP-01 limits at the ceiling accepted, ceiling + 1 refused for every key', () => {
    for (const key of Object.keys(TARGET_LIMITS_V1)) {
        const value = { ...TARGET_LIMITS_V1, [key]: TARGET_LIMITS_V1[key] + 1 };
        assertRefused(validateTargetLimits(value), 'capacity_exceeded', key);
    }
    for (const bad of [0, -1, 1.5, '8', null]) assertRefused(validateTargetLimits({ ...TARGET_LIMITS_V1, executionsPerTarget: bad }), 'invalid_request', String(bad));
});

test('CAP-03 a declaration carrying the policy floor or any interlock key is invalid_request', () => {
    for (const extra of [{ settledReceiptRetentionMs: 1 }, { settledReceiptRetentionMs: 604800000 }, ...Object.entries(INTERLOCK_LIMITS_V1).map(([k, v]) => ({ [k]: v })), { retiredWorkerGenerations: 4096 }]) {
        const declaration = { ...TARGET_LIMITS_V1, ...extra };
        assertRefused(validateTargetLimits(declaration), 'invalid_request', Object.keys(extra)[0]);
        assertRefused(combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration, qualification: TARGET_LIMITS_V1 }), 'invalid_request', `combine ${Object.keys(extra)[0]}`);
    }
    const missing = { ...TARGET_LIMITS_V1 };
    delete missing.leaseTtlMs;
    assertRefused(validateTargetLimits(missing), 'invalid_request', 'missing key');
    assertRefused(combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration: TARGET_LIMITS_V1, qualification: TARGET_LIMITS_V1, targetPolicy: { settledReceiptRetentionMs: 604799999 } }), 'invalid_request', 'policy lowered');
});

test('combineTargetLimits: component-wise minimum, relationships after combination, digest over limits and policy', () => {
    const declaration = { ...TARGET_LIMITS_V1, executionsPerTarget: 2, connectionsPerTarget: 128 };
    const qualificationLimits = { ...TARGET_LIMITS_V1, executionsPerTarget: 4, bufferedBytesPerTarget: 8388608 };
    const combined = combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration, qualification: qualificationLimits });
    assert.equal(combined.ok, true);
    assert.equal(combined.value.limits.executionsPerTarget, 2);
    assert.equal(combined.value.limits.connectionsPerTarget, 128);
    assert.equal(combined.value.limits.bufferedBytesPerTarget, 8388608);
    assert.deepEqual(combined.value.policy, TARGET_POLICY_V1);
    assert.equal(combined.value.limitsDigest, sha(referenceCanonical({ version: 1, limits: combined.value.limits, policy: TARGET_POLICY_V1 })));
    // Each input alone may break a relationship that the combination satisfies, and vice versa.
    const lowTtl = { ...TARGET_LIMITS_V1, leaseTtlMs: 14999 };
    const declarationAlone = { ...TARGET_LIMITS_V1, leaseTtlMs: 9000 };
    assertRefused(validateTargetLimits(declarationAlone), 'invalid_request', 'declaration alone breaks the renew ratio');
    assert.equal(combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration: declarationAlone, qualification: { ...TARGET_LIMITS_V1, renewIntervalMs: 2000 } }).ok, true, 'relationships are checked after combination');
    assertRefused(validateTargetLimits(lowTtl), 'invalid_request', '3 * renewIntervalMs <= leaseTtlMs');
    assertRefused(combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration: lowTtl, qualification: TARGET_LIMITS_V1 }), 'invalid_request', 'renew ratio after combination');
    const relationships = [
        ['frameBytes floor 589824', { frameBytes: 589823 }],
        ['pending opens per execution <= per target', { pendingOpensPerTarget: 7 }],
        ['connections per execution <= per target', { connectionsPerTarget: 63 }],
        ['descriptors per execution <= per target', { descriptorsPerTarget: 255 }],
        ['buffered per execution <= per target', { bufferedBytesPerTarget: 4194303 }],
        ['connections >= listeners', { connectionsPerExecution: 20 }],
        ['buffered per connection <= per execution', { bufferedBytesPerExecution: 262143 }],
        ['data per frame <= buffered per connection', { bufferedBytesPerConnection: 65535 }],
        ['descriptors per frame <= per execution', { descriptorsPerExecution: 7 }],
        ['challenge <= lease', { leaseTtlMs: 4000, renewIntervalMs: 1000 }],
        ['connection lifetime <= execution lifetime', { executionLifetimeMs: 86399999 }],
        ['idle <= connection lifetime', { connectionLifetimeMs: 299999 }]
    ];
    for (const [label, change] of relationships) {
        const declarationChange = { ...TARGET_LIMITS_V1, ...change };
        const result = combineTargetLimits({ workerPolicy: TARGET_LIMITS_V1, declaration: declarationChange, qualification: TARGET_LIMITS_V1 });
        assertRefused(result, 'invalid_request', label);
    }
    // With the frame floor equal to the frame ceiling, header + data + 1024 <= frame cannot be violated within the
    // ceilings; it is asserted on the v1 values.
    assert.ok(TARGET_LIMITS_V1.headerBytes + TARGET_LIMITS_V1.dataBytesPerFrame + 1024 <= TARGET_LIMITS_V1.frameBytes);
});
