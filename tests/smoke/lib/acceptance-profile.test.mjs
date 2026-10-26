import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    acceptanceLedger, selectAcceptanceCases, validateAcceptanceProfile, assertLedgerResults,
    collectAcceptancePreflight, assertAcceptanceGeneration, acceptancePreflightRecord, writeTerminalPostflight, POSTFLIGHT_FILE,
} from './acceptance-profile.mjs';
import { assertAccountRoles, assertMarketplaceLifecycleFixture } from './account-preflight.mjs';
import AcceptanceReporter from './acceptance-reporter.mjs';
import { collectCopilotReleaseEvidence, sameCopilotReleaseGeneration } from './copilot-release-evidence.mjs';
import { validateNativeEvidence } from './live-sessions.mjs';
import { siblingPath, siblingUrl } from '../../helpers/sibling-roots.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const source = '/fixture/explorer';
const baseEnv = {
    SMOKE_DEPLOYMENT_MODE: 'box', SMOKE_BASE_URL: 'http://127.0.0.1:8080',
    SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080', SMOKE_WORKSPACE_ROOT: '/fixture/workspace',
    SMOKE_PLOINKY_BOX_CONTAINER: 'fixture-box', SMOKE_EXPECT_BOX_IMAGE_ID: digest,
    SMOKE_EXPECT_BOX_IMAGE_REF: 'localhost/fixture:exact', SMOKE_RELEASE_MANIFEST: '/fixture/manifest.json',
    SMOKE_LOGIN_EMAIL: 'admin@example.test', SMOKE_SIGN_IN_METHOD: 'password', SMOKE_ACCOUNT_PASSWORD: 'fabricated-password',
    SMOKE_WEBTTY_WATCHER_USERNAME: 'watcher@example.test',
    SMOKE_SECONDARY_LOGIN_EMAIL: 'user@example.test', SMOKE_SECONDARY_SIGN_IN_METHOD: 'password', SMOKE_SECONDARY_ACCOUNT_PASSWORD: 'fabricated-secondary',
    SMOKE_WEBTTY_CORE: '1',
};
const args = ['--project=chromium', '--workers=1', '--retries=0', 'specs/01-webtty-core.spec.mjs'];
const record = entry => ({ identity: entry.identity, expectedStatus: 'passed', outcome: 'expected', results: [{ status: 'passed', retry: 0 }] });

const liveArgs = ['--project=chromium', '--workers=1', '--retries=0', 'specs/07-live-sessions.spec.mjs'];
const liveEnv = { ...baseEnv, SMOKE_LIVE_SESSIONS: '1', SMOKE_PLOINKY_BIN: '/fixture/ploinky/bin/ploinky',
    SMOKE_LIVE_SESSIONS_FOREIGN_LOGIN_EMAIL: 'foreign@example.test', SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD: 'password',
    SMOKE_LIVE_SESSIONS_FOREIGN_ACCOUNT_PASSWORD: 'fabricated-foreign', SMOKE_LIVE_SESSIONS_NATIVE_EVIDENCE: '/private/native-evidence.json' };

