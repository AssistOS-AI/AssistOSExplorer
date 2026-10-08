import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    acceptanceLedger, selectAcceptanceCases, validateAcceptanceProfile, assertLedgerResults,
    collectAcceptancePreflight, assertAcceptanceGeneration,
} from './acceptance-profile.mjs';
import { assertAccountRoles, assertSearchAgentFixture } from './account-preflight.mjs';
import AcceptanceReporter from './acceptance-reporter.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const source = '/fixture/explorer';
const baseEnv = {
    SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_BASE_URL: 'http://127.0.0.1:8080',
    SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080', SMOKE_WORKSPACE_ROOT: '/fixture/workspace',
    SMOKE_PLOINKY_BOX_CONTAINER: 'fixture-box', SMOKE_EXPECT_BOX_IMAGE_ID: digest,
    SMOKE_EXPECT_BOX_IMAGE_REF: 'localhost/fixture:exact', SMOKE_RELEASE_MANIFEST: '/fixture/manifest.json',
    SMOKE_LOGIN_EMAIL: 'admin@example.test', SMOKE_SIGN_IN_METHOD: 'password', SMOKE_ACCOUNT_PASSWORD: 'fabricated-password',
    SMOKE_SECONDARY_LOGIN_EMAIL: 'user@example.test', SMOKE_SECONDARY_SIGN_IN_METHOD: 'password', SMOKE_SECONDARY_ACCOUNT_PASSWORD: 'fabricated-secondary',
    SMOKE_WEBTTY_CORE: '1',
};
const args = ['--project=chromium', '--workers=1', '--retries=0', 'specs/01-webtty-core.spec.mjs'];
const record = entry => ({ identity: entry.identity, expectedStatus: 'passed', outcome: 'expected', results: [{ status: 'passed', retry: 0 }] });

test('ledger retains all 44 identities and the 25 previously executed required cases', () => {
    assert.equal(acceptanceLedger.identities.length, 44);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance').length, 25);
    assert.equal(new Set(acceptanceLedger.identities.map(entry => entry.identity)).size, 44);
    for (const entry of acceptanceLedger.identities) {
        const escaped = entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const selection = selectAcceptanceCases([entry.selection.spec, '--grep', `^${escaped}$`]);
        assert.deepEqual(selection.cases.map(value => value.identity), [entry.identity]);
    }
});

test('missing image pins, profile flags and private sign-in inputs fail before collectors', () => {
    for (const name of ['SMOKE_EXPECT_BOX_IMAGE_ID', 'SMOKE_EXPECT_BOX_IMAGE_REF', 'SMOKE_PLOINKY_BOX_CONTAINER', 'SMOKE_RELEASE_MANIFEST', 'SMOKE_BOX_BASE_URL', 'SMOKE_WORKSPACE_ROOT', 'SMOKE_ACCOUNT_PASSWORD', 'SMOKE_SECONDARY_LOGIN_EMAIL', 'SMOKE_WEBTTY_CORE']) {
        const env = { ...baseEnv }; delete env[name];
        assert.throws(() => validateAcceptanceProfile(args, env), error => error.message.includes(name) && !error.message.includes('fabricated-password'));
    }
    assert.throws(() => validateAcceptanceProfile(['specs/33-umami-routing.spec.mjs'], { ...baseEnv, SMOKE_UMAMI: '1' }), /SMOKE_UMAMI_USERNAME/);
    assert.throws(() => validateAcceptanceProfile(['specs/33-umami-routing.spec.mjs'], { ...baseEnv, SMOKE_UMAMI: '1', SMOKE_UMAMI_USERNAME: 'private-user' }), /SMOKE_UMAMI_PASSWORD/);
    assert.throws(() => validateAcceptanceProfile(['specs/50-onlyoffice-dpu.spec.mjs'], { ...baseEnv, SMOKE_ONLYOFFICE: '1', SMOKE_PLOINKY_BIN: 'relative' }), /must be absolute/);
    assert.doesNotThrow(() => validateAcceptanceProfile(args, baseEnv));
});

