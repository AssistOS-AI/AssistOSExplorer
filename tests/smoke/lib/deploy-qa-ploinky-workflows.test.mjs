import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
const deploy = read('deploy-explorer-qa-ploinky.yml');
const destroy = read('destroy-explorer-qa-ploinky.yml');

const WORKSPACE_REPOSITORIES_BLOCK = /# BEGIN QA workspace repositories[\s\S]*# END QA workspace repositories/;
const IMAGE_PRUNE_BLOCK = /# BEGIN QA image cleanup[\s\S]*# END QA image cleanup/;
// The function that runs a fixed program inside the Box. The registry check defines it before the shared block does.
const RUN_IN_BOX_FUNCTION = /run_in_box\(\) \{\n[^\n]*container exec[^\n]*\n\s*\}\n/g;

function runBlocks(source) {
    const blocks = [];
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^(\s*)run: \|$/);
        if (!match) continue;
        const body = [];
        const indent = match[1].length;
        let cursor = index + 1;
        while (cursor < lines.length && (!lines[cursor].trim() || lines[cursor].search(/\S/) > indent)) {
            body.push(lines[cursor].slice(indent + 2));
            cursor += 1;
        }
        blocks.push(body.join('\n'));
    }
    return blocks;
}

function step(source, name) {
    const start = source.indexOf(`- name: ${name}\n`);
    assert.notEqual(start, -1, name);
    const end = source.indexOf('\n      - name: ', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
}

for (const [name, source] of [['deploy', deploy], ['destroy', destroy]]) {
    test(`${name}: every run block is valid shell`, () => {
        const blocks = runBlocks(source);
        assert.ok(blocks.length >= 4);
        for (const block of blocks) {
            const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
    });

    test(`${name}: targets the pinned QA identity and shares the other QA workflows' serialization`, () => {
        for (const line of [
            "SSH_USER: 'admin'",
            "SSH_HOST: '45.136.70.141'",
            "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'",
            "WORKSPACE: 'explorerQaWorkspace'",
            "ROUTER_PORT: '8097'",
            '  group: deploy-explorer-qa\n',
            'LOCK=/home/admin/.qa-deployment-operation.lock',
            'PLOINKY_BIN=/home/admin/.qa-deployment-tools/ploinky/bin/ploinky',
        ]) {
            assert.ok(source.includes(line), line);
        }
    });

    test(`${name}: refuses to run over the removed workflows' parked state`, () => {
        assert.match(source, /STATE_DIR=\/home\/admin\/\.qa-deployment-state\n/);
        assert.match(source, /if \[ -e "\$STATE_DIR" \] && \[ -n "\$\(ls -A "\$STATE_DIR"\)" \]; then/);
    });

    test(`${name}: the host is driven through Ploinky, not through its internals or its files`, () => {
        for (const forbidden of [
            /\bscp\b/, /container (?:exec|cp)/, /\bsudo\b/, /\.runtime\/ploinky/, /supervisor\.mjs/,
            /\/opt\/ploinky\/cli/, /qa-teardown/, /update-explorer-qa/, /quiesce-explorer-qa/,
            /\.ploinky\/(?:repos|running|data)/, /rm -rf/,
        ]) {
            // Placing the repositories at the workspace root is an exception for every pattern, and listing images
            // inside the Box one for `container exec` only, and so is the one function that runs a fixed program there.
            // Both have their own tests.
            const exempt = forbidden.source.startsWith('container') ? [WORKSPACE_REPOSITORIES_BLOCK, IMAGE_PRUNE_BLOCK, RUN_IN_BOX_FUNCTION] : [WORKSPACE_REPOSITORIES_BLOCK];
            assert.doesNotMatch(exempt.reduce((text, block) => text.replace(block, ''), source), forbidden);
        }
    });

    test(`${name}: the checkout is bootstrapped outside the workspace with fast-forward only`, () => {
        assert.match(source, /CHECKOUT=\/home\/admin\/\.qa-deployment-tools\/ploinky\n/);
        assert.match(source, /merge --quiet --ff-only "origin\/\$BRANCH"/);
        assert.doesNotMatch(source, /reset --hard|clean -f/);
    });
}

test('deploy: a secret reaches a command only through stdin', () => {
    const uses = deploy.split('\n').filter((line) => /ploinky_locked var /.test(line));
    assert.ok(uses.length >= 5);
    for (const line of uses) {
        assert.match(line, /^\s*printf '%s' "\$[A-Z_]+[^"]*" \| ploinky_locked var \S+ --stdin$/, line);
    }
    assert.doesNotMatch(deploy, /MASTER_KEY/);
    assert.match(deploy, /printf '%s\\n' "\$EDGE_DOCUMENT" \| ploinky_locked edge set -/);
});

test('deploy: the order sets values, updates sources, saves the publication, then starts and waits', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const order = [
        'update_kept_repos() {',
        'BOX_STATE=present',
        'reset_explorer_checkout needs a workspace with no Box. Nothing was changed.',
        'ploinky_locked --port "$ROUTER_PORT" start explorer --repo-branch AchillesIDE=main --reset-repos',
        'ploinky_locked --port "$ROUTER_PORT" start explorer\n            fi\n            wait_ready',
        'ploinky_locked var "$CLOUDFLARE_API_SECRET_HANDLE" --stdin',
        'ploinky_locked var "$CLOUDFLARE_TUNNEL_SECRET_HANDLE" --stdin',
        'ploinky_locked var USERPERSISTO_OIDC_ISSUER --stdin',
        '# BEGIN QA workspace repositories',
        'ploinky_locked uninstall repo "$repo"',
        '| run_in_box "$COPY_PROGRAM"',
        '| run_in_box "$CSVMAIL_PLACE_PROGRAM"',
        '| run_in_box "$BUNDLE_PROGRAM"',
        'run_in_box "$CLONE_PROGRAM"',
        'ploinky_locked var BIZANSO_PUBLIC_LINK_BASE --stdin',
        'ploinky_locked add repo https://github.com/Axiologic/simpleCSVMailSend.git simpleCSVMailSend',
        'ploinky_locked add repo https://github.com/Axiologic/bizanso.git bizanso',
        'ploinky_locked add repo https://github.com/AssistOS-AI/PromotionScoutV2.git PromotionScoutV2',
        'ploinky_locked add repo https://github.com/Axiologic/ScriptaHubAgent.git ScriptaHubAgent',
        'ploinky_locked enable agent simpleCSVMailSend/csvMailAgent',
        'ploinky_locked enable agent bizanso/bizanso',
        'ploinky_locked enable agent PromotionScoutV2/promotionScout',
        'ploinky_locked enable agent ScriptaHubAgent/scriptahubAgent',
        'GRAPH_RUNTIMES="$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent"',
        'GRAPH_RUNTIMES="$GRAPH_RUNTIMES csvMailAgent"',
        'podman pull -q "$agent"',
        'podman pull -q "$robot"',
        'podman tag "$robot" docker.io/assistos/roboteam-agent:runtime',
        '\n          update_kept_repos\n',
        'test "$(g rev-parse HEAD)" = "$head"',
        'ploinky_locked restart\n          wait_ready',
        'Post-restart image verification failed',
        '| ploinky_locked edge set -',
        'ploinky_locked --port "$ROUTER_PORT" start explorer\n\n          wait_ready',
    ];
    let cursor = 0;
    for (const marker of order) {
        const found = body.indexOf(marker, cursor);
        assert.notEqual(found, -1, marker);
        cursor = found;
    }
    // Overwriting a Cloudflare-mode journal with a local-only document is refused by Ploinky.
    assert.doesNotMatch(deploy, /"hosts":\{\}/);
});

test('deploy: the added agents are enabled only when missing and are awaited only after that', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const graph = body.match(/GRAPH_RUNTIMES='([^']*)'/);
    assert.ok(graph);
    // The first start waits for this list before these agents have been enabled.
    assert.doesNotMatch(graph[1], /bizanso|promotionScout|scriptahubAgent|csvMailAgent/);
    for (const [runtime, agent] of [['csvMailAgent', 'simpleCSVMailSend/csvMailAgent'], ['bizanso', 'bizanso/bizanso'], ['promotionScout', 'PromotionScoutV2/promotionScout'], ['scriptahubAgent', 'ScriptaHubAgent/scriptahubAgent']]) {
        assert.ok(body.includes(`if ! grep -q '^${runtime} ' <<< "$ENABLED_STATES"; then\n            ploinky_locked enable agent ${agent}\n          fi\n`), runtime);
    }
    assert.ok(deploy.indexOf('- name: Verify public URL') < deploy.indexOf('- name: Verify Bizanso and ScriptaHub'));
    const verify = step(deploy, 'Verify Bizanso and ScriptaHub');
    assert.match(verify, /bizanso\/8787\/how-it-works\//);
    assert.match(verify, /scriptahubAgent\/3002\/health/);
    assert.match(verify, /for path in bizanso\/8787\/how-it-works\/ scriptahubAgent\/3002\/health; do\n/);
    assert.doesNotMatch(verify, /deepProofArticle|form\.js/);
    // promotionScout declares MCP readiness and no web surface, so its proof is the awaited runtime state alone.
    assert.doesNotMatch(verify, /promotionScout/);
    assert.match(body, /GRAPH_RUNTIMES="\$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent"\n[\s\S]*ploinky_locked restart\n\s+wait_ready/);
    // CSV Mail is awaited from its own line, so the line shared with the product workflows stays as it is.
    assert.equal(body.split('GRAPH_RUNTIMES="$GRAPH_RUNTIMES csvMailAgent"\n').length - 1, 1);
    assert.match(body, /GRAPH_RUNTIMES="\$GRAPH_RUNTIMES csvMailAgent"\n[\s\S]*ploinky_locked restart\n\s+wait_ready/);
    for (const name of ['deploy-explorer-qa-bizanso.yml', 'deploy-explorer-qa-scriptahub.yml']) {
        assert.doesNotMatch(read(name), /csvMailAgent|simpleCSVMailSend/, name);
    }
});