test('fresh Live Sessions profile selects exactly two additive identities with strict private prerequisites', () => {
    const profile = validateAcceptanceProfile(liveArgs, liveEnv);
    assert.equal(profile.box, true);
    assert.equal(profile.accounts.secondary, true);
    assert.equal(profile.cases.length, 2);
    assert.ok(profile.cases.every(entry => entry.cohort === 'fresh-live-sessions'));
    for (const name of ['SMOKE_LIVE_SESSIONS', 'SMOKE_PLOINKY_BIN', 'SMOKE_LIVE_SESSIONS_NATIVE_EVIDENCE',
        'SMOKE_LIVE_SESSIONS_FOREIGN_LOGIN_EMAIL', 'SMOKE_LIVE_SESSIONS_FOREIGN_SIGN_IN_METHOD',
        'SMOKE_LIVE_SESSIONS_FOREIGN_ACCOUNT_PASSWORD', 'SMOKE_SECONDARY_ACCOUNT_PASSWORD']) {
        const env = { ...liveEnv }; delete env[name];
        assert.throws(() => validateAcceptanceProfile(liveArgs, env), error => !error.message.includes('fabricated-foreign'));
    }
    for (const email of [liveEnv.SMOKE_LOGIN_EMAIL, liveEnv.SMOKE_SECONDARY_LOGIN_EMAIL.toUpperCase()]) {
        assert.throws(() => validateAcceptanceProfile(liveArgs, { ...liveEnv, SMOKE_LIVE_SESSIONS_FOREIGN_LOGIN_EMAIL: email }), /distinct/);
    }
    assert.throws(() => validateAcceptanceProfile(liveArgs, { ...liveEnv, SMOKE_LIVE_SESSIONS_NATIVE_EVIDENCE: 'relative' }), /absolute/);
    assert.throws(() => validateAcceptanceProfile(liveArgs, { ...liveEnv, SMOKE_ALLOW_BROWSER_ERRORS: '1' }), /browser errors/);
    assert.throws(() => validateAcceptanceProfile([...liveArgs, '--grep', '^RoboTeam restart'], liveEnv), /both complete feature identities/);
    assert.throws(() => validateAcceptanceProfile([...liveArgs, 'specs/01-webtty-core.spec.mjs'], liveEnv), /own separate two-test cohort/);
    assertLedgerResults(profile.cases, profile.cases.map(record), { terminal: true });
    for (const status of ['skipped', 'interrupted', 'timedOut', 'failed']) {
        const records = profile.cases.map(record); records[1].results[0].status = status;
        assert.throws(() => assertLedgerResults(profile.cases, records, { terminal: true }));
    }
    assert.throws(() => assertLedgerResults(profile.cases, [], { terminal: true }));
    assert.throws(() => assertLedgerResults(profile.cases, [record(profile.cases[0])], { terminal: true }));
    assert.doesNotThrow(() => validateAcceptanceProfile([...liveArgs, '--list'], { SMOKE_LIVE_SESSIONS: '1' }));
});

test('ledger retains all 44 historical identities, 24 required cases and two Live Sessions identities', () => {
    assert.equal(acceptanceLedger.identities.filter(entry => entry.cohort !== 'fresh-live-sessions').length, 44);
    assert.equal(acceptanceLedger.identities.length, 46);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance').length, 24);
    assert.equal(new Set(acceptanceLedger.identities.map(entry => entry.identity)).size, 46);
    // The WebAssist guest case needs an explicitly installed legacy-agents repository, so it is a flag-gated separate profile.
    const webAssistGuest = acceptanceLedger.identities.find(entry => entry.file === '15-webassist-guest.spec.mjs');
    assert.equal(webAssistGuest.disposition, 'separate-profile');
    assert.deepEqual(webAssistGuest.requiredFlags, { SMOKE_WEBASSIST: '1' });
    for (const entry of acceptanceLedger.identities) {
        const escaped = entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const selection = selectAcceptanceCases([entry.selection.spec, '--grep', `^${escaped}$`]);
        assert.deepEqual(selection.cases.map(value => value.identity), [entry.identity]);
    }
});