test('selector/output/worker/headless/error overrides and zero identities are refused', () => {
    for (const extra of ['specs/01-webtty-core.spec.mjs:606', 'specs/nonexistent.spec.mjs', '--workers=2', '--retries=1', '--project=firefox', '--headed', '--repeat-each=2', '--output=/escape']) {
        assert.throws(() => validateAcceptanceProfile([...args, extra], baseEnv));
    }
    assert.throws(() => validateAcceptanceProfile([...args, '--grep=nonexistent identity'], baseEnv), /zero required/);
    assert.throws(() => validateAcceptanceProfile([], baseEnv), /explicit complete/);
    assert.throws(() => validateAcceptanceProfile(args, { ...baseEnv, SMOKE_GPT_RESEARCHER: '1' }), /SMOKE_GPT_RESEARCHER=0/);
    assert.throws(() => validateAcceptanceProfile(args, { ...baseEnv, SMOKE_ALLOW_BROWSER_ERRORS: '1' }), /browser errors/);
});

test('explicit headed screen profile retains its gate but cannot close the planned headless ledger identity', () => {
    const screenArgs = ['specs/30-webmeet-room-chat.spec.mjs', '--headed'];
    const env = { ...baseEnv, SMOKE_WEBMEET_SCREEN: '1', SMOKE_WEBMEET_MEDIA: '1' };
    const screen = validateAcceptanceProfile(screenArgs, env);
    assert.equal(screen.box, true);
    assert.equal(screen.ledgerCoverage, false);
    assert.throws(() => validateAcceptanceProfile(screenArgs, { ...env, SMOKE_ACCEPTANCE: '1' }));
    const headless = validateAcceptanceProfile(['specs/30-webmeet-room-chat.spec.mjs'], {
        ...baseEnv, SMOKE_WEBMEET_HEADLESS: '1', SMOKE_WEBMEET_MEDIA: '1', SMOKE_MEDIA_TIMEOUT_MS: '60000',
    });
    assert.equal(headless.ledgerCoverage, true);
});

test('discovery and terminal pass matching refuses every false-pass outcome', () => {
    const cases = acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance');
    assert.doesNotThrow(() => assertLedgerResults(cases, cases.map(record), { terminal: true }));
    for (const count of [0, 24, 26]) assert.throws(() => assertLedgerResults(cases, Array.from({ length: count }, (_, index) => record(cases[index % 25]))));
    for (const status of ['skipped', 'failed', 'timedOut', 'interrupted', 'blocked']) {
        const records = cases.map(record); records[0].results[0].status = status;
        assert.throws(() => assertLedgerResults(cases, records, { terminal: true }), /terminal outcomes/);
    }
    for (const alter of [row => row.results[0].retry = 1, row => row.results = [], row => row.outcome = 'flaky', row => row.expectedStatus = 'failed', row => row.results.push({ status: 'passed', retry: 1 })]) {
        const records = cases.map(record); alter(records[0]);
        assert.throws(() => assertLedgerResults(cases, records, { terminal: true }));
    }
});

test('actual common preflight compares independent manifest, image, workspace and descriptor evidence', async () => {
    const profile = validateAcceptanceProfile(args, baseEnv);
    const evidence = { imageDigest: digest, repositories: { explorer: { repositoryPath: source } }, liveBox: {
        box: { imageId: digest }, workspaceSourceMount: { source: baseEnv.SMOKE_WORKSPACE_ROOT },
    } };
    const fsApi = { realpathSync: value => value, readFileSync: () => assert.fail('Preflight must not read the Explorer tool descriptor.') };
    const options = { profile, env: baseEnv, baseURL: baseEnv.SMOKE_BASE_URL, boxBaseURL: baseEnv.SMOKE_BOX_BASE_URL,
        collect: async inputs => { assert.equal(inputs.expectedContainerName, 'fixture-box'); assert.equal(inputs.generationMaxAgeMs, 1800000); return evidence; }, fsApi };
    assert.equal(await collectAcceptancePreflight(options), evidence);
    for (const modified of [ { ...evidence, imageDigest: 'wrong' }, { ...evidence, liveBox: { ...evidence.liveBox, box: { imageId: 'wrong' } } }, { ...evidence, liveBox: { ...evidence.liveBox, workspaceSourceMount: { source: '/foreign' } } } ]) {
        await assert.rejects(collectAcceptancePreflight({ ...options, collect: async () => modified }));
    }
    await assert.rejects(collectAcceptancePreflight({ ...options, collect: async () => { throw new Error('Box outer container generation is not fresh enough for the release gate.'); } }), /not fresh/);
});

