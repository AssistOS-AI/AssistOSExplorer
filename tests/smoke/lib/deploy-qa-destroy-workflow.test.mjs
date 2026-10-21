import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/destroy-explorer-qa.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

const PINNED_HASH = '7a31ab7775eb';
const PROTECTED_TUNNEL = '091c4096-d1c8-4dbc-bb12-0c6357431d96';
const DIGEST = `sha256:${'a'.repeat(64)}`;
// Absence patterns are assembled from parts so that the repository-wide search for retired
// names cannot match this test's own assertions.
const part = (...pieces) => pieces.join('');
const FORBIDDEN_IN_DESTROY = [
    ['the Box preparation call', part('prepareBox', 'ForCommand')],
    ['a Ploinky start', part('start', ' explorer')],
    ['a Ploinky destroy', part('" ', 'destroy')],
    ['a Ploinky binary variable', part('$PLO', 'INKY')],
    ['a recursive removal', part('rm', ' -rf')],
    ['a node recursive removal', part('rm', 'Sync')],
    ['a forced container removal', part('container', ' rm -f')],
    ['a privileged removal', part('su', 'do ')],
];

// ---------------------------------------------------------------- workflow slicing

const steps = source.split('\n      - name: ').slice(1).map(block => {
    const name = block.slice(0, block.indexOf('\n'));
    const run = block.match(/\n        run: \|\n([\s\S]*)$/);
    return {
        name,
        block,
        run: run ? run[1].replace(/^ {10}/gm, '') : null,
    };
});
const step = name => {
    const found = steps.find(candidate => candidate.name === name);
    assert.ok(found, `missing step ${name}`);
    return found;
};
function heredocs(script) {
    return [...script.matchAll(/<<'(\w+)'[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/g)]
        .map(match => ({ delimiter: match[1], body: match[2] }));
}
const memo = compute => {
    let cached;
    return () => (cached ??= compute());
};
// The extraction is lazy so that a workflow without the expected shape fails the tests that need
// the shape, with a named reason, instead of failing the whole file at load time.
const getHostStep = memo(() => {
    const found = steps.find(candidate => candidate.run?.includes("<<'REMOTE'"));
    assert.ok(found, 'no step uploads a script to the host');
    return found;
});
const getCloudflareStep = memo(() => {
    const found = steps.find(candidate => candidate.run?.includes('cfd_tunnel'));
    assert.ok(found, 'no step deletes the Cloudflare publication');
    return found;
});
const getValidateStep = memo(() => step('Validate GitHub configuration'));
const getRemoteBody = memo(() => {
    const doc = heredocs(getHostStep().run).find(entry => entry.delimiter === 'REMOTE');
    assert.ok(doc, 'the host step has no REMOTE script');
    return doc.body;
});
const getCloudflareScript = memo(() => {
    const doc = heredocs(getCloudflareStep().run).find(entry => entry.delimiter === 'NODE');
    assert.ok(doc, 'the Cloudflare step has no embedded program');
    return doc.body;
});

// ---------------------------------------------------------------- static contract (AC18)

test('the only input is delete_data: a boolean that defaults to false', () => {
    const header = source.slice(source.indexOf('workflow_dispatch:'), source.indexOf('\nconcurrency:'));
    const keys = [...header.matchAll(/^ {6}([A-Za-z_]+):$/gm)].map(match => match[1]);
    assert.deepEqual(keys, ['delete_data']);
    assert.match(header, /^ {8}type: boolean$/m);
    assert.match(header, /^ {8}default: false$/m);
    assert.match(header, /^ {8}description: 'Also delete the QA data \(\.data, workspace documents, encryption identity\)\. Unchecked keeps them for the next deploy\.'$/m);
    assert.doesNotMatch(source, /confirm_destroy|CONFIRM_DESTROY/);
    assert.match(source, /^ {2}DELETE_DATA: \$\{\{ inputs\.delete_data \}\}$/m);
    assert.doesNotMatch(source, /inputs\.(?:workspace_name|deploy_branch|ploinky_branch)|workspace_name/);
});

test('the workflow shares the deployment concurrency group and tests itself before any remote step', () => {
    assert.match(source, /^concurrency:\n {2}group: deploy-explorer-qa\n {2}cancel-in-progress: false$/m);
    assert.deepEqual(steps.map(candidate => candidate.name), [
        'Check out the reviewed teardown helpers',
        'Set up the teardown test runtime',
        'Test the teardown helpers and this workflow',
        'Validate GitHub configuration',
        'Prepare SSH key',
        'Tear down the Explorer QA Box on the host',
        'Delete the dedicated Cloudflare publication',
        'Create summary',
        'Cleanup',
    ]);
    assert.match(step('Check out the reviewed teardown helpers').block, /uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false/);
    assert.match(step('Set up the teardown test runtime').block, /uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: '24'/);
    assert.equal(
        step('Test the teardown helpers and this workflow').run.trim(),
        'QA_TEARDOWN_PRIVILEGED_TESTS=1 node --test tests/smoke/lib/qa-teardown.test.mjs tests/smoke/lib/deploy-qa-destroy-workflow.test.mjs',
    );
});

test('the pinned SSH identity, publication identity and shared-tunnel pin are fixed before any remote mutation', () => {
    for (const required of [
        "SSH_USER: 'admin'",
        "SSH_HOST: '45.136.70.141'",
        "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'",
        "WORKSPACE: 'explorerQaWorkspace'",
        "PUBLIC_HOST: 'explorer-qa.axiologic.dev'",
        "CLOUDFLARE_TUNNEL_NAME: 'explorer-qa'",
        `CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: '${PROTECTED_TUNNEL}'`,
    ]) {
        assert.equal(source.includes(required), true, `missing destroy workflow contract: ${required}`);
    }
    assert.match(getValidateStep().run, /\[ "\$CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID" != '091c4096-d1c8-4dbc-bb12-0c6357431d96' \]/);
    assert.match(getValidateStep().run, /case "\$\{DELETE_DATA:-\}" in\n {2}true\|false\) ;;/);
    assert.equal(source.match(/ssh-keyscan/g)?.length, 1, 'destroy host key must be scanned only in pinned preflight');
    assert.ok(
        source.indexOf('SSH_ED25519_FINGERPRINT') < source.indexOf('- name: Tear down the Explorer QA Box on the host'),
        'destroy target fingerprint must be established before remote mutation',
    );
    assert.match(source, /install -m 600 "\$RUNNER_TEMP\/explorer_qa_known_hosts"/);
    assert.doesNotMatch(source, /EXPLORER_QA_CLOUDFLARE_TUNNEL_(?:TOKEN|ID)/);
    assert.doesNotMatch(source, /tunnelTokenSecret|publication\/explorer-qa-tunnel/);
    assert.doesNotMatch(source, /(?<![\w.-])\/workspace(?![\w-])/, 'QA destroy uses the same-path host workspace');
    assert.doesNotMatch(source, /vars\.EXPLORER_QA_(?:SSH_USER|SSH_HOST|WORKSPACE)/);
    assert.doesNotMatch(source, /inputs\.(?:deploy_branch|ploinky_branch)|ploinky-proxy/);
});