test('deploy: CSV Mail passes only when its route is published behind sign-in, after the Bizanso check', (t) => {
    assert.ok(deploy.indexOf('- name: Verify Bizanso and ScriptaHub') < deploy.indexOf('- name: Verify CSV Mail'));
    assert.ok(deploy.indexOf('- name: Verify CSV Mail') < deploy.indexOf('- name: Verify dedicated connector and protected Cloudflare topology'));
    const verify = step(deploy, 'Verify CSV Mail');
    assert.doesNotMatch(verify, /\n {8}if: /, 'it runs only after a successful deploy');
    const script = runBlocks(verify)[0];
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-csvmail-verify-'));
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = (replies) => {
        // Each call prints the next reply; the last one repeats.
        fs.writeFileSync(path.join(bin, 'replies'), replies.join('\n') + '\n');
        fs.writeFileSync(path.join(bin, 'count'), '0');
        fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
echo "$*" >> "${bin}/args"
n=$(( $(cat "${bin}/count") + 1 )); echo "$n" > "${bin}/count"
total=$(wc -l < "${bin}/replies")
[ "$n" -le "$total" ] || n=$total
sed -n "\${n}p" "${bin}/replies" | tr -d '\\n'
`, { mode: 0o755 });
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLIC_URL: 'https://explorer-qa.axiologic.dev' } });
        return { ...result, calls: Number(fs.readFileSync(path.join(bin, 'count'), 'utf8')) };
    };
    const signIn = '302 /auth/login?returnTo=%2FcsvMailAgent%2Fpublic%2F';
    const passed = run(['404 ', '502 ', signIn]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.equal(passed.calls, 3);
    assert.match(fs.readFileSync(path.join(bin, 'args'), 'utf8'), /https:\/\/explorer-qa\.axiologic\.dev\/csvMailAgent\/public\/\n/);
    // An unpublished route, a page served without sign-in, or a redirect elsewhere never passes.
    for (const reply of ['404 ', '200 ', '302 /auth/login?returnTo=%2F', '302 https://elsewhere.test/auth/login?returnTo=%2FcsvMailAgent%2Fpublic%2F']) {
        const failed = run([reply]);
        assert.equal(failed.status, 1, reply);
        assert.equal(failed.calls, 60, reply);
        assert.match(failed.stdout, /::error::\/csvMailAgent\/public\/ was not published behind sign-in; last reply: /, reply);
    }
    const summary = step(deploy, 'Create summary');
    assert.match(summary, /CSV Mail: .*csvMailAgent\/public\/.*\$\{CSVMAIL_COMMIT:-not-resolved\}/);
});

test('deploy: the retiring second agent is not enabled, awaited, required or probed by any QA deploy workflow', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    assert.doesNotMatch(deploy, /deepProofArticle/);
    assert.doesNotMatch(body, /enable agent bizanso\/(?!bizanso\b)/);
    for (const name of ['deploy-explorer-qa-ploinky.yml', 'deploy-explorer-qa-bizanso.yml', 'deploy-explorer-qa-scriptahub.yml']) {
        const lines = read(name).split('\n').filter((line) => line.includes('GRAPH_RUNTIMES='));
        assert.ok(lines.length >= 2, name);
        for (const line of lines) assert.doesNotMatch(line, /deepProofArticle/, `${name}: ${line}`);
    }
    // The first-start graph never names the added agents.
    assert.doesNotMatch(body.match(/GRAPH_RUNTIMES='([^']*)'/)[1], /deepProofArticle/);
});

const REGISTRY_BEGIN = '# BEGIN QA registry check';
const REGISTRY_END = '# END QA registry check';

test('deploy: the QA registry check reads inside the Box and comes before the first Cloudflare call, host change and Ploinky command', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    assert.equal(body.split(REGISTRY_BEGIN).length - 1, 1);
    const at = body.indexOf('qa_registry_check "Nothing was changed." || exit 1\n');
    assert.notEqual(at, -1);
    assert.ok(body.indexOf(REGISTRY_BEGIN) < at && at < body.indexOf(REGISTRY_END));
    // Only the read of the running Box and the registry come first. A refusal changes nothing.
    for (const marker of ['curl -fsS', 'Bootstrapping the pinned Node', 'ploinky_locked ', 'ploinky_read ', 'mktemp /tmp/', 'bash -s']) {
        const first = body.indexOf(marker);
        assert.notEqual(first, -1, marker);
        assert.ok(at < first, `the registry check comes before the first ${marker}`);
    }
    // The only host commands before it are the two reads of the check itself.
    const before = body.slice(0, at).split('\n').filter((line) => line.includes('"${SSH[@]}"') && !line.trimStart().startsWith('#'));
    assert.deepEqual(before.map((line) => line.trim().split(/\s+/).slice(0, 3).join(' ')), ['"${SSH[@]}" "exec flock', 'running="$("${SSH[@]}" "exec flock']);
    assert.ok(deploy.indexOf('- name: Check out Bizanso') < deploy.indexOf('- name: Bootstrap the host and deploy through Ploinky commands'));
    // run_in_box is the same function as the one of the shared workspace block, defined here before its first use.
    const early = body.indexOf('run_in_box() {');
    assert.ok(early < at);
    assert.equal(body.slice(early, body.indexOf('\n}', early) + 2), body.slice(body.lastIndexOf('run_in_box() {'), body.indexOf('\n}', body.lastIndexOf('run_in_box() {')) + 2));
    assert.doesNotMatch(body.slice(body.indexOf(REGISTRY_BEGIN), body.indexOf(REGISTRY_END)), /deepProofArticle/);
});

// Runs the check block itself under `set -euo pipefail` with stub ssh, flock and podman. A Box that runs answers the
// name filter and runs the program in its workspace; `registry` is the text of .ploinky/agents.json, or null for none.
function runRegistryCheck(t, { registry, boxRunning = true, tree = [], busy = '', upAfter = 0, boxFile = false, env = {}, calls: callLines }) {
    const body = runBlocks(step(deploy, 'Bootstrap the host and deploy through Ploinky commands'))[0];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-registry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const ws = path.join(dir, 'ws');
    const checkout = path.join(dir, 'github/.qa-bizanso-source');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(ws, '.ploinky'), { recursive: true });
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(path.join(dir, 'runner'));
    for (const agent of tree) {
        fs.mkdirSync(path.join(checkout, agent), { recursive: true });
        fs.writeFileSync(path.join(checkout, agent, 'manifest.json'), '{}\n');
    }
    if (registry !== null) {
        if (registry === 'directory') fs.mkdirSync(path.join(ws, '.ploinky/agents.json'));
        else fs.writeFileSync(path.join(ws, '.ploinky/agents.json'), typeof registry === 'string' ? registry : JSON.stringify(registry));
    }
    const calls = path.join(dir, 'calls');
    const stub = (name, text) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
    stub('fakessh', 'eval "${@: -1}"');
    stub('flock', `echo "flock $*" >> "$CALLS"
if [ -n "\${BUSY:-}" ]; then case "$*" in *"$BUSY"*) exit 75 ;; esac; fi
shift 5
exec "$@"`);
    stub('podman', `echo "podman $1 $2" >> "$CALLS"
if [ "$1" = ps ]; then
  n=$(grep -c '^podman ps' "$CALLS" || true)
  up=no
  if [ -n "\${BOX_FILE:-}" ]; then [ ! -e "$BOX_FILE" ] || up=yes; elif [ "\${BOX_RUNNING}" = yes ] && [ "$n" -gt "$UP_AFTER" ]; then up=yes; fi
  case "$*" in *" --filter name=^ploinky-box-explorerqaworkspace-7a31ab7775eb\$") [ "$up" != yes ] || echo ploinky-box-explorerqaworkspace-7a31ab7775eb ;; esac
  exit 0
fi
if [ "$1 $2" = "container exec" ]; then
  shift 2; wd=""
  while [ $# -gt 0 ]; do case "$1" in -i) shift ;; --user|--env) shift 2 ;; --workdir) wd="$2"; shift 2 ;; *) break ;; esac; done
  shift
  cd "$wd" && exec sh -c "$3" sh
fi
exit 1`);
    const runIn = body.indexOf('run_in_box() {');
    const runFn = body.slice(runIn, body.indexOf('\n}', runIn) + 2);
    const block = body.slice(body.indexOf(REGISTRY_BEGIN), body.indexOf(REGISTRY_END) + REGISTRY_END.length);
    const script = `set -euo pipefail
SSH=(fakessh); LOCK=/lock; WORK_DIR='${ws}'
${runFn}
${block}
${(callLines || []).join('\n')}
echo completed`;
    const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, BUSY: busy, UP_AFTER: String(upAfter), BOX_FILE: boxFile ? path.join(dir, 'box-up') : '', BOX_RUNNING: boxRunning ? 'yes' : 'no', ...env, RUNNER_TEMP: path.join(dir, 'runner'), GITHUB_WORKSPACE: path.join(dir, 'github') },
    });
    return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [] };
}
const record = (agent, extra = {}) => ({ type: 'agent', agentName: agent, repoName: 'bizanso', containerId: 'c'.repeat(64), ...extra });

test('deploy: a registry record of an enabled bizanso agent whose folder the checkout lacks is refused, the folder present passes', (t) => {
    const registry = { ploinky_bizanso_bizanso_a: record('bizanso'), ploinky_bizanso_second_b: record('secondAgent') };
    const refused = runRegistryCheck(t, { registry, tree: ['bizanso'] });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /::error::The QA registry lists the enabled Bizanso agent\(s\) secondAgent, but the checked-out Bizanso tree has no <agent>\/manifest\.json for them\. Nothing was changed\./);
    assert.doesNotMatch(refused.stdout, /completed/);
    // Only reads: the Box probe and the registry read.
    assert.deepEqual(refused.calls.filter((line) => line.startsWith('podman')), ['podman ps --quiet', 'podman container exec']);
    const two = runRegistryCheck(t, { registry: { a: record('zeta'), b: record('alpha') }, tree: [] });
    assert.match(two.stdout, /agent\(s\) alpha zeta, but/);
    const passed = runRegistryCheck(t, { registry, tree: ['bizanso', 'secondAgent'] });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /The QA registry lists no Bizanso agent whose folder the checked-out tree lacks\.\ncompleted\n/);
});

test('deploy: no record, alias-only records, other repositories and an empty registry or none pass the registry check', (t) => {
    for (const [name, registry] of Object.entries({
        'an empty object': {},
        'an alias-only record': { x: record('secondAgent', { alias: 'second' }) },
        'another repository': { x: record('secondAgent', { repoName: 'PromotionScoutV2' }) },
        'not an agent': { x: record('secondAgent', { type: 'service' }) },
        'a null record': { x: null },
        'no registry file': null,
    })) {
        const result = runRegistryCheck(t, { registry, tree: [] });
        assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /completed\n$/, name);
    }
});

test('deploy: a Box that is not running passes the first registry check, which reads nothing', (t) => {
    const result = runRegistryCheck(t, { registry: { x: record('secondAgent') }, boxRunning: false, tree: [] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[qa\] No QA Box is running yet; the registry is checked again once it runs\.\ncompleted\n$/);
    assert.deepEqual(result.calls.filter((line) => line.startsWith('podman')), ['podman ps --quiet']);
});

test('deploy: an empty, malformed or unreadable registry refuses with its own message', (t) => {
    for (const [name, registry] of Object.entries({
        'an empty file': '',
        'not JSON': 'not json',
        'an array': '[]',
        'null': 'null',
        'a path-like agent name': { x: record('../x') },
        'an agent name that is not a string': { x: record(7) },
        'a directory': 'directory',
    })) {
        const result = runRegistryCheck(t, { registry, tree: [] });
        assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /::error::Cannot read the QA registry.* Nothing was changed\./, name);
        assert.doesNotMatch(result.stdout, /The QA registry lists|completed/, name);
    }
});

test('deploy: a Box that was just started is checked again, and a record without its folder refuses before the copy', (t) => {
    const second = ['qa_registry_check "Bizanso was not copied; the Box may have been started." need_box'];
    const record2 = { ploinky_bizanso_second_b: record('secondAgent') };
    // The Box is not running at the first check (one empty answer), then runs: the kept registry refuses at the second.
    const refused = runRegistryCheck(t, { registry: record2, upAfter: 1, tree: [], calls: second });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /\[qa\] No QA Box is running yet; the registry is checked again once it runs\.\n/);
    assert.match(refused.stdout, /::error::The QA registry lists the enabled Bizanso agent\(s\) secondAgent, but the checked-out Bizanso tree has no <agent>\/manifest\.json for them\. Bizanso was not copied; the Box may have been started\. Disable/);
    assert.doesNotMatch(refused.stdout, /completed/);
    // The same registry with its folder present passes both calls.
    const passed = runRegistryCheck(t, { registry: record2, upAfter: 1, tree: ['secondAgent'], calls: second });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /completed\n$/);
    // A Box that still is not running after its start is a refusal, not a pass.
    const down = runRegistryCheck(t, { registry: {}, boxRunning: false, tree: [], calls: second });
    assert.equal(down.status, 1, down.stdout + down.stderr);
    assert.match(down.stdout, /::error::The QA Box is not running although it was just started, so the registry cannot be checked\. Bizanso was not copied; the Box may have been started\./);
});

// The start-or-update section of the deploy step, from the Box state to the second registry check, with the Ploinky
// commands stubbed. The Box exists while the file box-up does; destroy removes it and a start creates it.
function runRecreate(t, { recreate, registry, tree }) {
    const body = runBlocks(step(deploy, 'Bootstrap the host and deploy through Ploinky commands'))[0];
    const graph = body.match(/^GRAPH_RUNTIMES='[^']*'$/m)[0];
    const states = body.slice(body.indexOf('runtime_states() {'), body.indexOf('\n}\n', body.indexOf('runtime_states() {')) + 3);
    const from = body.indexOf('BOX_STATE=present\n');
    const callText = 'qa_registry_check "Bizanso was not copied; the Box may have been started." need_box || exit 1\n';
    const slice = body.slice(from, body.indexOf(callText) + callText.length);
    const status = `Agent runtimes:\n${['explorer', 'gitAgent', 'userPersistoAgent', 'emailAgent', 'dpuAgent', 'roboTeamAgent', 'soul-gateway', 'workspaceMonitorAgent', 'local-llm'].map((name) => `  x [running] [ready]\n     agent: ${name}`).join('\n')}\n`;
    const prelude = `LOG="$CALLS"; ROUTER_PORT=8097
prune_images() { :; }
require_free_disk() { :; }
wait_ready() { :; }
ploinky_read() { echo "read $*" >> "$LOG"; }
ploinky_locked() { echo "locked $*" >> "$LOG"; case "$*" in destroy) rm -f "$BOX_FILE" ;; *start*) : > "$BOX_FILE" ;; esac; }
${graph}
${states}
echo reached-start-section >> "$LOG"
${slice}
echo second-check-passed`;
    const result = runRegistryCheck(t, { registry, tree, boxFile: true, boxRunning: false, env: { RECREATE_BOX: recreate, RESET_EXPLORER_CHECKOUT: 'false', STATUS_OUTPUT: status }, calls: [prelude] });
    return result;
}

test('deploy: a recreate with a running graph destroys the Box, runs the first start, and only then the second registry check', (t) => {
    const record2 = { ploinky_bizanso_second_b: record('secondAgent') };
    const passed = runRecreate(t, { recreate: 'true', registry: record2, tree: ['secondAgent'] });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /second-check-passed\ncompleted\n$/);
    const locked = passed.calls.filter((line) => line.startsWith('locked'));
    assert.deepEqual(locked, ['locked destroy', 'locked --port 8097 start explorer']);
    const refused = runRecreate(t, { recreate: 'true', registry: record2, tree: [] });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /::error::The QA registry lists the enabled Bizanso agent\(s\) secondAgent, .* Bizanso was not copied; the Box may have been started\. Disable/);
    assert.doesNotMatch(refused.stdout, /second-check-passed|The QA Box is not running/);
    assert.deepEqual(refused.calls.filter((line) => line.startsWith('locked')), ['locked destroy', 'locked --port 8097 start explorer']);
    // Without a recreate the graph is up and no start runs.
    const kept = runRecreate(t, { recreate: 'false', registry: record2, tree: ['secondAgent'] });
    assert.equal(kept.calls.filter((line) => line.startsWith('locked')).length, 0, kept.stdout + kept.stderr);
});

test('deploy: the second registry check follows the first start and comes before every value, repository move and the Bizanso copy', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const call = 'qa_registry_check "Bizanso was not copied; the Box may have been started." need_box || exit 1\n';
    assert.equal(body.split(call).length - 1, 1);
    const at = body.indexOf(call);
    const start = body.indexOf('ploinky_locked --port "$ROUTER_PORT" start explorer\n            fi\n            wait_ready\n          fi\n');
    assert.notEqual(start, -1);
    assert.ok(start < at);
    for (const marker of ['ploinky_locked var "$CLOUDFLARE_API_SECRET_HANDLE"', 'ploinky_locked uninstall repo', '| run_in_box "$COPY_PROGRAM"', 'ploinky_locked add repo']) {
        assert.ok(at < body.indexOf(marker), marker);
    }
});

test('deploy: a held host lock refuses the registry check, as the other refusals do, with nothing changed', (t) => {
    for (const busy of ['podman ps --quiet', 'cat .ploinky/agents.json']) {
        const result = runRegistryCheck(t, { registry: {}, busy });
        assert.equal(result.status, 1, `${busy}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /::error::Another Explorer QA operation holds the host lock\. Nothing was changed\./, busy);
        assert.doesNotMatch(result.stdout, /completed/, busy);
    }
});

test('deploy: the PromotionScoutV2 key stays on the runner and reaches only its checkout', () => {
    const uses = deploy.split('\n').filter((line) => line.includes('EXPLORER_QA_PROMOTIONSCOUT_DEPLOY_KEY }}'));
    assert.deepEqual(uses.map((line) => line.trim()), [
        'PROMOTIONSCOUT_DEPLOY_KEY: ${{ secrets.EXPLORER_QA_PROMOTIONSCOUT_DEPLOY_KEY }}',
        'ssh-key: ${{ secrets.EXPLORER_QA_PROMOTIONSCOUT_DEPLOY_KEY }}',
    ]);
    const validate = step(deploy, 'Validate GitHub configuration');
    assert.match(validate, /Missing required repository secret EXPLORER_QA_PROMOTIONSCOUT_DEPLOY_KEY/);
    const checkout = step(deploy, 'Check out PromotionScoutV2');
    for (const line of ['repository: AssistOS-AI/PromotionScoutV2', 'path: .qa-promotionscout-source', 'persist-credentials: false', 'fetch-depth: 0']) {
        assert.ok(checkout.includes(line), line);
    }
    assert.doesNotMatch(step(deploy, 'Bootstrap the host and deploy through Ploinky commands'), /PROMOTIONSCOUT_DEPLOY_KEY/);
    assert.doesNotMatch(destroy, /PROMOTIONSCOUT/);
});

