import assert from 'node:assert/strict';
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
const legacyDeploy = read('deploy-explorer-qa.yml');
const legacyDestroy = read('destroy-explorer-qa.yml');

const WORKSPACE_REPOSITORIES_BLOCK = /# BEGIN QA workspace repositories[\s\S]*# END QA workspace repositories/;
const IMAGE_PRUNE_BLOCK = /# BEGIN QA image cleanup[\s\S]*# END QA image cleanup/;

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
            // Placing the repositories at the workspace root is an exception for every pattern, and listing images
            // inside the Box one for `container exec` only. Both have their own tests.
            const exempt = forbidden.source.startsWith('container') ? [WORKSPACE_REPOSITORIES_BLOCK, IMAGE_PRUNE_BLOCK] : [WORKSPACE_REPOSITORIES_BLOCK];
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
        '| run_in_box "$BUNDLE_PROGRAM"',
        'run_in_box "$CLONE_PROGRAM"',
        'ploinky_locked var BIZANSO_PUBLIC_LINK_BASE --stdin',
        'ploinky_locked add repo https://github.com/Axiologic/bizanso.git bizanso',
        'ploinky_locked add repo https://github.com/AssistOS-AI/PromotionScoutV2.git PromotionScoutV2',
        'ploinky_locked add repo https://github.com/Axiologic/ScriptaHubAgent.git ScriptaHubAgent',
        'ploinky_locked enable agent bizanso/bizanso',
        'ploinky_locked enable agent bizanso/deepProofArticle',
        'ploinky_locked enable agent PromotionScoutV2/promotionScout',
        'ploinky_locked enable agent ScriptaHubAgent/scriptahubAgent',
        'GRAPH_RUNTIMES="$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent deepProofArticle"',
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
    assert.doesNotMatch(graph[1], /bizanso|promotionScout|scriptahubAgent/);
    for (const [runtime, agent] of [['bizanso', 'bizanso/bizanso'], ['promotionScout', 'PromotionScoutV2/promotionScout'], ['scriptahubAgent', 'ScriptaHubAgent/scriptahubAgent']]) {
        assert.ok(body.includes(`if ! grep -q '^${runtime} ' <<< "$ENABLED_STATES"; then\n            ploinky_locked enable agent ${agent}\n          fi\n`), runtime);
    }
    assert.ok(deploy.indexOf('- name: Verify public URL') < deploy.indexOf('- name: Verify Bizanso and ScriptaHub'));
    const verify = step(deploy, 'Verify Bizanso and ScriptaHub');
    assert.match(verify, /bizanso\/8787\/how-it-works\//);
    assert.match(verify, /scriptahubAgent\/3002\/health/);
    assert.match(verify, /for path in [^\n]* deepProofArticle\/8790\/assets\/form\.js; do\n/);
    // promotionScout declares MCP readiness and no web surface, so its proof is the awaited runtime state alone.
    assert.doesNotMatch(verify, /promotionScout/);
    assert.match(body, /GRAPH_RUNTIMES="\$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent deepProofArticle"\n[\s\S]*ploinky_locked restart\n\s+wait_ready/);
});

test('deploy: the article agent is enabled only when missing, only when the Bizanso tree has it, after bizanso/bizanso', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const enable = `if ! grep -q '^deepProofArticle ' <<< "$ENABLED_STATES"; then\n            ploinky_locked enable agent bizanso/deepProofArticle\n          fi\n`;
    assert.equal(body.split(enable).length - 1, 1);
    const at = body.indexOf(enable);
    assert.ok(body.indexOf('ploinky_locked enable agent bizanso/bizanso') < at);
    assert.ok(at < body.indexOf('GRAPH_RUNTIMES="$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent deepProofArticle"'));
    // The first-start graph never names it.
    assert.doesNotMatch(body.match(/GRAPH_RUNTIMES='([^']*)'/)[1], /deepProofArticle/);
});

test('deploy: a Bizanso tree without the article agent is refused before anything is changed', () => {
    const body = step(deploy, 'Bootstrap the host and deploy through Ploinky commands');
    const refusal = `if [ ! -f "$GITHUB_WORKSPACE/.qa-bizanso-source/deepProofArticle/manifest.json" ]; then\n            echo "::error::The Bizanso default branch has no deepProofArticle/manifest.json, and this deployment enables bizanso/deepProofArticle. Nothing was changed."\n            exit 1\n          fi\n`;
    assert.equal(body.split(refusal).length - 1, 1);
    const at = body.indexOf(refusal);
    // Before the first Cloudflare call, host command or Ploinky command, and after the Bizanso checkout step.
    for (const marker of ['curl -fsS', '"${SSH[@]}"', 'ploinky_locked ']) {
        const first = body.indexOf(marker);
        assert.notEqual(first, -1, marker);
        assert.ok(at < first, `the refusal comes before the first ${marker}`);
    }
    assert.ok(deploy.indexOf('- name: Check out Bizanso') < deploy.indexOf('- name: Bootstrap the host and deploy through Ploinky commands'));
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
MANAGED_PROGRAM=MANAGED COPY_PROGRAM=COPY BUNDLE_PROGRAM=BUNDLE CLONE_PROGRAM=CLONE GITHUB_WORKSPACE=/w
${block.slice(start, end)}`], { encoding: 'utf8' });
    const refused = run('echo bizanso; exit 1');
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.equal(refused.stdout, '', 'nothing is uninstalled, copied or cloned');
    const unexpected = run('echo other');
    assert.notEqual(unexpected.status, 0);
    assert.doesNotMatch(unexpected.stdout, /ploinky:|box:/);
    assert.equal(run('echo bizanso').stdout, 'ploinky:uninstall repo bizanso\nbox:COPY\nbox:BUNDLE\nbox:CLONE\n');
    assert.equal(run('true').stdout, 'box:COPY\nbox:BUNDLE\nbox:CLONE\n');
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
    assert.match(body, /if \[ "\$repo" != bizanso \] && \[ "\$repo" != PromotionScoutV2 \]; then\n\s+ploinky_locked update repo "\$repo"\n/);
    assert.doesNotMatch(body, /ploinky_locked update\n/);
    // The loop lives only in update_kept_repos, called once, after the workspace repositories are placed.
    assert.equal(body.split('ploinky_locked update repo').length - 1, 1);
    assert.equal(body.split(/\n\s+update_kept_repos\n/).length - 1, 1);
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

test('the runner-side Cloudflare and public checks stay identical to the older workflows', () => {
    for (const name of ['Verify public URL', 'Verify dedicated connector and protected Cloudflare topology']) {
        assert.equal(step(deploy, name), step(legacyDeploy, name), name);
    }
    assert.equal(
        step(destroy, 'Delete the dedicated Cloudflare publication').replace(' && inputs.delete_data', ''),
        step(legacyDestroy, 'Delete the dedicated Cloudflare publication'),
    );
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