test('the host teardown takes the host flock, uploads only the checked helpers and sends no Cloudflare credential', () => {
    const run = getHostStep().run;
    assert.match(
        run,
        /"flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation\.lock bash -s -- '\$REMOTE_DIR' '\$TEARDOWN_MODE' '\$SHA_TEARDOWN' '\$SHA_PRIVILEGED' '\$SHA_QUIESCE' '\$SOUL_GATEWAY_ROUTER_PORT'" <<'REMOTE' \| tee "\$RUNNER_TEMP\/explorer-qa-destroy\.log" \|\| status=\$\?/,
    );
    assert.match(run, /mktemp -d \/tmp\/explorer-qa-destroy\.XXXXXXXX/);
    assert.match(run, /for helper in qa-teardown\.mjs qa-teardown-privileged\.mjs quiesce-explorer-qa\.mjs; do\n {2}"\$\{SCP\[@\]\}"/);
    assert.ok(run.indexOf('trap cleanup_destroy_files EXIT') < run.indexOf('mktemp -d'), 'cleanup is armed before the directory exists');
    assert.match(run, /if \[ "\$status" -eq 75 \]; then\n {2}echo "::error::Another Explorer QA deployment operation holds the host lock/);
    assert.doesNotMatch(getHostStep().block, /CLOUDFLARE_API_TOKEN|secrets\.|vars\.EXPLORER_QA_CLOUDFLARE/);
    assert.doesNotMatch(getHostStep().block, /\n {8}env:/, 'the host step receives no secret or credential environment');
    assert.doesNotMatch(getRemoteBody(), /CLOUDFLARE|[Tt]oken|explorer_qa_destroy\.env/);
    assert.doesNotMatch(source, /explorer_qa_destroy\.env|write_shell_var/, 'no environment file is uploaded');
    assert.ok(source.indexOf('- name: Test the teardown') < source.indexOf('- name: Validate GitHub configuration'));
});

test('the remote script runs the identity checks, snapshot, plan, execute, snapshot comparison and Soul health in that order', () => {
    const marks = [
        ['pinned identity', "[ \"$(id -un)\" != 'admin' ]"],
        ['QA Node', 'export PATH="$QA_NODE_HOME/bin:$PATH"'],
        ['minimum Node', "-lt 22 ]"],
        ['pinned hash', "[ \"$PINNED_BOX_PATH_HASH\" != '7a31ab7775eb' ]"],
        ['checksum check', 'sha256sum -c -'],
        ['Soul probe', 'SOUL_UP_BEFORE=0'],
        ['first snapshot', 'protected-snapshot < /dev/null > "$PROTECTED_BEFORE_FILE"'],
        ['plan', 'qa-teardown.mjs" plan --scope destroy --mode "$TEARDOWN_MODE" --lock-held < /dev/null'],
        ['execute', 'qa-teardown.mjs" execute --scope destroy --mode "$TEARDOWN_MODE" --quiesce "$QUIESCE_POLICY" --plan-digest "$PLAN_DIGEST" --lock-held < /dev/null'],
        ['second snapshot', 'protected-snapshot < /dev/null > "$PROTECTED_AFTER_FILE"'],
        ['comparison', 'cmp -s "$PROTECTED_BEFORE_FILE" "$PROTECTED_AFTER_FILE"'],
        ['Soul health', 'if [ "$SOUL_UP_BEFORE" = "1" ] && ! curl -sf "$SOUL_HEALTH_URL"'],
    ];
    let previous = -1;
    for (const [label, text] of marks) {
        const index = getRemoteBody().indexOf(text);
        assert.ok(index > previous, `${label} must follow the previous stage (${text})`);
        previous = index;
    }
    assert.match(getRemoteBody(), /keep-data\) QUIESCE_POLICY=fatal ;;\n {2}delete-data\) QUIESCE_POLICY=skip ;;/);
    assert.equal(getRemoteBody().match(/mkdir/g), null, 'the remote script creates nothing');
    // An absent workspace must still reach the helpers: leftover containers, backups and state live elsewhere.
    assert.doesNotMatch(getRemoteBody(), /nothing to destroy/);
    assert.match(getRemoteBody(), /if \[ -L "\$WORK_DIR" \]; then/);
});

test('the destroy workflow never uses the Ploinky runtime and does no filesystem or engine work of its own', () => {
    for (const [label, forbidden] of FORBIDDEN_IN_DESTROY) {
        assert.equal(source.includes(forbidden), false, `the destroy workflow must not contain ${label}`);
    }
    assert.doesNotMatch(getRemoteBody(), /ploinky|\.runtime|\bgit\b/i);
    assert.doesNotMatch(getRemoteBody(), /\b(?:podman|docker)\b (?:container|volume|image) /);
    assert.doesNotMatch(source, /--reset-repos|--repo-branch|resolve_default_branch|edge-desired|inspect_outer_box_status/);
});

test('the QA-scoped Node is selected before the pinned hash and the helpers run', () => {
    const selectNode = getRemoteBody().indexOf('export PATH="$QA_NODE_HOME/bin:$PATH"');
    assert.ok(selectNode > 0, 'destroy must prefer the deploy-installed QA Node');
    assert.match(getRemoteBody(), /QA_NODE_HOME="\/home\/admin\/\.qa-deployment-tools\/node-v24\.19\.0-linux-\$QA_NODE_ARCH"/);
    assert.match(getRemoteBody(), /--version 2>\/dev\/null\)" = 'v24\.19\.0' \]/);
    assert.match(getRemoteBody(), /process\.versions\.node\.split\("\."\)\[0\]'\)" -lt 22 \]/);
    for (const marker of ['PINNED_BOX_PATH_HASH="$(', 'qa-teardown.mjs" protected-snapshot', 'qa-teardown.mjs" plan']) {
        assert.ok(selectNode < getRemoteBody().indexOf(marker), `QA Node must be selected before ${marker}`);
    }
});

test('the Cloudflare deletion runs on the runner only after a successful host teardown and refuses the protected tunnel', () => {
    const hostIndex = steps.indexOf(getHostStep());
    const cloudflareIndex = steps.indexOf(getCloudflareStep());
    assert.equal(cloudflareIndex, hostIndex + 1);
    assert.match(getCloudflareStep().block, /\n {8}if: success\(\)\n/);
    assert.doesNotMatch(getCloudflareStep().run, /\bssh\b|\bscp\b|flock/);
    assert.match(getCloudflareStep().block, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.EXPLORER_QA_CLOUDFLARE_API_TOKEN \}\}/);
    assert.match(getCloudflareScript(), /if \(protectedTunnelId !== '091c4096-d1c8-4dbc-bb12-0c6357431d96'\)/);
    assert.match(getCloudflareScript(), /if \(tunnelId === protectedTunnelId\) \{\n {2}throw new Error\('refusing to delete the protected shared Cloudflare tunnel'\);/);
    const guard = getCloudflareScript().indexOf('tunnelId === protectedTunnelId');
    assert.ok(guard > getCloudflareScript().indexOf("/^[a-f0-9-]{36}$/.test(tunnelId)"));
    assert.ok(guard < getCloudflareScript().indexOf('request(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`)'), 'the guard precedes any request that uses the tunnel id');
    const dns = getCloudflareScript().indexOf("request(`/zones/${zoneId}/dns_records/${records[0].id}`, { method: 'DELETE' })");
    const connections = getCloudflareScript().indexOf('/cfd_tunnel/${tunnelId}/connections');
    const tunnel = getCloudflareScript().indexOf("request(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' })");
    assert.ok(dns > 0 && dns < connections && connections < tunnel, 'DNS is deleted before the tunnel');
    assert.match(getCloudflareScript(), /Exact Explorer QA Cloudflare publication was already absent/);
    assert.match(getCloudflareScript(), /Exact Explorer QA Cloudflare publication deletion verified/);
    assert.match(step('Create summary').run, /Unrelated Cloudflare tunnels and routes: preserved/);
    assert.match(step('Create summary').run, /QA Box image: removed when present; retained when another container still uses it or when it is not the QA image/);
    assert.match(step('Create summary').run, /Router access policy: parked for the next deploy, which restores it/);
    assert.match(step('Cleanup').block, /if: always\(\)/);
});