test('deploy: the Bizanso key stays on the runner and reaches only its checkout', () => {
    const uses = deploy.split('\n').filter((line) => line.includes('EXPLORER_QA_BIZANSO_DEPLOY_KEY }}'));
    assert.deepEqual(uses.map((line) => line.trim()), [
        'BIZANSO_DEPLOY_KEY: ${{ secrets.EXPLORER_QA_BIZANSO_DEPLOY_KEY }}',
        'ssh-key: ${{ secrets.EXPLORER_QA_BIZANSO_DEPLOY_KEY }}',
    ]);
    const checkout = step(deploy, 'Check out Bizanso');
    assert.match(checkout, /persist-credentials: false/);
    assert.match(checkout, /repository: Axiologic\/bizanso/);
    assert.doesNotMatch(step(deploy, 'Bootstrap the host and deploy through Ploinky commands'), /BIZANSO_DEPLOY_KEY/);
    assert.doesNotMatch(destroy, /BIZANSO/);
});

test('deploy: the CSV Mail key stays on the runner and reaches only its checkout', () => {
    const uses = deploy.split('\n').filter((line) => line.includes('EXPLORER_QA_CSVMAIL_DEPLOY_KEY }}'));
    assert.deepEqual(uses.map((line) => line.trim()), [
        'CSVMAIL_DEPLOY_KEY: ${{ secrets.EXPLORER_QA_CSVMAIL_DEPLOY_KEY }}',
        'ssh-key: ${{ secrets.EXPLORER_QA_CSVMAIL_DEPLOY_KEY }}',
    ]);
    assert.match(step(deploy, 'Validate GitHub configuration'), /Missing required repository secret EXPLORER_QA_CSVMAIL_DEPLOY_KEY/);
    const checkout = step(deploy, 'Check out simpleCSVMailSend');
    for (const line of ['repository: Axiologic/simpleCSVMailSend', 'path: .qa-csvmail-source', 'persist-credentials: false']) {
        assert.ok(checkout.includes(line), line);
    }
    assert.ok(deploy.indexOf('- name: Check out simpleCSVMailSend') < deploy.indexOf('- name: Resolve the CSV Mail source'));
    assert.ok(deploy.indexOf('- name: Resolve the CSV Mail source') < deploy.indexOf('- name: Bootstrap the host and deploy through Ploinky commands'));
    assert.doesNotMatch(step(deploy, 'Bootstrap the host and deploy through Ploinky commands'), /CSVMAIL_DEPLOY_KEY/);
    assert.doesNotMatch(destroy, /CSVMAIL|csvMail/);
});

// A throwaway Git repository standing in for the simpleCSVMailSend checkout.
function csvMailSource(root, { agent = true } = {}) {
    const source = path.join(root, '.qa-csvmail-source');
    const git = (...args) => {
        const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    fs.mkdirSync(path.join(source, 'data/projects/default'), { recursive: true });
    fs.writeFileSync(path.join(source, 'data/projects/default/activity.json'), '{"recipients":["someone@example.test"]}\n');
    fs.writeFileSync(path.join(source, 'README.md'), 'CSV Mail\n');
    if (agent) {
        fs.mkdirSync(path.join(source, 'csvMailAgent/src'), { recursive: true });
        fs.writeFileSync(path.join(source, 'csvMailAgent/manifest.json'), '{"name":"csvMailAgent"}\n');
        fs.writeFileSync(path.join(source, 'csvMailAgent/src/ploinky.mjs'), '// agent\n');
    }
    git('init', '--quiet');
    git('add', '-A');
    git('-c', 'user.name=QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
    return { source, commit: git('rev-parse', 'HEAD') };
}

test('deploy: the CSV Mail source is resolved on the runner and refused without the agent manifest', (t) => {
    const script = runBlocks(step(deploy, 'Resolve the CSV Mail source'))[0];
    assert.doesNotMatch(script, /\bssh\b|SSH\[|run_in_box|ploinky/);
    const resolve = (options) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-csvmail-resolve-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const { commit } = csvMailSource(root, options);
        const env = path.join(root, 'github-env');
        fs.writeFileSync(env, '');
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root, GITHUB_ENV: env } });
        return { ...result, commit, env: fs.readFileSync(env, 'utf8') };
    };
    const resolved = resolve();
    assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
    assert.equal(resolved.env, `CSVMAIL_COMMIT=${resolved.commit}\n`);
    const refused = resolve({ agent: false });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /::error::simpleCSVMailSend@[0-9a-f]{40} has no csvMailAgent\/manifest\.json\. Nothing was changed\./);
    assert.equal(refused.env, '');
});

function workspaceRepositoriesBlock() {
    return step(deploy, 'Bootstrap the host and deploy through Ploinky commands').match(WORKSPACE_REPOSITORIES_BLOCK)[0];
}

