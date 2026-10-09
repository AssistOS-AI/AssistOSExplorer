import fs from 'node:fs';
import path from 'node:path';
import { collectCopilotReleaseEvidence } from './copilot-release-evidence.mjs';
import { sameLiveBoxGeneration, parseLocalBoxBaseUrl, assertOriginBindAddress } from './live-box.mjs';
import { validateQaAcceptanceProfile } from './qa-acceptance-profile.mjs';

export const acceptanceLedger = JSON.parse(fs.readFileSync(new URL('../acceptance-ledger.json', import.meta.url), 'utf8'));
const enabled = value => /^(1|true|yes|on)$/i.test(String(value || '').trim());

function optionValue(args, name) {
    if (args.filter(value => value === name || value.startsWith(`${name}=`)).length > 1) {
        throw new Error('Smoke gates forbid duplicate selection or execution options.');
    }
    const joined = args.find(value => value.startsWith(`${name}=`));
    if (joined) return joined.slice(name.length + 1);
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
}

export function selectAcceptanceCases(args, { ledger = acceptanceLedger, exists = file => fs.existsSync(new URL(`../${file}`, import.meta.url)) } = {}) {
    const specs = args.filter(value => !value.startsWith('-') && value.includes('.spec.mjs'));
    for (const spec of specs) {
        if (!/^specs\/[^/]+\.spec\.mjs$/.test(spec) || !exists(spec)) {
            throw new Error('Smoke selectors require an existing complete specs/*.spec.mjs filename; file:line selectors are forbidden.');
        }
    }
    const grep = optionValue(args, '--grep') ?? optionValue(args, '-g');
    const inverse = optionValue(args, '--grep-invert');
    let include, exclude;
    try {
        include = grep === undefined ? null : new RegExp(grep);
        exclude = inverse === undefined ? null : new RegExp(inverse);
    } catch {
        throw new Error('Smoke title grep must be a valid regular expression.');
    }
    // Playwright applies grep to the full title, including project/file/suites.
    // Discovery must still match the selected ledger identities exactly.
    const cases = ledger.identities.filter(entry => (
        specs.includes(entry.selection.spec)
        && (!include || include.test(entry.title))
        && (!exclude || !exclude.test(entry.title))
    ));
    if (specs.length && !cases.length) throw new Error('Smoke selection discovers zero required ledger identities.');
    return { specs, cases };
}

function required(env, name) {
    if (!String(env[name] || '').trim()) throw new Error(`Smoke preflight requires ${name}.`);
}

function accountInputs(env, secondary = false) {
    const prefix = secondary ? 'SMOKE_SECONDARY_' : 'SMOKE_';
    required(env, `${prefix}LOGIN_EMAIL`);
    const method = env[`${prefix}SIGN_IN_METHOD`];
    if (method === 'password') required(env, `${prefix}ACCOUNT_PASSWORD`);
    else if (method === 'totp') required(env, `${prefix}TOTP_SECRET`);
    else if (method === 'emailCode') required(env, 'SMOKE_EMAIL_CODE_COMMAND');
    else throw new Error(`Smoke preflight requires ${prefix}SIGN_IN_METHOD=password, emailCode or totp.`);
}

