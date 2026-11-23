import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expectedHeader, probeOrigin, sourceFingerprint, runningRelease } from '../../../.github/scripts/qa-cache-origin.mjs';

const cdn = 'cloudflare-cdn-cache-control';
const release = '0123456789abcdef01234567';
const settings = { version: 1, applications: { 'bizanso/bizanso': { enabled: true, pageSeconds: 120 } }, held: {} };
const liveHeader = 'max-age=120, stale-if-error=900';

function fixture() {
    const routes = {
        '/': { status: 200, headers: { 'content-type': ['text/html; charset=utf-8'] },
            body: `<title>Bizanso</title><link href="/static/releases/${release}/css/index.css">` },
        '/docs': { status: 200, headers: { [cdn]: ['no-store'] } },
        '/how-it-works/': { status: 200, headers: { [cdn]: [liveHeader], 'content-type': ['text/html'] } },
        [`/static/releases/${release}/css/index.css`]: { status: 200, headers: { 'content-type': ['text/css'] } },
    };
    const options = { phase: 'post', expectedRelease: release, request: async path => routes[path] ?? { status: 404, headers: {} },
        settings: async () => settings };
    return { routes, options };
}

test('the origin gate checks the current release and the configured TTL, including disabled and held settings', async () => {
    const { routes, options } = fixture();
    assert.equal(await probeOrigin(options), 'verified');
    for (const seconds of [60, 120, 300]) {
        assert.equal(expectedHeader({ ...settings, applications: { 'bizanso/bizanso': { enabled: true, pageSeconds: seconds } } }),
            `max-age=${seconds}, stale-if-error=900`);
    }
    routes['/how-it-works/'].headers[cdn] = ['no-store'];
    for (const stored of [{ ...settings, applications: {} }, { ...settings, held: { 'bizanso/bizanso': {} } },
        { ...settings, applications: { 'bizanso/bizanso': { enabled: false, pageSeconds: 60 } } }]) {
        assert.equal(await probeOrigin({ ...options, settings: async () => stored }), 'verified');
    }
    assert.throws(() => expectedHeader({}), /Invalid/);
    assert.throws(() => expectedHeader({ ...settings, applications: { 'bizanso/bizanso': { enabled: true, pageSeconds: 0 } } }), /Invalid/);
});

test('legacy requires consistent header omission after deployment and T9 still fails', async () => {
    const { routes, options } = fixture();
    const old = { ...options, settings: () => assert.fail('legacy Router has no settings') };
    delete routes['/docs'].headers[cdn];
    await assert.rejects(probeOrigin(old), /inconsistent/i);
    delete routes['/how-it-works/'].headers[cdn];
    routes['/'].headers[cdn] = ['no-store'];
    await assert.rejects(probeOrigin(old), /inconsistent/i);
    delete routes['/'].headers[cdn];
    assert.equal(await probeOrigin(old), 'legacy');
    assert.equal(await probeOrigin({ ...old, phase: 'pre' }), 'legacy');
    await assert.rejects(probeOrigin({ ...old, forceFailure: true }), /gate/);
    for (const value of ['', 'public', ['no-store', 'no-store']]) {
        routes['/docs'].headers[cdn] = Array.isArray(value) ? value : [value];
        await assert.rejects(probeOrigin(old), /no-store|Ambiguous/);
    }
    routes['/docs'] = { status: 503, headers: {} };
    await assert.rejects(probeOrigin(old), /status/);
    assert.equal(await probeOrigin({ ...old, phase: 'pre' }), 'unverified');
    assert.equal(await probeOrigin({ ...old, phase: 'pre', request: async () => { throw new Error('Router down'); } }), 'unverified');
});

test('wrong headers, T9, wrong application and stale release paths all fail the gate', async () => {
    const { options } = fixture();
    await assert.rejects(probeOrigin({ ...options, forceFailure: true }), /gate/);
    for (const corrupt of [
        routes => { routes['/how-it-works/'].headers[cdn] = ['no-store']; },
        routes => { routes['/'].body = routes['/'].body.replace('<title>Bizanso', '<title>Explorer'); },
        routes => { routes['/'].body = routes['/'].body.replace(release, 'aaaaaaaaaaaaaaaaaaaaaaaa'); },
        routes => { routes['/static/releases/1123456789abcdef01234567/css/index.css'] = { status: 200 }; },
        routes => { routes['/how-it-works/'].status = 302; },
    ]) {
        const { routes, options } = fixture();
        corrupt(routes);
        await assert.rejects(probeOrigin(options));
    }
});