test('deploy: the private copy replaces the workspace-root repository and keeps one predecessor', () => {
    const block = workspaceRepositoriesBlock();
    assert.match(block, / podman container exec -i --user podman .* ploinky-box-explorerqaworkspace-7a31ab7775eb sh -c /);
    const program = block.match(/COPY_PROGRAM='([^']*)'/)[1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-private-copy-'));
    try {
        const copy = (file, withGit = false) => {
            const source = fs.mkdtempSync(path.join(root, 'source-'));
            fs.writeFileSync(path.join(source, file), 'x');
            if (withGit) fs.mkdirSync(path.join(source, '.git'));
            const archive = spawnSync('tar', ['-cf', '-', '-C', source, '.']);
            assert.equal(archive.status, 0);
            return spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, input: archive.stdout });
        };
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        const repo = path.join(workspace, 'bizanso');
        const previous = path.join(workspace, '.ploinky/.qa-private-copy/previous');
        assert.equal(copy('one').status, 0);
        assert.ok(fs.existsSync(path.join(repo, 'one')));
        assert.equal(copy('two').status, 0);
        assert.ok(fs.existsSync(path.join(repo, 'two')) && !fs.existsSync(path.join(repo, 'one')));
        assert.ok(fs.existsSync(path.join(previous, 'one')));
        assert.equal(copy('three').status, 0);
        assert.ok(fs.existsSync(path.join(repo, 'three')));
        assert.ok(fs.existsSync(path.join(previous, 'two')) && !fs.existsSync(path.join(previous, 'one')));
        assert.deepEqual(fs.readdirSync(path.dirname(previous)), ['previous']);
        // A source carrying Git metadata is refused and leaves the live copy in place.
        assert.notEqual(copy('four', true).status, 0);
        assert.ok(fs.existsSync(path.join(repo, 'three')));
        // So is an archive that produced no files.
        const empty = fs.mkdtempSync(path.join(root, 'empty-'));
        const nothing = spawnSync('tar', ['-cf', '-', '-C', empty, '--exclude', './*', '.']);
        assert.notEqual(spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, input: nothing.stdout }).status, 0);
        assert.notEqual(spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, input: '' }).status, 0);
        assert.ok(fs.existsSync(path.join(repo, 'three')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('deploy: CSV Mail arrives as its agent folder alone, in a stage of its own, and keeps one predecessor', (t) => {
    const block = workspaceRepositoriesBlock();
    const program = block.match(/CSVMAIL_PLACE_PROGRAM='([^']*)'/)[1];
    // The runner streams only csvMailAgent/ of the resolved commit, never the data/ the repository tracks.
    const archive = 'git -C "$GITHUB_WORKSPACE/.qa-csvmail-source" archive --format=tar "$CSVMAIL_COMMIT" csvMailAgent | run_in_box "$CSVMAIL_PLACE_PROGRAM"\n';
    assert.equal(block.split(archive).length - 1, 1);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-csvmail-place-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky/.qa-private-copy/previous'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ploinky/.qa-private-copy/previous/bizanso-file'), 'x');
    const place = (input) => spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, input });
    const repo = path.join(workspace, 'simpleCSVMailSend');
    const previous = path.join(workspace, '.ploinky/.qa-csvmail-copy/previous');
    // The archive line itself, run against a real checkout that also tracks data/.
    const { commit } = csvMailSource(root);
    const runner = spawnSync('bash', ['-c', `set -euo pipefail\nrun_in_box() { sh -c "$1" sh; }\ncd '${workspace}'\n${archive}`], {
        encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root, CSVMAIL_COMMIT: commit, CSVMAIL_PLACE_PROGRAM: program },
    });
    assert.equal(runner.status, 0, runner.stderr);
    assert.deepEqual(fs.readdirSync(repo), ['csvMailAgent']);
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/manifest.json')));
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/src/ploinky.mjs')));
    assert.ok(!fs.existsSync(path.join(repo, 'data')) && !fs.existsSync(path.join(repo, '.git')));
    const tarOf = (files) => {
        const source = fs.mkdtempSync(path.join(root, 'source-'));
        for (const [file, text] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
            fs.writeFileSync(path.join(source, file), text);
        }
        const result = spawnSync('tar', ['-cf', '-', '-C', source, ...Object.keys(files).map((file) => file.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
        assert.equal(result.status, 0);
        return result.stdout;
    };
    fs.mkdirSync(previous, { recursive: true });
    fs.mkdirSync(path.join(repo, '.roboteam'));
    fs.writeFileSync(path.join(repo, '.roboteam/marker'), 'live sibling');
    const rootInode = fs.statSync(repo).ino;
    fs.writeFileSync(path.join(previous, 'legacy-data'), 'previous sibling');
    assert.equal(place(tarOf({ 'csvMailAgent/manifest.json': '{}', 'csvMailAgent/two': 'x' })).status, 0);
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/two')));
    assert.ok(fs.existsSync(path.join(previous, 'csvMailAgent/src/ploinky.mjs')));
    assert.equal(fs.statSync(repo).ino, rootInode);
    assert.equal(fs.readFileSync(path.join(repo, '.roboteam/marker'), 'utf8'), 'live sibling');
    assert.equal(place(tarOf({ 'csvMailAgent/manifest.json': '{}', 'csvMailAgent/three': 'x' })).status, 0);
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/three')) && !fs.existsSync(path.join(repo, 'csvMailAgent/two')));
    assert.ok(fs.existsSync(path.join(previous, 'csvMailAgent/two')));
    assert.equal(fs.statSync(repo).ino, rootInode);
    assert.equal(fs.readFileSync(path.join(repo, '.roboteam/marker'), 'utf8'), 'live sibling');
    assert.equal(fs.readFileSync(path.join(previous, 'legacy-data'), 'utf8'), 'previous sibling');
    assert.deepEqual(fs.readdirSync(path.dirname(previous)), ['previous']);
    // Each refusal leaves the live copy in place: data or Git metadata beside the agent, no manifest, nothing at all.
    for (const [name, input] of [
        ['data beside the agent', tarOf({ 'csvMailAgent/manifest.json': '{}', 'data/activity.json': '{}' })],
        ['Git metadata beside the agent', tarOf({ 'csvMailAgent/manifest.json': '{}', '.git/HEAD': 'ref' })],
        ['no agent manifest', tarOf({ 'csvMailAgent/other': 'x' })],
        ['an empty input', ''],
    ]) {
        assert.notEqual(place(input).status, 0, name);
        assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/three')), name);
    }
    // Refuse symlinks in either the incoming agent or its manifest.
    for (const target of ['csvMailAgent', 'csvMailAgent/manifest.json']) {
        const source = fs.mkdtempSync(path.join(root, 'symlink-'));
        if (target.includes('/')) fs.mkdirSync(path.join(source, 'csvMailAgent'));
        fs.symlinkSync('/tmp', path.join(source, target));
        const archive = spawnSync('tar', ['-cf', '-', '-C', source, 'csvMailAgent']);
        assert.equal(archive.status, 0);
        assert.notEqual(place(archive.stdout).status, 0, target);
        assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/three')));
    }
    // An interrupted rotation leaves its predecessor intact on the next placement.
    fs.rmSync(path.join(repo, 'csvMailAgent'), { recursive: true });
    assert.equal(place(tarOf({ 'csvMailAgent/manifest.json': '{}', 'csvMailAgent/retry': 'x' })).status, 0);
    assert.ok(fs.existsSync(path.join(previous, 'csvMailAgent/two')));
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/retry')));

    // Fail only the incoming publish; the rotated live agent must be restored.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\ncase "$1" in */incoming.*/csvMailAgent) exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const failedPublish = spawnSync('sh', ['-c', program, 'sh'], {
        cwd: workspace, input: tarOf({ 'csvMailAgent/manifest.json': '{}', 'csvMailAgent/fail': 'x' }),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(failedPublish.status, 0);
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/retry')));
    assert.equal(fs.readFileSync(path.join(previous, 'legacy-data'), 'utf8'), 'previous sibling');
    assert.deepEqual(fs.readdirSync(path.dirname(previous)), ['previous']);

    // If a destination appears during a failed publish, retain the backup rather than nesting it.
    fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\ncase "$1" in */incoming.*/csvMailAgent) mkdir "$2"; exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const occupied = spawnSync('sh', ['-c', program, 'sh'], {
        cwd: workspace, input: tarOf({ 'csvMailAgent/manifest.json': '{}' }),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(occupied.status, 0);
    assert.ok(fs.existsSync(path.join(previous, 'csvMailAgent/retry')));
    assert.deepEqual(fs.readdirSync(path.join(repo, 'csvMailAgent')), []);
    fs.rmSync(path.join(repo, 'csvMailAgent'), { recursive: true });
    fs.renameSync(path.join(previous, 'csvMailAgent'), path.join(repo, 'csvMailAgent'));

    // A symlink at a protected child path is rejected without following it.
    fs.rmSync(path.join(previous, 'csvMailAgent'), { recursive: true, force: true });
    fs.symlinkSync(repo, path.join(previous, 'csvMailAgent'));
    assert.notEqual(place(tarOf({ 'csvMailAgent/manifest.json': '{}' })).status, 0);
    assert.ok(fs.existsSync(path.join(repo, 'csvMailAgent/retry')));
    // The Bizanso predecessor in its own stage is never touched.
    assert.ok(fs.existsSync(path.join(workspace, '.ploinky/.qa-private-copy/previous/bizanso-file')));
});

test('deploy: only a repository solely in its managed location is uninstalled', () => {
    const block = workspaceRepositoriesBlock();
    const program = block.match(/MANAGED_PROGRAM='([^']*)'/)[1];
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-managed-'));
    const run = () => spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, encoding: 'utf8' });
    try {
        assert.equal(run().stdout, '');
        fs.mkdirSync(path.join(workspace, 'bizanso'));
        fs.mkdirSync(path.join(workspace, 'PromotionScoutV2'));
        fs.mkdirSync(path.join(workspace, 'ScriptaHubAgent'));
        assert.equal(run().stdout, '', 'an already moved workspace is left alone');
        fs.rmSync(path.join(workspace, 'bizanso'), { recursive: true });
        fs.mkdirSync(path.join(workspace, '.ploinky/repos/bizanso'), { recursive: true });
        assert.deepEqual([run().status, run().stdout], [0, 'bizanso\n']);
        fs.mkdirSync(path.join(workspace, 'bizanso'));
        assert.notEqual(run().status, 0, 'both locations stop the run before anything is uninstalled');
        fs.rmSync(path.join(workspace, 'bizanso'), { recursive: true });
        fs.rmSync(path.join(workspace, 'PromotionScoutV2'), { recursive: true });
        fs.mkdirSync(path.join(workspace, '.ploinky/repos/PromotionScoutV2'), { recursive: true });
        assert.equal(run().stdout, 'bizanso\nPromotionScoutV2\n');
        fs.mkdirSync(path.join(workspace, '.ploinky/repos/simpleCSVMailSend'), { recursive: true });
        assert.equal(run().stdout, 'bizanso\nPromotionScoutV2\nsimpleCSVMailSend\n');
        fs.mkdirSync(path.join(workspace, 'simpleCSVMailSend'));
        assert.notEqual(run().status, 0, 'CSV Mail in both locations stops the run too');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('deploy: a failed managed location check stops the run before anything moves', () => {
    const block = workspaceRepositoriesBlock();
    const start = block.indexOf('MANAGED_LOCATIONS="$(');
    const end = block.indexOf('# END QA workspace repositories');
    const run = (stub) => spawnSync('bash', ['-c', `set -euo pipefail
run_in_box() { case "$1" in MANAGED) ${stub} ;; *) cat > /dev/null; echo "box:$1" ;; esac; }
ploinky_locked() { echo "ploinky:$*"; }
git() { case "$*" in *symbolic-ref*) echo main ;; *) echo archive ;; esac; }
node() { [[ "$1" = .github/scripts/qaPredeploy.mjs ]] && echo "receipt:$2:$3"; }
MANAGED_PROGRAM=MANAGED COPY_PROGRAM=COPY CSVMAIL_PLACE_PROGRAM=CSVMAIL BUNDLE_PROGRAM=BUNDLE CLONE_PROGRAM=CLONE GITHUB_WORKSPACE=/w CSVMAIL_COMMIT=${'c'.repeat(40)}
${block.slice(start, end)}`], { encoding: 'utf8' });
    const refused = run('echo bizanso; exit 1');
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.equal(refused.stdout, '', 'nothing is uninstalled, copied or cloned');
    const unexpected = run('echo other');
    assert.notEqual(unexpected.status, 0);
    assert.doesNotMatch(unexpected.stdout, /ploinky:|box:/);
    assert.equal(run('echo bizanso').stdout, 'ploinky:uninstall repo bizanso\nreceipt:prepare:bizanso\nbox:COPY\nreceipt:installed:bizanso\nreceipt:prepare:simpleCSVMailSend\nbox:CSVMAIL\nreceipt:installed:simpleCSVMailSend\nbox:BUNDLE\nbox:CLONE\n');
    assert.equal(run('echo simpleCSVMailSend').stdout, 'ploinky:uninstall repo simpleCSVMailSend\nreceipt:prepare:bizanso\nbox:COPY\nreceipt:installed:bizanso\nreceipt:prepare:simpleCSVMailSend\nbox:CSVMAIL\nreceipt:installed:simpleCSVMailSend\nbox:BUNDLE\nbox:CLONE\n');
    assert.equal(run('true').stdout, 'receipt:prepare:bizanso\nbox:COPY\nreceipt:installed:bizanso\nreceipt:prepare:simpleCSVMailSend\nbox:CSVMAIL\nreceipt:installed:simpleCSVMailSend\nbox:BUNDLE\nbox:CLONE\n');
});

test('deploy: ScriptaHub is a workspace-root checkout of the exact public source', () => {
    const block = workspaceRepositoriesBlock();
    const program = block.match(/CLONE_PROGRAM='([^']*)'/)[1];
    assert.match(program, /url=https:\/\/github\.com\/Axiologic\/ScriptaHubAgent\.git\n/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-clone-'));
    try {
        const url = 'https://github.com/Axiologic/ScriptaHubAgent.git';
        const init = (origin) => {
            for (const args of [['init', '--quiet', 'ScriptaHubAgent'], ['-C', 'ScriptaHubAgent', 'remote', 'add', 'origin', origin]]) {
                assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
            }
        };
        init(url);
        assert.equal(spawnSync('sh', ['-c', program, 'sh'], { cwd: root }).status, 0, 'an existing checkout is kept');
        fs.rmSync(path.join(root, 'ScriptaHubAgent'), { recursive: true });
        init('https://example.test/other.git');
        assert.notEqual(spawnSync('sh', ['-c', program, 'sh'], { cwd: root }).status, 0, 'another origin stops the run');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('deploy: PromotionScoutV2 is a real checkout that only fast-forwards from the streamed bundle', () => {
    const block = workspaceRepositoriesBlock();
    const program = block.match(/BUNDLE_PROGRAM='([^']*)'/)[1];
    assert.match(program, /url=https:\/\/github\.com\/AssistOS-AI\/PromotionScoutV2\.git\n/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bundle-'));
    const git = (cwd, ...args) => {
        const result = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        const source = path.join(root, 'source');
        const workspace = path.join(root, 'workspace');
        const repo = path.join(workspace, 'PromotionScoutV2');
        fs.mkdirSync(source);
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        git(source, 'init', '--quiet', '-b', 'trunk');
        const commit = (text) => {
            fs.writeFileSync(path.join(source, 'file'), `${text}\n`);
            git(source, 'add', 'file');
            git(source, 'commit', '--quiet', '-m', text);
        };
        const send = () => spawnSync('sh', ['-c', program, 'sh'], {
            cwd: workspace,
            encoding: 'utf8',
            input: spawnSync('git', ['-C', source, 'bundle', 'create', '-', 'refs/heads/trunk'], { maxBuffer: 1 << 26 }).stdout,
        });
        commit('one');
        assert.equal(send().status, 0);
        assert.equal(git(repo, 'remote', 'get-url', 'origin'), 'https://github.com/AssistOS-AI/PromotionScoutV2.git');
        assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
        assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'refs/remotes/origin/trunk'));
        assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky')), [], 'the bundle and staging clone are removed');
        assert.equal(send().status, 0, 'an equal checkout is a no-op');
        commit('two');
        assert.equal(send().status, 0);
        assert.equal(fs.readFileSync(path.join(repo, 'file'), 'utf8'), 'two\n', 'a clean checkout fast-forwards');
        commit('three');
        fs.writeFileSync(path.join(repo, 'file'), 'edited\n');
        const dirty = send();
        assert.notEqual(dirty.status, 0);
        assert.match(dirty.stderr, /uncommitted changes; left untouched/);
        assert.equal(fs.readFileSync(path.join(repo, 'file'), 'utf8'), 'edited\n');
        git(repo, 'checkout', '--quiet', 'file');
        git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'local');
        const local = git(repo, 'rev-parse', 'HEAD');
        const diverged = send();
        assert.notEqual(diverged.status, 0);
        assert.match(diverged.stderr, /left untouched/);
        assert.equal(git(repo, 'rev-parse', 'HEAD'), local);
        git(repo, 'reset', '--quiet', '--hard', 'HEAD~1');
        git(repo, 'remote', 'set-url', 'origin', 'https://example.test/other.git');
        assert.notEqual(send().status, 0, 'another origin stops the run');
        git(repo, 'remote', 'set-url', 'origin', 'https://github.com/AssistOS-AI/PromotionScoutV2.git');
        assert.notEqual(spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, input: '' }).status, 0, 'no bundle stops the run');
        assert.equal(send().status, 0);
        assert.equal(fs.readFileSync(path.join(repo, 'file'), 'utf8'), 'three\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('deploy: every installed repository except the private copy moves on its own', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const start = body.indexOf('installed_repos() {');
    const definition = body.slice(start, body.indexOf('\n          }\n', start));
    const sample = [
        'Available repositories:',
        '- basic: https://example.test/basic.git [agents]',
        '- AchillesIDE: https://example.test/ide.git [agents] [installed]',
        '- bizanso: (local) [agents] [installed]',
        '',
        "Tip: install repos with 'install repo <url> [name]'. [installed]",
    ].join('\n');
    const result = spawnSync('bash', ['-c', `${definition}\n}\ninstalled_repos`], { input: sample, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'AchillesIDE\nbizanso\n');
    // The Box holds no credential for the private sources, and the two copies have no Git metadata at all.
    assert.match(body, /if \[ "\$repo" != bizanso \] && \[ "\$repo" != PromotionScoutV2 \] && \[ "\$repo" != simpleCSVMailSend \]; then\n\s+ploinky_locked update repo "\$repo"\n/);
    assert.doesNotMatch(body, /ploinky_locked update\n/);
    // The loop lives only in update_kept_repos, called once, after the workspace repositories are placed.
    assert.equal(body.split('ploinky_locked update repo').length - 1, 1);
    assert.equal(body.split(/\n\s+update_kept_repos\n/).length - 1, 1);
});

test('deploy: the link-install checkouts AdvancedLanguageAgent and DocumentationSkills are updated with the installed repositories, before the restart', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const start = body.indexOf('update_kept_repos() {');
    const fn = body.slice(start, body.indexOf('\n          }\n', start));
    // Ploinky cannot update them: they hold no agent folder, so `update repo` finds no installed repository.
    assert.match(fn, /ploinky_locked update repo "\$repo"[\s\S]*run_in_box "\$LINK_INSTALL_PROGRAM" < \/dev\/null/);
    assert.match(fn, /if ! run_in_box "\$LINK_INSTALL_PROGRAM" < \/dev\/null; then[\s\S]*exit 1/);
    assert.ok(body.indexOf("LINK_INSTALL_PROGRAM='") < start);
    assert.ok(start < body.indexOf('\n          update_kept_repos\n'));
    assert.ok(body.indexOf('\n          update_kept_repos\n') < body.indexOf('ploinky_locked restart\n'));
    assert.equal(body.split('run_in_box "$LINK_INSTALL_PROGRAM"').length - 1, 1);
    const program = body.match(/LINK_INSTALL_PROGRAM='([^']*)'/)[1];
    assert.match(program, /for name in AdvancedLanguageAgent DocumentationSkills; do/);
    assert.match(program, /merge --quiet --ff-only/);
    assert.doesNotMatch(program, /reset|checkout|stash|clean/);
});

test('deploy: the link-install program fast-forwards a clean checkout and leaves every other state untouched', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const program = body.match(/LINK_INSTALL_PROGRAM='([^']*)'/)[1];
    assert.match(program, /^set -eu\n\s+export GIT_ALLOW_PROTOCOL=https\n/);
    assert.match(program, /remote get-url origin\) \|\| \{ echo "\$name has no origin/);
    assert.match(program, /fetch --quiet "\$url" /);
    assert.doesNotMatch(program, /config --get|fetch --quiet origin/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-link-install-'));
    const names = ['AdvancedLanguageAgent', 'DocumentationSkills'];
    const upstream = (name) => path.join(root, 'upstream', name);
    const url = (name) => `https://github.com/AssistOS-AI/${name}.git`;
    const git = (cwd, ...args) => {
        const result = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        // The seam: a PATH shim that rewrites only the URL a fetch is given, so `remote get-url` still reports the real
        // URL and the program is the unchanged text. The shim lifts GIT_ALLOW_PROTOCOL only for this local transport.
        const bin = path.join(root, 'bin');
        const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
unset GIT_ALLOW_PROTOCOL
fetching=0
for arg in "$@"; do [ "$arg" = fetch ] && fetching=1; done
if [ "$fetching" = 1 ]; then
  count=$#
  while [ "$count" -gt 0 ]; do
    arg=$1; shift; count=$((count - 1))
    case "$arg" in
    ${names.map((name) => `"${url(name)}") set -- "$@" "${upstream(name)}" ;;`).join('\n    ')}
    *) set -- "$@" "$arg" ;;
    esac
  done
fi
exec "${realGit}" "$@"
`, { mode: 0o755 });
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        const commit = (name, text) => {
            fs.writeFileSync(path.join(upstream(name), 'file'), `${text}\n`);
            git(upstream(name), 'add', 'file');
            git(upstream(name), 'commit', '--quiet', '-m', text);
        };
        for (const name of names) {
            fs.mkdirSync(upstream(name), { recursive: true });
            git(upstream(name), 'init', '--quiet', '-b', 'trunk');
            commit(name, 'one');
        }
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
        const run = () => spawnSync('sh', ['-c', program, 'sh'], { cwd: workspace, encoding: 'utf8', env, input: '' });
        const checkout = (name) => path.join(workspace, name);
        const text = (name) => fs.readFileSync(path.join(checkout(name), 'file'), 'utf8');
        const head = (name) => git(checkout(name), 'rev-parse', 'HEAD');
        const clone = (name) => {
            git(workspace, 'clone', '--quiet', '--branch', 'trunk', upstream(name), name);
            git(checkout(name), 'remote', 'set-url', 'origin', url(name));
        };
        const none = run();
        assert.equal(none.status, 0, none.stderr);
        assert.match(none.stdout, /AdvancedLanguageAgent is not at the workspace root; skipped\./);
        assert.match(none.stdout, /DocumentationSkills is not at the workspace root; skipped\./);
        for (const name of names) clone(name);
        for (const name of names) commit(name, 'two');
        const moved = run();
        assert.equal(moved.status, 0, moved.stderr);
        for (const name of names) assert.equal(text(name), 'two\n', `${name} fast-forwards`);
        assert.match(moved.stdout, /AdvancedLanguageAgent [0-9a-f]+ on trunk\./);
        assert.equal(run().status, 0, 'an equal checkout is a no-op');
        // Each refusal leaves the checkout exactly as it was.
        const refuses = (name, pattern, label) => {
            const before = head(name);
            const result = run();
            assert.notEqual(result.status, 0, label);
            assert.match(result.stderr, pattern, label);
            assert.equal(head(name), before, `${label}: HEAD unchanged`);
        };
        const ala = 'AdvancedLanguageAgent';
        const docs = 'DocumentationSkills';
        commit(ala, 'three');
        fs.writeFileSync(path.join(checkout(docs), 'file'), 'edited\n');
        // The alphabetical order makes AdvancedLanguageAgent move before the refusal.
        refuses(docs, /DocumentationSkills has uncommitted or untracked changes; left untouched/, 'dirty');
        assert.equal(text(docs), 'edited\n');
        assert.equal(text(ala), 'three\n', 'the checkout before the refused one still moved');
        git(checkout(docs), 'checkout', '--quiet', 'file');
        fs.writeFileSync(path.join(checkout(docs), 'stray'), 'x\n');
        refuses(docs, /uncommitted or untracked changes/, 'untracked file');
        fs.rmSync(path.join(checkout(docs), 'stray'));
        git(checkout(docs), 'commit', '--quiet', '--allow-empty', '-m', 'local');
        refuses(docs, /DocumentationSkills has commits that trunk lacks; left untouched/, 'diverged');
        git(checkout(docs), 'reset', '--quiet', '--hard', 'HEAD~1');
        git(checkout(docs), 'remote', 'set-url', 'origin', 'https://example.test/other.git');
        refuses(docs, /DocumentationSkills has an unexpected origin; left untouched/, 'foreign origin');
        git(checkout(docs), 'remote', 'remove', 'origin');
        refuses(docs, /DocumentationSkills has no origin; left untouched/, 'missing origin');
        git(checkout(docs), 'remote', 'add', 'origin', url(docs));
        // A repo-local insteadOf makes `remote get-url` report the redirected URL, so it never matches.
        git(checkout(docs), 'config', `url.${path.join(root, 'foreign')}.insteadOf`, url(docs));
        refuses(docs, /DocumentationSkills has an unexpected origin; left untouched/, 'repo-local insteadOf');
        git(checkout(docs), 'config', '--remove-section', `url.${path.join(root, 'foreign')}`);
        git(checkout(docs), 'checkout', '--quiet', '--detach');
        refuses(docs, /detached HEAD; left untouched/, 'detached HEAD');
        git(checkout(docs), 'checkout', '--quiet', 'trunk');
        // A checkout whose upstream branch is gone cannot be compared; that is a different message from a divergence.
        git(checkout(docs), 'branch', '--quiet', 'gone');
        git(checkout(docs), 'checkout', '--quiet', 'gone');
        const missingRef = run();
        assert.notEqual(missingRef.status, 0);
        assert.doesNotMatch(missingRef.stderr, /commits that gone lacks/);
        git(checkout(docs), 'checkout', '--quiet', 'trunk');
        fs.renameSync(checkout(docs), path.join(root, 'docs-real'));
        fs.symlinkSync(path.join(root, 'docs-real'), checkout(docs));
        refuses(ala, /DocumentationSkills is a symlink; left untouched/, 'symlink');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Runs a slice of the deploy step with stubs for every command, so only its shell logic is proven. The status texts
// are Ploinky's: `Ploinky Box: absent` from formatBoxStatus for no Box, and the in-Box status output, which has no
// `Ploinky Box:` line, for a running initialized Box.
const ABSENT_STATUS = 'Ploinky Box: absent\nWorkspace identity: explorerqaworkspace-7a31ab7775eb';
const RUNNING_STATUS = 'Agent runtimes:\n  [running] [ready] agent: explorer';
function runSlice(t, { from, to, env }) {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const begin = body.indexOf(from);
    assert.notEqual(begin, -1, from);
    const end = body.indexOf(to, begin);
    assert.notEqual(end, -1, to);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-first-start-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const log = path.join(dir, 'calls');
    const script = `set -euo pipefail
LOG='${log}'; ROUTER_PORT=8097
ploinky_locked() { echo "locked $*" >> "$LOG"; }
ploinky_read() { echo "read $*" >> "$LOG"; }
prune_images() { echo "prune $*" >> "$LOG"; }
require_free_disk() { echo 'disk' >> "$LOG"; }
runtime_states() { cat > /dev/null; }
wait_ready() { echo 'wait_ready' >> "$LOG"; }
${body.slice(begin, end + to.length)}
echo done >> "$LOG"
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: result.status, stdout: result.stdout, calls };
}

test('deploy: reset_explorer_checkout is an opt-in boolean, validated before anything runs', () => {
    assert.match(deploy, /\n      reset_explorer_checkout:\n        description: '[^'\n]+'\n        required: false\n        default: false\n        type: boolean\n/);
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    assert.match(body, /RESET_EXPLORER_CHECKOUT: \$\{\{ inputs\.reset_explorer_checkout \}\}/);
    assert.match(body, /case "\$RESET_EXPLORER_CHECKOUT" in\n\s+true\|false\) ;;\n\s+\*\) echo "::error::reset_explorer_checkout must be true or false"; exit 1 ;;/);
    // Only the first start resets, and only AchillesIDE.
    assert.equal(deploy.split('--reset-repos').length - 1, 1);
    assert.equal(deploy.split('--repo-branch').length - 1, 1);
});