export function validateAcceptanceProfile(args, env = process.env, options = {}) {
    const selection = selectAcceptanceCases(args, options);
    for (const name of ['--config', '-c', '--output', '--reporter', '--update-snapshots', '-u', '--update-source-method']) {
        if (args.some(value => value.split('=')[0] === name)) {
            throw new Error(`Explorer smoke gates forbid Playwright output override '${name}'; all artifacts must remain under SMOKE_ARTIFACT_DIR.`);
        }
    }
    const listing = args.includes('--list');
    const box = (!listing && selection.specs.length === 0) || enabled(env.SMOKE_ACCEPTANCE)
        || env.SMOKE_DEPLOYMENT_MODE === 'box' || Boolean(env.SMOKE_PLOINKY_BOX_CONTAINER)
        || selection.cases.some(entry => ['fresh-webtty', 'official-release', 'supporting-61'].includes(entry.cohort));
    const separateScreen = enabled(env.SMOKE_WEBMEET_SCREEN) && !enabled(env.SMOKE_ACCEPTANCE)
        && selection.specs.length === 1 && selection.specs[0] === 'specs/30-webmeet-room-chat.spec.mjs';
    for (const entry of selection.cases) {
        for (const [name, value] of Object.entries(entry.requiredFlags)) {
            if (separateScreen && ['SMOKE_WEBMEET_HEADLESS', 'SMOKE_WEBMEET_MEDIA', 'SMOKE_MEDIA_TIMEOUT_MS'].includes(name)) continue;
            if (String(env[name] || '') !== value) throw new Error(`Smoke preflight requires ${name}=${value} for the selected identity.`);
        }
    }
    for (const [name, requiredValue] of [['--workers', '1'], ['--retries', '0'], ['--project', 'chromium']]) {
        const value = optionValue(args, name);
        if (value !== undefined && value !== requiredValue) throw new Error(`Smoke gates require ${name}=${requiredValue}.`);
    }
    const acceptance = box || enabled(env.SMOKE_ACCEPTANCE);
    if (acceptance) {
        if (!selection.specs.length) throw new Error('Box acceptance requires explicit complete spec filenames.');
        if ((!separateScreen && args.includes('--headed')) || args.includes('--debug') || args.includes('--ui') || args.includes('--headless=false')) {
            throw new Error('Box acceptance requires Chromium headless execution.');
        }
        if (String(env.SMOKE_GPT_RESEARCHER || '0') !== '0') throw new Error('Box acceptance requires SMOKE_GPT_RESEARCHER=0.');
        if (enabled(env.SMOKE_ALLOW_BROWSER_ERRORS)) throw new Error('Box acceptance disallows browser errors.');
        for (const name of ['--repeat-each', '--shard', '--last-failed', '--only-changed', '--test-list', '--test-list-invert', '-j']) {
            if (args.some(value => value.split('=')[0] === name)) throw new Error('Box acceptance forbids test selection/worker overrides outside complete spec filenames and title grep.');
        }
    }
    const dualAccounts = selection.cases.some(entry => entry.title === 'two Explorer accounts can join one room and exchange chat'
        || entry.cohort === 'fresh-webtty' || entry.cohort === 'supporting-61');
    const guestOnly = selection.cases.length > 0 && selection.cases.every(entry => entry.cohort === 'supporting-15');
    const accounts = { enabled: acceptance && !guestOnly, secondary: dualAccounts, primaryAdmin: true,
        searchAgentFixture: selection.specs.includes('specs/04-marketplace-lifecycle.spec.mjs'),
    };
    if (!listing) {
        for (const entry of selection.cases) {
            for (const name of entry.privateInputNamesOrCategories.filter(value => /^SMOKE_/.test(value))) required(env, name);
        }
        if (selection.cases.some(entry => entry.selection.spec === 'specs/50-onlyoffice-dpu.spec.mjs')) {
            required(env, 'SMOKE_PLOINKY_BIN');
            if (!path.isAbsolute(env.SMOKE_PLOINKY_BIN)) throw new Error('SMOKE_PLOINKY_BIN must be absolute.');
        }
        if (box) {
            for (const name of ['SMOKE_PLOINKY_BOX_CONTAINER', 'SMOKE_EXPECT_BOX_IMAGE_ID', 'SMOKE_EXPECT_BOX_IMAGE_REF', 'SMOKE_BOX_BASE_URL', 'SMOKE_WORKSPACE_ROOT', 'SMOKE_BASE_URL']) required(env, name);
            if (!/^sha256:[0-9a-f]{64}$/.test(env.SMOKE_EXPECT_BOX_IMAGE_ID)) throw new Error('SMOKE_EXPECT_BOX_IMAGE_ID must be immutable sha256.');
            if (!path.isAbsolute(env.SMOKE_WORKSPACE_ROOT)) throw new Error('SMOKE_WORKSPACE_ROOT must be absolute.');
            const manifestName = env.SMOKE_SOURCE_VERIFICATION === 'local-snapshot' ? 'SMOKE_LOCAL_SNAPSHOT_MANIFEST' : 'SMOKE_RELEASE_MANIFEST';
            required(env, manifestName);
            if (!path.isAbsolute(env[manifestName])) throw new Error(`${manifestName} must be absolute.`);
        }
        if (accounts.enabled) {
            accountInputs(env);
            if (dualAccounts) {
                accountInputs(env, true);
                if (env.SMOKE_LOGIN_EMAIL.trim().toLowerCase() === env.SMOKE_SECONDARY_LOGIN_EMAIL.trim().toLowerCase()) {
                    throw new Error('Smoke preflight requires two distinct accounts.');
                }
            }
        }
    }
    const separateQa = enabled(env.SMOKE_QA_ACCEPTANCE);
    return Object.freeze({ ...selection, box, listing, acceptance, accounts, ledgerCoverage: !separateScreen && !separateQa,
        coverage: separateQa ? 'separate-qa-profile-no-local-box-acceptance'
            : separateScreen ? 'separate-screen-profile-no-ledger-acceptance' : 'selected-ledger-identities',
        imageAgePolicy: 'common-explicit-pins; common-image-age-disabled; generation<=30m; additional-profile-age-checks-retained',
    });
}