test('missing image pins, profile flags and private sign-in inputs fail before collectors', () => {
    for (const name of ['SMOKE_EXPECT_BOX_IMAGE_ID', 'SMOKE_EXPECT_BOX_IMAGE_REF', 'SMOKE_PLOINKY_BOX_CONTAINER', 'SMOKE_RELEASE_MANIFEST', 'SMOKE_BOX_BASE_URL', 'SMOKE_WORKSPACE_ROOT', 'SMOKE_ACCOUNT_PASSWORD', 'SMOKE_SECONDARY_LOGIN_EMAIL', 'SMOKE_WEBTTY_WATCHER_USERNAME', 'SMOKE_WEBTTY_CORE']) {
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

const publicRoomTitle = 'standalone loader serves the authenticated dashboard and a guest invitation';
const publicRoomArgs = ['--project=chromium', '--workers=1', '--retries=0', 'specs/30-webmeet-room-chat.spec.mjs', '--grep', publicRoomTitle];

test('public-room WebMeet gate is a required official-release identity that needs only the primary account', () => {
    const entry = acceptanceLedger.identities.find(value => value.title === publicRoomTitle);
    assert.equal(entry.cohort, 'official-release');
    assert.equal(entry.disposition, 'required-local-acceptance');
    assert.deepEqual(entry.requiredFlags, {});
    const env = { ...baseEnv };
    for (const name of Object.keys(env)) if (name.startsWith('SMOKE_SECONDARY_')) delete env[name];
    delete env.SMOKE_WEBTTY_CORE;
    const profile = validateAcceptanceProfile(publicRoomArgs, env);
    assert.deepEqual(profile.cases.map(value => value.identity), [entry.identity]);
    assert.equal(profile.box, true);
    assert.equal(profile.ledgerCoverage, true);
    assert.deepEqual({ ...profile.accounts }, { enabled: true, secondary: false, primaryAdmin: true, marketplaceLifecycleFixture: false });
    for (const name of ['SMOKE_LOGIN_EMAIL', 'SMOKE_ACCOUNT_PASSWORD', 'SMOKE_PLOINKY_BOX_CONTAINER', 'SMOKE_RELEASE_MANIFEST']) {
        const missing = { ...env }; delete missing[name];
        assert.throws(() => validateAcceptanceProfile(publicRoomArgs, missing), error => error.message.includes(name));
    }
    assert.throws(() => validateAcceptanceProfile([...publicRoomArgs, '--headed'], env), /headless/);
    assert.throws(() => validateAcceptanceProfile(publicRoomArgs, { ...env, SMOKE_ALLOW_BROWSER_ERRORS: '1' }), /browser errors/);
    const twoAccounts = validateAcceptanceProfile(['specs/30-webmeet-room-chat.spec.mjs', '--grep', 'two Explorer accounts can join one room and exchange chat'],
        { ...baseEnv, SMOKE_WEBMEET_HEADLESS: '1', SMOKE_WEBMEET_MEDIA: '1', SMOKE_MEDIA_TIMEOUT_MS: '60000' });
    assert.equal(twoAccounts.cases.length, 1);
    assert.equal(twoAccounts.accounts.secondary, true);
});

test('public-room gate source keeps its positive proof and its team-room negative control', () => {
    const specSource = fs.readFileSync(new URL('../specs/30-webmeet-room-chat.spec.mjs', import.meta.url), 'utf8');
    const start = specSource.indexOf(`test('${publicRoomTitle}'`);
    const end = specSource.indexOf("test('two Explorer accounts", start);
    assert.ok(start >= 0 && end > start);
    const body = specSource.slice(start, end);
    for (const required of [
        "roomType: 'guest'", "createRoom(page, teamTitle, { roomType: 'team' })",
        'readRoomShareLink(page, publicTitle)', 'storageState()', "{ cookies: [], origins: [] }",
        'joinStandaloneGuestRoom(guestPage, { url: publicRoomUrl', 'expectGuestVisibleToOwner(page, guestPage',
        'sendWebMeetChat(guestPage, guestMessage)', 'expectChatEntry(page, guestMessage, { author: guestDisplayName })',
        'sendWebMeetChat(page, ownerMessage)', 'expectChatEntry(guestPage, ownerMessage)',
        'openStandaloneWebMeet(deniedPage, { url: teamRoomUrl })', 'PUBLIC_ROOM_DENIED_MESSAGE',
        "toContain('Public room not found.')", "locator('#webmeetChatInput')).toHaveCount(0)",
        'forbiddenGuestAdmissionTools(deniedToolCalls)', 'deniedDiagnostics.actionableEvents()',
        'deleteRoomIfPresent(page, publicTitle)', 'deleteRoomIfPresent(page, teamTitle)',
    ]) assert.ok(body.includes(required), `gate source lost: ${required}`);
    assert.doesNotMatch(body, /signIn\(|trySignIn|openWebMeet\(guestPage|openWebMeet\(deniedPage/);
    assert.doesNotMatch(body, /allowBrowserErrors|SMOKE_ALLOW_BROWSER_ERRORS|acknowledgeExact/);
});

test('discovery and terminal pass matching refuses every false-pass outcome', () => {
    const cases = acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance');
    assert.doesNotThrow(() => assertLedgerResults(cases, cases.map(record), { terminal: true }));
    for (const count of [0, 23, 25]) assert.throws(() => assertLedgerResults(cases, Array.from({ length: count }, (_, index) => record(cases[index % 24]))));
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
        collect: async inputs => {
            assert.equal(inputs.expectedContainerName, 'fixture-box');
            assert.equal(inputs.generationMaxAgeMs, 1800000);
            assert.equal(inputs.requireActiveRoboTeamAgent, false);
            assert.equal('requireActiveAchillesCLI' in inputs, false);
            return evidence;
        }, fsApi };
    assert.equal(await collectAcceptancePreflight(options), evidence);
    for (const modified of [ { ...evidence, imageDigest: 'wrong' }, { ...evidence, liveBox: { ...evidence.liveBox, box: { imageId: 'wrong' } } }, { ...evidence, liveBox: { ...evidence.liveBox, workspaceSourceMount: { source: '/foreign' } } } ]) {
        await assert.rejects(collectAcceptancePreflight({ ...options, collect: async () => modified }));
    }
    await assert.rejects(collectAcceptancePreflight({ ...options, collect: async () => { throw new Error('Box outer container generation is not fresh enough for the release gate.'); } }), /not fresh/);
});

test('common preflight accepts the provider canonical localhost origin and still binds browser to Box exactly', async () => {
    const localhostEnv = { ...baseEnv, SMOKE_BASE_URL: 'http://localhost:8080', SMOKE_BOX_BASE_URL: 'http://localhost:8080' };
    const profile = validateAcceptanceProfile(args, localhostEnv);
    const evidence = { imageDigest: digest, repositories: { explorer: { repositoryPath: source } }, liveBox: {
        box: { imageId: digest }, workspaceSourceMount: { source: baseEnv.SMOKE_WORKSPACE_ROOT },
    } };
    const collected = [];
    const options = { profile, env: localhostEnv, baseURL: 'http://localhost:8080', boxBaseURL: 'http://localhost:8080',
        collect: async inputs => { collected.push(inputs); return evidence; },
        fsApi: { realpathSync: value => value, readFileSync: () => '{"tools":[]}' },
    };
    assert.equal(await collectAcceptancePreflight(options), evidence);
    assert.equal(collected[0].baseURL, 'http://localhost:8080');
    assert.equal(collected[0].boxBaseURL, 'http://localhost:8080');
    assert.equal(await collectAcceptancePreflight({ ...options, baseURL: 'http://localhost:8080/', boxBaseURL: 'http://localhost:8080/' }), evidence);
    assert.equal(await collectAcceptancePreflight({ ...options, baseURL: 'http://localhost', boxBaseURL: 'http://localhost:80' }), evidence);
    collected.length = 0;
    const rejections = [
        ['http://localhost:8080', 'http://127.0.0.1:8080', /same|equal|binding/],
        ['http://127.0.0.1:8080', 'http://localhost:8080', /same|equal|binding/],
        ['http://localhost:8080', 'http://localhost:18080', /same|equal|binding/],
        ['https://localhost:8080', 'https://localhost:8080', /binding/],
        ['http://localhost:8080', 'https://localhost:8080', /binding/],
        ['http://0.0.0.0:8080', 'http://0.0.0.0:8080', /binding/],
        ['http://[::1]:8080', 'http://[::1]:8080', /binding/],
        ['http://remote.example:8080', 'http://remote.example:8080', /binding/],
        ['http://localhost:8080/path', 'http://localhost:8080/path', /binding/],
        ['http://localhost:8080?x=1', 'http://localhost:8080?x=1', /binding/],
        ['http://private-user:private-password@localhost:8080', 'http://private-user:private-password@localhost:8080', /binding/],
        ['http://localhost:8080', '', /binding/],
        ['http://localhost:0', 'http://localhost:0', /binding/],
    ];
    for (const [browserOrigin, boxOrigin, expected] of rejections) {
        await assert.rejects(collectAcceptancePreflight({ ...options, baseURL: browserOrigin, boxBaseURL: boxOrigin }), error => (
            expected.test(error.message) && !/private-user|private-password/.test(error.message)
        ), `${browserOrigin} vs ${boxOrigin}`);
    }
    for (const address of ['0.0.0.0', '192.168.1.50']) {
        await assert.rejects(collectAcceptancePreflight({ ...options, env: { ...localhostEnv, SMOKE_BOX_ROUTER_BIND_ADDRESS: address } }), /localhost Box origin requires|not assigned to a network interface/);
    }
    assert.equal(collected.length, 0, 'an invalid binding must fail before observing any Box');
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
    assert.throws(() => assertMarketplaceLifecycleFixture({ marketplace: { agents: [] } }), /catalog fixture/);
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

test('canonical discovery finds exactly the 24 required identities without starting a browser or Box probe', () => {
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

test('source inventory discovers 44 historical and two additive identities while preserving historical dispositions', () => {
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
        assert.equal(cases.filter(entry => entry.disposition !== 'required-local-acceptance' && entry.cohort !== 'fresh-live-sessions').length, 20);
        assert.ok(cases.every(entry => entry.executionAllowedByThisPlan === false));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The paired boundary: the real current release verifier (found beside this repository) reads a real manifest
// over real temporary Git checkouts; the real collector and preflight consume its output. Only the live Box
// observation is a fixture, because no Box is deployed by a source test.
async function pairedRelease(t) {
    const verifierUrl = siblingUrl('ploinky', 'tests/release/verifyExplorerReleaseBundle.mjs');
    const verifier = await import(verifierUrl.href);
    const { LOCKED_ROOT_POSTINSTALL } = await import(siblingUrl('ploinky', 'tests/release/verifyCopilot421Bundle.mjs').href);
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'paired-release-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const git = (cwd, ...gitArgs) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const workspace = path.join(base, 'workspace');
    const evidenceDir = path.join(base, 'evidence');
    fs.mkdirSync(workspace); fs.mkdirSync(evidenceDir);
    const inventory = { schemaVersion: 1, kind: 'explorer-source-inventory', roboTeam: { repository: 'explorer', path: 'roboTeamAgent' }, repositories: {} };
    const roots = {};
    const add = (name, files, role = 'deployed-source') => {
        const root = path.join(workspace, name);
        roots[name] = root;
        fs.mkdirSync(root);
        git(root, 'init', '-q');
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content);
        }
        git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fixture');
        inventory.repositories[name] = { root, commit: git(root, 'rev-parse', 'HEAD'), role };
    };
    add('ploinky', { 'package.json': JSON.stringify({ scripts: { postinstall: LOCKED_ROOT_POSTINSTALL } }), 'globalDeps/package.json': '{"dependencies":{}}' });
    add('explorer', { 'roboTeamAgent/manifest.json': '{}' });
    add('achillesAgentLib', { 'package.json': '{}' }, 'provenance-reference');
    add('webmeet', { 'manifest.json': '{}' });
    add('OnlyOfficeAgent', { 'manifest.json': '{}' });
    const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2));
    const inventoryPath = path.join(evidenceDir, 'source-inventory.json');
    fs.writeFileSync(inventoryPath, inventoryBytes);
    const manifestPath = path.join(evidenceDir, 'standard-release.json');
    const inventorySha256 = (await import('node:crypto')).createHash('sha256').update(inventoryBytes).digest('hex');
    verifier.writeManifestFile({ inventoryPath, expectedInventorySha256: inventorySha256, imageDigest: digest, outputPath: manifestPath });
    const agentLibCommit = inventory.repositories.achillesAgentLib.commit;
    const liveBox = () => ({
        box: { imageId: digest, containerId: 'c'.repeat(64), semanticLabels: { agentLibMode: 'image', agentLibSourceIdHash: '4'.repeat(64), agentLibSourceRelativePath: 'image' } },
        ploinkySourceMount: { source: roots.ploinky }, workspaceSourceMount: { source: workspace },
    });
    const collect = (inputs, overrides = {}) => collectCopilotReleaseEvidence({ ...inputs, collectLiveBox: liveBox,
        readImageAgentLib: () => ({ commit: agentLibCommit }), realpathSync: value => value, ...overrides });
    return { verifierPath: fileURLToPath(verifierUrl), manifestPath, inventory, roots, workspace, collect, git, agentLibCommit, base };
}

test('actual standard verifier output passes the real collector and common preflight with the complete source map', async t => {
    const paired = await pairedRelease(t);
    const env = { ...baseEnv, SMOKE_WORKSPACE_ROOT: paired.workspace, SMOKE_RELEASE_MANIFEST: paired.manifestPath };
    const profile = validateAcceptanceProfile(args, env);
    let collected;
    const evidence = await collectAcceptancePreflight({ profile, env, manifestPath: paired.manifestPath, verifierPath: paired.verifierPath,
        baseURL: env.SMOKE_BASE_URL, boxBaseURL: env.SMOKE_BOX_BASE_URL,
        collect: inputs => { collected = inputs; return paired.collect(inputs); } });
    assert.equal(collected.verifierPath, paired.verifierPath, 'the exact absolute verifier path reaches the collector');
    assert.equal(collected.manifestPath, paired.manifestPath);
    assert.equal(evidence.releaseBundle.kind, 'explorer-release-bundle');
    assert.equal(evidence.imageDigest, digest);
    assert.deepEqual(Object.keys(evidence.repositories), ['OnlyOfficeAgent', 'achillesAgentLib', 'explorer', 'ploinky', 'webmeet']);
    for (const [name, entry] of Object.entries(paired.inventory.repositories)) {
        assert.deepEqual({ ...evidence.repositories[name] }, { name, repositoryPath: entry.root, commit: entry.commit, role: entry.role });
    }
    assert.equal(evidence.repositories.achillesAgentLib.role, 'provenance-reference');
    assert.equal('achillesCLI' in evidence.repositories, false);
    const post = await paired.collect({ manifestPath: paired.manifestPath, verifierPath: paired.verifierPath, baseURL: env.SMOKE_BASE_URL, boxBaseURL: env.SMOKE_BOX_BASE_URL });
    assert.doesNotThrow(() => assertAcceptanceGeneration(evidence, post));
    assert.equal(sameCopilotReleaseGeneration(evidence, post), true);
    const drifted = structuredClone(post);
    drifted.repositories.webmeet.commit = 'f'.repeat(40);
    assert.throws(() => assertAcceptanceGeneration(evidence, drifted), /source identity changed/);
    const dropped = structuredClone(post);
    delete dropped.repositories.OnlyOfficeAgent;
    assert.throws(() => assertAcceptanceGeneration(evidence, dropped), /source identity changed/);
    // The legacy verifier is refused for the current manifest, so no fallback can verify it.
    await assert.rejects(paired.collect({ manifestPath: paired.manifestPath, baseURL: env.SMOKE_BASE_URL, boxBaseURL: env.SMOKE_BOX_BASE_URL,
        verifierPath: fileURLToPath(siblingUrl('ploinky', 'tests/release/verifyCopilot421Bundle.mjs')) }), /Copilot 421 release bundle rejected/);
    // A dirty dependency refuses the actual verifier before any Box is observed.
    fs.appendFileSync(path.join(paired.roots.webmeet, 'manifest.json'), '\n');
    let observed = false;
    await assert.rejects(paired.collect({ manifestPath: paired.manifestPath, verifierPath: paired.verifierPath, baseURL: env.SMOKE_BASE_URL, boxBaseURL: env.SMOKE_BOX_BASE_URL },
        { collectLiveBox: () => { observed = true; return {}; } }), /webmeet repository has uncommitted or untracked content/);
    assert.equal(observed, false);
});

test('a three-core-only native map is refused when the release evidence contains dependencies', async t => {
    const paired = await pairedRelease(t);
    const release = await paired.collect({ manifestPath: paired.manifestPath, verifierPath: paired.verifierPath,
        baseURL: baseEnv.SMOKE_BASE_URL, boxBaseURL: baseEnv.SMOKE_BOX_BASE_URL });
    const generation = 'c'.repeat(64);
    const runtime = { containerId: 'runtime', containerName: 'robo', instanceId: 'instance', enableGeneration: 3 };
    const record = { schemaVersion: 1, robotId: 'default-123456', workspaceRoot: paired.workspace, outerContainerId: release.liveBox.box.containerId,
        imageDigest: release.imageDigest, repositories: JSON.parse(JSON.stringify(release.repositories)), initialRoboTeam: runtime,
        native: { backend: 'claude', model: 'configured-model', effort: 'configured-effort', version: '1.2.3', cliVersion: '1.2.3 (Claude Code)',
            sha256: 'd'.repeat(64), generation, cacheRoot: '/cache', executablePath: '/cache/shell/bin/claude',
            realpath: `/cache/claude/generations/${generation}/bin/claude` } };
    const config = { codingAgent: 'claude', models: { claude: 'configured-model' }, efforts: { claude: 'configured-effort' } };
    const options = { release, runtime, workspaceRoot: paired.workspace, config };
    assert.doesNotThrow(() => validateNativeEvidence(record, options), 'the complete map satisfies every other native assertion');
    const core = Object.fromEntries(['ploinky', 'explorer', 'achillesAgentLib'].map(name => [name, record.repositories[name]]));
    assert.equal(Object.keys(core).length, 3);
    assert.ok(Object.keys(release.repositories).length > 3, 'the release evidence contains dependencies');
    assert.throws(() => validateNativeEvidence({ ...record, repositories: core }, options), /complete verified source graph/);
    for (const dependency of ['webmeet', 'OnlyOfficeAgent']) {
        const missingOne = { ...record.repositories };
        delete missingOne[dependency];
        assert.throws(() => validateNativeEvidence({ ...record, repositories: missingOne }, options), /complete verified source graph/, dependency);
    }
    assert.throws(() => validateNativeEvidence({ ...record, repositories: { ...record.repositories, webmeet: { ...record.repositories.webmeet, commit: 'e'.repeat(40) } } }, options), /complete verified source graph/);
});

// ---- C5 ledger entry (D12) and the runner's per-invocation evidence (G6, Δ6, Δ7) ------------------------------------------------------

test('ledger 06 is the route-A C5 separate profile, and the counts stay 46, 44, 24 and 20 with one blocked identity left', () => {
    const live = acceptanceLedger.identities.find(entry => entry.file === '06-copilot-live-skills.spec.mjs');
    assert.equal(live.cohort, 'copilot-live-skills');
    assert.equal(live.disposition, 'separate-profile');
    assert.deepEqual(live.requiredFlags, { SMOKE_COPILOT_LIVE_SKILLS: '1', CODEX_TEST_AUTH_GATE: 'c5', CODEX_TEST_AUTH_SOURCE: 'owner' });
    assert.equal(live.runner, 'npm run test:copilot-live-skills');
    assert.equal(live.executionAllowedByThisPlan, false);
    assert.match(live.prerequisite, /route-A parent/);
    assert.equal(acceptanceLedger.identities.length, 46);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.cohort !== 'fresh-live-sessions').length, 44);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.disposition === 'required-local-acceptance').length, 24);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.disposition === 'blocked-B+C-preflight').length, 1);
    assert.equal(acceptanceLedger.identities.filter(entry => entry.disposition !== 'required-local-acceptance' && entry.cohort !== 'fresh-live-sessions').length, 20);
    // The package script launches the parent, never the runner directly.
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['test:copilot-live-skills'], 'CODEX_TEST_AUTH_GATE=c5 node ./scripts/codex-test-auth.mjs run');
    // The spec source line the ledger records is the test's own line.
    const spec = fs.readFileSync(new URL('../specs/06-copilot-live-skills.spec.mjs', import.meta.url), 'utf8').split('\n');
    assert.match(spec[live.sourceLine - 1], /test\('one native conversation consumes local edits/);
});

test('selecting spec 06 without the parent gate variables is refused before any collector, naming CODEX_TEST_AUTH_GATE=c5', () => {
    const c5Args = ['--project=chromium', '--workers=1', '--retries=0', 'specs/06-copilot-live-skills.spec.mjs'];
    assert.throws(() => validateAcceptanceProfile(c5Args, { ...baseEnv, SMOKE_COPILOT_LIVE_SKILLS: '1' }), /CODEX_TEST_AUTH_GATE=c5/);
    assert.throws(() => validateAcceptanceProfile(c5Args, { ...baseEnv, SMOKE_COPILOT_LIVE_SKILLS: '1', CODEX_TEST_AUTH_GATE: 'c5' }), /CODEX_TEST_AUTH_SOURCE=owner/);
    assert.throws(() => validateAcceptanceProfile(c5Args, { ...baseEnv, SMOKE_COPILOT_LIVE_SKILLS: '1', CODEX_TEST_AUTH_GATE: 'c5', CODEX_TEST_AUTH_SOURCE: 'stream' }), /CODEX_TEST_AUTH_SOURCE=owner/);
    const profile = validateAcceptanceProfile([...c5Args, '--list'], { SMOKE_COPILOT_LIVE_SKILLS: '1', CODEX_TEST_AUTH_GATE: 'c5', CODEX_TEST_AUTH_SOURCE: 'owner' });
    assert.deepEqual(profile.cases.map(entry => entry.file), ['06-copilot-live-skills.spec.mjs']);
});

const bundle = { schemaVersion: 1, kind: 'explorer-release-bundle', sourceInventorySha256: 'b'.repeat(64) };
const commonEvidence = () => ({ releaseBundle: { ...bundle }, repositories: { explorer: { name: 'explorer', repositoryPath: '/w/AssistOSExplorer', commit: 'c'.repeat(40), role: 'deployed-source' } },
    liveBox: { generationMaxAgeMs: 1_800_000, imageCreatedAt: '2026-10-26T10:00:00.000Z', workspaceSourceMount: { source: '/w' },
        box: { containerId: 'd'.repeat(64), startedAt: '2026-10-26T11:00:00.000Z', imageId: digest, semanticLabels: {}, normalizedPortBindings: {} } } });

test('the preflight record carries the run id, the selection, its capture time, the release bundle and the complete source map', () => {
    const profile = validateAcceptanceProfile(args, baseEnv);
    const record = acceptancePreflightRecord({ profile, ledgerCoverage: profile.coverage, evidence: commonEvidence(), runId: '0f2b6c1e-8a4d-4c3b-9e5f-7a1b2c3d4e5f',
        args: [...args, '--grep', 'opens a working Copilot'], capturedAt: '2026-10-26T11:05:00.000Z' });
    assert.equal(record.runId, '0f2b6c1e-8a4d-4c3b-9e5f-7a1b2c3d4e5f');
    assert.equal(record.capturedAt, '2026-10-26T11:05:00.000Z');
    assert.deepEqual(record.specs, ['specs/01-webtty-core.spec.mjs']);
    assert.equal(record.grep, 'opens a working Copilot');
    assert.equal(record.releaseBundle.sourceInventorySha256, 'b'.repeat(64));
    assert.equal(record.ledgerCoverage, 'selected-ledger-identities');
    assert.equal(record.generationMaxAgeMs, 1_800_000);
    assert.deepEqual(record.box, commonEvidence().liveBox.box);
    assert.deepEqual(record.repositories, commonEvidence().repositories);
    assert.equal(acceptancePreflightRecord({ profile, ledgerCoverage: profile.coverage, evidence: commonEvidence(), runId: 'r', args, capturedAt: 'x' }).grep, null);
});

test('the common postflight refuses a changed release bundle, as it refuses a changed Box or source map', () => {
    const before = commonEvidence();
    assert.doesNotThrow(() => assertAcceptanceGeneration(before, commonEvidence()));
    const rehashed = commonEvidence(); rehashed.releaseBundle.sourceInventorySha256 = 'e'.repeat(64);
    assert.throws(() => assertAcceptanceGeneration(before, rehashed), /source identity changed/);
    const dropped = commonEvidence(); delete dropped.releaseBundle;
    assert.throws(() => assertAcceptanceGeneration(before, dropped), /source identity changed/);
});

test('the terminal postflight is written once, 0600, only for exit code 0 and a common postflight, and never overwritten', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-postflight-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, POSTFLIGHT_FILE);
    // A failed run, including one whose Copilot release postflight failed (the runner then has exitCode 1), writes nothing.
    assert.equal(writeTerminalPostflight({ artifactDir: root, exitCode: 1, runId: 'run-1', post: commonEvidence() }), 1);
    assert.equal(fs.existsSync(file), false);
    // No common postflight collection (no Box profile, or a failed common postflight) writes nothing either.
    assert.equal(writeTerminalPostflight({ artifactDir: root, exitCode: 0, runId: 'run-1', post: null }), 0);
    assert.equal(fs.existsSync(file), false);
    const now = () => Date.parse('2026-10-26T11:20:00.000Z');
    assert.equal(writeTerminalPostflight({ artifactDir: root, exitCode: 0, runId: 'run-1', post: commonEvidence(), now }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { runId: 'run-1', capturedAt: '2026-10-26T11:20:00.000Z', exitCode: 0,
        box: commonEvidence().liveBox.box, releaseBundle: bundle, repositories: commonEvidence().repositories });
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    // A second write is refused and turns the pass into a failure, rather than replacing the first verdict.
    const before = fs.readFileSync(file);
    assert.equal(writeTerminalPostflight({ artifactDir: root, exitCode: 0, runId: 'run-2', post: commonEvidence(), now }), 1);
    assert.ok(fs.readFileSync(file).equals(before));
});

test('the runner writes the preflight before Playwright and the terminal postflight as its last statement, after every post-run check', () => {
    const source = fs.readFileSync(new URL('../scripts/run-playwright.mjs', import.meta.url), 'utf8');
    const lines = source.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'process.exitCode = exitCode;');
    assert.match(lines.at(-2), /^exitCode = writeTerminalPostflight\(\{ artifactDir: childEnv\.SMOKE_ARTIFACT_DIR, exitCode, runId: childEnv\.SMOKE_RUN_ID, post: commonPostflight \}\);$/);
    assert.equal(source.split('writeTerminalPostflight(').length, 2, 'one call only');
    const writer = source.indexOf('exitCode = writeTerminalPostflight(');
    for (const check of ["readFileSync(path.join(childEnv.SMOKE_ARTIFACT_DIR, 'ledger-outcomes_codex.json')", 'assertAcceptanceGeneration(commonEvidence, post)',
        'sameScreenRuntimeGeneration(screenRuntimeEvidence, postRunEvidence)', 'sameCopilotReleaseGeneration(copilotReleaseEvidence, postRunEvidence)']) {
        const at = source.indexOf(check);
        assert.ok(at > 0 && at < writer, check);
    }
    // A failing Copilot release postflight sets exitCode = 1 before the writer, which then writes nothing.
    const copilot = source.indexOf('Post-Copilot release evidence failed');
    assert.ok(copilot > 0 && source.indexOf('exitCode = 1;', copilot) < writer);
    // The common postflight collection is the one the file describes, and it is only kept when it matched the preflight.
    assert.ok(source.indexOf('commonPostflight = post;') > source.indexOf('assertAcceptanceGeneration(commonEvidence, post)'));
    const preflight = source.indexOf('acceptancePreflightRecord({');
    assert.ok(preflight > 0 && preflight < source.indexOf("spawn(process.execPath, [cliPath, 'test', ...playwrightArgs]"));
    assert.match(source, /runId: childEnv\.SMOKE_RUN_ID, args: playwrightArgs,\s+capturedAt: new Date\(\)\.toISOString\(\)/);
});