const GUARD = { from: '          BOX_STATE=present\n', to: '          require_free_disk\n' };

test('deploy: a requested reset is refused before anything moves when a Box exists', (t) => {
    const run = runSlice(t, { ...GUARD, env: { STATUS_OUTPUT: RUNNING_STATUS, RECREATE_BOX: 'false', RESET_EXPLORER_CHECKOUT: 'true' } });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::reset_explorer_checkout needs a workspace with no Box\. Nothing was changed\./);
    assert.deepEqual(run.calls, []);
    const recreate = runSlice(t, { ...GUARD, env: { STATUS_OUTPUT: RUNNING_STATUS, RECREATE_BOX: 'true', RESET_EXPLORER_CHECKOUT: 'true' } });
    assert.equal(recreate.status, 1);
    assert.deepEqual(recreate.calls, []);
});

test('deploy: the reset guard lets every other combination through', (t) => {
    for (const [status, reset] of [[ABSENT_STATUS, 'true'], [ABSENT_STATUS, 'false'], [RUNNING_STATUS, 'false']]) {
        const run = runSlice(t, { ...GUARD, env: { STATUS_OUTPUT: status, RECREATE_BOX: 'false', RESET_EXPLORER_CHECKOUT: reset } });
        assert.equal(run.status, 0, `${reset} ${status}`);
        assert.deepEqual(run.calls, ['prune pre', 'disk', 'done']);
    }
});

const FIRST_START = { from: '          if [ "$GRAPH_UP" = false ]; then\n', to: '\n            wait_ready\n          fi\n' };

test('deploy: only a requested reset adds the AchillesIDE reset to the first start', (t) => {
    const reset = runSlice(t, { ...FIRST_START, env: { GRAPH_UP: 'false', RESET_EXPLORER_CHECKOUT: 'true' } });
    assert.equal(reset.status, 0);
    assert.deepEqual(reset.calls, ['locked --port 8097 start explorer --repo-branch AchillesIDE=main --reset-repos', 'wait_ready', 'done']);
    const plain = runSlice(t, { ...FIRST_START, env: { GRAPH_UP: 'false', RESET_EXPLORER_CHECKOUT: 'false' } });
    assert.equal(plain.status, 0);
    assert.deepEqual(plain.calls, ['locked --port 8097 start explorer', 'wait_ready', 'done']);
    const up = runSlice(t, { ...FIRST_START, env: { GRAPH_UP: 'true', RESET_EXPLORER_CHECKOUT: 'true' } });
    assert.equal(up.status, 0);
    assert.deepEqual(up.calls, ['done']);
});

test('deploy: readiness reads only the runtime block of real status output', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const start = body.indexOf('runtime_states() {');
    const end = body.indexOf('\n          }\n', start);
    const definition = body.slice(start, end);
    const sample = [
        'Workspace status:',
        '- Repos:',
        '  - webmeet [agents] [local]',
        '  - local-llms [agents] [local]',
        'Agent runtimes:',
        '  - ploinky_AchillesIDE_explorer_x [running] [container] pid 7',
        '     agent: explorer  repo: AchillesIDE',
        '     image: i',
        '',
        '  - ploinky_webmeet_room_x [starting] [container]',
        '     agent: webmeetAgent  repo: webmeet',
        '  - ploinky_local_x [failed] [bwrap]',
        '     agent: local-llm  repo: local-llms',
    ].join('\n');
    const result = spawnSync('bash', ['-c', `${definition}\n}\nruntime_states`], { input: sample, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'explorer running\nwebmeetAgent starting\nlocal-llm failed\n');
});

test('destroy: maps delete_data to exactly the two Ploinky forms before the Cloudflare step', () => {
    const body = step(destroy, 'Destroy the Box through Ploinky commands');
    assert.match(body, /true\) ploinky_locked destroy --delete-data --confirm-workspace "\$WORK_DIR" ;;/);
    assert.match(body, /false\) ploinky_locked destroy ;;/);
    assert.match(body, /WORK_DIR="\/home\/admin\/\$WORKSPACE"/);
    assert.ok(destroy.indexOf('- name: Destroy the Box through') < destroy.indexOf('- name: Delete the dedicated Cloudflare publication'));
    // The kept journal names this tunnel, so only a delete-data destroy removes the publication.
    assert.match(step(destroy, 'Delete the dedicated Cloudflare publication'), /if: success\(\) && inputs\.delete_data\n/);
});

// The steps below ran under the removed non-Ploinky workflows too, and their behavioural cases are kept here against
// the text these workflows hold. Only the workflow they read changed; the assertions are the ones of those cases.
const NODE_HEREDOC = (script) => script.match(/<<'NODE'[^\n]*\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
const cloudflareScript = () => {
    const found = NODE_HEREDOC(runBlocks(step(destroy, 'Delete the dedicated Cloudflare publication'))[0]);
    assert.ok(found, 'the Cloudflare step has an embedded program');
    return found;
};

test('destroy: the Cloudflare deletion runs on the runner after the Box is destroyed and refuses the protected tunnel', () => {
    const cloudflare = step(destroy, 'Delete the dedicated Cloudflare publication');
    assert.ok(destroy.indexOf('- name: Destroy the Box through') < destroy.indexOf('- name: Delete the dedicated Cloudflare publication'));
    assert.match(cloudflare, /\n {8}if: success\(\) && inputs\.delete_data\n/);
    assert.doesNotMatch(runBlocks(cloudflare)[0], /\bssh\b|\bscp\b|flock/);
    assert.match(cloudflare, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.EXPLORER_QA_CLOUDFLARE_API_TOKEN \}\}/);
    const script = cloudflareScript();
    assert.match(script, /if \(protectedTunnelId !== '091c4096-d1c8-4dbc-bb12-0c6357431d96'\)/);
    assert.match(script, /if \(tunnelId === protectedTunnelId\) \{\n {2}throw new Error\('refusing to delete the protected shared Cloudflare tunnel'\);/);
    const guard = script.indexOf('tunnelId === protectedTunnelId');
    assert.ok(guard > script.indexOf('/^[a-f0-9-]{36}$/.test(tunnelId)'));
    assert.ok(guard < script.indexOf('request(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`)'), 'the guard precedes any request that uses the tunnel id');
    const dns = script.indexOf("request(`/zones/${zoneId}/dns_records/${records[0].id}`, { method: 'DELETE' })");
    const connections = script.indexOf('/cfd_tunnel/${tunnelId}/connections');
    const tunnel = script.indexOf("request(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' })");
    assert.ok(dns > 0 && dns < connections && connections < tunnel, 'DNS is deleted before the tunnel');
    assert.match(script, /Exact Explorer QA Cloudflare publication was already absent/);
    assert.match(script, /Exact Explorer QA Cloudflare publication deletion verified/);
    assert.match(step(destroy, 'Cleanup'), /if: always\(\)/);
});

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

const PROTECTED_TUNNEL = '091c4096-d1c8-4dbc-bb12-0c6357431d96';
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
        input: cloudflareScript(),
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

test('destroy: the pinned identity and the shared-tunnel pin are fixed before the host is touched', () => {
    const validate = runBlocks(step(destroy, 'Validate GitHub configuration'))[0];
    assert.match(validate, /\[ "\$CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID" != '091c4096-d1c8-4dbc-bb12-0c6357431d96' \]/);
    assert.match(validate, /case "\$\{DELETE_DATA:-\}" in\n {2}true\|false\) ;;/);
    assert.equal(destroy.match(/ssh-keyscan/g)?.length, 1, 'destroy host key must be scanned only in pinned preflight');
    assert.ok(
        destroy.indexOf('SSH_ED25519_FINGERPRINT') < destroy.indexOf('- name: Destroy the Box through Ploinky commands'),
        'destroy target fingerprint must be established before remote mutation',
    );
    assert.match(destroy, /install -m 600 "\$RUNNER_TEMP\/explorer_qa_known_hosts"/);
    assert.match(destroy, /CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: '091c4096-d1c8-4dbc-bb12-0c6357431d96'/);
    assert.doesNotMatch(destroy, /EXPLORER_QA_CLOUDFLARE_TUNNEL_(?:TOKEN|ID)/);
    assert.doesNotMatch(destroy, /vars\.EXPLORER_QA_(?:SSH_USER|SSH_HOST|WORKSPACE)/);
});