test('common preflight binds local browser origin to the inspected Box before collection', async () => {
    const profile = validateAcceptanceProfile(args, baseEnv);
    const evidence = { imageDigest: digest, repositories: { explorer: { repositoryPath: source } }, liveBox: {
        box: { imageId: digest }, workspaceSourceMount: { source: baseEnv.SMOKE_WORKSPACE_ROOT },
    } };
    let collections = 0;
    const options = { profile, env: baseEnv, baseURL: baseEnv.SMOKE_BASE_URL, boxBaseURL: baseEnv.SMOKE_BOX_BASE_URL,
        collect: async () => { collections += 1; return evidence; },
        fsApi: { realpathSync: value => value, readFileSync: () => '{"tools":[]}' },
    };
    for (const browserOrigin of ['http://127.0.0.1:18080', 'http://localhost:8080', 'http://[::1]:8080', 'https://other.invalid', 'http://private-user:private-password@127.0.0.1:8080']) {
        collections = 0;
        await assert.rejects(collectAcceptancePreflight({ ...options, baseURL: browserOrigin }), error => (
            /origin|loopback|binding/.test(error.message) && !/private-user|private-password/.test(error.message)
        ));
        assert.equal(collections, 0, 'invalid binding must fail before observing any Box');
    }
    assert.equal(await collectAcceptancePreflight({ ...options, baseURL: 'http://127.0.0.1:8080/' }), evidence);
    assert.equal(await collectAcceptancePreflight({ ...options, baseURL: 'http://127.0.0.1:80/', boxBaseURL: 'http://127.0.0.1' }), evidence);
    await assert.rejects(collectAcceptancePreflight({ ...options, env: { ...baseEnv, SMOKE_QA_ACCEPTANCE: '1', SMOKE_QA_EDGE_IP: '203.0.113.25' }, baseURL: 'https://explorer-qa.axiologic.dev/' }), /binding is unverified/);
    await assert.rejects(collectAcceptancePreflight({ ...options, env: { ...baseEnv, SMOKE_QA_ACCEPTANCE: '1', SMOKE_QA_EDGE_IP: '203.0.113.25' }, baseURL: 'https://other.invalid' }), /exact/);
    await assert.rejects(collectAcceptancePreflight({ ...options, env: { ...baseEnv, SMOKE_QA_ACCEPTANCE: '1' }, baseURL: 'https://explorer-qa.axiologic.dev' }), /binding is unverified/);
    await assert.rejects(collectAcceptancePreflight({ ...options, env: { ...baseEnv, SMOKE_QA_ACCEPTANCE: '1', SMOKE_QA_EDGE_IP: '127.0.0.1' }, baseURL: 'https://explorer-qa.axiologic.dev' }), /public IPv4/);
    const qa = validateAcceptanceProfile(['specs/80-explorer-qa-acceptance.spec.mjs'], { SMOKE_QA_ACCEPTANCE: '1' });
    assert.equal(qa.box, false);
    assert.equal(qa.ledgerCoverage, false);
    assert.equal(qa.coverage, 'separate-qa-profile-no-local-box-acceptance');
});