test('every shell block parses and every embedded Node program is syntactically valid', t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-destroy-syntax-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const shells = [...new Set(['/bin/bash', 'bash'])];
    let checked = 0;
    for (const entry of steps.filter(candidate => candidate.run)) {
        for (const shell of shells) {
            const parsed = spawnSync(shell, ['-n'], { input: entry.run, encoding: 'utf8' });
            assert.equal(parsed.status, 0, `${shell} -n failed for step "${entry.name}": ${parsed.stderr}`);
            checked += 1;
        }
        for (const [index, doc] of heredocs(entry.run).entries()) {
            if (doc.delimiter === 'REMOTE') {
                for (const shell of shells) {
                    const parsed = spawnSync(shell, ['-n'], { input: doc.body, encoding: 'utf8' });
                    assert.equal(parsed.status, 0, `${shell} -n failed for the REMOTE heredoc: ${parsed.stderr}`);
                    checked += 1;
                }
            } else {
                const file = path.join(scratch, `${entry.name.replace(/\W+/g, '-')}-${index}.mjs`);
                fs.writeFileSync(file, doc.body);
                const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
                assert.equal(parsed.status, 0, `node --check failed for a ${doc.delimiter} heredoc: ${parsed.stderr}`);
                checked += 1;
            }
        }
    }
    assert.ok(checked >= 10, `only ${checked} syntax checks ran`);
});

// ---------------------------------------------------------------- sliced host teardown (AC19, probes)

const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

function hasRealSha256sum() {
    return spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status === 0;
}

const HELPER_STUB = (root) => `import fs from 'node:fs';
import path from 'node:path';
const [command, ...rest] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'stub.json'))}, 'utf8'));
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(root, 'events.log'))}, command + '\\n');
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))}, JSON.stringify({
    argv: process.argv.slice(2), dir: path.dirname(process.argv[1]), stdinBytes: stdin.length, nodeVersion: process.version,
}) + '\\n');
let entry = config[command];
if (command === 'protected-snapshot') {
    const counter = ${JSON.stringify(path.join(root, 'snapshot.count'))};
    const index = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(index + 1));
    entry = entry[Math.min(index, entry.length - 1)];
}
process.stdout.write(entry.stdout);
process.exit(entry.status);
`;

function plan(overrides = {}) {
    return JSON.stringify({ result: 'planned', digest: DIGEST, keep: [], delete: [], ...overrides });
}
function receipt(overrides = {}) {
    return JSON.stringify({ result: 'torn-down', removedContainers: [], removedImages: [], ...overrides });
}
const DEFAULT_CONFIG = {
    'protected-snapshot': [{ stdout: '[{"kind":"container","id":"soul"}]\n', status: 0 }],
    plan: { stdout: `${plan()}\n`, status: 0 },
    execute: { stdout: `${receipt()}\n`, status: 0 },
};

function stubScript(body) {
    return `#!/bin/bash\n${body}\n`;
}

function makeBin(root, { realFlock, home }) {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const write = (name, body) => fs.writeFileSync(path.join(bin, name), stubScript(body), { mode: 0o755 });
    const events = path.join(root, 'events.log');
    // Binaries the destroy host script must never call. Any call is recorded and fails.
    for (const name of ['podman', 'docker', 'sudo', 'git', 'ploinky']) {
        write(name, `echo "forbidden:${name} $*" >> '${events}'\nexit 99`);
    }
    write('id', `if [ "$1" = '-un' ]; then cat '${path.join(root, 'identity')}'; else exit 98; fi`);
    write('curl', `echo curl >> '${events}'
counter='${path.join(root, 'soul.count')}'
n=0; [ -f "$counter" ] && n="$(cat "$counter")"
echo $((n + 1)) > "$counter"
state="$(cut -d, -f$((n + 1)) '${path.join(root, 'soul')}')"
[ -n "$state" ] || state="$(cut -d, -f1 '${path.join(root, 'soul')}')"
[ "$state" = up ]`);
    if (!hasRealSha256sum()) write('sha256sum', 'exec shasum -a 256 "$@"');
    if (!realFlock) {
        write('flock', `echo "$*" >> '${path.join(root, 'flock.log')}'
if [ -e '${path.join(root, 'lock-held')}' ]; then exit 75; fi
[ "$1 $2 $3 $4" = '-n -E 75 --close' ] || { echo "unexpected flock arguments: $*" >&2; exit 97; }
shift 5
exec "$@"`);
    }
    write('scp', `src="\${@: -2:1}"
dest="\${@: -1}"
dest="\${dest#*:}"
cp "$src" "$dest"
echo "$(dirname "$dest")" >> '${path.join(root, 'uploads.log')}'
base="$(basename "$dest")"
if [ -f '${path.join(root, 'tamper')}' ] && [ "$(cat '${path.join(root, 'tamper')}')" = "$base" ]; then
  echo '// tampered' >> "$dest"
fi`);
    write('ssh', `cmd="\${@: -1}"
export HOME='${home}'
case "$cmd" in
  'umask 077; mktemp -d /tmp/explorer-qa-destroy.XXXXXXXX') eval "$cmd" ;;
  "flock "*|"rm -f '/tmp/explorer-qa-destroy."*) exec bash -c "$cmd" ;;
  *) echo "unexpected ssh command: $cmd" >> '${path.join(root, 'unexpected.log')}'; exit 96 ;;
esac`);
    return bin;
}

