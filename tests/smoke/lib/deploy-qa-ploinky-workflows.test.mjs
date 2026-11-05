import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
const deploy = read('deploy-explorer-qa-ploinky.yml');
const destroy = read('destroy-explorer-qa-ploinky.yml');
const legacyDeploy = read('deploy-explorer-qa.yml');
const legacyDestroy = read('destroy-explorer-qa.yml');

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

    test(`${name}: targets the pinned QA identity and shares the older workflows' serialization`, () => {
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

    test(`${name}: refuses to run over the older workflows' parked state`, () => {
        assert.match(source, /STATE_DIR=\/home\/admin\/\.qa-deployment-state\n/);
        assert.match(source, /if \[ -e "\$STATE_DIR" \] && \[ -n "\$\(ls -A "\$STATE_DIR"\)" \]; then/);
    });

    test(`${name}: the host is driven through Ploinky, not through its internals or its files`, () => {
        for (const forbidden of [
            /\bscp\b/, /container (?:exec|cp)/, /\bsudo\b/, /\.runtime\/ploinky/, /supervisor\.mjs/,
            /\/opt\/ploinky\/cli/, /qa-teardown/, /update-explorer-qa/, /quiesce-explorer-qa/,
            /\.ploinky\/(?:repos|running|data)/, /rm -rf/,
        ]) {
            assert.doesNotMatch(source, forbidden);
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
        'BOX_STATE=present',
        'ploinky_locked --port "$ROUTER_PORT" start explorer\n            wait_ready',
        'ploinky_locked var "$CLOUDFLARE_API_SECRET_HANDLE" --stdin',
        'ploinky_locked var "$CLOUDFLARE_TUNNEL_SECRET_HANDLE" --stdin',
        'ploinky_locked var USERPERSISTO_OIDC_ISSUER --stdin',
        'ploinky_locked add repo https://github.com/Axiologic/ScriptaHubAgent.git ScriptaHubAgent',
        'ploinky_locked enable agent ScriptaHubAgent/scriptahubAgent',
        'GRAPH_RUNTIMES="$GRAPH_RUNTIMES scriptahubAgent"',
        'ploinky_locked update\n          wait_ready',
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

test('deploy: ScriptaHub is enabled only when missing and is awaited only after that', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const graph = body.match(/GRAPH_RUNTIMES='([^']*)'/);
    assert.ok(graph);
    // The first start waits for this list before ScriptaHub has been enabled.
    assert.doesNotMatch(graph[1], /scriptahubAgent/);
    assert.match(body, /if ! grep -q '\^scriptahubAgent ' <<< "\$ENABLED_STATES"; then\n\s+ploinky_locked enable agent ScriptaHubAgent\/scriptahubAgent\n\s+fi\n/);
    assert.ok(deploy.indexOf('- name: Verify public URL') < deploy.indexOf('- name: Verify ScriptaHub'));
    assert.match(step(deploy, 'Verify ScriptaHub'), /\/base-agent-additional-server\/scriptahubAgent\/3002\/health/);
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

test('the runner-side Cloudflare and public checks stay identical to the older workflows', () => {
    for (const name of ['Verify public URL', 'Verify dedicated connector and protected Cloudflare topology']) {
        assert.equal(step(deploy, name), step(legacyDeploy, name), name);
    }
    assert.equal(
        step(destroy, 'Delete the dedicated Cloudflare publication').replace(' && inputs.delete_data', ''),
        step(legacyDestroy, 'Delete the dedicated Cloudflare publication'),
    );
});