export async function collectAcceptancePreflight({ profile, env, manifestPath, verifierPath, baseURL, boxBaseURL,
    collect = collectCopilotReleaseEvidence, fsApi = fs } = {}) {
    if (!profile.box || profile.listing) return null;
    if (enabled(env.SMOKE_QA_ACCEPTANCE)) {
        validateQaAcceptanceProfile({ enabled: true, headed: false, baseURL, edgeIP: env.SMOKE_QA_EDGE_IP });
        throw new Error('QA edge-to-Box binding is unverified; common local Box acceptance cannot validate this separate profile.');
    } else {
        let application, box;
        try {
            application = parseLocalBoxBaseUrl(baseURL);
            box = parseLocalBoxBaseUrl(boxBaseURL);
        } catch {
            throw new Error('Local smoke acceptance requires a valid loopback browser/Box origin binding.');
        }
        assertOriginBindAddress(application, undefined, env);
        if (application.baseURL !== box.baseURL) {
            throw new Error('Local smoke browser origin must equal the inspected Box origin.');
        }
    }
    const evidence = await collect({
        manifestPath, verifierPath, baseURL, boxBaseURL,
        verificationMode: env.SMOKE_SOURCE_VERIFICATION || 'release',
        requireActiveAchillesCLI: false,
        expectedContainerName: env.SMOKE_PLOINKY_BOX_CONTAINER,
        expectedImageRef: env.SMOKE_EXPECT_BOX_IMAGE_REF,
        generationMaxAgeMs: 30 * 60_000,
    });
    if (evidence?.imageDigest !== env.SMOKE_EXPECT_BOX_IMAGE_ID || evidence?.liveBox?.box?.imageId !== env.SMOKE_EXPECT_BOX_IMAGE_ID) {
        throw new Error('Common smoke preflight image pin does not match inspected Box and verified manifest.');
    }
    if (evidence?.liveBox?.workspaceSourceMount?.source !== fsApi.realpathSync(env.SMOKE_WORKSPACE_ROOT)) {
        throw new Error('Common smoke preflight inspected workspace binding does not match SMOKE_WORKSPACE_ROOT.');
    }
    const explorer = evidence?.repositories?.explorer?.repositoryPath;
    if (!path.isAbsolute(String(explorer || ''))) throw new Error('Smoke preflight requires the verified Explorer source path.');
    return evidence;
}

export function assertAcceptanceGeneration(before, after) {
    if (!sameLiveBoxGeneration(before?.liveBox, after?.liveBox)
        || JSON.stringify(before?.repositories) !== JSON.stringify(after?.repositories)) {
        throw new Error('Common smoke preflight Box generation or source identity changed during the cohort.');
    }
}

export function assertLedgerResults(cases, records, { terminal = false } = {}) {
    const expected = cases.map(entry => entry.identity).sort();
    const actual = records.map(entry => entry.identity).sort();
    if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Smoke discovery/outcomes do not exactly match the selected acceptance ledger identities.');
    if (terminal && records.some(entry => entry.expectedStatus !== 'passed' || entry.outcome !== 'expected'
        || entry.results?.length !== 1 || entry.results[0].status !== 'passed' || entry.results[0].retry !== 0)) {
        throw new Error('Smoke ledger requires passed terminal outcomes: no skips, retries, flakes, cancellations, blocked or expected failures.');
    }
}