test('an internally consistent older application and a stale Router target both fail the release check', async t => {
    const root = mkdtempSync(join(process.cwd(), '.qa-release-inputs-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'static'));
    mkdirSync(join(root, 'src/server'), { recursive: true });
    writeFileSync(join(root, 'src/server/frontend-release.mjs'), '');
    const file = join(root, 'static/site.css');
    writeFileSync(file, 'old release');
    const oldFingerprint = sourceFingerprint(root);
    writeFileSync(file, 'incoming release');
    const incoming = sourceFingerprint(root);
    const { routes, options } = fixture();
    const readPage = async () => routes['/'].body;
    await assert.rejects(runningRelease(incoming, oldFingerprint, readPage), /incoming checkout/);
    assert.equal(await runningRelease(incoming, incoming, readPage), release);
    await assert.rejects(probeOrigin({ ...options, expectedRelease: 'f'.repeat(24) }), /different Bizanso release/);
});

test('the pre probe rejects a mismatched QA Box identity or bind before contacting the origin', () => {
    const source = readFileSync(new URL('../../../.github/scripts/qa-cache-origin.mjs', import.meta.url), 'utf8');
    const id = 'a'.repeat(64);
    const expected = { Id: id, Name: 'ploinky-box-explorerqaworkspace-7a31ab7775eb', State: { Running: true },
        Config: { Labels: { 'io.assistos.ploinky-box.path-hash': '7a31ab7775eb', 'io.assistos.ploinky-box.role': 'box' } },
        HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8097' }] } } };
    for (const inspected of [{ ...expected, Name: 'other-box' }, { ...expected, HostConfig: {} }]) {
        const mocks = `
            import child from 'node:child_process';
            import http from 'node:http';
            import { syncBuiltinESMExports } from 'node:module';
            child.execFileSync = (cmd, args) => {
                if (cmd === 'podman' && args[0] === 'ps') return ${JSON.stringify(id)};
                if (cmd === 'podman' && args[0] === 'inspect') return ${JSON.stringify(JSON.stringify([inspected]))};
                throw Error('Unexpected command');
            };
            http.get = () => { throw Error('Unexpected HTTP request'); };
            syncBuiltinESMExports();
        `;
        const run = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(mocks),
            '--input-type=module', '-', 'pre', 'explorer-qa.axiologic.dev', '8097', 'false'], { input: source, encoding: 'utf8' });
        assert.ifError(run.error);
        assert.equal(run.status, 1);
        assert.match(run.stderr, /QA Box identity or Router binding mismatch/);
        assert.equal(run.stdout, '');
    }
});

const helper = fileURLToPath(new URL('../../../.github/scripts/qa-cache-router.sh', import.meta.url));
// Fake the SSH command as a bash function. Probe and purge are never sent to a host.
// The generated sentinel exists only in memory, and the harness logs only operation names.
function shellGate(t, phase, response, fail = '') {
    const temp = mkdtempSync(join(process.cwd(), '.qa-cache-output-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const outputFile = join(temp, 'output');
    writeFileSync(outputFile, '');
    const marker = randomBytes(24).toString('hex');
    const script = `
        node() { printf '%064d\\n' 1; }
        ssh() {
            local command="\${!#}" input=''
            [[ "$command" != *"\${EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN:-__unset__}"* ]] || return 91
            if printenv EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN >/dev/null; then return 92; fi
            if [[ "$FAIL_AT" == *:* && "$command" == *"\${FAIL_AT%:*}"* ]]; then
                return "\${FAIL_AT##*:}"
            fi
            case "$command" in
                *"--input-type=module - 'identify'"*)
                    cat >/dev/null
                    printf '%064d\\n' 1
                    ;;
                *' ps --quiet --no-trunc '*)
                    printf '%064d\\n' 2
                    ;;
                *'--input-type=module - running '*)
                    cat >/dev/null
                    printf '%024d\\n' 3
                    ;;
                *'--input-type=module'*)
                    cat >/dev/null
                    [[ "$FAIL_AT" != probe ]] || return 1
                    echo "$FAKE_RESPONSE"
                    ;;
                *' sh help')
                    [[ "$FAIL_AT" == missing-command ]] || echo 'ploinky cache purge-config'
                    ;;
                *'var publication/explorer-qa-purge --stdin')
                    IFS= read -r input || :
                    [[ -n "$input" && "$input" == "$EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN" ]] || return 93
                    # A CLI error that echoes its input must also stay out of Actions logs.
                    printf '%s' "$input" >&2
                    [[ "$FAIL_AT" != store ]] || return 42
                    ;;
                *'cache purge-config --host explorer-qa.axiologic.dev --zone '*)
                    echo configured
                    [[ "$FAIL_AT" != configure ]] || return 42
                    ;;
                *'cache clear --host explorer-qa.axiologic.dev')
                    echo clear
                    if [[ "$FAIL_AT" == cooldown ]]; then
                        # Run the inner command with a CLI whose refusal has flock's exit code.
                        local quote="'" inner="\${command#* sh -c }"
                        inner="\${inner#"$quote"}"
                        inner="\${inner%%"$quote sh "*}"
                        ploinky() { echo cooldown; return 75; }
                        export -f ploinky
                        bash -c "$inner" sh cache clear --host explorer-qa.axiologic.dev
                        return $?
                    fi
                    [[ "$FAIL_AT" != clear ]] || return 42
                    ;;
                *) return 95 ;;
            esac
        }
        source "$1" "$2"
    `;
    const run = spawnSync('bash', ['-c', script, 'gate', helper, phase], { encoding: 'utf8', env: {
        PATH: process.env.PATH, HOME: '/unused', GITHUB_WORKSPACE: '/unused', PUBLIC_HOST: 'explorer-qa.axiologic.dev', ROUTER_PORT: '8097',
        SSH_USER: 'admin', SSH_HOST: '45.136.70.141', WORKSPACE: 'explorerQaWorkspace',
        QA_NODE_HOME: '/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64', CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        ...(fail === 'missing-secret' ? {} : { EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN: marker }), GITHUB_OUTPUT: outputFile, FAIL_AT: fail,
        FAKE_RESPONSE: response === 'absent' ? response : `${response} ${'a'.repeat(64)}`,
    } });
    assert.ifError(run.error);
    const output = run.stdout + run.stderr + readFileSync(outputFile, 'utf8');
    assert.equal(output.includes(marker), false, 'purge sentinel escaped into the command output');
    return { status: run.status, output };
}

test('the shell gate grants activation only after a verified origin and an accepted second purge', t => {
    const good = shellGate(t, 'post', 'verified');
    assert.equal(good.status, 0, good.output);
    assert.match(good.output, /configured\nclear\nQA Router accepted the post-deploy purge[^\n]*\nverified=true/);
    const pre = shellGate(t, 'pre', 'supported');
    assert.equal(pre.status, 0, pre.output);
    assert.match(pre.output, /configured\nclear/);
    for (const fail of ['probe', 'missing-command', 'missing-secret', 'store', 'configure', 'clear', 'cooldown']) {
        const bad = shellGate(t, 'post', 'verified', fail);
        assert.notEqual(bad.status, 0);
        assert.doesNotMatch(bad.output, /verified=true/);
    }
});

test('initial purge failures warn with R2 off and allow deployment', t => {
    for (const fail of ['missing-command', 'missing-secret', 'store', 'configure', 'clear', 'cooldown']) {
        const run = shellGate(t, 'pre', 'supported', fail);
        assert.equal(run.status, 0, fail + ': ' + run.output);
        assert.match(run.output, /::warning::.*R2 off/, fail);
        assert.doesNotMatch(run.output, /accepted|verified=true/);
        if (fail === 'cooldown') assert.match(run.output, /^cooldown$/m);
        if (!['clear', 'cooldown'].includes(fail)) assert.doesNotMatch(run.output, /^clear$/m);
    }
});

test('confirmed absence and legacy Routers need no secret and leave R2 off', t => {
    for (const [phase, result] of [['pre', 'absent'], ['pre', 'unverified'], ['pre', 'legacy'], ['post', 'legacy']]) {
        const run = shellGate(t, phase, result, 'missing-secret');
        assert.equal(run.status, 0, run.output);
        assert.match(run.output, /::warning::/);
        assert.doesNotMatch(run.output, /^clear$|verified=true/m);
        if (phase === 'post') assert.match(run.output, /verified=false/);
    }
});

test('host admission, transport failures and malformed helper output stop deployment', t => {
    for (const [phase, result] of [['pre', 'verified'], ['pre', 'unknown'], ['post', 'unverified'],
        ['post', 'absent'], ['post', 'supported'], ['post', 'unknown']]) {
        const run = shellGate(t, phase, result);
        assert.notEqual(run.status, 0);
        assert.doesNotMatch(run.output, /configured|::warning::|verified=true/);
    }
    for (const code of [1, 75, 125, 126, 255]) {
        for (const command of ['--input-type=module', 'sh help', 'var publication/', 'cache purge-config', 'cache clear']) {
            const run = shellGate(t, 'pre', 'supported', command + ':' + code);
            assert.equal(run.status, code, command + ': ' + run.output);
            assert.doesNotMatch(run.output, /::warning::|verified=true/);
        }
    }
    const admission = shellGate(t, 'pre', 'supported', 'probe');
    assert.notEqual(admission.status, 0);
    assert.doesNotMatch(admission.output, /configured|::warning::|verified=true/);
});