test('deploy: the public URL check always runs after a successful step and the topology check runs even after a failure', () => {
    assert.doesNotMatch(step(deploy, 'Verify public URL'), /^ {8}if:/m);
    assert.match(step(deploy, 'Verify dedicated connector and protected Cloudflare topology'), /^ {8}if: always\(\)$/m);
});

function runValidate(t, env = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-destroy-validate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.writeFileSync(path.join(bin, 'ssh-keyscan'), `#!/bin/bash\necho scanned >> '${path.join(root, 'scan.log')}'\necho '45.136.70.141 ssh-ed25519 AAAA'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ssh-keygen'), '#!/bin/bash\necho "256 SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA 45.136.70.141 (ED25519)"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-c', runBlocks(step(destroy, 'Validate GitHub configuration'))[0]], {
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

test('destroy: validation accepts both delete_data values and rejects other values, a moved shared-tunnel pin and a Global API Key', t => {
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

test('deploy: the dedicated tunnel provisioning is fail-closed and preserves the shared tunnel', () => {
    for (const required of [
        "CLOUDFLARE_TUNNEL_CREATED='true'",
        "if (created === 'true' && (ingress.length > 1 || records.length !== 0))",
        'named.length !== 1 || named[0]?.id !== selectedId',
        "ingress[0]?.service !== 'http://127.0.0.1:8080'",
        'records[0]?.content !== expectedTarget',
        'config?.config?.ingress ?? config?.ingress ?? []',
        'cleanup_local_files() {',
        'trap cleanup_local_files EXIT',
        'echo "::add-mask::$CLOUDFLARE_TUNNEL_TOKEN"',
        'publication/explorer-qa-api',
        'publication/explorer-qa-tunnel',
        'beforeJson !== afterJson',
        'digest(after) !== process.env.PROTECTED_CLOUDFLARE_DIGEST',
        'result.filter((record) => record?.name !== publicHost)',
        'records.filter((record) => record?.name !== process.env.PUBLIC_HOST)',
        'dedicated Explorer QA connector has no active Cloudflare connection',
    ]) {
        assert.equal(deploy.includes(required), true, `missing dedicated tunnel invariant: ${required}`);
    }
    assert.doesNotMatch(deploy, /EXPLORER_QA_CLOUDFLARE_TUNNEL_TOKEN/);
    assert.doesNotMatch(deploy, /cfd_tunnel\/091c4096-d1c8-4dbc-bb12-0c6357431d96(?:\/token|\"\s*,\s*\{\s*method:\s*['\"](?:PUT|POST|DELETE))/);
    assert.equal(
        deploy.match(/config\?\.config\?\.ingress \?\? config\?\.ingress \?\? \[\]/g)?.length,
        2,
        'both existing-tunnel inventories must normalize Cloudflare missing configuration to empty ingress',
    );
});

test('deploy: the dedicated tunnel validator rejects malformed, shared, ambiguous, and wrong-DNS fixtures', () => {
    const source = deploy;
    const marker = 'const [listPath, detailPath, configPath, dnsPath, selectedId, created]';
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex > 0, 'dedicated tunnel validator marker must exist');
    const heredocStart = source.lastIndexOf("<<'NODE'\n", markerIndex);
    const scriptStart = heredocStart + "<<'NODE'\n".length;
    const scriptEnd = source.indexOf('\n          NODE', markerIndex);
    assert.ok(heredocStart > 0 && scriptEnd > scriptStart, 'dedicated tunnel validator heredoc must close');
    const script = source.slice(scriptStart, scriptEnd).replace(/^          /gm, '');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-qa-tunnel-validator-'));
    const selectedId = '11111111-2222-4333-8444-555555555555';
    const accountId = 'a'.repeat(32);
    const hostname = 'explorer-qa.axiologic.dev';
    const response = (result) => ({ success: true, result });
    const run = ({
        named = [{ id: selectedId, name: 'explorer-qa' }],
        detail = { id: selectedId, name: 'explorer-qa', deleted_at: null, account_tag: accountId },
        ingress = [],
        dns = [],
        created = 'false',
    } = {}) => {
        const documents = [response(named), response(detail), response({ config: { ingress } }), response(dns)];
        const files = documents.map((document, index) => {
            const file = path.join(temporary, `${index}.json`);
            fs.writeFileSync(file, JSON.stringify(document));
            return file;
        });
        return spawnSync(
            process.execPath,
            ['--input-type=module', '-', ...files, selectedId, created],
            {
                encoding: 'utf8',
                env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, PUBLIC_HOST: hostname },
                input: script,
            },
        );
    };
    try {
        assert.equal(run({ created: 'true' }).status, 0, 'a newly created empty dedicated tunnel is accepted');
        assert.notEqual(run({ created: 'maybe' }).status, 0, 'the creation marker must be a literal boolean');
        assert.notEqual(run({
            created: 'true',
            ingress: [
                { hostname, service: 'http://127.0.0.1:8080' },
                { service: 'http_status:404' },
            ],
        }).status, 0, 'a newly created tunnel must not already carry routes');
        assert.notEqual(run({ named: [] }).status, 0, 'the created or reused tunnel must be listed before token retrieval');
        assert.equal(
            run({ ingress: null }).status,
            0,
            'existing selected tunnel with no configuration object may have empty ingress',
        );
        assert.notEqual(run({ ingress: { unexpected: true } }).status, 0);
        assert.equal(run({
            ingress: [
                { hostname, service: 'http://127.0.0.1:8080' },
                { service: 'http_status:404' },
            ],
            dns: [{
                id: 'dns_1',
                type: 'CNAME',
                name: hostname,
                content: `${selectedId}.cfargotunnel.com`,
                proxied: true,
            }],
        }).status, 0, 'exact reusable dedicated tunnel must pass');
        assert.notEqual(run({ named: [{ id: selectedId }, { id: 'other' }] }).status, 0);
        assert.notEqual(run({ detail: { id: selectedId, name: 'explorer-qa', account_tag: 'b'.repeat(32) } }).status, 0);
        assert.notEqual(run({
            ingress: [
                { hostname: 'unrelated.example.test', service: 'http://127.0.0.1:8080' },
                { service: 'http_status:404' },
            ],
        }).status, 0);
        assert.notEqual(run({
            dns: [{ type: 'CNAME', name: hostname, content: 'wrong.cfargotunnel.com', proxied: true }],
        }).status, 0);
        assert.notEqual(run({ created: 'true', dns: [{ type: 'CNAME' }] }).status, 0);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publicUrl = 'https://explorer-qa.axiologic.dev';
const userPersistoService = '/base-agent-additional-server/userPersistoAgent/7000/service';
const issuer = `${publicUrl}${userPersistoService}/oidc`;
function publicVerificationBlock() {
    const match = deploy.match(/\/\/ BEGIN QA public email-first verification\n([\s\S]*?)\/\/ END QA public email-first verification/);
    assert.ok(match, 'the public verification block');
    return match[1].replace(/^ {10}/gm, '');
}

async function verifyPublic(overrides = {}) {
    const login = `${publicUrl}${userPersistoService}/auth/?requestId=request&state=state`;
    const responses = {
        [login]: '<main id="auth_content"></main><script type="module" src="main.js"></script>',
        [`${publicUrl}${userPersistoService}/auth/setup`]: { ok: true, setupComplete: false, registration: true, methods: { password: true, emailCode: true } },
        [`${issuer}/.well-known/openid-configuration`]: {
            issuer, code_challenge_methods_supported: ['S256'], authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/me`,
        },
        ...overrides.responses,
    };
    const requests = [];
    const logs = [];
    await new AsyncFunction('body', 'headers', 'mismatchBody', 'mismatchHeaders', 'fetch', 'process', 'console', publicVerificationBlock())(
        overrides.body ?? `Continue with Single Sign-On<script>window.location.replace(${JSON.stringify(login)})</script>`,
        overrides.headers ?? 'cf-ray: test', { ok: false, error: 'auth_route_context_mismatch' }, 'cf-ray: test',
        async (url, options) => {
            requests.push(url);
            assert.equal(options.redirect, 'error');
            assert.equal(options.method, undefined, 'verification must never submit sign-in or registration');
            assert(Object.hasOwn(responses, url));
            return { ok: true, headers: new Map([['cf-ray', 'test']]), text: async () => responses[url], json: async () => responses[url] };
        },
        { exit: () => { throw new Error('verification rejected'); } },
        { log: (label, details) => logs.push({ label, details: JSON.parse(details) }) },
    );
    return { requests, logs };
}

test('deploy: the public verification checks the SSO wizard and OIDC metadata without claiming an unclaimed installation', async () => {
    const result = await verifyPublic();
    assert.equal(result.requests.length, 3);
    assert.deepEqual(result.logs[0].details.methods, { password: true, emailCode: true, passkey: false, totp: false, google: false });
    await assert.rejects(verifyPublic({ body: '<form data-auth-login-form><input type="password"></form>' }), /rejected/);
    // Current Routers redirect with 303 and no page body.
    const login = `${publicUrl}${userPersistoService}/auth/?requestId=request&state=state`;
    const redirected = await verifyPublic({ body: '', headers: `HTTP/2 303\r\nLocation: ${login}\r\ncf-ray: test\r\n` });
    assert.equal(redirected.requests[0], login);
    await assert.rejects(verifyPublic({ body: '', headers: 'HTTP/2 303\r\nLocation: https://other.example/auth/?state=x&requestId=y\r\ncf-ray: test\r\n' }), /rejected/);
    await assert.rejects(verifyPublic({ body: '', headers: 'HTTP/2 303\r\ncf-ray: test\r\n' }), /rejected/);
    await assert.rejects(verifyPublic({ body: 'Continue with Single Sign-On<script>window.location.replace("https://other.example/auth/?state=x&requestId=y")</script>' }), /rejected/);
    await assert.rejects(verifyPublic({ responses: {
        [`${issuer}/.well-known/openid-configuration`]: { issuer: 'https://other.example' },
    } }), /rejected/);
});

test('the default Explorer graph the QA deploy waits for includes UserPersisto and its email dependency', () => {
    const explorer = JSON.parse(fs.readFileSync(path.join(ROOT, 'explorer/manifest.json'), 'utf8'));
    const provider = JSON.parse(fs.readFileSync(path.join(ROOT, 'userPersistoAgent/manifest.json'), 'utf8'));
    assert.equal(explorer.sso.providerAgent, 'userPersistoAgent');
    // An enable entry is a spec string or an object carrying the spec and its profile.
    const enabled = manifest => manifest.enable.map(entry => String(typeof entry === 'string' ? entry : entry.agent).split(/\s+/)[0]);
    assert.ok(enabled(explorer).includes('userPersistoAgent'));
    assert.ok(enabled(provider).includes('emailAgent'));
});

test('the four QA workflows neither provision nor inspect the retired local model runtime, nor manage retired stack repositories', () => {
    const retiredRepositoryPattern = new RegExp(`\\b(?:${['basic', ['webmeet', 'Infra'].join('')].join('|')})\\b`);
    for (const name of ['deploy-explorer-qa-ploinky.yml', 'destroy-explorer-qa-ploinky.yml', 'deploy-explorer-qa-bizanso.yml', 'deploy-explorer-qa-scriptahub.yml']) {
        const source = read(name);
        assert.doesNotMatch(source, retiredRepositoryPattern, `${name} must not manage a retired stack repository`);
        assert.doesNotMatch(source, /DEFAULT_LOCAL_LLM/, `${name} must not define or forward a local model image`);
        assert.doesNotMatch(source, /default-local-llm/i, `${name} must not pull, start, or inspect the retired local model agent`);
        assert.doesNotMatch(source, /default local LLM image/i, `${name} must not inspect a local model image`);
    }
});

// The isolated Node runtime block is the same text in the Ploinky deploy and both product workflows
// (deploy-qa-product-workflows.test.mjs pins it byte for byte); the Ploinky destroy has none. These cases run it from the deploy.
const NODE_SECTION = deploy.match(/# BEGIN QA isolated Node runtime\n([\s\S]*?)# END QA isolated Node runtime/)[1].replace(/^ {10}/gm, '');
const NODE_SHA = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
const NODE_DIST = 'node-v24.19.0-linux-x64';

// The extracted deployment block intentionally uses GNU utilities. Resolve their g-prefixed macOS installations too,
// but never replace a deadline or checksum operation with a no-op fixture command.
const gnuTools = Object.fromEntries(['timeout', 'mv', 'sha256sum'].map(name => {
    for (const binary of [name, `g${name}`]) {
        for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
            const executable = path.join(directory, binary);
            const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 2000 });
            if (result.status === 0 && /GNU coreutils/.test(result.stdout || '')) return [name, executable];
        }
    }
    return [name, null];
}));
const missingGnuTools = Object.entries(gnuTools).filter(([, executable]) => !executable).map(([name]) => name);
const runtimeOptions = missingGnuTools.length
    ? { skip: `Requires GNU ${missingGnuTools.join(', ')}; run these workflow behavior tests on Linux or with GNU coreutils on PATH.` }
    : {};