function makeRepo(root) {
    const repo = path.join(root, 'repo');
    const scripts = path.join(repo, '.github/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'qa-teardown.mjs'), HELPER_STUB(root));
    fs.writeFileSync(path.join(scripts, 'qa-teardown-privileged.mjs'), '// privileged stub\n');
    fs.writeFileSync(path.join(scripts, 'quiesce-explorer-qa.mjs'), '// quiesce stub\n');
    return repo;
}

function runHostStep(t, {
    deleteData = 'false', config = {}, identity = 'admin', workspace = null, lockHeld = false, soul = 'up,up',
    tamper = null, realFlock = false, holdRealLock = false, qaNode = false, runStep = getHostStep(), args = null,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-destroy-slice-'));
    const home = path.join(root, 'home/admin');
    const runnerHome = path.join(root, 'runner');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(runnerHome, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    t.after(() => {
        const uploads = path.join(root, 'uploads.log');
        if (fs.existsSync(uploads)) {
            for (const dir of new Set(fs.readFileSync(uploads, 'utf8').split('\n').filter(Boolean))) {
                if (/^\/tmp\/explorer-qa-destroy\.[A-Za-z0-9]{8}$/.test(dir)) fs.rmSync(dir, { recursive: true, force: true });
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const target = path.join(home, 'explorerQaWorkspace');
    if (workspace === 'preserved') {
        fs.mkdirSync(path.join(target, '.data/userPersistoAgent'), { recursive: true });
        fs.mkdirSync(path.join(target, 'testN2'), { recursive: true });
        fs.writeFileSync(path.join(target, '.data/userPersistoAgent/state.json'), '{}');
        fs.writeFileSync(path.join(target, 'testN2/doc.md'), 'document');
        fs.writeFileSync(path.join(target, '.env'), 'KEY=value\n');
    }
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'elsewhere'), target);
    if (workspace === 'file') fs.writeFileSync(target, 'not a directory');
    fs.writeFileSync(path.join(root, 'identity'), identity);
    fs.writeFileSync(path.join(root, 'soul'), soul);
    fs.writeFileSync(path.join(root, 'stub.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...config }));
    if (lockHeld) fs.writeFileSync(path.join(root, 'lock-held'), '');
    if (tamper) fs.writeFileSync(path.join(root, 'tamper'), tamper);
    if (qaNode) {
        const nodeBin = path.join(home, `.qa-deployment-tools/node-v24.19.0-linux-${ARCH}/bin`);
        fs.mkdirSync(nodeBin, { recursive: true });
        fs.writeFileSync(path.join(nodeBin, 'node'), stubScript(`[ "$1" = '--version' ] && { echo v24.19.0; exit 0; }
echo qa-node >> '${path.join(root, 'events.log')}'
exec '${process.execPath}' "$@"`), { mode: 0o755 });
    }
    const bin = makeBin(root, { realFlock: realFlock || holdRealLock, home });
    const repo = makeRepo(root);
    if (holdRealLock) {
        const lock = path.join(home, '.qa-deployment-operation.lock');
        fs.writeFileSync(lock, '');
        const holder = spawn('flock', [lock, 'sleep', '60'], { stdio: 'ignore' });
        t.after(() => holder.kill());
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        assert.notEqual(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the holder owns the lock');
    }
    const hash = crypto.createHash('sha256').update(path.resolve(target)).digest('hex').slice(0, 12);
    const script = runStep.run.replaceAll('/home/admin', home).replaceAll(PINNED_HASH, hash);
    const result = spawnSync('bash', ['-c', args ?? script], {
        encoding: 'utf8',
        timeout: 60000,
        env: {
            PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: runnerHome,
            SSH_USER: 'admin',
            SSH_HOST: 'qa-host.invalid',
            DELETE_DATA: deleteData,
            SOUL_GATEWAY_ROUTER_PORT: '8080',
            GITHUB_WORKSPACE: repo,
            RUNNER_TEMP: path.join(root, 'tmp'),
        },
    });
    const read = name => (fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : '');
    const events = read('events.log').split('\n').filter(Boolean);
    const calls = read('calls.jsonl').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const uploads = [...new Set(read('uploads.log').split('\n').filter(Boolean))];
    return { result, events, calls, uploads, target, root, read, deleteData };
}

// Runs the summary step against the log that the host step teed, as the workflow does after success.
function runSummaryStep(run) {
    const summaryFile = path.join(run.root, 'step-summary.md');
    const result = spawnSync('bash', ['-c', step('Create summary').run], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: path.join(run.root, 'tmp'),
            GITHUB_STEP_SUMMARY: summaryFile,
            DELETE_DATA: run.deleteData,
            SSH_USER: 'admin',
            SSH_HOST: 'qa-host.invalid',
            WORKSPACE: 'explorerQaWorkspace',
            PUBLIC_HOST: 'explorer-qa.axiologic.dev',
        },
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(summaryFile, 'utf8');
}

const argv = (run, command) => run.calls.filter(call => call.argv[0] === command).map(call => call.argv);

test('keep-data teardown plans, executes with a fatal quiesce, compares the snapshots and checks Soul in order', t => {
    const run = runHostStep(t, { deleteData: 'false' });
    assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
    assert.deepEqual(run.events, ['curl', 'protected-snapshot', 'plan', 'execute', 'protected-snapshot', 'curl']);
    assert.deepEqual(argv(run, 'plan'), [['plan', '--scope', 'destroy', '--mode', 'keep-data', '--lock-held']]);
    assert.deepEqual(argv(run, 'execute'), [[
        'execute', '--scope', 'destroy', '--mode', 'keep-data', '--quiesce', 'fatal', '--plan-digest', DIGEST, '--lock-held',
    ]]);
    assert.deepEqual(argv(run, 'protected-snapshot'), [['protected-snapshot'], ['protected-snapshot']]);
    assert.ok(run.calls.every(call => call.stdinBytes === 0), 'helpers must not read the script from stdin');
    assert.match(run.result.stdout, /^\[destroy-qa\] Teardown summary: \{"result":"torn-down"/m);
    assert.doesNotMatch(run.result.stdout, /Teardown receipt/);
    assert.match(run.result.stdout, /Protected host resource identities remained unchanged/);
    assert.equal(fs.existsSync(path.join(run.root, 'unexpected.log')), false);
});

test('delete-data teardown skips the quiesce', t => {
    const run = runHostStep(t, { deleteData: 'true' });
    assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
    assert.deepEqual(argv(run, 'plan'), [['plan', '--scope', 'destroy', '--mode', 'delete-data', '--lock-held']]);
    assert.deepEqual(argv(run, 'execute'), [[
        'execute', '--scope', 'destroy', '--mode', 'delete-data', '--quiesce', 'skip', '--plan-digest', DIGEST, '--lock-held',
    ]]);
});

test('AC19: the host teardown succeeds when nothing is left, without any Ploinky runtime or engine call', t => {
    const nothing = {
        plan: { stdout: `${plan({ nothingToDo: true })}\n`, status: 0 },
        execute: { stdout: `${receipt({ nothingToDo: true })}\n`, status: 0 },
    };
    for (const deleteData of ['false', 'true']) {
        const run = runHostStep(t, { deleteData, config: nothing, workspace: null });
        assert.equal(run.result.status, 0, `${deleteData}: ${run.result.stderr}${run.result.stdout}`);
        assert.equal(fs.existsSync(run.target), false, 'no workspace and no runtime exist on the host');
        assert.deepEqual(run.events.filter(event => event.startsWith('forbidden:')), []);
        assert.deepEqual(run.events.filter(event => ['plan', 'execute'].includes(event)), ['plan', 'execute']);
    }
});

test('AC19: a preserved-data-only workspace without a runtime is handed to the helpers and left untouched by the script', t => {
    const run = runHostStep(t, { workspace: 'preserved' });
    assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
    assert.equal(fs.existsSync(path.join(run.target, '.runtime')), false);
    assert.deepEqual(run.events.filter(event => event.startsWith('forbidden:')), []);
    for (const kept of ['.data/userPersistoAgent/state.json', 'testN2/doc.md', '.env']) {
        assert.equal(fs.existsSync(path.join(run.target, kept)), true, `${kept} stays; only the helpers may change the workspace`);
    }
    assert.deepEqual(run.events, ['curl', 'protected-snapshot', 'plan', 'execute', 'protected-snapshot', 'curl']);
});

test('the helper directory is removed after success, a refused plan and a held lock', t => {
    for (const options of [{}, { config: { plan: { stdout: '{"result":"refused"}\n', status: 1 } } }, { lockHeld: true }]) {
        const run = runHostStep(t, options);
        assert.equal(run.uploads.length, 1, 'the three helpers share one private directory');
        for (const dir of run.uploads) {
            assert.match(dir, /^\/tmp\/explorer-qa-destroy\.[A-Za-z0-9]{8}$/);
            assert.equal(fs.existsSync(dir), false, `${dir} must be removed`);
        }
    }
});

test('a refused or malformed plan stops before execute and changes nothing', t => {
    const cases = {
        refused: { stdout: '{"result":"refused","code":"QA_TEARDOWN_MOUNT_INSIDE"}\n', status: 1 },
        'exit 0 but refused': { stdout: '{"result":"refused"}\n', status: 0 },
        'missing digest': { stdout: '{"result":"planned"}\n', status: 0 },
        'short digest': { stdout: `${plan({ digest: 'sha256:abc' })}\n`, status: 0 },
        'digest without algorithm': { stdout: `${plan({ digest: 'a'.repeat(64) })}\n`, status: 0 },
        'two lines': { stdout: `${plan()}\n${plan()}\n`, status: 0 },
        'not json': { stdout: 'planned\n', status: 0 },
        empty: { stdout: '', status: 0 },
    };
    for (const [label, entry] of Object.entries(cases)) {
        const run = runHostStep(t, { config: { plan: entry } });
        assert.equal(run.result.status, 1, `${label}: ${run.result.stderr}${run.result.stdout}`);
        assert.equal(run.events.includes('execute'), false, `${label}: execute must not run`);
        assert.match(run.result.stdout, /nothing was changed/, label);
    }
});

test('a failed execute or a malformed receipt fails the step and skips the final snapshot', t => {
    const failed = runHostStep(t, { config: { execute: { stdout: '{"result":"refused","code":"QA_TEARDOWN_QUIESCE_FAILED"}\n', status: 1 } } });
    assert.equal(failed.result.status, 1);
    assert.deepEqual(failed.events, ['curl', 'protected-snapshot', 'plan', 'execute']);
    assert.match(failed.result.stdout, /QA_TEARDOWN_QUIESCE_FAILED/);
    assert.match(failed.result.stdout, /No container was stopped and nothing was deleted; Explorer QA is still up \(its nested services may need a restart\)\./);
    assert.match(failed.result.stdout, /Options: fix Explorer QA and dispatch the destroy workflow again, dispatch it with delete_data ticked \(that skips the quiesce\), or run the deploy workflow\./);
    assert.doesNotMatch(failed.result.stdout, /Re-run the destroy workflow to finish it/);
    const preflight = runHostStep(t, { config: { execute: { stdout: '{"result":"failed","code":"QA_TEARDOWN_QUIESCE_PREFLIGHT_FAILED","phase":"quiesce"}\n', status: 1 } } });
    assert.equal(preflight.result.status, 1);
    assert.match(preflight.result.stdout, /No container was stopped and nothing was deleted; Explorer QA is still up/);
    assert.match(preflight.result.stdout, /"phase":"quiesce"/);
    for (const code of ['QA_TEARDOWN_IMAGE_REMOVAL_UNVERIFIED', 'QA_TEARDOWN_FAILED']) {
        const other = runHostStep(t, { config: { execute: { stdout: `{"result":"failed","code":"${code}","phase":"images"}\n`, status: 1 } } });
        assert.equal(other.result.status, 1);
        assert.match(other.result.stdout, new RegExp(`teardown failed \\(${code}\\)\\. Re-run the destroy workflow to finish it\\.`));
        assert.doesNotMatch(other.result.stdout, /nothing was deleted/);
    }
    const unreadable = runHostStep(t, { config: { execute: { stdout: 'boom\n', status: 1 } } });
    assert.match(unreadable.result.stdout, /\(unknown\)\. Re-run the destroy workflow to finish it\./);
    for (const stdout of ['{"result":"planned"}\n', 'torn down\n', '', `${receipt()}\n${receipt()}\n`]) {
        const malformed = runHostStep(t, { config: { execute: { stdout, status: 0 } } });
        assert.equal(malformed.result.status, 1, JSON.stringify(stdout));
        assert.equal(malformed.events.filter(event => event === 'protected-snapshot').length, 1, JSON.stringify(stdout));
    }
});

test('a changed protected resource set or an unrecorded snapshot fails the step', t => {
    const changed = runHostStep(t, { config: { 'protected-snapshot': [
        { stdout: '[{"id":"soul"}]\n', status: 0 },
        { stdout: '[{"id":"soul"},{"id":"extra"}]\n', status: 0 },
    ] } });
    assert.equal(changed.result.status, 1);
    assert.match(changed.result.stdout, /protected host resources changed during QA teardown/);
    const unrecorded = runHostStep(t, { config: { 'protected-snapshot': [{ stdout: '{"result":"failed"}\n', status: 1 }] } });
    assert.equal(unrecorded.result.status, 1);
    assert.deepEqual(unrecorded.events, ['curl', 'protected-snapshot']);
});

test('a tampered helper fails the checksum check before any helper or probe runs', t => {
    for (const helper of ['qa-teardown.mjs', 'qa-teardown-privileged.mjs', 'quiesce-explorer-qa.mjs']) {
        const run = runHostStep(t, { tamper: helper });
        assert.notEqual(run.result.status, 0, helper);
        assert.equal(fs.existsSync(path.join(run.root, 'flock.log')), true, `${helper}: the locked script ran`);
        assert.equal(run.uploads.length, 1, `${helper}: the helpers were uploaded before the check`);
        assert.deepEqual(run.events, [], helper);
    }
});

test('the identity, workspace-type and mode checks run before any helper', t => {
    const wrongUser = runHostStep(t, { identity: 'root' });
    assert.equal(wrongUser.result.status, 1);
    assert.match(wrongUser.result.stdout, /not the pinned admin account/);
    assert.deepEqual(wrongUser.events, []);
    for (const workspace of ['symlink', 'file']) {
        const run = runHostStep(t, { workspace });
        assert.equal(run.result.status, 1, workspace);
        assert.match(run.result.stdout, /workspace identity path/);
        assert.deepEqual(run.events, [], workspace);
    }
    const badMode = runHostStep(t, { deleteData: 'maybe' });
    assert.equal(badMode.result.status, 1);
    assert.equal(badMode.uploads.length, 0);
    assert.equal(fs.existsSync(path.join(badMode.root, 'flock.log')), false);
});

test('Soul Gateway health is compared before and after, and a Soul that was already down does not fail the destroy', t => {
    const unhealthy = runHostStep(t, { soul: 'up,down' });
    assert.equal(unhealthy.result.status, 1);
    assert.match(unhealthy.result.stdout, /protected Soul Gateway became unhealthy/);
    const alreadyDown = runHostStep(t, { soul: 'down,down' });
    assert.equal(alreadyDown.result.status, 0, alreadyDown.result.stderr + alreadyDown.result.stdout);
});

const SENTINEL_FILE = 'SENTINEL-private-notes-2026.docx';
const SENTINEL_HASH = 'f'.repeat(64);
// Names that a generic file-name pattern accepts, so a filter that only checks the character set leaks them.
const SENTINEL_BACKUP = 'SENTINEL-notes.docx';
const SENTINEL_OTHER = 'SENTINEL-other.docx';
const SENTINEL_PENDING = 'SENTINEL-pending.docx';
const GENERATED_BACKUPS = ['redeploy-AbCd1234', 'redeploy-AbCd1234-helpers', '.pruning-redeploy-ZyXw9876'];
const GENERATED_DELETIONS = ['.explorerQaWorkspace.deleting-4242', '.qa-deployment-state.deleting-4243'];
const KEEP_DIGEST = `sha256:${'d'.repeat(64)}`;
const PRIVATE_PLAN = plan({
    result: 'planned',
    containers: [{ id: 'c'.repeat(64), name: SENTINEL_FILE, image: 'e'.repeat(64) }],
    images: { remove: [{ id: 'e'.repeat(64), tags: [SENTINEL_FILE] }], retained: [] },
    workspace: {
        keep: { top: [SENTINEL_FILE, 'WebMeet'] },
        identity: [{ relative: '.ploinky/data/master-key', sha256: SENTINEL_HASH }],
        pendingDeletions: [...GENERATED_DELETIONS, SENTINEL_PENDING],
    },
    legacyBackups: {
        remove: [GENERATED_BACKUPS[0], SENTINEL_BACKUP],
        replayTombstones: [GENERATED_BACKUPS[2], SENTINEL_OTHER],
        retained: [{ name: GENERATED_BACKUPS[1], class: 'rollback-attempted' }, { name: SENTINEL_OTHER, class: 'incomplete-redeploy' }],
        retainedSiblings: [GENERATED_BACKUPS[1], SENTINEL_BACKUP],
        unrecognized: [SENTINEL_BACKUP, SENTINEL_OTHER],
    },
    capacity: { sufficient: true },
});
const PRIVATE_RECEIPT = receipt({
    phase: 'done',
    removedContainers: [{ engine: 'podman', id: 'a'.repeat(64), name: SENTINEL_FILE }, { engine: 'podman', id: SENTINEL_FILE, name: 'x' }],
    removedImages: [{ engine: 'podman', id: 'b'.repeat(64), tags: [SENTINEL_FILE] }],
    retainedImages: [{ engine: 'podman', id: '1'.repeat(64), reason: 'retained-in-use' }],
    stash: 'created',
    marker: { operation: 'destroy-keep' },
    workspace: {
        result: 'reduced',
        deleted: [SENTINEL_FILE],
        keep: { top: [SENTINEL_FILE, 'WebMeet'], digest: KEEP_DIGEST },
        identity: [{ relative: '.ploinky/data/master-key', sha256: SENTINEL_HASH, uid: 1000 }],
        digest: `sha256:${'9'.repeat(64)}`,
    },
    finishedDeletions: [...GENERATED_DELETIONS, SENTINEL_PENDING],
    legacyBackups: { removed: [GENERATED_BACKUPS[0], SENTINEL_BACKUP], replayedTombstones: [GENERATED_BACKUPS[2], SENTINEL_OTHER] },
    retainedBackups: [
        { name: 'redeploy-ZyXw9876', reason: 'rollback-attempted' },
        { name: SENTINEL_BACKUP, reason: 'unrecognized' },
        { name: SENTINEL_OTHER, reason: 'unrecognized' },
        { name: SENTINEL_OTHER, reason: 'sibling-of-retained' },
        { name: GENERATED_BACKUPS[1], reason: 'sibling-of-retained' },
    ],
    warnings: [SENTINEL_FILE],
});

test('user file names and identity checksums in the helper receipts never reach the log or the step summary', t => {
    const leaks = text => {
        assert.doesNotMatch(text, new RegExp(SENTINEL_FILE.replace(/\W/g, '.')), 'a user file name leaked');
        assert.equal(text.includes(SENTINEL_HASH), false, 'an identity checksum leaked');
        assert.equal(text.includes('SENTINEL'), false, 'a sentinel leaked');
        assert.doesNotMatch(text, /master-key|WebMeet|"top"|"identity"/);
    };
    for (const deleteData of ['false', 'true']) {
        const ok = runHostStep(t, { deleteData, config: {
            plan: { stdout: `${PRIVATE_PLAN}\n`, status: 0 },
            execute: { stdout: `${PRIVATE_RECEIPT}\n`, status: 0 },
        } });
        assert.equal(ok.result.status, 0, ok.result.stderr + ok.result.stdout);
        const summary = runSummaryStep(ok);
        leaks(ok.result.stdout + ok.result.stderr);
        leaks(summary);
        // The safe fields are present: ids, digests, stash, marker and legacy-backup names with reasons.
        for (const text of [ok.result.stdout, summary]) {
            assert.match(text, /"removedContainers":\["a{64}"\]/);
            assert.match(text, /"removedImages":\["b{64}"\]/);
            assert.match(text, /"retainedImages":\[\{"id":"1{64}","reason":"retained-in-use"\}\]/);
            assert.match(text, new RegExp(`"keepDigest":"${KEEP_DIGEST}"`));
            assert.match(text, /"stash":"created"/);
            assert.match(text, /"marker":"destroy-keep"/);
            // Only generated names are printed; every other entry is counted.
            assert.match(text, /"legacyBackups":\{"removed":\{"names":\["redeploy-AbCd1234"\],"other":1\},"replayedTombstones":\{"names":\["\.pruning-redeploy-ZyXw9876"\],"other":1\}\}/);
            assert.match(text, /"retainedBackups":\{"named":\[\{"name":"redeploy-ZyXw9876","reason":"rollback-attempted"\},\{"name":"redeploy-AbCd1234-helpers","reason":"sibling-of-retained"\}\],"unrecognized":2,"other":1\}/);
            assert.match(text, /"finishedDeletions":\{"names":\["\.explorerQaWorkspace\.deleting-4242","\.qa-deployment-state\.deleting-4243"\],"other":1\}/);
            assert.match(text, /"warnings":1/);
        }
        assert.match(ok.result.stdout, new RegExp(`Teardown plan summary: .*"digest":"${DIGEST}"`));
        const planLine = ok.result.stdout.split('\n').find(line => line.startsWith('[destroy-qa] Teardown plan summary: '));
        assert.match(planLine, /"pendingDeletions":\{"names":\["\.explorerQaWorkspace\.deleting-4242","\.qa-deployment-state\.deleting-4243"\],"other":1\}/);
        assert.match(planLine, /"legacyBackups":\{"remove":\{"names":\["redeploy-AbCd1234"\],"other":1\},"replayTombstones":\{"names":\["\.pruning-redeploy-ZyXw9876"\],"other":1\},"retained":\{"names":\["redeploy-AbCd1234-helpers"\],"other":1\},"retainedSiblings":\{"names":\["redeploy-AbCd1234-helpers"\],"other":1\},"unrecognized":2\}/);
        assert.match(summary, /### Teardown receipt \(safe fields only\)/);
    }
    const privateFailure = JSON.stringify({ result: 'failed', code: 'QA_TEARDOWN_IMAGE_REMOVAL_UNVERIFIED', phase: 'images',
        removedContainers: [{ id: 'a'.repeat(64), name: SENTINEL_FILE }],
        workspace: { keep: { top: [SENTINEL_FILE] }, identity: [{ sha256: SENTINEL_HASH }] }, error: SENTINEL_FILE });
    const failures = {
        'execute failure': { config: { execute: { stdout: `${privateFailure}\n`, status: 1 } }, expectedOutput: /"code":"QA_TEARDOWN_IMAGE_REMOVAL_UNVERIFIED"/ },
        'plan refused': { config: { plan: { stdout: `${JSON.stringify({ result: 'refused', code: 'QA_TEARDOWN_MOUNT_INSIDE', detail: SENTINEL_FILE, identity: SENTINEL_HASH })}\n`, status: 1 } }, expectedOutput: /"code":"QA_TEARDOWN_MOUNT_INSIDE"/ },
        'plan malformed': { config: { plan: { stdout: `${PRIVATE_PLAN}\n${PRIVATE_PLAN}\n`, status: 0 } }, expectedOutput: /nothing was changed/ },
        'receipt malformed': { config: { execute: { stdout: `${PRIVATE_RECEIPT}\n${PRIVATE_RECEIPT}\n`, status: 0 } }, expectedOutput: /receipt is malformed/ },
        'receipt of another kind': { config: { execute: { stdout: `${JSON.stringify({ result: 'planned', workspace: { keep: { top: [SENTINEL_FILE] } }, identity: SENTINEL_HASH })}\n`, status: 0 } }, expectedOutput: /receipt is malformed/ },
        'snapshot failure': { config: { 'protected-snapshot': [{ stdout: `${JSON.stringify({ result: 'failed', code: 'QA_TEARDOWN_SNAPSHOT_FAILED', detail: SENTINEL_FILE })}\n`, status: 1 }] }, expectedOutput: /Snapshot failure code: QA_TEARDOWN_SNAPSHOT_FAILED/ },
    };
    for (const [label, { config, expectedOutput }] of Object.entries(failures)) {
        const run = runHostStep(t, { config });
        assert.equal(run.result.status, 1, label);
        assert.match(run.result.stdout, expectedOutput, label);
        leaks(run.result.stdout + run.result.stderr);
    }
});

test('the QA-scoped Node runs the helpers when it is installed', t => {
    const run = runHostStep(t, { qaNode: true });
    assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
    assert.match(run.result.stdout, /Using the QA-scoped Node v24\.19\.0/);
    assert.ok(run.events.includes('qa-node'), 'helpers ran under the QA Node stub');
});

test('flock held by another operation: exit 75 before the plan, no helper call, nothing quiesced', t => {
    const run = runHostStep(t, { lockHeld: true });
    assert.equal(run.result.status, 75);
    assert.deepEqual(run.events, []);
    assert.match(run.result.stdout + run.result.stderr, /Another Explorer QA deployment operation holds the host lock/);
    const flockArgs = fs.readFileSync(path.join(run.root, 'flock.log'), 'utf8');
    assert.match(flockArgs, /^-n -E 75 --close \S+\.qa-deployment-operation\.lock bash -s -- \/tmp\/explorer-qa-destroy\.[A-Za-z0-9]{8} keep-data [a-f0-9]{64} [a-f0-9]{64} [a-f0-9]{64} 8080$/m);
});

test('the real flock binary: a lock held by another process gives exit 75 before the plan', t => {
    const available = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;
    if (!available) {
        assert.notEqual(process.platform, 'linux', 'flock must exist on Linux runners and on the apparatus host');
        t.skip('flock is not installed on this platform; the wiring test above covers the argument shape and the Linux run covers the binary');
        return;
    }
    const free = runHostStep(t, { realFlock: true });
    assert.equal(free.result.status, 0, free.result.stderr + free.result.stdout);
    assert.ok(free.events.includes('plan'));
    const held = runHostStep(t, { holdRealLock: true });
    assert.equal(held.result.status, 75, held.result.stderr + held.result.stdout);
    assert.deepEqual(held.events, [], 'neither the plan nor any other helper ran');
    assert.match(held.result.stdout + held.result.stderr, /Another Explorer QA deployment operation holds the host lock/);
});

// ---------------------------------------------------------------- sliced validation step

function runValidate(t, env = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-destroy-validate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.writeFileSync(path.join(bin, 'ssh-keyscan'), stubScript(`echo scanned >> '${path.join(root, 'scan.log')}'\necho '45.136.70.141 ssh-ed25519 AAAA'`), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ssh-keygen'), stubScript('echo "256 SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA 45.136.70.141 (ED25519)"'), { mode: 0o755 });
    const result = spawnSync('bash', ['-c', getValidateStep().run], {
        encoding: 'utf8',
        env: {
            PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            RUNNER_TEMP: path.join(root, 'tmp'),
            SSH_KEY: 'key',
            SSH_USER: 'admin',
            SSH_HOST: '45.136.70.141',
            WORKSPACE: 'explorerQaWorkspace',
            SOUL_GATEWAY_WORKSPACE: 'soulGateway',
            SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA',
            CLOUDFLARE_API_TOKEN: 'scoped-token',
            CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
            CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
            CLOUDFLARE_TUNNEL_NAME: 'explorer-qa',
            CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: PROTECTED_TUNNEL,
            PUBLIC_HOST: 'explorer-qa.axiologic.dev',
            ROUTER_PORT: '8097',
            DELETE_DATA: 'false',
            ...env,
        },
    });
    return { result, scanned: fs.existsSync(path.join(root, 'scan.log')) };
}

test('validation accepts both delete_data values and rejects other values, a moved shared-tunnel pin and a Global API Key', t => {
    for (const value of ['true', 'false']) {
        const run = runValidate(t, { DELETE_DATA: value });
        assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
        assert.equal(run.scanned, true);
    }
    for (const env of [
        { DELETE_DATA: 'maybe' },
        { DELETE_DATA: '' },
        { CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: 'f'.repeat(8) + PROTECTED_TUNNEL.slice(8) },
        { CLOUDFLARE_API_TOKEN: 'cfk_global' },
        { WORKSPACE: 'soulGateway' },
        { SSH_HOST: '203.0.113.9' },
    ]) {
        const run = runValidate(t, env);
        assert.notEqual(run.result.status, 0, JSON.stringify(env));
        assert.equal(run.scanned, false, `${JSON.stringify(env)} must fail before the host key is scanned`);
    }
});

// ---------------------------------------------------------------- sliced Cloudflare deletion

const FETCH_STUB = (statePath, logPath) => `import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const log = entry => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + '\\n');
const json = (result, status = 200) => new Response(JSON.stringify({ success: status === 200, result, errors: [] }), { status });
globalThis.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const method = init.method || 'GET';
    const route = pathname.replace('/client/v4', '');
    log({ method, route });
    const tunnelId = state.tunnels[0]?.id;
    if (method === 'GET' && /\\/cfd_tunnel$/.test(route)) return json(state.tunnelDeleted ? [] : state.tunnels);
    if (method === 'GET' && /\\/dns_records$/.test(route)) return json(state.dnsDeleted ? [] : state.records);
    if (method === 'GET' && /\\/cfd_tunnel\\/[^/]+\\/configurations$/.test(route)) return json({ config: { ingress: state.ingress } });
    if (method === 'GET' && /\\/cfd_tunnel\\/[^/]+$/.test(route)) return json({ id: tunnelId, name: state.tunnels[0].name, deleted_at: null });
    if (method === 'DELETE' && /\\/dns_records\\//.test(route)) { state.dnsDeleted = true; return json({}); }
    if (method === 'DELETE' && /\\/connections$/.test(route)) return json({});
    if (method === 'DELETE' && /\\/cfd_tunnel\\/[^/]+$/.test(route)) {
        if (!state.dnsDeleted && state.records.length) return json({}, 400);
        state.tunnelDeleted = true; return json({});
    }
    return json(null, 404);
};
`;

const TUNNEL_ID = '12345678-1234-1234-1234-123456789abc';
const dedicatedTunnel = (id = TUNNEL_ID) => ({ id, name: 'explorer-qa', deleted_at: null });
const dedicatedRecord = (id = TUNNEL_ID) => ({
    id: 'c'.repeat(32), name: 'explorer-qa.axiologic.dev', type: 'CNAME', content: `${id}.cfargotunnel.com`, proxied: true,
});
const OWN_INGRESS = [{ hostname: 'explorer-qa.axiologic.dev', service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }];

function runCloudflare(t, state, env = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-destroy-cloudflare-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const statePath = path.join(root, 'state.json');
    const logPath = path.join(root, 'requests.jsonl');
    fs.writeFileSync(statePath, JSON.stringify({ ingress: OWN_INGRESS, ...state }));
    const preload = path.join(root, 'fetch.mjs');
    fs.writeFileSync(preload, FETCH_STUB(statePath, logPath));
    const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module'], {
        input: getCloudflareScript(),
        encoding: 'utf8',
        timeout: 30000,
        env: {
            PATH: process.env.PATH,
            CLOUDFLARE_API_TOKEN: 'scoped-token',
            CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
            CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
            CLOUDFLARE_TUNNEL_NAME: 'explorer-qa',
            PUBLIC_HOST: 'explorer-qa.axiologic.dev',
            CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: PROTECTED_TUNNEL,
            ...env,
        },
    });
    const requests = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
    return { result, requests, deletes: requests.filter(request => request.method === 'DELETE').map(request => request.route.replace(/^\/(?:accounts|zones)\/[a-f0-9]+\//, '')) };
}

test('Cloudflare deletion removes DNS, then the connections, then the tunnel, and verifies', t => {
    const run = runCloudflare(t, { tunnels: [dedicatedTunnel()], records: [dedicatedRecord()] });
    assert.equal(run.result.status, 0, run.result.stderr + run.result.stdout);
    assert.deepEqual(run.deletes, [`dns_records/${'c'.repeat(32)}`, `cfd_tunnel/${TUNNEL_ID}/connections`, `cfd_tunnel/${TUNNEL_ID}`]);
    assert.match(run.result.stdout, /deletion verified/);
});

test('Cloudflare deletion is idempotent when the publication is already absent', t => {
    const run = runCloudflare(t, { tunnels: [], records: [] });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.result.stdout, /already absent/);
    assert.deepEqual(run.deletes, []);
    const tunnelOnly = runCloudflare(t, { tunnels: [dedicatedTunnel()], records: [] });
    assert.equal(tunnelOnly.result.status, 0, tunnelOnly.result.stderr);
    assert.deepEqual(tunnelOnly.deletes, [`cfd_tunnel/${TUNNEL_ID}/connections`, `cfd_tunnel/${TUNNEL_ID}`]);
});

test('Cloudflare deletion refuses the protected shared tunnel before any detail request or deletion', t => {
    const run = runCloudflare(t, { tunnels: [dedicatedTunnel(PROTECTED_TUNNEL)], records: [dedicatedRecord(PROTECTED_TUNNEL)] });
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /refusing to delete the protected shared Cloudflare tunnel/);
    assert.deepEqual(run.deletes, []);
    assert.equal(run.requests.every(request => request.method === 'GET' && /(?:cfd_tunnel|dns_records)$/.test(request.route)), true, 'only the two inventory listings ran');
});

test('Cloudflare deletion refuses a moved protected-tunnel pin, ambiguous inventory and foreign DNS or routes', t => {
    const pinMoved = runCloudflare(t, { tunnels: [dedicatedTunnel()], records: [dedicatedRecord()] }, { CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: TUNNEL_ID });
    assert.notEqual(pinMoved.result.status, 0);
    assert.deepEqual(pinMoved.requests, [], 'the pin is checked before any request');
    const cases = {
        'two tunnels': { tunnels: [dedicatedTunnel(), dedicatedTunnel('87654321-1234-1234-1234-123456789abc')], records: [] },
        'DNS without a tunnel': { tunnels: [], records: [dedicatedRecord()] },
        'DNS pointing elsewhere': { tunnels: [dedicatedTunnel()], records: [dedicatedRecord(PROTECTED_TUNNEL)] },
        'unproxied DNS': { tunnels: [dedicatedTunnel()], records: [{ ...dedicatedRecord(), proxied: false }] },
        'unrelated route': { tunnels: [dedicatedTunnel()], records: [], ingress: [{ hostname: 'other.example', service: 'http://127.0.0.1:1' }, { service: 'http_status:404' }] },
        'wrong tunnel name': { tunnels: [{ ...dedicatedTunnel(), name: 'proxies' }], records: [] },
    };
    for (const [label, state] of Object.entries(cases)) {
        const run = runCloudflare(t, state);
        assert.notEqual(run.result.status, 0, label);
        assert.deepEqual(run.deletes, [], `${label}: nothing is deleted`);
    }
    const wrongIdentity = runCloudflare(t, { tunnels: [], records: [] }, { PUBLIC_HOST: 'proxies.axiologic.dev' });
    assert.notEqual(wrongIdentity.result.status, 0);
    assert.deepEqual(wrongIdentity.requests, []);
});