test('postflight detects identity changes and account roles are authenticated separately', () => {
    const before = { repositories: {}, liveBox: { box: { containerId: 'exact', startedAt: 'now', imageId: digest, semanticLabels: {}, normalizedPortBindings: {} } } };
    assert.doesNotThrow(() => assertAcceptanceGeneration(before, structuredClone(before)));
    for (const key of ['containerId', 'startedAt', 'imageId']) {
        const after = structuredClone(before); after.liveBox.box[key] = 'changed';
        assert.throws(() => assertAcceptanceGeneration(before, after));
    }
    const admin = { canonicalId: 'one', roles: ['admin'] }, user = { canonicalId: 'two', roles: ['user'] };
    assert.doesNotThrow(() => assertAccountRoles(admin, user, { primaryAdmin: true, secondary: true }));
    assert.throws(() => assertAccountRoles(user, admin, { primaryAdmin: true, secondary: true }));
    assert.throws(() => assertAccountRoles(admin, admin, { primaryAdmin: true, secondary: true }));
    assert.throws(() => assertSearchAgentFixture({ marketplace: { agents: [] } }), /catalog fixture/);
});

test('acceptance reporter writes only identities/outcomes and refuses stale or unwritable artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-reporter-'));
    const previous = process.env.SMOKE_ARTIFACT_DIR;
    process.env.SMOKE_ARTIFACT_DIR = root;
    try {
        const reporter = new AcceptanceReporter();
        reporter.onBegin({}, { allTests: () => [{ location: { file: '/source/a.spec.mjs' }, title: 'title', expectedStatus: 'passed', outcome: () => 'expected', results: [{ status: 'passed', retry: 0, stdout: ['private-payload'] }] }] });
        reporter.onEnd({ status: 'passed' });
        const file = path.join(root, 'ledger-outcomes_codex.json');
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-payload/);
        assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
        process.env.SMOKE_ARTIFACT_DIR = file;
        assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
    } finally {
        if (previous === undefined) delete process.env.SMOKE_ARTIFACT_DIR; else process.env.SMOKE_ARTIFACT_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('canonical runner negative control rejects an omitted opt-in instead of reporting a skip pass', () => {
    const result = spawnSync(process.execPath, [new URL('../scripts/run-playwright.mjs', import.meta.url).pathname, 'specs/33-umami-routing.spec.mjs'], {
        env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SMOKE_UMAMI=1/);
    assert.doesNotMatch(result.stdout, /skipped|passed/);
});

test('canonical discovery finds exactly the 25 required identities without starting a browser or Box probe', () => {
    const cases = acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance');
    const specs = [...new Set(cases.map(entry => entry.selection.spec))];
    const grep = cases.map(entry => `${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).join('|');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-discovery-'));
    try {
        const result = spawnSync(process.execPath, [new URL('../scripts/run-playwright.mjs', import.meta.url).pathname,
            '--project=chromium', '--workers=1', '--retries=0', ...specs, '--grep', grep, '--list'], {
            cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
            env: { PATH: process.env.PATH, SMOKE_ARTIFACT_DIR: root, SMOKE_DISCOVERY_ONLY: '1',
                ...Object.assign({}, ...cases.map(entry => entry.requiredFlags)),
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const discovered = JSON.parse(fs.readFileSync(path.join(root, 'ledger-discovery_codex.json')));
        assertLedgerResults(cases, discovered.records);
        assert.ok(discovered.records.every(entry => entry.results.length === 0), 'list evidence never claims terminal passes');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source inventory discovers all 44 ledger identities while keeping 19 separate/blocked dispositions intact', () => {
    const cases = acceptanceLedger.identities;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-all-discovery-'));
    try {
        const result = spawnSync(process.execPath, [new URL('../scripts/run-playwright.mjs', import.meta.url).pathname,
            '--project=chromium', ...new Set(cases.map(entry => entry.selection.spec)), '--grep',
            cases.map(entry => `${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).join('|'), '--list'], {
            cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
            env: { PATH: process.env.PATH, SMOKE_ARTIFACT_DIR: root, SMOKE_DISCOVERY_ONLY: '1', SMOKE_QA_EDGE_IP: '203.0.113.25',
                ...Object.assign({}, ...cases.map(entry => entry.requiredFlags)),
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(fs.readFileSync(path.join(root, 'ledger-discovery_codex.json')));
        assertLedgerResults(cases, report.records);
        assert.ok(report.records.every(entry => entry.results.length === 0));
        assert.equal(cases.filter(entry => entry.disposition !== 'required-local-acceptance').length, 19);
        assert.ok(cases.every(entry => entry.executionAllowedByThisPlan === false));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