function nodeFixture(t) {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-node-runtime-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const root = path.join(folder, 'tools');
    const shims = path.join(folder, 'shims');
    const archiveRoot = path.join(folder, 'archive');
    const archive = path.join(folder, 'node.tar.xz');
    fs.mkdirSync(shims);
    for (const [name, executable] of Object.entries(gnuTools)) fs.symlinkSync(executable, path.join(shims, name));
    fs.mkdirSync(path.join(archiveRoot, NODE_DIST, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, NODE_DIST, 'bin/node'), '#!/bin/sh\nif [ "$1" = --version ]; then echo v24.19.0; else exec "$QA_REAL_NODE" "$@"; fi\n', { mode: 0o755 });
    assert.equal(spawnSync('tar', ['-cJf', archive, '-C', archiveRoot, NODE_DIST]).status, 0);
    fs.writeFileSync(path.join(shims, 'uname'), '#!/bin/sh\necho x86_64\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shims, 'curl'), '#!/bin/sh\nfor argument do destination="$argument"; done\necho fetch >> "$QA_FETCH_LOG"\ncp "$QA_FIXTURE_ARCHIVE" "$destination"\n', { mode: 0o755 });
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const source = 'set -euo pipefail\n' + NODE_SECTION.replaceAll('/home/admin/.qa-deployment-tools', root).replaceAll(NODE_SHA, checksum);
    const run = (script = source) => spawnSync('bash', ['-c', script], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${shims}:${path.dirname(process.execPath)}:${process.env.PATH}`,
            QA_REAL_NODE: process.execPath, QA_FIXTURE_ARCHIVE: archive, QA_FETCH_LOG: path.join(folder, 'fetches') },
    });
    return { folder, root, source, run, node: path.join(root, NODE_DIST, 'bin/node'), archive: path.join(root, `${NODE_DIST}.tar.xz`) };
}

test('QA scoped Node installs a verified archive and reuses the exact validated binary', runtimeOptions, t => {
    const f = nodeFixture(t);
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.archive).mode & 0o777, 0o600);
    const inode = fs.statSync(f.node).ino;
    const reused = f.run();
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(fs.statSync(f.node).ino, inode);
    assert.equal(fs.readFileSync(path.join(f.folder, 'fetches'), 'utf8'), 'fetch\n');
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.node-install-')), false);
});

test('QA scoped Node refuses a tampered cached binary before executing it', runtimeOptions, t => {
    const f = nodeFixture(t);
    assert.equal(f.run().status, 0);
    const marker = path.join(f.folder, 'executed');
    fs.writeFileSync(f.node, `#!/bin/sh\ntouch '${marker}'\necho v24.19.0\n`);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.node-install-')), false);
});

test('QA scoped Node refuses checksum mismatch and unsafe tool roots without publishing a runtime', runtimeOptions, t => {
    const f = nodeFixture(t);
    const badChecksum = f.source.replace(/QA_NODE_SHA=[a-f0-9]{64}/, `QA_NODE_SHA=${'0'.repeat(64)}`);
    assert.notEqual(f.run(badChecksum).status, 0);
    assert.equal(fs.existsSync(f.node), false);
    assert.equal(fs.existsSync(f.archive), false);
    fs.rmSync(f.root, { recursive: true });
    fs.symlinkSync(path.join(f.folder, 'archive'), f.root);
    assert.notEqual(f.run().status, 0);
    assert.equal(fs.existsSync(path.join(f.folder, 'archive', `${NODE_DIST}.tar.xz`)), false);
});

test('QA Node pinning is the pinned archive, never replaces the shared host installation, and is installed once', () => {
    assert.match(NODE_SECTION, /https:\/\/nodejs\.org\/dist\/v24\.19\.0\//);
    assert.ok(NODE_SECTION.includes(NODE_SHA));
    assert.ok(NODE_SECTION.includes('01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc'));
    assert.match(NODE_SECTION, /export PATH="\$QA_NODE_HOME\/bin:\$PATH"/);
    assert.match(NODE_SECTION, /cmp -s/);
    assert.doesNotMatch(NODE_SECTION, /sudo|apt-get|\/usr\/bin\/node|\/usr\/local\/bin\/node/);
    assert.equal(deploy.match(/# BEGIN QA isolated Node runtime/g).length, 1, 'the QA Node is installed once');
});

test('deploy: the image prune removes only listed, validated IDs with `podman image rm` and never forces', () => {
    const prune = deploy.match(IMAGE_PRUNE_BLOCK)?.[0];
    assert.ok(prune, 'the image prune block');
    assert.match(prune, /image rm "\$id"/);
    assert.equal((prune.match(/image rm/g) || []).length, 1);
    // The host lists only dangling images; the Box lists every image and keeps tagged ones (see the Box prune test).
    assert.match(prune, /filter='--filter dangling=true'\n\s+\[ "\$scope" = host \] \|\| filter=''\n/);
    assert.match(prune, /image ls \$filter --format "'\{\{\.ID\}\} \{\{\.Containers\}\} \{\{\.Dangling\}\} \{\{\.Names\}\}'"/);
    assert.match(prune, /PRUNE_DIGEST_REPOS='docker\.io\/assistos\/scriptahub-agent docker\.io\/assistos\/roboteam-agent docker\.io\/assistos\/bizanso-agent'\n/);
    assert.match(prune, /if \[\[ ! "\$ref" =~ \^\(\[a-z0-9\.\/_-\]\+\)@sha256:\[a-f0-9\]\{64\}\$ \]\]; then/);
    assert.match(prune, /\^\[a-f0-9\]\{12,64\}\$/);
    assert.match(prune, /\[ "\$containers" != 0 \]/);
    // No broad removal anywhere in the workflow, and no forced or all-image form of the removal.
    assert.doesNotMatch(deploy, /image prune/);
    assert.doesNotMatch(deploy, /podman[^\n]*\bimage rm\b[^\n]*(?:\s-[a-zA-Z]*[fa]\b|--force|--all)/);
    assert.doesNotMatch(deploy, /\bimage ls\b[^\n]*\s-a\b/);
    assert.doesNotMatch(deploy, /--external|\bsystem prune\b|\brmi\b/);
});

test('deploy: the host prune keeps only images whose name history is the Box image', () => {
    const prune = deploy.match(IMAGE_PRUNE_BLOCK)[0];
    assert.match(prune, /PRUNE_BOX_IMAGE=docker\.io\/assistos\/ploinky-box\n/);
    assert.match(prune, /image inspect --format "'\{\{range \.NamesHistory\}\}\{\{println \.\}\}\{\{end\}\}'" "\$id"/);
    assert.match(prune, /"\$PRUNE_BOX_IMAGE"\|"\$PRUNE_BOX_IMAGE":\*\|"\$PRUNE_BOX_IMAGE"@\*\) is_box_image=true/);
    assert.match(prune, /if \[ "\$scope" = host \]; then\n\s+if ! names=/);
    assert.match(prune, /kept unrelated dangling image \$id/);
    // The Box scope runs inside the Box container, as the workspace-repository helper does, under the host lock.
    assert.match(prune, /flock -n -E 75 --close '\$LOCK' podman container exec --user podman .* \$BOX_CONTAINER podman \$\*/);
    assert.match(prune, /BOX_CONTAINER=ploinky-box-explorerqaworkspace-7a31ab7775eb\n/);
});

test('deploy: a pre prune and the disk gate run before anything moves, a post prune after the readiness checks', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const order = [
        'unrelated_containers() {',
        '# BEGIN QA image cleanup',
        '# END QA image cleanup',
        'UNRELATED_BEFORE="$(unrelated_containers)"',
        'BOX_STATE=present',
        '          prune_images pre\n          require_free_disk\n',
        'ploinky_locked destroy',
        'ploinky_locked --port "$ROUTER_PORT" start explorer\n            fi\n            wait_ready',
        '# BEGIN QA workspace repositories',
        'ploinky_locked restart\n          wait_ready',
        'An unrelated host container changed during the deployment.',
        "echo '[deploy-qa] Explorer QA Box is ready.'",
        '          prune_images post\n',
        'free disk after prune: $FREE_AFTER GiB',
    ];
    let cursor = 0;
    for (const marker of order) {
        const found = body.indexOf(marker, cursor);
        assert.notEqual(found, -1, marker);
        cursor = found;
    }
    assert.equal((body.match(/^\s+prune_images (?:pre|post)$/gm) || []).length, 2);
    assert.equal((body.match(/^\s+require_free_disk$/gm) || []).length, 1);
});

test('deploy: the prune only warns, and only the disk gate fails the job', () => {
    const prune = deploy.match(IMAGE_PRUNE_BLOCK)[0];
    const scope = prune.slice(prune.indexOf('prune_scope() {'), prune.indexOf('prune_images() {'));
    assert.doesNotMatch(scope, /\bexit\b/);
    assert.equal((scope.match(/return 0/g) || []).length, 2);
    assert.match(scope, /::warning::prune \$scope failed \(\$phase\): the image listing failed/);
    assert.match(scope, /::warning::prune \$scope: podman kept \$id/);
    const images = prune.slice(prune.indexOf('prune_images() {'), prune.indexOf('free_disk_gib() {'));
    assert.doesNotMatch(images, /\bexit\b/);
    assert.match(images, /prune_scope host "\$phase" \|\| true/);
    assert.match(images, /prune_scope box "\$phase" \|\| true/);
    // The disk gate: df of the admin home, 5 GiB hard stop naming a read-only du command, 10 GiB warning.
    assert.match(prune, /DISK_MIN_FREE_GIB=5\n/);
    assert.match(prune, /DISK_WARN_FREE_GIB=10\n/);
    assert.match(prune, /df -Pk \/home\/admin/);
    assert.match(prune, /no agent or repository moved yet\. See usage on the host with: du -xh --max-depth=2 \$WORK_DIR \| sort -h \| tail/);
    assert.match(prune, /::warning::QA host free disk \$free GiB is below \$DISK_WARN_FREE_GIB GiB/);
    const tail = deploy.slice(deploy.indexOf("echo '[deploy-qa] Explorer QA Box is ready.'"));
    assert.match(tail.slice(0, tail.indexOf('- name: Verify public URL')), /::warning::Could not read the free disk space after the prune\./);
});

// Runs the deployed image cleanup block itself under `set -euo pipefail`, with stub executables in place of
// ssh, flock, podman and df, and records every podman argv.
function runCleanup(t, { call, env = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cleanup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stub = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub('fakessh', 'eval "${@: -1}"');
    stub('flock', 'shift 5; exec "$@"');
    stub('df', '[ "${DF_FAIL:-}" = 1 ] && exit 1; printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 %s 9%% /\\n" "$FREE_KIB"');
    stub('podman', `scope=host
if [ "$1" = container ]; then
  while [[ "$1" != ploinky-box-* ]]; do shift; done
  shift; shift; scope=box
fi
printf '%s: %s\\n' "$scope" "$*" >> "$PODMAN_LOG"
if [ "$1 $2" = "image ls" ]; then
  if [[ "$*" != *Size* ]]; then
    var="LIST_$scope"; exit_var="LIST_EXIT_$scope"
    [ -z "\${!exit_var:-}" ] || exit "\${!exit_var}"
    printf '%b' "\${!var:-}"
  else
    printf '%b' "\${NAMED_LIST:-}"
  fi
elif [ "$1 $2" = "image inspect" ]; then
  var="NAMES_\${@: -1}"
  printf '%b' "\${!var:-}"
elif [ "$1 $2" = "image rm" ]; then
  case " \${RM_FAIL:-} " in *" $3 "*) exit 2 ;; esac
  echo "$3"
fi`);
    fs.writeFileSync(path.join(dir, 'block.sh'), deploy.match(IMAGE_PRUNE_BLOCK)[0]);
    const log = path.join(dir, 'podman.log');
    fs.writeFileSync(log, '');
    const script = `set -euo pipefail
SSH=(fakessh); LOCK=/lock; WORK_DIR=/work; BOX_STATE=present
source "${dir}/block.sh"
${call}
echo "completed"`;
    const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PODMAN_LOG: log, ...env },
    });
    return { ...result, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

const GIB_KIB = 1048576;

test('deploy: the disk gate stops the job below 5 GiB, warns below 10 GiB and is silent above', (t) => {
    const low = runCleanup(t, { call: 'require_free_disk', env: { FREE_KIB: String(4 * GIB_KIB) } });
    assert.notEqual(low.status, 0);
    assert.match(low.stdout, /^::error::Free disk 4 GiB is below 5 GiB; no agent or repository moved yet\. See usage on the host with: du -xh --max-depth=2 \/work \| sort -h \| tail/m);
    assert.doesNotMatch(low.stdout, /completed/);

    const warn = runCleanup(t, { call: 'require_free_disk', env: { FREE_KIB: String(7 * GIB_KIB) } });
    assert.equal(warn.status, 0, warn.stderr);
    assert.match(warn.stdout, /^::warning::QA host free disk 7 GiB is below 10 GiB$/m);
    assert.match(warn.stdout, /completed/);

    const fine = runCleanup(t, { call: 'require_free_disk', env: { FREE_KIB: String(12 * GIB_KIB) } });
    assert.equal(fine.status, 0, fine.stderr);
    assert.doesNotMatch(fine.stdout, /::warning::|::error::/);
    assert.match(fine.stdout, /\[deploy-qa\] free disk: 12 GiB/);

    // An unreadable df stops the job with an annotation.
    const broken = runCleanup(t, { call: 'require_free_disk', env: { DF_FAIL: '1', FREE_KIB: '0' } });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout, /^::error::Could not read the free disk space of the QA host\.$/m);
});

test('deploy: the host prune removes only Box-image leftovers with exactly `image rm <id>`', (t) => {
    const result = runCleanup(t, {
        call: 'prune_images pre',
        env: {
            LIST_host: 'aaaaaaaaaaaa 0\\nbbbbbbbbbbbb 0\\ncccccccccccc 0\\ndddddddddddd 1\\n../x 0\\neeeeeeeeeeee 0\\nffffffffffff 0\\n',
            NAMES_aaaaaaaaaaaa: 'docker.io/assistos/ploinky-box:latest\\n',
            NAMES_bbbbbbbbbbbb: 'docker.io/library/postgres:16\\n',
            NAMES_cccccccccccc: '',
            NAMES_eeeeeeeeeeee: 'docker.io/assistos/ploinky-box@sha256:abc\\n',
            NAMES_ffffffffffff: 'docker.io/assistos/ploinky-box-other:latest\\n',
            RM_FAIL: 'aaaaaaaaaaaa',
            LIST_box: '111111111111 0 true\\n222222222222 0 true []\\n',
        },
    });
    assert.equal(result.status, 0, result.stderr);
    const removals = result.calls.filter((line) => / image rm /.test(line));
    // A refusal on the first ID does not stop later IDs, and nothing else is ever removed.
    assert.deepEqual(removals, [
        'host: image rm aaaaaaaaaaaa',
        'host: image rm eeeeeeeeeeee',
        'box: image rm 111111111111',
        'box: image rm 222222222222',
    ]);
    assert.match(result.stdout, /^::warning::prune host: podman kept aaaaaaaaaaaa$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune host: removed eeeeeeeeeeee$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune host: kept unrelated dangling image bbbbbbbbbbbb$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune host: kept unrelated dangling image cccccccccccc$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune host: kept unrelated dangling image ffffffffffff$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune host: kept dddddddddddd in use by 1 container\(s\)$/m);
    assert.match(result.stdout, /^::warning::prune host: skipped an unexpected image ID in the listing$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune box: removed 111111111111$/m);
    assert.equal(result.calls.some((line) => /(?:prune|--force| -f\b| -a\b|--all)/.test(line)), false, result.calls.join('\n'));
    assert.equal(result.calls.some((line) => /dddddddddddd|\.\.\/x/.test(line) && / image rm /.test(line)), false);
    // Only the host scope reads name history; the Box scope removes every unused dangling image.
    assert.ok(result.calls.every((line) => !/^box: image inspect/.test(line)));
    assert.ok(result.calls.some((line) => /^host: image inspect --format \{\{range \.NamesHistory\}\}\{\{println \.\}\}\{\{end\}\} aaaaaaaaaaaa$/.test(line)), result.calls.join('\n'));
});

test('deploy: the Box prune also removes unused digest-only product images and never a tagged or other pinned one', (t) => {
    const digest = (n) => `docker.io/assistos/scriptahub-agent@sha256:${n.repeat(64)}`;
    const result = runCleanup(t, {
        call: 'prune_images post',
        env: {
            LIST_host: '',
            LIST_box: [
                // The superseded agent image: unused, only a digest name.
                `111111111111 0 false [${digest('1')}]`,
                // Unused, two product digest names: a candidate, but podman refuses an image with several names by ID
                // without force, so it is reported and kept (stubbed here with RM_FAIL).
                `222222222222 0 false [${digest('2')} docker.io/assistos/roboteam-agent@sha256:${'3'.repeat(64)}]`,
                // Ploinky's Router authority helper: digest-only, no container between probes, never removed.
                `aaaaaaaaaaaa 0 false [docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d]`,
                // A product digest beside another repository's digest: kept.
                `bbbbbbbbbbbb 0 false [${digest('5')} docker.io/library/node@sha256:${'6'.repeat(64)}]`,
                // Other product repositories: removed when unused.
                `cccccccccccc 0 false [docker.io/assistos/bizanso-agent@sha256:${'7'.repeat(64)}]`,
                // A repository that only starts with a product name: kept.
                `dddddddddddd 0 false [docker.io/assistos/scriptahub-agent-x@sha256:${'9'.repeat(64)}]`,
                // Unused but tagged: a later start resolves the tag, so it stays.
                `333333333333 0 false [docker.io/assistos/scriptahub-agent:runtime ${digest('4')}]`,
                `444444444444 0 false [docker.io/assistos/local-llm:latest]`,
                // Unused, no names and not dangling, or an unexpected dangling field: kept.
                '555555555555 0 false []',
                '666666666666 0 maybe [x]',
                // A digest reference with a short or malformed digest: kept.
                `777777777777 0 false [docker.io/assistos/x@sha256:abc]`,
                // In use: kept, digest-only or not.
                `888888888888 2 false [${digest('8')}]`,
                // Unused and dangling: removed.
                '999999999999 0 true []',
                '',
            ].join('\\n'),
            RM_FAIL: '222222222222',
        },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.filter((line) => / image rm /.test(line)), [
        'box: image rm 111111111111',
        'box: image rm 222222222222',
        'box: image rm cccccccccccc',
        'box: image rm 999999999999',
    ]);
    assert.match(result.stdout, new RegExp(`^\\[deploy-qa\\] prune box: removed 111111111111 ${digest('1').replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(result.stdout, /^::warning::prune box: podman kept 222222222222$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune box: removed 999999999999$/m);
    assert.match(result.stdout, /^\[deploy-qa\] prune box: removed 3 unused dangling or digest-only image\(s\)$/m);
    // Host candidates still come only from the dangling listing; the Box listing has no filter.
    const listings = result.calls.filter((line) => / image ls /.test(line) && !/Size/.test(line));
    assert.ok(listings.some((line) => /^host: image ls --filter dangling=true /.test(line)), listings.join('\n'));
    assert.ok(listings.some((line) => /^box: image ls --format /.test(line)), listings.join('\n'));
    assert.equal(result.calls.some((line) => /(?:prune|--force| -f\b| -a\b|--all)/.test(line)), false, result.calls.join('\n'));
});

test('deploy: a failing listing only warns and the prune returns success', (t) => {
    const result = runCleanup(t, {
        call: 'prune_images post',
        env: { LIST_EXIT_host: '125', LIST_EXIT_box: '125' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::warning::prune host failed \(post\): the image listing failed$/m);
    assert.match(result.stdout, /^::warning::prune box failed \(post\): the image listing failed$/m);
    assert.match(result.stdout, /completed/);
    assert.equal(result.calls.some((line) => / image rm /.test(line)), false);
});


test('deploy: ScriptaHub registry gate is shared with the product deploy and checks running image IDs', () => {
    const product = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-explorer-qa-scriptahub.yml'), 'utf8');
    assert.equal(step(deploy, 'Resolve the ScriptaHub source and the published images'), step(product, 'Resolve the ScriptaHub source and the published images'));
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    assert.match(body, /docker\.io\/assistos\/roboteam-agent@\$robot_digest/);
    for (const prefix of ['ploinky_ScriptaHubAgent_scriptahubAgent_', 'ploinky_AchillesIDE_roboTeamAgent_', 'ploinky_AchillesIDE_roboWorkAgent_']) assert.ok(body.includes(prefix));
    assert.match(body, /test "\$lines" = "\$expected"/);
});

test('deploy: the image verification program rejects a wrong running RoboWork image', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const program = body.match(/\| run_in_box '(set -eu\n\s+read -r agent_id\n[\s\S]*?)'; then/);
    assert.ok(program);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-image-check-'));
    try {
        const agent = 'e'.repeat(64);
        const robot = 'f'.repeat(64);
        fs.writeFileSync(path.join(root, 'podman'), `#!/bin/sh\nprintf '%s\\n' 'ploinky_ScriptaHubAgent_scriptahubAgent_x ${agent}' 'ploinky_AchillesIDE_roboTeamAgent_x ${robot}' "ploinky_AchillesIDE_roboWorkAgent_x \${WRONG_ID:-${robot}}"\n`, { mode: 0o755 });
        for (const [wrong, expected] of [['', 0], ['1'.repeat(64), 1]]) {
            const result = spawnSync('sh', ['-c', program[1]], {
                input: `${agent}\n${robot}\n`, encoding: 'utf8',
                env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, WRONG_ID: wrong },
            });
            assert.equal(result.status, expected, result.stderr);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------------------------------------------
// ScriptaHub dependency fingerprint: the gate compares the selected checkout with the image label before the restart.

const I10 = ' '.repeat(10);
const FP_BEGIN = `${I10}# BEGIN ScriptaHub dependency fingerprint`;
const FP_END = `${I10}# END ScriptaHub dependency fingerprint`;
const fingerprintBlocks = (source) => {
    const found = [];
    let from = 0;
    for (;;) {
        const start = source.indexOf(`\n${FP_BEGIN}\n`, from);
        if (start === -1) return found;
        const end = source.indexOf(`\n${FP_END}\n`, start);
        assert.notEqual(end, -1, 'an unterminated fingerprint block');
        found.push(source.slice(start + 1, end + 1 + FP_END.length));
        from = end;
    }
};
const unindent10 = (text) => text.split('\n').map((line) => (line.startsWith(I10) ? line.slice(I10.length) : line)).join('\n');
const INPUTS = 'scriptahubAgent/deployment/dependency-inputs.txt';
const LOCKFILE = 'skills/a/external/html/package-lock.json';
const blobId = (bytes) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const oracleFingerprint = (files) => {
    const hash = crypto.createHash('sha256').update('scriptahub-dependency-fingerprint-v1\n');
    for (const file of files[INPUTS].slice(0, -1).split('\n')) hash.update(`${blobId(files[file])} ${file}\n`);
    return hash.digest('hex');
};
const GOLDEN = { files: { [INPUTS]: `${INPUTS}\nskills/x/external/html/package-lock.json\n`, 'skills/x/external/html/package-lock.json': '{}\n' }, fingerprint: 'b46a273fb33f3535a42f1244c246494d87596d7214588d45b9bdb74877b40016' };
const SHELLS = [...new Set([process.env.QA_PROGRAM_SHELL || 'sh', 'bash', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])])];

function gitRepo(t, name, files) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pre-restart-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    const git = (...args) => {
        const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '--quiet');
    const commit = (next, message = 'commit') => {
        for (const entry of fs.readdirSync(repo)) if (entry !== '.git') fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
        for (const [file, content] of Object.entries(next)) {
            fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
            if (typeof content === 'string') fs.writeFileSync(path.join(repo, file), content);
            else fs.symlinkSync(content.symlink, path.join(repo, file));
        }
        git('add', '-A');
        git('commit', '--quiet', '--allow-empty', '-m', message);
        return git('rev-parse', 'HEAD');
    };
    return { root, repo, git, commit };
}

test('deploy: the ScriptaHub dependency fingerprint block is the one of the product workflow and yields the golden vector', (t) => {
    const product = read('deploy-explorer-qa-scriptahub.yml');
    const [resolveBlock, preRestartBlock] = fingerprintBlocks(deploy);
    assert.equal(fingerprintBlocks(deploy).length, 2, 'the resolve step and the pre-restart program');
    assert.equal(fingerprintBlocks(step(deploy, 'Resolve the ScriptaHub source and the published images')).length, 1);
    assert.equal(resolveBlock, preRestartBlock);
    for (const use of fingerprintBlocks(product)) assert.equal(use, resolveBlock);
    assert.equal(resolveBlock.includes("'"), false);
    const { repo, commit } = gitRepo(t, 'golden', {});
    const rev = commit(GOLDEN.files);
    for (const shell of SHELLS) {
        const result = spawnSync(shell, ['-c', `${unindent10(resolveBlock)}\nscripta_dependency_fingerprint "$1" "$2"`, 'sh', repo, rev], { encoding: 'utf8' });
        assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: `${GOLDEN.fingerprint}\n`, stderr: '' }, shell);
    }
    assert.equal(oracleFingerprint(GOLDEN.files), GOLDEN.fingerprint);
});

test('deploy: the pre-restart check compares the dependency fingerprint of the checkout at HEAD in the Box, before the restart', (t) => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const found = body.match(/printf '%s\\n%s\\n' "\$SCRIPTA_HEAD" "\$SCRIPTA_DEPENDENCY_FINGERPRINT" \| run_in_box '(set -eu\n[\s\S]*?)'; then\n\s+echo "::error::([^"]*)"/);
    assert.ok(found, 'the pre-restart program');
    assert.match(found[2], /did not match the selected source or its dependency fingerprint.*no restart has occurred/);
    assert.equal(body.includes('SCRIPTA_COPIED_TREES'), false);
    // The gate is the resolve step, which runs before the step that pulls, moves and restarts.
    assert.ok(deploy.indexOf('- name: Resolve the ScriptaHub source and the published images\n') < deploy.indexOf('- name: Bootstrap the host and deploy through Ploinky commands\n'));
    const check = body.indexOf('"$SCRIPTA_DEPENDENCY_FINGERPRINT" | run_in_box');
    assert.ok(body.indexOf('\n          update_kept_repos\n') < check && check < body.indexOf('\n          ploinky_locked restart\n'), 'update, then check, then restart');
    const program = unindent10(found[1]);
    const files = { [INPUTS]: `${INPUTS}\n${LOCKFILE}\n`, [LOCKFILE]: '{}\n', 'skills/a/SKILL.md': 'a\n' };
    const F = oracleFingerprint(files);
    const run = (workspace, input, shell = SHELLS[0]) => spawnSync(shell, ['-c', program, 'sh'], { cwd: workspace, input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: workspace } });
    for (const shell of SHELLS) {
        const { root, repo, commit } = gitRepo(t, 'ScriptaHubAgent', {});
        const head = commit(files);
        const ok = run(root, `${head}\n${F}\n`, shell);
        assert.equal(ok.status, 0, `${shell}: ${ok.stderr}`);
        // A skill source edit after the image keeps the check passing; the checkout must be clean and at the head.
        const edited = commit({ ...files, 'skills/a/SKILL.md': 'changed\n' }, 'skill edit');
        assert.equal(run(root, `${edited}\n${F}\n`, shell).status, 0, `${shell}: a skill source edit keeps the fingerprint`);
        assert.notEqual(run(root, `${head}\n${F}\n`, shell).status, 0, `${shell}: another head`);
        assert.notEqual(run(root, `${edited}\n${'1'.repeat(64)}\n`, shell).status, 0, `${shell}: another fingerprint`);
        fs.writeFileSync(path.join(repo, 'README.md'), 'untracked\n');
        assert.notEqual(run(root, `${edited}\n${F}\n`, shell).status, 0, `${shell}: a dirty checkout`);
        fs.rmSync(path.join(repo, 'README.md'));
        // Hostile or malformed stdin is refused before Git runs.
        for (const hostile of [`$(touch ${path.join(root, 'pwned')})\n${F}\n`, `${edited}\n${F.toUpperCase()}\n`, `${edited}\n${F.slice(1)}\n`, `${edited.slice(1)}\n${F}\n`, `\n\n`, '', `${edited}\n`]) {
            assert.notEqual(run(root, hostile, shell).status, 0, `${shell}: ${JSON.stringify(hostile)}`);
        }
        assert.equal(fs.existsSync(path.join(root, 'pwned')), false);
        // The inputs that the head carries decide, and an input that became a symlink or a lockfile edit is refused.
        const lockEdited = commit({ ...files, [LOCKFILE]: '{"changed":true}\n' }, 'lockfile edit');
        assert.notEqual(run(root, `${lockEdited}\n${F}\n`, shell).status, 0, `${shell}: a lockfile edit`);
        const linked = commit({ ...files, [LOCKFILE]: { symlink: 'SKILL.md' } }, 'a symlinked input');
        assert.notEqual(run(root, `${linked}\n${F}\n`, shell).status, 0, `${shell}: a symlinked input`);
        const crlf = commit({ ...files, [INPUTS]: `${INPUTS}\r\n${LOCKFILE}\r\n` }, 'CRLF list');
        assert.notEqual(run(root, `${crlf}\n${F}\n`, shell).status, 0, `${shell}: a CRLF list`);
        const noList = commit({ [LOCKFILE]: '{}\n' }, 'no list');
        assert.notEqual(run(root, `${noList}\n${F}\n`, shell).status, 0, `${shell}: a checkout that predates the list`);
    }
});
