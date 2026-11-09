import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Tests of deploy-explorer-qa-bizanso.yml and deploy-explorer-qa-scriptahub.yml. Static cases read the workflows;
// the behavioural cases run the workflows' own shell with stub executables for ssh, flock, podman, ploinky, curl,
// docker, sleep and df, so only the shell logic is proven. The container name prefixes, the podman output formats
// and the real Ploinky messages can only be proven by the first live run.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// AssistOSExplorer main when these workflows were written. Bump it only when the shared blocks of the full deploy
// change on purpose, and copy the change into both product workflows in the same commit.
const BASE = 'a92457a7c2198e4e8c1d4ec9667966dd528801c2';
const PLOINKY = 'deploy-explorer-qa-ploinky.yml';
const NAMES = { bizanso: 'deploy-explorer-qa-bizanso.yml', scriptahub: 'deploy-explorer-qa-scriptahub.yml' };
const KEYS = Object.keys(NAMES);
const I = ' '.repeat(10);
// The shell that runs the in-Box programs. Linux runners have dash as sh; QA_PROGRAM_SHELL=/bin/dash checks that on macOS.
const PROGRAM_SHELL = process.env.QA_PROGRAM_SHELL || 'sh';

const readWorkflow = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
const WORKFLOWS = Object.fromEntries(KEYS.map((key) => [key, fs.existsSync(path.join(ROOT, '.github/workflows', NAMES[key])) ? readWorkflow(NAMES[key]) : null]));
const workflow = (key) => {
    assert.ok(WORKFLOWS[key] !== null, `${NAMES[key]} does not exist`);
    return WORKFLOWS[key];
};
const ploinkyNow = readWorkflow(PLOINKY);
function showBase(file) {
    const shown = spawnSync('git', ['-C', ROOT, 'show', `${BASE}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(shown.status, 0, `${BASE} is not in the history of this checkout: fetch the full history. ${shown.stderr}`);
    return shown.stdout;
}

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
const stepScript = (source, name) => runBlocks(step(source, name))[0];
const DEPLOY_STEP = { bizanso: 'Deploy Bizanso through Ploinky commands', scriptahub: 'Deploy ScriptaHub through Ploinky commands' };
const deployBody = (key) => stepScript(workflow(key), DEPLOY_STEP[key]);

// A block runs from its first full line to the end of its last line; both are matched exactly, indentation included.
function slice(source, start, end) {
    const from = source.indexOf(`\n${start}\n`) + 1;
    assert.notEqual(from, 0, `block start not found: ${start}`);
    const to = source.indexOf(end, from);
    assert.notEqual(to, -1, `block end not found: ${end}`);
    return source.slice(from, to + end.length);
}
const SHARED = {
    node: [`${I}# BEGIN QA isolated Node runtime`, `${I}# END QA isolated Node runtime`],
    helpers: [`${I}ploinky_locked() {`, `/healthz/' >/dev/null"\n${I}}`],
    cleanup: [`${I}# BEGIN QA image cleanup`, `${I}# END QA image cleanup`],
    graph: [`${I}GRAPH_RUNTIMES='explorer gitAgent userPersistoAgent emailAgent dpuAgent roboTeamAgent soul-gateway workspaceMonitorAgent local-llm'`,
        `Timed out waiting for the graph runtimes to stay ready."\n            return 1\n${I}}`],
    extend: [`${I}GRAPH_RUNTIMES="$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent"`, `${I}GRAPH_RUNTIMES="$GRAPH_RUNTIMES bizanso promotionScout scriptahubAgent"`],
    runinbox: [`${I}run_in_box() {`, `\n${I}}`],
    copy: [`${I}COPY_PROGRAM='set -eu`, `${I}mv "$incoming" bizanso'`],
};
// Only in the product workflows, identical in both.
const OWN = {
    routes: [`${I}# BEGIN QA product routes`, `${I}# END QA product routes`],
    restart: [`${I}# BEGIN QA product restart`, `${I}# END QA product restart`],
};
const block = (source, name) => slice(source, ...(SHARED[name] || OWN[name]));
const SHARED_BY = { bizanso: ['node', 'helpers', 'cleanup', 'graph', 'extend', 'runinbox', 'copy'], scriptahub: ['node', 'helpers', 'cleanup', 'graph', 'extend', 'runinbox'] };

// ---------------------------------------------------------------------------------------------------------------
// Static cases

test('both product workflows exist', () => {
    for (const key of KEYS) workflow(key);
});

for (const key of KEYS) {
    test(`${key}: every run block is valid shell`, () => {
        const blocks = runBlocks(workflow(key));
        assert.ok(blocks.length >= 7);
        for (const body of blocks) {
            const result = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
    });

    test(`${key}: targets the pinned QA identity and shares the full deploy's serialization`, () => {
        const source = workflow(key);
        for (const line of [
            "SSH_USER: 'admin'",
            "SSH_HOST: '45.136.70.141'",
            "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'",
            "WORKSPACE: 'explorerQaWorkspace'",
            "ROUTER_PORT: '8097'",
            '  group: deploy-explorer-qa\n',
            '  cancel-in-progress: false\n',
            'LOCK=/home/admin/.qa-deployment-operation.lock',
            'PLOINKY_BIN=/home/admin/.qa-deployment-tools/ploinky/bin/ploinky',
            "SOUL_GATEWAY_ROUTER_PORT: '8080'",
            '    permissions:\n      contents: read\n',
        ]) {
            assert.ok(source.includes(line), line);
        }
        // The env lines are the ones of the full deploy, byte for byte, in the same order.
        const lines = showBase(`.github/workflows/${PLOINKY}`).split('\n');
        const first = lines.indexOf("  SSH_USER: 'admin'");
        const copied = lines.slice(first, first + 7);
        assert.equal(copied.length, 7);
        assert.equal(copied[6], "  PUBLIC_URL: 'https://explorer-qa.axiologic.dev'");
        assert.ok(source.includes(`${copied.join('\n')}\n`), 'the seven identity lines of the full deploy');
        assert.match(source, /\non:\n {2}workflow_dispatch:\n\n/);
        assert.match(source, /timeout-minutes: (?:90|150)\n/);
    });

    test(`${key}: refuses to run over the older workflows' parked state and never creates the workspace`, () => {
        const source = workflow(key);
        assert.match(source, /STATE_DIR=\/home\/admin\/\.qa-deployment-state\n/);
        assert.match(source, /if \[ -e "\$STATE_DIR" \] && \[ -n "\$\(ls -A "\$STATE_DIR"\)" \]; then/);
        assert.match(source, /if \[ -L "\$WORK_DIR" \] \|\| \[ ! -d "\$WORK_DIR" \]; then/);
    });
}

test('every shared block is byte-identical to the full deploy at the recorded base and in the working tree', () => {
    const base = showBase(`.github/workflows/${PLOINKY}`);
    for (const key of KEYS) {
        const source = workflow(key);
        for (const name of SHARED_BY[key]) {
            const expected = block(base, name);
            assert.ok(expected.length > 20, name);
            assert.equal(source.split(expected).length - 1, 1, `${key}: ${name} appears exactly once, identical to ${BASE}`);
            assert.equal(block(ploinkyNow, name), expected, `${name} of the full deploy changed since ${BASE}; copy the change into both product workflows`);
            assert.equal(block(source, name), expected, `${key}: ${name}`);
        }
        // The Node block is the only one the preflight runs; the rest run on the runner.
        assert.ok(step(source, DEPLOY_STEP[key]).includes(block(base, 'node')));
    }
    // The routes and restart blocks exist only here and are the same in both files.
    for (const name of Object.keys(OWN)) {
        assert.equal(block(workflow('bizanso'), name), block(workflow('scriptahub'), name), name);
    }
    assert.equal(workflow('scriptahub').includes('COPY_PROGRAM'), false);
});

function inBoxPrograms(source) {
    const found = [...source.matchAll(/^ *([A-Z_]+_PROGRAM)='([^']*)'$/gm)].map((match) => ({ name: match[1], body: match[2] }));
    const declared = [...source.matchAll(/^ *[A-Z_]+_PROGRAM='/gm)].length;
    assert.equal(found.length, declared, 'every in-Box program is one single-quoted string that ends at its line end');
    return found;
}

test('no in-Box program contains a single quote, and each is valid shell', () => {
    const expected = {
        bizanso: ['DRAIN_ROUTING_PROGRAM', 'DRAIN_AGENTS_PROGRAM', 'DRAIN_RUNNING_PROGRAM', 'PROBE_PROGRAM', 'BIZANSO_READ_PROGRAM', 'BIZANSO_MANIFEST_PROGRAM', 'BIZANSO_PULL_PROGRAM', 'COPY_PROGRAM'],
        scriptahub: ['DRAIN_ROUTING_PROGRAM', 'DRAIN_AGENTS_PROGRAM', 'DRAIN_RUNNING_PROGRAM', 'PROBE_PROGRAM', 'SCRIPTAHUB_READ_PROGRAM', 'SCRIPTAHUB_DIGEST_PROGRAM', 'SCRIPTAHUB_PULL_PROGRAM', 'SCRIPTAHUB_MERGE_PROGRAM', 'SCRIPTAHUB_TAG_PROGRAM'],
    };
    for (const key of KEYS) {
        const programs = inBoxPrograms(deployBody(key));
        assert.deepEqual(programs.map((program) => program.name).sort(), [...expected[key]].sort(), key);
        for (const program of programs) {
            assert.equal(program.body.includes("'"), false, `${key} ${program.name}`);
            for (const shell of [PROGRAM_SHELL, 'bash']) {
                const result = spawnSync(shell, ['-n'], { input: program.body, encoding: 'utf8' });
                assert.equal(result.status, 0, `${key} ${program.name} ${result.stderr}`);
            }
        }
    }
    // A single quote anywhere would end the assignment early and fail the line-end rule above.
    assert.throws(() => inBoxPrograms("          X_PROGRAM='a'b'\n"));
});

test('neither workflow takes inputs, touches the tunnel, starts, destroys, installs or enables, or fixes a port', () => {
    for (const key of KEYS) {
        const source = workflow(key);
        assert.doesNotMatch(source, /^\s*inputs:/m, key);
        assert.doesNotMatch(source, /\$\{\{\s*inputs\./, key);
        assert.doesNotMatch(source, /CLOUDFLARE|Cloudflare|edge set/, key);
        assert.doesNotMatch(source, /ploinky_locked\s+(?:start|destroy|uninstall|install|add repo|enable agent|--port|reinstall|update)/, key);
        assert.doesNotMatch(source, /--port/, key);
        assert.doesNotMatch(source, /ploinky_locked[^\n]*--accept-failed-drain/, key);
        // The private copy program, copied from the full deploy, is the one place that removes its stale predecessor.
        const withoutCopy = source.replace(SHARED_BY[key].includes('copy') ? block(source, 'copy') : '', '');
        assert.doesNotMatch(withoutCopy, /\brm -rf\b|\bsudo\b|\bscp\b|container cp\b/, key);
        assert.match(source, /deploy-explorer-qa-ploinky\.yml/, key);
    }
});

test('no workflow runs Git on the Ploinky checkout beyond reading it, clones, or creates the workspace', () => {
    for (const key of KEYS) {
        const source = workflow(key);
        assert.doesNotMatch(source, /git -C "\$CHECKOUT" +(?:fetch|checkout|merge|reset|clean|pull)/, key);
        assert.doesNotMatch(source, /git (?:-c [^ ]+ )*(?:-C [^ ]+ )?clone/, key);
        assert.doesNotMatch(source, /mkdir -p "\$WORK_DIR"/, key);
        // The preflight, without the idempotent Node install, moves nothing on the checkout or in the workspace.
        const preflight = source.split("<<'REMOTE'")[1].split('\n          REMOTE\n')[0].replace(block(source, 'node'), '');
        assert.doesNotMatch(preflight, /git [^\n]*\b(?:fetch|checkout|merge|clone|reset|clean|pull)\b/, key);
        assert.doesNotMatch(preflight, /\bmkdir\b/, key);
        assert.match(preflight, /git -C "\$CHECKOUT" remote get-url origin/);
        assert.match(preflight, /PLOINKY_COMMIT=%s\\n' "\$\(git -C "\$CHECKOUT" rev-parse --short HEAD\)"/);
        assert.match(preflight, /\[ -L "\$CHECKOUT" \] \|\| \[ ! -d "\$CHECKOUT" \]/);
    }
});

test('every action is pinned by commit, tests run first, and no job holds more than read access', () => {
    for (const key of KEYS) {
        const source = workflow(key);
        const uses = source.split('\n').filter((line) => /^\s*(?:- )?uses:/.test(line));
        assert.ok(uses.length >= 3);
        for (const line of uses) assert.match(line, /uses: [\w./-]+@[0-9a-f]{40}( #.*)?$/, line);
        const names = [...source.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]);
        assert.equal(names[0], 'Check out the workflow tests');
        assert.equal(names[2], 'Test these workflows');
        assert.match(step(source, 'Test these workflows'), /run: node --test tests\/smoke\/lib\/deploy-qa-product-workflows\.test\.mjs/);
        assert.match(step(source, 'Check out the workflow tests'), /fetch-depth: 0/);
        assert.equal((source.match(/permissions:/g) || []).length, 1);
    }
});

test('secrets reach steps only through env or ssh-key, and each key only the step that needs it', () => {
    const bizanso = workflow('bizanso');
    const secretLines = (source) => source.split('\n').filter((line) => line.includes('secrets.'));
    assert.deepEqual(secretLines(bizanso).map((line) => line.trim()), [
        'SSH_KEY: ${{ secrets.EXPLORER_QA_SSH_KEY }}',
        'BIZANSO_DEPLOY_KEY: ${{ secrets.EXPLORER_QA_BIZANSO_DEPLOY_KEY }}',
        'SSH_KEY: ${{ secrets.EXPLORER_QA_SSH_KEY }}',
        'ssh-key: ${{ secrets.EXPLORER_QA_BIZANSO_DEPLOY_KEY }}',
    ]);
    assert.equal((bizanso.match(/secrets\.EXPLORER_QA_BIZANSO_DEPLOY_KEY/g) || []).length, 2);
    assert.match(step(bizanso, 'Check out Bizanso'), /persist-credentials: false/);
    assert.match(step(bizanso, 'Check out Bizanso'), /repository: Axiologic\/bizanso/);
    assert.doesNotMatch(deployBody('bizanso'), /DEPLOY_KEY|SSH_KEY/);
    const scripta = workflow('scriptahub');
    assert.deepEqual(secretLines(scripta).map((line) => line.trim()), [
        'SSH_KEY: ${{ secrets.EXPLORER_QA_SSH_KEY }}',
        'SSH_KEY: ${{ secrets.EXPLORER_QA_SSH_KEY }}',
    ]);
    assert.doesNotMatch(scripta, /BIZANSO|PROMOTIONSCOUT|CLOUDFLARE/);
    assert.doesNotMatch(deployBody('scriptahub'), /SSH_KEY/);
    const checkout = step(scripta, 'Check out ScriptaHub');
    assert.match(checkout, /repository: Axiologic\/ScriptaHubAgent/);
    assert.match(checkout, /fetch-depth: 0/);
    assert.match(checkout, /persist-credentials: false/);
    assert.doesNotMatch(checkout, /ssh-key/);
    for (const key of KEYS) {
        assert.doesNotMatch(workflow(key), /MASTER_KEY/, key);
        for (const body of runBlocks(workflow(key))) assert.doesNotMatch(body, /\$\{\{/, key);
        // A value reaches a Ploinky command only on stdin.
        for (const line of workflow(key).split('\n').filter((entry) => /ploinky_locked var /.test(entry))) {
            assert.match(line, /^\s*(?:if ! )?printf '%s' "\$[A-Z_]+[^"]*" \| ploinky_locked var \S+ --stdin(?:; then)?$/, line);
        }
    }
});

// The first use of each refusal and each mutation in the deploy step, by its call site and not its definition.
const MARKERS = {
    bizanso: {
        refusals: [
            'STATUS_OUTPUT="$(ploinky_read status)"',
            'echo "::error::Runtime $agent is not running',
            'run_in_box "$BIZANSO_READ_PROGRAM" < /dev/null)"',
            'echo "::error::The product check found no single running bizanso container.',
            'if [ "$(any_route_draining)" != no ]; then',
            'if ! await_routes 3; then',
            '\nprune_images pre\nrequire_free_disk\n',
        ],
        mutations: [
            'printf \'%s\\n\' "$BIZANSO_IMAGE" | run_in_box "$BIZANSO_PULL_PROGRAM")"',
            '| run_in_box "$COPY_PROGRAM"',
            'ploinky_locked var BIZANSO_PUBLIC_LINK_BASE --stdin',
            'restart_product "$RESTART_SCOPE" ||',
        ],
    },
    scriptahub: {
        refusals: [
            'STATUS_OUTPUT="$(ploinky_read status)"',
            'echo "::error::Runtime $agent is not running',
            'run_in_box "$SCRIPTAHUB_READ_PROGRAM" < /dev/null)"',
            'echo "::error::The product check found no single running $key container.',
            'if [ "$(any_route_draining)" != no ]; then',
            'if ! await_routes 3; then',
            '\nprune_images pre\nrequire_free_disk\n',
            'run_in_box "$SCRIPTAHUB_DIGEST_PROGRAM" < /dev/null',
            'if [ "$DISK_NOW_GIB" -lt "$DISK_NEEDED_GIB" ]; then',
        ],
        mutations: [
            '| run_in_box "$SCRIPTAHUB_PULL_PROGRAM")"',
            '| run_in_box "$SCRIPTAHUB_MERGE_PROGRAM"',
            '| run_in_box "$SCRIPTAHUB_TAG_PROGRAM"',
            'restart_product whole ||',
        ],
    },
};

test('every refusal comes before the first mutation, in the specified order', () => {
    for (const key of KEYS) {
        const source = workflow(key);
        const body = deployBody(key);
        const flow = body.slice(body.indexOf('# BEGIN QA product flow'));
        const positions = (markers) => markers.map((marker) => {
            const index = flow.indexOf(marker);
            assert.notEqual(index, -1, `${key}: marker missing: ${marker}`);
            return index;
        });
        const refusals = positions(MARKERS[key].refusals);
        const mutations = positions(MARKERS[key].mutations);
        assert.deepEqual([...refusals].sort((a, b) => a - b), refusals, `${key}: refusal order`);
        assert.ok(Math.max(...refusals) < Math.min(...mutations), `${key}: a refusal comes after a mutation`);
        assert.deepEqual([...mutations].sort((a, b) => a - b), mutations, `${key}: mutation order`);
        // Validation, host pinning and the preflight come before the flow; the status refusal needs the Box state first.
        const steps = ['Validate GitHub configuration', 'Prepare SSH key', DEPLOY_STEP[key]].map((name) => source.indexOf(`- name: ${name}\n`));
        assert.deepEqual([...steps].sort((a, b) => a - b), steps);
        assert.ok(body.indexOf("<<'REMOTE'") < body.indexOf('# BEGIN QA product flow'));
        assert.ok(flow.indexOf('BOX_STATE=present') > flow.indexOf('STATUS_OUTPUT="$(ploinky_read status)"'));
        assert.ok(flow.indexOf('BOX_STATE=present') < flow.indexOf('prune_images pre'));
        // The prune is not a mutation of product state, and no mutation precedes it.
        assert.equal((flow.match(/^\s*prune_images (?:pre|post)$/gm) || []).length, 2);
        assert.equal((flow.match(/^\s*require_free_disk$/gm) || []).length, 1);
    }
});

// ---------------------------------------------------------------------------------------------------------------
// Stub Box

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const GRAPH = ['explorer', 'gitAgent', 'userPersistoAgent', 'emailAgent', 'dpuAgent', 'roboTeamAgent', 'soul-gateway', 'workspaceMonitorAgent', 'local-llm', 'bizanso', 'promotionScout', 'scriptahubAgent'];
const GIB_KIB = 1048576;
const hex = (char) => char.repeat(64);

// What `ploinky status` prints: a repository block, then the runtime block that readiness is read from.
function statusText(overrides = {}) {
    const lines = ['Workspace status:', '- Repos:', '  - webmeet [agents] [local]', 'Agent runtimes:'];
    for (const name of GRAPH) {
        const state = overrides[name] ?? 'running';
        if (state === 'absent') continue;
        lines.push(`  - ploinky_Repo_${name}_x [${state}] [container] pid 7`, `     agent: ${name}  repo: Repo`, '');
    }
    return lines.join('\n');
}

const STUBS = {
    // Runs the command string that ssh would send, here, with the stubs below on PATH.
    fakessh: 'eval "${@: -1}"',
    // flock -n -E 75 --close LOCK command...; one call that mentions the pattern in $STUB/flock-busy finds the lock held.
    flock: `if [ -f "$STUB/flock-busy" ]; then
  pattern=$(cat "$STUB/flock-busy")
  case "$*" in *"$pattern"*) rm -f "$STUB/flock-busy"; echo "flock-busy $*" >> "$STUB/calls.log"; exit 75 ;; esac
fi
shift 5
exec "$@"`,
    sleep: 'exit 0',
    df: '[ "${DF_FAIL:-}" = 1 ] && exit 1; printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 %s 9%% /\\n" "$(cat "$STUB/free_kib")"',
    // One poll is one explorer request: it advances $STUB/routes.plan (explorer bizanso scripta, each CODE or CODE:BODY).
    // Written with shell builtins only, because a dwell makes hundreds of calls.
    curl: `url=""; out=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  http://127.0.0.1:*/healthz/) [ -f "$STUB/soul-down" ] && exit 22; exit 0 ;;
  */auth/login?agent=explorer)
    n=0; [ ! -f "$STUB/poll.n" ] || read -r n < "$STUB/poll.n"
    n=$((n + 1)); echo "$n" > "$STUB/poll.n"
    i=0; line=""; last=""
    while IFS= read -r entry; do
      i=$((i + 1)); last="$entry"
      if [ "$i" -eq "$n" ]; then line="$entry"; break; fi
    done < "$STUB/routes.plan"
    [ -n "$line" ] || line="$last"
    echo "$line" > "$STUB/poll.cur"; field=1 ;;
  */bizanso/8787/how-it-works/) field=2 ;;
  */scriptahubAgent/3002/health) field=3 ;;
  *) echo "unexpected curl $url" >> "$STUB/unexpected.log"; exit 7 ;;
esac
read -r first second third < "$STUB/poll.cur"
case "$field" in 1) value="$first" ;; 2) value="$second" ;; *) value="$third" ;; esac
code="\${value%%:*}"; body=""
case "$value" in *:*) body="\${value#*:}" ;; esac
[ -z "$out" ] || printf '%s' "$body" > "$out"
[ -z "$wfmt" ] || printf '%s' "$code"
exit 0`,
    sha256sum: 'exec shasum -a 256 "$@"',
    // docker buildx imagetools inspect [--raw] REF [--format F]: answers from $STUB/imagetools.{raw,json}.<ref with / : @ as _>.
    docker: `echo "docker $*" >> "$STUB/calls.log"
shift 3
raw=0; ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --raw) raw=1; shift ;;
    --format) shift 2 ;;
    *) ref="$1"; shift ;;
  esac
done
key=$(printf '%s' "$ref" | tr '/:@' '___')
if [ "$raw" = 1 ]; then cat "$STUB/imagetools.raw.$key" || exit 1; else cat "$STUB/imagetools.json.$key" || exit 1; fi`,
    // The Ploinky CLI. A restart runs the hook $STUB/hook-restart-<agent with / and spaces as _>, or hook-restart-whole.
    ploinky: `echo "ploinky $*" >> "$STUB/calls.log"
case "$1" in
  status) cat "$STUB/status.txt" ;;
  restart)
    shift
    key=$(printf '%s' "$*" | tr '/ ' '__')
    hook="$STUB/hook-restart-\${key:-whole}"
    if [ -x "$hook" ]; then "$hook" "$@"; exit $?; fi
    exit 0 ;;
  var) cat >> "$STUB/var.$2" ;;
  *) exit 0 ;;
esac`,
    // Host podman, Box podman (container exec ... podman) and the Box shell (container exec ... sh -c PROGRAM sh).
    // $STUB/images holds the local images and $STUB/registry the pullable ones: "name id revision digests-or-dash" per line.
    podman: `if [ "$1" = container ] && [ "$2" = exec ]; then
  shift 2; wd=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -i) shift ;;
      --user|--env) shift 2 ;;
      --workdir) wd="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  shift
  if [ "$1" = sh ]; then cd "$wd" && exec "\${QA_PROGRAM_SHELL:-sh}" -c "$3" sh; fi
  if [ "$1" = podman ]; then shift; exec "$0" "$@"; fi
  exit 1
fi
row() { awk -v k="$1" '$1 == k || $2 == k { print; exit }' "$STUB/images"; }
case "$1" in
  ps)
    shift
    if [ "$1" = -a ]; then cat "$STUB/ps-a" 2> /dev/null; exit 0; fi
    prefix=""; cid=""
    for arg in "$@"; do case "$arg" in name=^*) prefix="\${arg#name=^}" ;; id=*) cid="\${arg#id=}" ;; esac; done
    if [ -n "$cid" ]; then echo "podman ps id=$cid" >> "$STUB/calls.log"; cat "$STUB/running.$cid" 2> /dev/null; exit 0; fi
    echo "podman ps $prefix" >> "$STUB/calls.log"
    cat "$STUB/ps.$prefix" 2> /dev/null; exit 0 ;;
  pull)
    echo "podman $*" >> "$STUB/calls.log"
    [ ! -f "$STUB/pull-fail" ] || exit 125
    ref="$3"
    found=$(awk -v k="$ref" '$1 == k { print; exit }' "$STUB/registry")
    [ -n "$found" ] || { echo "no such image $ref" >&2; exit 125; }
    grep -v "^$ref " "$STUB/images" > "$STUB/images.tmp" || true
    { cat "$STUB/images.tmp"; echo "$found"; } > "$STUB/images"
    echo "\${found#* }" | cut -d ' ' -f1 ;;
  tag)
    echo "podman $*" >> "$STUB/calls.log"
    case "$3" in *roboteam-agent*) [ ! -f "$STUB/tag-fail" ] || exit 125 ;; esac
    found=$(row "$2")
    [ -n "$found" ] || exit 125
    set -- $found "$3"
    grep -v "^$5 " "$STUB/images" > "$STUB/images.tmp" || true
    { cat "$STUB/images.tmp"; echo "$5 $2 $3 $4"; } > "$STUB/images" ;;
  image)
    case "$2" in
      inspect)
        fmt="$4"; ref="$5"
        found=$(row "$ref")
        [ -n "$found" ] || { echo "no such image $ref" >&2; exit 125; }
        set -- $found
        case "$fmt" in
          *RepoDigests*) [ "$4" = - ] || printf '%s\\n' "$4" | tr ',' '\\n' ;;
          *Labels*) echo "$3" ;;
          *) echo "$2" ;;
        esac ;;
      ls) exit 0 ;;
      rm) echo "podman $*" >> "$STUB/calls.log" ;;
    esac ;;
esac`,
};

// A Box, its host and its runner on disk. Every path is short enough for any socket the stubs might need.
function makeBox(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prod-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const box = {
        dir,
        bin: path.join(dir, 'bin'),
        stub: path.join(dir, 'stub'),
        ws: path.join(dir, 'ws'),
        runner: path.join(dir, 'runner'),
        github: path.join(dir, 'github'),
    };
    for (const folder of [box.bin, box.stub, box.ws, box.runner, box.github, path.join(box.ws, '.ploinky')]) fs.mkdirSync(folder, { recursive: true });
    for (const [name, body] of Object.entries(STUBS)) {
        if (name === 'sha256sum' && spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status === 0) continue;
        fs.writeFileSync(path.join(box.bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }
    box.githubEnv = path.join(dir, 'github.env');
    fs.writeFileSync(box.githubEnv, '');
    box.write = (name, text) => fs.writeFileSync(path.join(box.stub, name), text);
    box.hook = (name, body) => fs.writeFileSync(path.join(box.stub, `hook-restart-${name}`), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    box.status = (overrides) => box.write('status.txt', statusText(overrides));
    box.images = (rows) => box.write('images', rows.map((row) => row.join(' ')).join('\n') + (rows.length ? '\n' : ''));
    box.registry = (rows) => box.write('registry', rows.map((row) => row.join(' ')).join('\n') + (rows.length ? '\n' : ''));
    box.ps = (prefix, lines) => box.write(`ps.${prefix}`, lines.map((line) => `${line}\n`).join(''));
    box.routes = (...plan) => box.write('routes.plan', plan.map((line) => `${line}\n`).join(''));
    box.freeGib = (gib) => box.write('free_kib', String(Math.round(gib * GIB_KIB)));
    box.calls = () => (fs.existsSync(path.join(box.stub, 'calls.log')) ? fs.readFileSync(path.join(box.stub, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
    box.env = (extra = {}) => ({
        PATH: `${box.bin}:${process.env.PATH}`,
        HOME: dir,
        STUB: box.stub,
        QA_PROGRAM_SHELL: PROGRAM_SHELL,
        RUNNER_TEMP: box.runner,
        GITHUB_WORKSPACE: box.github,
        GITHUB_ENV: box.githubEnv,
        SSH_USER: 'admin',
        SSH_HOST: '45.136.70.141',
        WORKSPACE: 'explorerQaWorkspace',
        ROUTER_PORT: '8097',
        PUBLIC_HOST: 'explorer-qa.axiologic.dev',
        PUBLIC_URL: 'https://explorer-qa.axiologic.dev',
        SOUL_GATEWAY_ROUTER_PORT: '8080',
        ...extra,
    });
    box.exec = (script, extra = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: box.env(extra), maxBuffer: 1 << 26 });
    // Defaults: a healthy graph, healthy routes, 20 GiB free, nothing pullable.
    // Neither Ploinky file marks anything as draining until a test says so.
    fs.writeFileSync(path.join(box.ws, '.ploinky/routing.json'), JSON.stringify({ routes: { explorer: { container: 'ploinky_AchillesIDE_explorer_x' } } }));
    fs.writeFileSync(path.join(box.ws, '.ploinky/agents.json'), '{}');
    box.status();
    box.routes('303 200 200');
    box.freeGib(20);
    box.images([]);
    box.registry([]);
    return box;
}

// The environment a step exported through $GITHUB_ENV.
function exported(box) {
    return Object.fromEntries(fs.readFileSync(box.githubEnv, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

// The flow of a deploy step, run against the stub Box with what the preflight would have established.
function prelude(box) {
    return `set -euo pipefail
umask 077
SSH=(fakessh)
LOCK=/lock
WORK_DIR=${box.ws}
PLOINKY_BIN=${box.bin}/ploinky
QA_NODE_HOME=/home/admin/.qa-deployment-tools/node-v24.19.0-linux-x64
PLOINKY_COMMIT=abc1234
`;
}
function flowScript(box, key) {
    const body = deployBody(key);
    const flow = body.slice(body.indexOf('# BEGIN QA product flow'));
    assert.ok(flow.length > 1000);
    return prelude(box) + flow;
}
const logOf = (result) => `${result.stdout}\n${result.stderr}`;

// The shared helper blocks and the product blocks, without the flow's own refusals, for restart_product alone.
function restartScript(box, key, { productCheck = 'return 0', mode = 'targeted', extra = '' } = {}) {
    const source = workflow(key);
    const unindent = (text) => text.split('\n').map((line) => (line.startsWith(I) ? line.slice(10) : line)).join('\n');
    const agent = key === 'bizanso' ? ['bizanso/bizanso', 'bizanso'] : ['ScriptaHubAgent/scriptahubAgent', 'scriptahubAgent'];
    return `${prelude(box)}REMOTE_ENV="cd '$WORK_DIR' && export PATH='$QA_NODE_HOME/bin':\\"\\$PATH\\" PLOINKY_WORKSPACE_ROOT='$WORK_DIR'"
${['helpers', 'graph', 'extend', 'runinbox'].map((name) => unindent(block(source, name))).join('\n')}
${unindent(block(source, 'routes'))}
PRODUCT_AGENT=${agent[0]}
PRODUCT_RUNTIME=${agent[1]}
product_check() { ${productCheck}; }
${unindent(block(source, 'restart'))}
${extra}
restart_status=0
restart_product ${mode} || restart_status=$?
echo "RESTART_STATUS=$restart_status RESTART_RESULT=$RESTART_RESULT"
`;
}
const restartCalls = (box) => box.calls().filter((line) => /^ploinky restart/.test(line));
const outcome = (result) => ({
    status: Number(result.stdout.match(/RESTART_STATUS=(\d+)/)?.[1]),
    result: result.stdout.match(/RESTART_RESULT=(\S+)/)?.[1],
});

// ---------------------------------------------------------------------------------------------------------------
// restart_product

const AGENTS_JSON_ID = hex('c');
const DRAIN_TEXT = "targeted drain for 'bizanso' did not exit cleanly (exit=143); refusing removal or recreate";
const writeJson = (box, name, value) => fs.writeFileSync(path.join(box.ws, '.ploinky', name), JSON.stringify(value));
const AGENT_RECORDS = { ploinky_bizanso_bizanso_abc: { type: 'agent', agentName: 'bizanso', repoName: 'bizanso', containerId: AGENTS_JSON_ID } };
// A hook that leaves the product running again.
const RUNNING_AGAIN = (box, state = {}) => `cat > "$STUB/status.txt" <<'STATUS'\n${statusText(state)}\nSTATUS`;

test('restart_product: a targeted restart whose checks pass makes exactly one targeted call', (t) => {
    const box = makeBox(t);
    const result = box.exec(restartScript(box, 'bizanso'));
    assert.equal(result.status, 0, logOf(result));
    assert.deepEqual(outcome(result), { status: 0, result: 'targeted' });
    assert.deepEqual(restartCalls(box), ['ploinky restart bizanso/bizanso']);
    // 1 poll to be alive, then the 6-minute dwell: 24 polls.
    assert.equal(fs.readFileSync(path.join(box.stub, 'poll.n'), 'utf8').trim(), '25');
    assert.equal(fs.existsSync(path.join(box.stub, 'unexpected.log')), false);
    // Repeating it after a success is the same single call again, and changes nothing else.
    const again = box.exec(restartScript(box, 'bizanso'));
    assert.deepEqual(outcome(again), { status: 0, result: 'targeted' });
    assert.equal(restartCalls(box).length, 2);
});

test('restart_product: a failed targeted restart recovers with one whole restart', (t) => {
    const box = makeBox(t);
    box.hook('bizanso_bizanso', 'echo "targeted boom"; exit 1');
    const result = box.exec(restartScript(box, 'bizanso'));
    assert.equal(result.status, 0, logOf(result));
    assert.deepEqual(outcome(result), { status: 0, result: 'whole-after-targeted' });
    assert.deepEqual(restartCalls(box), ['ploinky restart bizanso/bizanso', 'ploinky restart']);
    assert.match(result.stdout, /::warning::The targeted restart of bizanso\/bizanso exited 1 or a runtime, route or image check failed; recovering with a whole-workspace restart\./);
    assert.match(result.stdout, /targeted boom/);
});

test('restart_product: each check of the targeted path falls back to the whole restart when it fails', (t) => {
    const cases = {
        'the product never settles': {
            setup: (box) => { box.status({ bizanso: 'stopped' }); box.hook('whole', RUNNING_AGAIN(box)); },
        },
        'another runtime reports failed readiness': {
            setup: (box) => { box.status({ gitAgent: 'failed' }); box.hook('whole', RUNNING_AGAIN(box)); },
        },
        'the routes answer EDGE_GENERATION_INACTIVE': {
            setup: (box) => { box.routes(...Array(18).fill('200:EDGE_GENERATION_INACTIVE 200 200'), '303 200 200'); },
        },
        'the explorer route answers 503': {
            setup: (box) => { box.routes(...Array(18).fill('503 200 200'), '303 200 200'); },
        },
        'the scriptahub route answers 502': {
            setup: (box) => { box.routes(...Array(18).fill('303 200 502'), '303 200 200'); },
        },
        'the product check fails': {
            productCheck: '[ -f "$STUB/repaired" ]',
            setup: (box) => { box.hook('whole', 'touch "$STUB/repaired"'); },
        },
        'the routes are lost during the dwell': {
            setup: (box) => { box.routes('303 200 200', '303 200 200', '503 200 200', '303 200 200'); },
        },
    };
    for (const [name, scenario] of Object.entries(cases)) {
        const box = makeBox(t);
        scenario.setup(box);
        const result = box.exec(restartScript(box, 'bizanso', { productCheck: scenario.productCheck }));
        assert.equal(result.status, 0, `${name}: ${logOf(result)}`);
        assert.deepEqual(outcome(result), { status: 0, result: 'whole-after-targeted' }, name);
        assert.deepEqual(restartCalls(box), ['ploinky restart bizanso/bizanso', 'ploinky restart'], name);
        assert.match(result.stdout, /::warning::The targeted restart of bizanso\/bizanso exited 0 or a runtime, route or image check failed/, name);
    }
});

test('restart_product: routes lost during the dwell run the dwell again after the whole restart, and a second loss fails the run', (t) => {
    const box = makeBox(t);
    // Poll 1 is the wait, polls 2 to 4 the first dwell, which is lost at its fourth poll (5 in all).
    box.routes('303 200 200', '303 200 200', '303 200 200', '303 200 200', '503 200 200', '303 200 200');
    const result = box.exec(restartScript(box, 'bizanso'));
    assert.deepEqual(outcome(result), { status: 0, result: 'whole-after-targeted' });
    assert.match(result.stdout, /routes lost on dwell poll 4: explorer=503 bizanso=200 scriptahub=200/);
    // 5 polls until the loss, then 1 to be alive and a full dwell of 24.
    assert.equal(fs.readFileSync(path.join(box.stub, 'poll.n'), 'utf8').trim(), String(5 + 1 + 24));

    // A second loss, in the dwell that follows the whole restart, fails the run.
    const failing = makeBox(t);
    failing.routes('303 200 200', '503 200 200', '303 200 200', '503 200 200');
    const second = failing.exec(restartScript(failing, 'bizanso'));
    assert.deepEqual(outcome(second), { status: 1, result: 'failed' });
    assert.match(second.stdout, /::error::bizanso\/bizanso is not ready after a whole-workspace restart \(exit 0\)\. Recover with deploy-explorer-qa-ploinky\.yml\./);
    assert.deepEqual(restartCalls(failing), ['ploinky restart bizanso/bizanso', 'ploinky restart']);
});

test('restart_product: a lock held on the targeted restart returns 75 with no fallback', (t) => {
    const box = makeBox(t);
    box.write('flock-busy', 'restart bizanso/bizanso');
    const result = box.exec(restartScript(box, 'bizanso'));
    assert.deepEqual(outcome(result), { status: 75, result: 'failed' });
    assert.match(result.stdout, /::error::Another Explorer QA operation holds the host lock\./);
    assert.deepEqual(restartCalls(box), []);
    assert.equal(box.calls().filter((line) => line.startsWith('flock-busy')).length, 1);
    // The lock also stops the whole restart that follows a failed targeted one.
    const whole = makeBox(t);
    whole.hook('bizanso_bizanso', 'echo "ploinky restart" > "$STUB/flock-busy"; exit 1');
    const second = whole.exec(restartScript(whole, 'bizanso'));
    assert.deepEqual(outcome(second), { status: 75, result: 'failed' });
    assert.deepEqual(restartCalls(whole), ['ploinky restart bizanso/bizanso']);
});

test('restart_product: a refused drain is never answered with a restart, and the error names the accept command with the container ID', (t) => {
    for (const evidence of ['the output text', 'the routing flag']) {
        const box = makeBox(t);
        writeJson(box, 'agents.json', AGENT_RECORDS);
        if (evidence === 'the output text') box.hook('bizanso_bizanso', `echo "${DRAIN_TEXT}"; exit 1`);
        else {
            box.hook('bizanso_bizanso', 'echo "restart failed"; exit 1');
            writeJson(box, 'routing.json', { routes: { bizanso: { container: 'ploinky_bizanso_bizanso_abc', draining: true }, explorer: { container: 'ploinky_AchillesIDE_explorer_x' } } });
        }
        const result = box.exec(restartScript(box, 'bizanso'));
        assert.deepEqual(outcome(result), { status: 1, result: 'failed' }, evidence);
        assert.deepEqual(restartCalls(box), ['ploinky restart bizanso/bizanso'], evidence);
        assert.match(result.stdout, new RegExp(`::error::The targeted drain of bizanso/bizanso was refused.*ploinky restart bizanso/bizanso --accept-failed-drain ${AGENTS_JSON_ID}$`, 'm'), evidence);
        assert.doesNotMatch(result.stdout, /deploy-explorer-qa-ploinky\.yml/, evidence);
        assert.equal(box.calls().some((line) => line.includes('--accept-failed-drain')), false, 'the workflow never accepts a drain');
        // Neither file is ever printed.
        assert.doesNotMatch(logOf(result), /ploinky_bizanso_bizanso_abc/, evidence);
    }
    // A routing file that cannot be read rules nothing out: no whole restart either.
    const unknown = makeBox(t);
    unknown.hook('bizanso_bizanso', 'echo "restart failed"; exit 1');
    fs.writeFileSync(path.join(unknown.ws, '.ploinky/routing.json'), 'not json');
    const result = unknown.exec(restartScript(unknown, 'bizanso'));
    assert.deepEqual(outcome(result), { status: 1, result: 'failed' });
    assert.deepEqual(restartCalls(unknown), ['ploinky restart bizanso/bizanso']);
    assert.match(result.stdout, /a refused drain cannot be ruled out, so no whole restart was tried/);
    assert.doesNotMatch(logOf(result), /not json/);
});

test('restart_product: a whole restart that leaves the product stopped fails within 3 polls and says how to recover', (t) => {
    for (const key of KEYS) {
        const agent = key === 'bizanso' ? 'bizanso' : 'scriptahubAgent';
        const repo = key === 'bizanso' ? 'bizanso' : 'ScriptaHubAgent';
        const box = makeBox(t);
        box.status({ [agent]: 'stopped' });
        const run = box.exec(restartScript(box, key, { mode: 'whole' }));
        assert.deepEqual(outcome(run), { status: 1, result: 'failed' }, key);
        // Exactly 3 polls of the product, and no readiness wait or route wait ran.
        assert.equal(box.calls().filter((line) => line === 'ploinky status').length, 3, `${key}: exactly 3 settle polls`);
        assert.match(run.stdout, /on 3 polls in a row\./);
        assert.match(run.stdout, /::error::.* is not ready after a whole-workspace restart \(exit 0\)\. Recover with deploy-explorer-qa-ploinky\.yml\./, key);
        assert.equal(box.calls().some((line) => line.includes('--accept-failed-drain')), false);
        assert.equal(fs.existsSync(path.join(box.stub, 'poll.n')), false, 'no route poll');

        const drained = makeBox(t);
        drained.status({ [agent]: 'stopped' });
        writeJson(drained, 'agents.json', { x: { type: 'agent', agentName: agent, repoName: repo, containerId: AGENTS_JSON_ID } });
        writeJson(drained, 'routing.json', { routes: { [agent]: { draining: true } } });
        const drainedRun = drained.exec(restartScript(drained, key, { mode: 'whole' }));
        assert.deepEqual(outcome(drainedRun), { status: 1, result: 'failed' }, key);
        assert.match(drainedRun.stdout, new RegExp(`--accept-failed-drain ${AGENTS_JSON_ID}$`, 'm'), key);
        assert.doesNotMatch(drainedRun.stdout, /deploy-explorer-qa-ploinky\.yml/, key);
        assert.equal(drained.calls().some((line) => line.includes('--accept-failed-drain')), false, key);
    }
});

test('restart_product: a whole restart that exits 75 returns 75', (t) => {
    const box = makeBox(t);
    box.write('flock-busy', 'ploinky restart');
    const result = box.exec(restartScript(box, 'scriptahub', { mode: 'whole' }));
    assert.deepEqual(outcome(result), { status: 75, result: 'failed' });
    assert.deepEqual(restartCalls(box), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Bizanso

const BIZ_REF = `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(64)}`;
const BIZ_PREFIX = 'ploinky_bizanso_bizanso_';
const bizansoFiles = (overrides = {}) => {
    const files = {
        'bizanso/manifest.json': `${JSON.stringify({ name: 'bizanso', container: BIZ_REF, enable: [{ agent: 'userPersistoAgent' }], routerAccess: { httpRoutes: [{ path: '/a', access: 'public' }] }, profiles: { default: { env: { PORT: { default: '7000' } } } } }, null, 2)}\n`,
        'bizanso/mcp-config.json': '{"tools":[]}\n',
        'bizanso/package.json': '{"name":"bizanso"}\n',
        'bizanso/src/runtime.mjs': 'export default 1;\n',
        'package.json': '{"name":"root"}\n',
        'package-lock.json': '{"lockfileVersion":3}\n',
        ...overrides,
    };
    return Object.fromEntries(Object.entries(files).filter(([, value]) => value !== null));
};
const manifestWith = (change) => `${JSON.stringify(change(JSON.parse(bizansoFiles()['bizanso/manifest.json'])), null, 2)}\n`;
function writeTree(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
    }
}
function vcs(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function commitTree(dir, files, message = 'commit') {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) vcs(dir, 'init', '--quiet');
    for (const entry of fs.readdirSync(dir)) if (entry !== '.git') fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    writeTree(dir, files);
    vcs(dir, 'add', '-A');
    vcs(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
    return vcs(dir, 'rev-parse', 'HEAD');
}
const epoch = () => Math.floor(Date.now() / 1000);

// A Box whose bizanso/ holds `live`, running `liveImage`, with `source` waiting in the runner's checkout.
function bizansoBox(t, { source = {}, live = {}, liveImage = hex('a'), pulledId = hex('b'), started = epoch() - 3600 } = {}) {
    const box = makeBox(t);
    commitTree(path.join(box.github, '.qa-bizanso-source'), bizansoFiles(source));
    writeTree(path.join(box.ws, 'bizanso'), bizansoFiles(live));
    box.ps(BIZ_PREFIX, [`${liveImage} ${started} ${BIZ_PREFIX}abc`]);
    box.registry([[BIZ_REF, pulledId, '-', '-']]);
    const up = `printf '%s %s %s\\n' ${pulledId} "$(date +%s)" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"; echo restarted`;
    box.hook('bizanso_bizanso', up);
    box.hook('whole', up);
    return box;
}
function resolveBizanso(box) {
    const result = box.exec(stepScript(workflow('bizanso'), 'Resolve the Bizanso source'));
    return { result, env: result.status === 0 ? exported(box) : {} };
}
function runBizansoFlow(box, extra = {}) {
    const { result: resolved, env } = resolveBizanso(box);
    assert.equal(resolved.status, 0, logOf(resolved));
    return box.exec(flowScript(box, 'bizanso'), { ...env, ...extra });
}
const noMutation = (box, { pull = false } = {}) => {
    const calls = box.calls();
    assert.deepEqual(calls.filter((line) => (pull ? /^podman (?:tag|image rm)|^ploinky (?:restart|var)/ : /^podman (?:pull|tag|image rm)|^ploinky (?:restart|var)/).test(line)), []);
    assert.equal(fs.existsSync(path.join(box.ws, '.ploinky/.qa-private-copy')), false);
};

test('Bizanso source: the commit, the image reference and the tree digest are resolved on the runner', (t) => {
    const box = bizansoBox(t);
    const { result, env } = resolveBizanso(box);
    assert.equal(result.status, 0, logOf(result));
    assert.match(env.BIZANSO_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
    assert.equal(env.BIZANSO_IMAGE, BIZ_REF);
    assert.match(env.BIZANSO_SOURCE_TREE, /^sha256:[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(env.BIZANSO_INCOMING_DIR, 'bizanso/manifest.json')));
    assert.equal(fs.existsSync(path.join(env.BIZANSO_INCOMING_DIR, '.git')), false);
});

test('Bizanso source: a container field that is not an exact digest reference refuses the run', (t) => {
    const badRefs = [
        'docker.io/assistos/bizanso-agent:runtime',
        `docker.io/other/x@sha256:${'1'.repeat(64)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(63)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(65)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(64)};touch pwned`,
        'docker.io/assistos/bizanso-agent@sha256:$(touch pwned)',
        '',
    ];
    for (const ref of badRefs) {
        const box = bizansoBox(t, { source: { 'bizanso/manifest.json': manifestWith((manifest) => ({ ...manifest, container: ref })) } });
        const { result } = resolveBizanso(box);
        assert.notEqual(result.status, 0, ref);
        assert.match(logOf(result), /not a digest-pinned docker\.io\/assistos\/bizanso-agent reference/, ref);
        assert.equal(fs.existsSync(path.join(box.runner, 'pwned')) || fs.existsSync(path.join(box.github, 'pwned')), false);
    }
});

test('Bizanso pull program: only the exact repository by a 64-hex digest is pulled, and a bad value is refused before anything runs', (t) => {
    const program = deployBody('bizanso').match(/^BIZANSO_PULL_PROGRAM='([^']*)'$/m)[1];
    const run = (box, ref) => spawnSync(PROGRAM_SHELL, ['-c', program, 'sh'], { cwd: box.ws, input: `${ref}\n`, encoding: 'utf8', env: box.env() });
    const box = makeBox(t);
    box.registry([[BIZ_REF, hex('b'), '-', '-']]);
    const good = run(box, BIZ_REF);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, `IMAGE_ID=${hex('b')}\n`);
    assert.deepEqual(box.calls(), [`podman pull -q ${BIZ_REF}`]);
    for (const ref of [
        'docker.io/assistos/bizanso-agent:latest',
        `docker.io/other/x@sha256:${'1'.repeat(64)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(63)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(65)}`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(63)};`,
        `docker.io/assistos/bizanso-agent@sha256:${'1'.repeat(63)}G`,
        'docker.io/assistos/bizanso-agent@sha256:$(touch pwned)',
        '',
    ]) {
        const other = makeBox(t);
        const refused = run(other, ref);
        assert.notEqual(refused.status, 0, ref);
        assert.deepEqual(other.calls(), [], `${ref} reached podman`);
        assert.equal(fs.existsSync(path.join(other.ws, 'pwned')), false);
    }
});

test('the tree digest is the same on the runner and in the Box, and one changed byte changes it', (t) => {
    const line = 'find . -type f -print0 | LC_ALL=C sort -z | xargs -0r sha256sum | sha256sum | cut -d " " -f1';
    const program = deployBody('bizanso').match(/^BIZANSO_READ_PROGRAM='([^']*)'$/m)[1];
    assert.ok(stepScript(workflow('bizanso'), 'Resolve the Bizanso source').includes(line));
    assert.ok(program.includes(line));
    const box = bizansoBox(t);
    const { env } = resolveBizanso(box);
    const read = () => spawnSync(PROGRAM_SHELL, ['-c', program, 'sh'], { cwd: box.ws, encoding: 'utf8', env: box.env() });
    const here = read();
    assert.equal(here.status, 0, here.stderr);
    assert.equal(here.stdout, `TREE=${env.BIZANSO_SOURCE_TREE}\n`);
    fs.writeFileSync(path.join(box.ws, 'bizanso/bizanso/src/runtime.mjs'), 'export default 2;\n');
    const changed = read();
    assert.match(changed.stdout, /^TREE=sha256:[0-9a-f]{64}\n$/);
    assert.notEqual(changed.stdout, here.stdout);
});

test('Bizanso read program: a symlinked or Git-carrying or doubly managed directory is refused', (t) => {
    const program = deployBody('bizanso').match(/^BIZANSO_READ_PROGRAM='([^']*)'$/m)[1];
    const run = (box) => spawnSync(PROGRAM_SHELL, ['-c', program, 'sh'], { cwd: box.ws, encoding: 'utf8', env: box.env() });
    const absent = makeBox(t);
    assert.notEqual(run(absent).status, 0, 'no bizanso at the workspace root');
    const withGit = bizansoBox(t);
    fs.mkdirSync(path.join(withGit.ws, 'bizanso/.git'));
    assert.notEqual(run(withGit).status, 0);
    const managed = bizansoBox(t);
    fs.mkdirSync(path.join(managed.ws, '.ploinky/repos/bizanso'), { recursive: true });
    assert.notEqual(run(managed).status, 0);
    const linked = bizansoBox(t);
    fs.renameSync(path.join(linked.ws, 'bizanso'), path.join(linked.dir, 'elsewhere'));
    fs.symlinkSync(path.join(linked.dir, 'elsewhere'), path.join(linked.ws, 'bizanso'));
    assert.notEqual(run(linked).status, 0);
    assert.equal(run(bizansoBox(t)).status, 0);
});

// The classifier runs on the runner, from the workflow's own text.
function classify(box, { live, incoming, liveTree = 'a', sourceTree = 'a', liveImage = 'i', imageId = 'i' }) {
    const liveDir = path.join(box.dir, `live-${Math.random().toString(16).slice(2)}`);
    const incomingDir = path.join(box.dir, `incoming-${Math.random().toString(16).slice(2)}`);
    writeTree(liveDir, bizansoFiles(live));
    writeTree(incomingDir, bizansoFiles(incoming));
    const source = deployBody('bizanso');
    const text = source.slice(source.indexOf('# BEGIN QA Bizanso classifier'), source.indexOf('# END QA Bizanso classifier'));
    return box.exec(`${text}\nclassify_bizanso "$1" "$2" "$3" "$4" "$5" "$6"`.replace('"$1" "$2" "$3" "$4" "$5" "$6"', `${JSON.stringify(liveDir)} ${JSON.stringify(incomingDir)} ${liveTree} ${sourceTree} ${liveImage} ${imageId}`));
}
const scopeOf = (result) => result.stdout.match(/^scope=(\w+) reason=(.*)$/m)?.slice(1, 3);

test('Bizanso classifier: identical trees and image are none, a container-only change is targeted, other manifest, config or package changes are whole', (t) => {
    const box = makeBox(t);
    assert.equal(scopeOf(classify(box, {}))[0], 'none');
    // Same files but another image on the running container: targeted.
    assert.equal(scopeOf(classify(box, { imageId: 'j' }))[0], 'targeted');
    // Different trees with nothing that needs more than a restart of the agent: targeted.
    assert.equal(scopeOf(classify(box, { incoming: { 'bizanso/src/runtime.mjs': 'export default 2;\n' }, sourceTree: 'b' }))[0], 'targeted');
    const other = `docker.io/assistos/bizanso-agent@sha256:${'2'.repeat(64)}`;
    assert.equal(scopeOf(classify(box, { incoming: { 'bizanso/manifest.json': manifestWith((m) => ({ ...m, container: other })) }, sourceTree: 'b' }))[0], 'targeted');
    // Key order and whitespace of the manifest do not matter.
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(bizansoFiles()['bizanso/manifest.json'])).reverse()));
    assert.equal(scopeOf(classify(box, { incoming: { 'bizanso/manifest.json': reordered } }))[0], 'none');
    const whole = {
        enable: { 'bizanso/manifest.json': manifestWith((m) => ({ ...m, enable: [] })) },
        routerAccess: { 'bizanso/manifest.json': manifestWith((m) => ({ ...m, routerAccess: { httpRoutes: [] } })) },
        'an empty manifest': { 'bizanso/manifest.json': '{}\n' },
        'mcp-config.json': { 'bizanso/mcp-config.json': '{"tools":["x"]}\n' },
        'bizanso/package.json': { 'bizanso/package.json': '{"name":"other"}\n' },
        'package.json': { 'package.json': '{"name":"other"}\n' },
        'package-lock.json': { 'package-lock.json': '{"lockfileVersion":2}\n' },
        'a package file only on the incoming side': { 'bizanso/package.json': '{}\n' },
    };
    for (const [name, incoming] of Object.entries(whole)) {
        const result = classify(box, { incoming, sourceTree: 'b' });
        assert.equal(result.status, 0, `${name}: ${logOf(result)}`);
        assert.equal(scopeOf(result)[0], 'whole', name);
    }
    // And only on the live side.
    assert.equal(scopeOf(classify(box, { incoming: { 'package-lock.json': null }, sourceTree: 'b' }))[0], 'whole');
    assert.equal(scopeOf(classify(box, { live: { 'bizanso/mcp-config.json': null }, sourceTree: 'b' }))[0], 'whole');
    // The container field alone never makes it whole.
    assert.equal(scopeOf(classify(box, { live: { 'bizanso/manifest.json': manifestWith((m) => ({ ...m, container: other })) }, sourceTree: 'b' }))[0], 'targeted');
});

test('Bizanso classifier: a manifest missing on either side, or not JSON, fails', (t) => {
    const box = makeBox(t);
    for (const [name, options] of Object.entries({
        'live manifest missing': { live: { 'bizanso/manifest.json': null } },
        'incoming manifest missing': { incoming: { 'bizanso/manifest.json': null } },
        'live manifest not JSON': { live: { 'bizanso/manifest.json': 'not json' } },
        'live manifest an array': { live: { 'bizanso/manifest.json': '[]' } },
    })) {
        const result = classify(box, options);
        assert.notEqual(result.status, 0, name);
        assert.equal(scopeOf(result), undefined, name);
    }
});

const inOrder = (text, patterns, label = '') => {
    let cursor = 0;
    for (const pattern of patterns) {
        const rest = text.slice(cursor);
        const match = rest.match(pattern);
        assert.ok(match, `${label}${pattern} missing or out of order in:\n${text.slice(-3500)}`);
        cursor += match.index + match[0].length;
    }
};

test('Bizanso flow: a source change copies, sets the link base, restarts only bizanso/bizanso and proves the result', (t) => {
    const box = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    const result = runBizansoFlow(box);
    assert.equal(result.status, 0, logOf(result));
    const env = exported(box);
    const out = result.stdout;
    inOrder(out, [
        /\[deploy-qa-bizanso\] source [0-9a-f]{40} tree sha256:[0-9a-f]{64} image docker\.io\/assistos\/bizanso-agent@sha256:[0-9a-f]{64} id b{64}\n/,
        /\[deploy-qa-bizanso\] live tree before sha256:[0-9a-f]{64}\n/,
        /\[deploy-qa-bizanso\] restart scope: targeted \(the sources or the container image changed\)\n/,
        /\[deploy-qa-bizanso\] restart result: targeted\n/,
        new RegExp(`\\[deploy-qa-bizanso\\] container ${BIZ_PREFIX}new image b{64} started \\d+ >= copy \\d+\\n`),
        new RegExp(`\\[deploy-qa-bizanso\\] live tree after ${env.BIZANSO_SOURCE_TREE}\\n`),
        /\[deploy-qa\] free disk after prune: 20 GiB\n/,
    ]);
    const calls = box.calls();
    assert.deepEqual(calls.filter((line) => /^ploinky (?:restart|var)/.test(line)), ['ploinky var BIZANSO_PUBLIC_LINK_BASE --stdin', 'ploinky restart bizanso/bizanso']);
    assert.deepEqual(calls.filter((line) => line.startsWith('podman pull')), [`podman pull -q ${BIZ_REF}`]);
    assert.equal(fs.readFileSync(path.join(box.stub, 'var.BIZANSO_PUBLIC_LINK_BASE'), 'utf8'), 'https://explorer-qa.axiologic.dev/base-agent-additional-server/bizanso/8787');
    // The copy replaced the live tree and kept exactly one predecessor.
    assert.equal(fs.readFileSync(path.join(box.ws, 'bizanso/bizanso/src/runtime.mjs'), 'utf8'), 'export default 2;\n');
    assert.equal(fs.readFileSync(path.join(box.ws, '.ploinky/.qa-private-copy/previous/bizanso/src/runtime.mjs'), 'utf8'), 'export default 1;\n');
    assert.equal(fs.existsSync(path.join(box.stub, 'unexpected.log')), false);
    assert.ok(deployBody('bizanso').includes('echo "[deploy-qa-bizanso] Ploinky checkout $PLOINKY_COMMIT (not moved)."'));

    // Running it again finds equal trees and an equal image: no copy, no restart, no variable.
    const before = box.calls().length;
    const again = runBizansoFlowAgain(box);
    assert.equal(again.status, 0, logOf(again));
    assert.match(again.stdout, /restart scope: none \(the tree and the image are identical\)\n/);
    assert.match(again.stdout, /restart result: none\n/);
    assert.deepEqual(box.calls().slice(before).filter((line) => /^ploinky (?:restart|var)|^podman (?:tag|image rm)/.test(line)), []);
    assert.equal(fs.readdirSync(path.join(box.ws, '.ploinky/.qa-private-copy')).join(), 'previous', 'no second copy');
    assert.equal(fs.readFileSync(path.join(box.ws, '.ploinky/.qa-private-copy/previous/bizanso/src/runtime.mjs'), 'utf8'), 'export default 1;\n');
});

// The second run of one Box: a fresh runner, the same source, and what the first run left behind.
function runBizansoFlowAgain(box) {
    fs.rmSync(path.join(box.runner), { recursive: true, force: true });
    fs.mkdirSync(box.runner, { recursive: true });
    fs.writeFileSync(box.githubEnv, '');
    return runBizansoFlow(box);
}

test('Bizanso flow: a change outside the sources restarts the whole workspace, and a no-op makes no mutation at all', (t) => {
    const box = bizansoBox(t, { source: { 'bizanso/mcp-config.json': '{"tools":["new"]}\n' } });
    const result = runBizansoFlow(box);
    assert.equal(result.status, 0, logOf(result));
    assert.match(result.stdout, /restart scope: whole \(bizanso\/mcp-config\.json differs\)\n/);
    assert.match(result.stdout, /restart result: whole\n/);
    assert.deepEqual(box.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart']);

    const same = bizansoBox(t, { liveImage: hex('b') });
    const noop = runBizansoFlow(same);
    assert.equal(noop.status, 0, logOf(noop));
    assert.match(noop.stdout, /restart scope: none/);
    noMutation(same, { pull: true });
    // The image is pulled by digest even then, and nothing but reads follow.
    assert.deepEqual(same.calls().filter((line) => line.startsWith('podman pull')), [`podman pull -q ${BIZ_REF}`]);
});

test('Bizanso flow: an image change alone restarts only bizanso/bizanso, and the container must run the new image', (t) => {
    const box = bizansoBox(t, { liveImage: hex('a') });
    box.hook('bizanso_bizanso', `printf '%s %s %s\\n' ${hex('d')} "$(date +%s)" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"`);
    box.hook('whole', `printf '%s %s %s\\n' ${hex('d')} "$(date +%s)" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"`);
    const result = runBizansoFlow(box);
    // Both restarts ran the wrong image, so the run fails after recovering once.
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`::error::The bizanso container runs image ${hex('d')}, not ${hex('b')}\\.`));
    assert.match(result.stdout, /::error::Post-mutation failure: Bizanso was copied and its image pulled, but the restart did not complete \(exit 1\)/);
    assert.deepEqual(box.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart bizanso/bizanso', 'ploinky restart']);
});

test('Bizanso flow: every refusal stops the run before any pull, copy, variable or restart', (t) => {
    const cases = {
        'status fails': { setup: (box) => fs.rmSync(path.join(box.stub, 'status.txt')), message: /::error::Status failed: this QA Box is not one the Ploinky-command workflows manage\..*deploy-explorer-qa-ploinky\.yml/ },
        'the Box is absent': { setup: (box) => box.write('status.txt', `Ploinky Box: absent\n${statusText()}`), message: /::error::There is no QA Box\./ },
        'a graph runtime is stopped': { setup: (box) => box.status({ dpuAgent: 'stopped' }), message: /::error::Runtime dpuAgent is not running.*deploy-explorer-qa-ploinky\.yml/ },
        'a graph runtime is missing': { setup: (box) => box.status({ bizanso: 'absent' }), message: /::error::Runtime bizanso is not running/ },
        'a product runtime is starting': { setup: (box) => box.status({ promotionScout: 'starting' }), message: /::error::Runtime promotionScout is not running/ },
        'bizanso is absent from the workspace root': { setup: (box) => fs.rmSync(path.join(box.ws, 'bizanso'), { recursive: true }), message: /::error::The product check failed: bizanso must be a real directory at the workspace root.*deploy-explorer-qa-ploinky\.yml installs it/ },
        'bizanso carries Git metadata': { setup: (box) => fs.mkdirSync(path.join(box.ws, 'bizanso/.git')), message: /::error::The product check failed/ },
        'bizanso is also managed': { setup: (box) => fs.mkdirSync(path.join(box.ws, '.ploinky/repos/bizanso'), { recursive: true }), message: /::error::The product check failed/ },
        'the live manifest is missing': { setup: (box) => fs.rmSync(path.join(box.ws, 'bizanso/bizanso/manifest.json')), message: /::error::The product check could not read bizanso\/manifest\.json/ },
        'no bizanso container runs': { setup: (box) => box.ps(BIZ_PREFIX, []), message: /::error::Expected exactly one bizanso container, found 0\.\n.*::error::The product check found no single running bizanso container/s },
        'two bizanso containers run': { setup: (box) => box.ps(BIZ_PREFIX, [`${hex('a')} 1 ${BIZ_PREFIX}one`, `${hex('a')} 2 ${BIZ_PREFIX}two`]), message: /Expected exactly one bizanso container, found 2\./ },
        'the routes are unhealthy': { setup: (box) => box.routes('503 200 200'), message: /::error::QA routes are not healthy before this run \(explorer=503 bizanso=200 scriptahub=200\)\. Nothing was changed\./ },
        'the Bizanso route is unhealthy': { setup: (box) => box.routes('303 502 200'), message: /::error::QA routes are not healthy before this run \(explorer=303 bizanso=502 scriptahub=200\)/ },
        'the disk is below the floor': { setup: (box) => box.freeGib(4), message: /::error::Free disk 4 GiB is below 5 GiB; no agent or repository moved yet\./ },
    };
    for (const [name, scenario] of Object.entries(cases)) {
        const box = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
        scenario.setup(box);
        const result = runBizansoFlow(box);
        assert.notEqual(result.status, 0, `${name}: ${logOf(result)}`);
        assert.match(result.stdout, scenario.message, name);
        noMutation(box);
        const live = path.join(box.ws, 'bizanso/bizanso/src/runtime.mjs');
        assert.notEqual(fs.existsSync(live) && fs.readFileSync(live, 'utf8'), 'export default 2;\n', `${name}: the live tree is untouched`);
    }
    // The routes get three tries before the refusal, and the second one may succeed.
    const flaky = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    flaky.routes('503 200 200', '303 200 200');
    const recovered = runBizansoFlow(flaky);
    assert.equal(recovered.status, 0, logOf(recovered));
    assert.match(recovered.stdout, /\[deploy-qa-product\] routes explorer=503 bizanso=200 scriptahub=200\n/);
});

test('Bizanso flow: a failed pull changes nothing, and a lock held on the restart ends the run with 75 and no fallback', (t) => {
    const failing = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    failing.write('pull-fail', '1');
    const refused = runBizansoFlow(failing);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /::error::Pulling docker\.io\/assistos\/bizanso-agent@sha256:1{64} inside the Box failed; nothing else was changed\./);
    assert.equal(fs.existsSync(path.join(failing.ws, '.ploinky/.qa-private-copy')), false);
    assert.deepEqual(failing.calls().filter((line) => /^ploinky (?:restart|var)/.test(line)), []);

    const busy = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    busy.write('flock-busy', 'restart bizanso/bizanso');
    const result = runBizansoFlow(busy);
    assert.equal(result.status, 75, logOf(result));
    assert.match(result.stdout, /::error::Another Explorer QA operation holds the host lock\./);
    assert.match(result.stdout, /::error::Post-mutation failure: Bizanso was copied and its image pulled, but the restart did not complete \(exit 75\)\. The previous copy is at \.ploinky\/\.qa-private-copy\/previous\./);
    assert.deepEqual(busy.calls().filter((line) => /^ploinky restart/.test(line)), []);
});

test('Bizanso flow: a refused drain ends the run with the accept command and no other restart', (t) => {
    const box = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    box.hook('bizanso_bizanso', `echo "${DRAIN_TEXT}"; exit 1`);
    writeJson(box, 'agents.json', AGENT_RECORDS);
    const result = runBizansoFlow(box);
    assert.equal(result.status, 1, logOf(result));
    assert.match(result.stdout, new RegExp(`ploinky restart bizanso/bizanso --accept-failed-drain ${AGENTS_JSON_ID}`));
    assert.deepEqual(box.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart bizanso/bizanso']);
    assert.equal(box.calls().some((line) => line.includes('--accept-failed-drain')), false);
});

test('Bizanso flow: the protected Soul Gateway and unrelated containers are compared before and after', (t) => {
    const soul = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    soul.hook('bizanso_bizanso', `touch "$STUB/soul-down"; printf '%s %s %s\\n' ${hex('b')} "$(date +%s)" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"`);
    const result = runBizansoFlow(soul);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::Protected Soul Gateway became unhealthy during the deployment\./);
    const unrelated = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    unrelated.write('ps-a', 'aaaa ploinky-box-explorerqaworkspace-7a31ab7775eb\nbbbb other-box\n');
    unrelated.hook('bizanso_bizanso', `echo "cccc another" >> "$STUB/ps-a"; printf '%s %s %s\\n' ${hex('b')} "$(date +%s)" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"`);
    const second = runBizansoFlow(unrelated);
    assert.notEqual(second.status, 0);
    assert.match(second.stdout, /::error::An unrelated host container changed during the deployment\./);
});

test('Bizanso copy program: an archive carrying Git metadata or nothing is refused and leaves the live copy in place', (t) => {
    const program = deployBody('bizanso').match(/^COPY_PROGRAM='([^']*)'$/m)[1];
    const box = bizansoBox(t);
    const before = fs.readFileSync(path.join(box.ws, 'bizanso/package.json'), 'utf8');
    const archive = (withGit) => {
        const source = fs.mkdtempSync(path.join(box.dir, 'archive-'));
        fs.writeFileSync(path.join(source, 'package.json'), '{"changed":true}\n');
        if (withGit) fs.mkdirSync(path.join(source, '.git'));
        return spawnSync('tar', ['-cf', '-', '-C', source, '.']).stdout;
    };
    const run = (input) => spawnSync(PROGRAM_SHELL, ['-c', program, 'sh'], { cwd: box.ws, input, encoding: 'utf8', env: box.env() });
    assert.notEqual(run(archive(true)).status, 0);
    assert.notEqual(run('').status, 0);
    assert.equal(fs.readFileSync(path.join(box.ws, 'bizanso/package.json'), 'utf8'), before);
    assert.equal(run(archive(false)).status, 0);
    assert.equal(fs.readFileSync(path.join(box.ws, 'bizanso/package.json'), 'utf8'), '{"changed":true}\n');
});

// ---------------------------------------------------------------------------------------------------------------
// ScriptaHub

const SCRIPTA_URL = 'https://github.com/Axiologic/ScriptaHubAgent.git';
const ROBOT_REPO = 'docker.io/assistos/scriptahub-robot';
const AGENT_REPO = 'docker.io/assistos/scriptahub-agent';
const ROBOTEAM_TAG = 'docker.io/assistos/roboteam-agent:runtime';
const PREFIX = {
    scripta: 'ploinky_ScriptaHubAgent_scriptahubAgent_',
    roboteam: 'ploinky_AchillesIDE_roboTeamAgent_',
    robowork: 'ploinky_AchillesIDE_roboWorkAgent_',
};
const refKey = (ref) => ref.replace(/[/:@]/g, '_');
const AGENT_ID = hex('e');
const ROBOT_ID = hex('f');
const OLD_ROBOTEAM_ID = hex('1');
const OLD_AGENT_ID = hex('2');
const scriptaFiles = (extra = {}) => ({
    'skills/a/SKILL.md': 'skill a\n',
    'scriptahubAgent/deployment/start.mjs': 'start\n',
    'scriptahubAgent/site/reader/reader.css': 'body {}\n',
    'README.md': 'one\n',
    ...extra,
});
const platformJson = (revision, other = revision) => JSON.stringify({
    'linux/amd64': { config: { Labels: { 'org.opencontainers.image.revision': revision } } },
    'linux/arm64': { config: { Labels: { 'org.opencontainers.image.revision': other } } },
});

// A source checkout on the runner with the image revision T and the head H, the QA checkout in the Box at `old`, and the
// registry, the local images and the containers the full update starts from.
function scriptaBox(t, options = {}) {
    const { headFiles = {}, image = 'ancestor', old = 'image', robotJson, agentJson, localRobot = false, robotRevisionPulled } = options;
    const box = makeBox(t);
    const source = path.join(box.github, '.qa-scriptahub-source');
    const base = commitTree(source, scriptaFiles(), 'image revision');
    let imageRevision = base;
    if (image === 'divergent') {
        vcs(source, 'checkout', '--quiet', '-b', 'other');
        imageRevision = commitTree(source, scriptaFiles({ 'README.md': 'other\n' }), 'other');
        vcs(source, 'checkout', '--quiet', 'main');
        for (const entry of fs.readdirSync(source)) if (entry !== '.git') fs.rmSync(path.join(source, entry), { recursive: true, force: true });
        writeTree(source, scriptaFiles());
    }
    if (image === 'unknown') imageRevision = 'a'.repeat(40);
    const head = image === 'head' ? base : commitTree(source, scriptaFiles({ 'README.md': 'two\n', ...headFiles }), 'head');
    if (image === 'head') imageRevision = head;
    const robotRaw = `robot-index ${Math.random()}`;
    const agentRaw = `agent-index ${Math.random()}`;
    const robotIndex = `sha256:${sha256(robotRaw)}`;
    const agentIndex = `sha256:${sha256(agentRaw)}`;
    box.write(`imagetools.raw.${refKey(`${ROBOT_REPO}:runtime`)}`, robotRaw);
    box.write(`imagetools.raw.${refKey(`${AGENT_REPO}:runtime`)}`, agentRaw);
    box.write(`imagetools.json.${refKey(`${ROBOT_REPO}@${robotIndex}`)}`, robotJson ?? platformJson(imageRevision));
    box.write(`imagetools.json.${refKey(`${AGENT_REPO}@${agentIndex}`)}`, agentJson ?? platformJson(base));
    box.registry([
        [`${AGENT_REPO}@${agentIndex}`, AGENT_ID, base, '-'],
        [`${ROBOT_REPO}@${robotIndex}`, ROBOT_ID, robotRevisionPulled ?? imageRevision, '-'],
    ]);
    box.images([
        [ROBOTEAM_TAG, OLD_ROBOTEAM_ID, 'x', '-'],
        ...(localRobot ? [[`${ROBOT_REPO}:runtime`, ROBOT_ID, imageRevision, `${ROBOT_REPO}@${robotIndex}`]] : []),
    ]);
    const clone = path.join(box.ws, 'ScriptaHubAgent');
    vcs(box.ws, 'clone', '--quiet', source, 'ScriptaHubAgent');
    vcs(clone, 'config', 'remote.origin.url', SCRIPTA_URL);
    vcs(clone, 'config', `url.${source}.insteadOf`, SCRIPTA_URL);
    vcs(clone, 'reset', '--quiet', '--hard', old === 'head' ? head : base);
    box.ps(PREFIX.scripta, [`${OLD_AGENT_ID} ${epoch() - 3600} ${PREFIX.scripta}abc`]);
    box.ps(PREFIX.roboteam, [`${OLD_ROBOTEAM_ID} ${epoch() - 3600} ${PREFIX.roboteam}abc`]);
    box.ps(PREFIX.robowork, [`${OLD_ROBOTEAM_ID} ${epoch() - 3600} ${PREFIX.robowork}abc`]);
    box.hook('whole', ['scripta', 'roboteam', 'robowork'].map((key) => `printf '%s %s %s\\n' ${key === 'scripta' ? AGENT_ID : ROBOT_ID} "$(date +%s)" ${PREFIX[key]}new > "$STUB/ps.${PREFIX[key]}"`).join('\n'));
    Object.assign(box, { source, clone, base, head, imageRevision, robotIndex, agentIndex });
    return box;
}
function resolveScripta(box) {
    const result = box.exec(stepScript(workflow('scriptahub'), 'Resolve the ScriptaHub source and the published images'));
    return { result, env: result.status === 0 ? exported(box) : {} };
}
function runScriptaFlow(box, extra = {}) {
    const { result: resolved, env } = resolveScripta(box);
    assert.equal(resolved.status, 0, logOf(resolved));
    return box.exec(flowScript(box, 'scriptahub'), { ...env, ...extra });
}
const scriptaRestartAgain = (box, extra = {}) => {
    fs.rmSync(box.runner, { recursive: true, force: true });
    fs.mkdirSync(box.runner, { recursive: true });
    fs.writeFileSync(box.githubEnv, '');
    return runScriptaFlow(box, extra);
};
const checkoutHead = (box) => vcs(box.clone, 'rev-parse', 'HEAD');
const noScriptaMutation = (box, before) => {
    assert.deepEqual(box.calls().filter((line) => /^podman (?:pull|tag|image rm)|^ploinky (?:restart|var)/.test(line)), []);
    assert.equal(checkoutHead(box), before, 'the QA checkout did not move');
};

test('ScriptaHub gate: the checkout moves only when the three copied paths equal those of the robot image revision', (t) => {
    const accepted = {
        'the image was built from the head': { image: 'head' },
        'only README.md changed after the image revision': {},
        'a path the image does not copy changed': { headFiles: { 'docs/notes.md': 'new\n' } },
    };
    for (const [name, options] of Object.entries(accepted)) {
        const box = scriptaBox(t, options);
        const { result, env } = resolveScripta(box);
        assert.equal(result.status, 0, `${name}: ${logOf(result)}`);
        assert.equal(env.SCRIPTA_HEAD, box.head, name);
        assert.equal(env.SCRIPTA_BRANCH, 'main', name);
        assert.equal(env.SCRIPTA_ROBOT_REVISION, box.imageRevision, name);
        assert.equal(env.SCRIPTA_ROBOT_INDEX, box.robotIndex, name);
        assert.equal(env.SCRIPTA_AGENT_INDEX, box.agentIndex, name);
        assert.equal(env.SCRIPTA_COPIED_TREES.split(' ').length, 3, name);
        assert.match(env.SCRIPTA_COPIED_TREES, /^[0-9a-f]{40}( [0-9a-f]{40}){2}$/, name);
        assert.equal(env.SCRIPTA_AGENT_REVISION, box.base, name);
    }
    const refused = {
        'skills changed after the image': { headFiles: { 'skills/a/SKILL.md': 'changed\n' }, path: 'skills' },
        'a new skill file': { headFiles: { 'skills/b/SKILL.md': 'new\n' }, path: 'skills' },
        'the deployment folder changed': { headFiles: { 'scriptahubAgent/deployment/start.mjs': 'changed\n' }, path: 'scriptahubAgent/deployment' },
        'the reader stylesheet changed': { headFiles: { 'scriptahubAgent/site/reader/reader.css': 'body { color: red }\n' }, path: 'scriptahubAgent/site/reader/reader.css' },
        'the image revision is not an ancestor of the head': { image: 'divergent', path: null, message: /is not an ancestor of main@/ },
        'the image revision is not in the history': { image: 'unknown', path: null, message: /is not in the ScriptaHubAgent history/ },
    };
    for (const [name, options] of Object.entries(refused)) {
        const box = scriptaBox(t, options);
        const { result } = resolveScripta(box);
        assert.notEqual(result.status, 0, name);
        const log = logOf(result);
        assert.match(log, options.message || new RegExp(`::error::${options.path.replace(/\//g, '\\/')} differs between main@[0-9a-f]{40} and the robot image revision [0-9a-f]{40}`), name);
        for (const word of ['images/scriptahub-agent/sources.lock.json', 'publish-scriptahub-robot-image.yml', 'publish-scriptahub-agent-image.yml', 'Nothing was changed']) {
            assert.ok(log.includes(word), `${name}: ${word}`);
        }
        assert.equal(box.calls().some((line) => /^(?:ploinky|podman)/.test(line)), false);
    }
});

test('ScriptaHub gate: malformed or inconsistent registry answers refuse the run, and the agent label is only informational', (t) => {
    const T = 'c'.repeat(40);
    const bad = {
        'a non-JSON answer': 'not json at all',
        'an empty answer': '',
        'a list instead of a platform map': '[]',
        'a missing arm64 platform': JSON.stringify({ 'linux/amd64': { config: { Labels: { 'org.opencontainers.image.revision': T } } } }),
        'differing amd64 and arm64 revisions': platformJson(T, 'd'.repeat(40)),
        'a short revision': platformJson('abc123'),
        'a revision with a shell expansion': platformJson('$(touch pwned)'.padEnd(40, 'a')),
        'no labels': JSON.stringify({ 'linux/amd64': { config: {} }, 'linux/arm64': { config: {} } }),
    };
    for (const [name, robotJson] of Object.entries(bad)) {
        const box = scriptaBox(t, { robotJson });
        const { result } = resolveScripta(box);
        assert.notEqual(result.status, 0, name);
        assert.match(logOf(result), /The robot image has no common 40-hex revision label|The robot image configuration could not be read/, name);
        assert.equal(fs.readFileSync(box.githubEnv, 'utf8'), '', `${name}: nothing exported`);
        assert.equal(fs.existsSync(path.join(box.github, 'pwned')), false);
    }
    // An index that cannot be read refuses too.
    const box = scriptaBox(t);
    fs.rmSync(path.join(box.stub, `imagetools.raw.${refKey(`${AGENT_REPO}:runtime`)}`));
    const { result } = resolveScripta(box);
    assert.notEqual(result.status, 0);
    assert.match(logOf(result), /The published ScriptaHub image indexes could not be read from the registry\. Nothing was changed\./);
    // The agent image's label never decides anything.
    for (const agentJson of ['garbage', platformJson('not-a-revision')]) {
        const tolerant = scriptaBox(t, { agentJson });
        const resolved = resolveScripta(tolerant);
        assert.equal(resolved.result.status, 0, logOf(resolved.result));
        assert.equal(resolved.env.SCRIPTA_AGENT_REVISION, 'unknown');
    }
});

const programOf = (key, name) => deployBody(key).match(new RegExp(`^${name}='([^']*)'$`, 'm'))[1];
const runProgram = (box, program, input = '') => spawnSync(PROGRAM_SHELL, ['-c', program, 'sh'], { cwd: box.ws, input, encoding: 'utf8', env: box.env() });

test('ScriptaHub read program: a wrong origin, a dirty tree, a symlinked .git or a detached head is refused, and a clean checkout prints its branch, head and copied trees', (t) => {
    const program = programOf('scriptahub', 'SCRIPTAHUB_READ_PROGRAM');
    const box = scriptaBox(t);
    const ok = runProgram(box, program);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^BRANCH=main\nHEAD=[0-9a-f]{40}\nCOPIED=[0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40}\n$/);
    assert.equal(ok.stdout.match(/HEAD=(\S+)/)[1], box.base);
    assert.equal(ok.stdout.match(/COPIED=(.*)/)[1], ['skills', 'scriptahubAgent/deployment', 'scriptahubAgent/site/reader/reader.css'].map((p) => vcs(box.clone, 'rev-parse', `HEAD:${p}`)).join(' '));

    const origin = scriptaBox(t);
    vcs(origin.clone, 'config', 'remote.origin.url', 'https://example.test/other.git');
    assert.notEqual(runProgram(origin, program).status, 0, 'another origin');
    const dirty = scriptaBox(t);
    fs.writeFileSync(path.join(dirty.clone, 'README.md'), 'edited\n');
    assert.notEqual(runProgram(dirty, program).status, 0, 'a modified file');
    const untracked = scriptaBox(t);
    fs.writeFileSync(path.join(untracked.clone, 'new.txt'), 'x\n');
    assert.notEqual(runProgram(untracked, program).status, 0, 'an untracked file');
    const linked = scriptaBox(t);
    fs.renameSync(path.join(linked.clone, '.git'), path.join(linked.dir, 'gitdir'));
    fs.symlinkSync(path.join(linked.dir, 'gitdir'), path.join(linked.clone, '.git'));
    assert.notEqual(runProgram(linked, program).status, 0, 'a symlinked .git');
    const managed = scriptaBox(t);
    fs.mkdirSync(path.join(managed.ws, '.ploinky/repos/ScriptaHubAgent'), { recursive: true });
    assert.notEqual(runProgram(managed, program).status, 0, 'also managed');
    const detached = scriptaBox(t);
    vcs(detached.clone, 'checkout', '--quiet', '--detach');
    assert.notEqual(runProgram(detached, program).status, 0, 'no branch');
    const symlinkedRoot = scriptaBox(t);
    fs.renameSync(symlinkedRoot.clone, path.join(symlinkedRoot.dir, 'elsewhere'));
    fs.symlinkSync(path.join(symlinkedRoot.dir, 'elsewhere'), symlinkedRoot.clone);
    assert.notEqual(runProgram(symlinkedRoot, program).status, 0, 'a symlinked checkout');
    assert.notEqual(runProgram(makeBox(t), program).status, 0, 'no checkout');
    // A hook or an fsmonitor the Box wrote into the checkout's Git configuration never runs.
    const hooked = scriptaBox(t);
    vcs(hooked.clone, 'config', 'core.fsmonitor', `touch ${path.join(hooked.dir, 'fsmonitor-ran')}; echo`);
    fs.mkdirSync(path.join(hooked.clone, '.git/hooks'), { recursive: true });
    fs.writeFileSync(path.join(hooked.clone, '.git/hooks/post-merge'), `#!/bin/sh\ntouch ${path.join(hooked.dir, 'hook-ran')}\n`, { mode: 0o755 });
    assert.equal(runProgram(hooked, program).status, 0);
    assert.equal(fs.existsSync(path.join(hooked.dir, 'fsmonitor-ran')), false);
});

test('ScriptaHub merge program: it fast-forwards to exactly the given commit, and otherwise leaves the checkout untouched', (t) => {
    const program = programOf('scriptahub', 'SCRIPTAHUB_MERGE_PROGRAM');
    const merge = (box, head, branch) => runProgram(box, program, `${head}\n${branch}\n`);
    // origin/main is ahead of the given commit: the checkout stops at the given commit.
    const ahead = scriptaBox(t);
    const newer = commitTree(ahead.source, scriptaFiles({ 'README.md': 'three\n' }), 'newer');
    const done = merge(ahead, ahead.head, 'main');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(checkoutHead(ahead), ahead.head);
    assert.notEqual(checkoutHead(ahead), newer);
    assert.equal(merge(ahead, ahead.head, 'main').status, 0, 'repeating it is a no-op');
    assert.equal(checkoutHead(ahead), ahead.head);

    // The given commit is not on origin's branch.
    const stray = scriptaBox(t);
    vcs(stray.source, 'checkout', '--quiet', '-b', 'feature');
    const strayHead = commitTree(stray.source, scriptaFiles({ 'README.md': 'stray\n' }), 'stray');
    const refused = merge(stray, strayHead, 'main');
    assert.notEqual(refused.status, 0);
    assert.equal(checkoutHead(stray), stray.base);
    // The checkout has a commit the given one lacks.
    const local = scriptaBox(t);
    vcs(local.clone, 'commit', '--quiet', '--allow-empty', '-m', 'local');
    const localHead = checkoutHead(local);
    const diverged = merge(local, local.head, 'main');
    assert.notEqual(diverged.status, 0);
    assert.equal(checkoutHead(local), localHead);
    // A dirty tree, another branch, another origin, or a commit git does not know.
    const dirty = scriptaBox(t);
    fs.writeFileSync(path.join(dirty.clone, 'README.md'), 'edited\n');
    assert.notEqual(merge(dirty, dirty.head, 'main').status, 0);
    assert.equal(checkoutHead(dirty), dirty.base);
    const other = scriptaBox(t);
    vcs(other.clone, 'checkout', '--quiet', '-b', 'work');
    assert.notEqual(merge(other, other.head, 'main').status, 0);
    const origin = scriptaBox(t);
    vcs(origin.clone, 'config', 'remote.origin.url', 'https://example.test/other.git');
    assert.notEqual(merge(origin, origin.head, 'main').status, 0);
    const unknown = scriptaBox(t);
    assert.notEqual(merge(unknown, 'e'.repeat(40), 'main').status, 0);
    assert.equal(checkoutHead(unknown), unknown.base);
    // Values that are not a commit and a branch name never reach Git.
    for (const [head, branch] of [['', 'main'], ['abc', 'main'], ['E'.repeat(40), 'main'], [`${'a'.repeat(39)};`, 'main'], ['a'.repeat(41), 'main'],
        ['a'.repeat(40), ''], ['a'.repeat(40), '-x'], ['a'.repeat(40), 'a..b'], ['a'.repeat(40), '$(touch pwned)'], ['a'.repeat(40), 'a;b'], ['a'.repeat(40), '/main'], ['a'.repeat(40), 'main.lock']]) {
        const box = scriptaBox(t);
        const result = merge(box, head, branch);
        assert.notEqual(result.status, 0, `${head} ${branch}`);
        assert.equal(checkoutHead(box), box.base);
        assert.equal(fs.existsSync(path.join(box.ws, 'pwned')), false);
    }
});

test('ScriptaHub pull and tag programs: only exact references by digest are pulled, and only a 64-hex ID is tagged', (t) => {
    const pull = programOf('scriptahub', 'SCRIPTAHUB_PULL_PROGRAM');
    const tag = programOf('scriptahub', 'SCRIPTAHUB_TAG_PROGRAM');
    const agent = `${AGENT_REPO}@sha256:${'1'.repeat(64)}`;
    const robot = `${ROBOT_REPO}@sha256:${'2'.repeat(64)}`;
    const box = makeBox(t);
    box.registry([[agent, AGENT_ID, 'ra', '-'], [robot, ROBOT_ID, 'rr', '-']]);
    box.images([[ROBOTEAM_TAG, OLD_ROBOTEAM_ID, 'x', '-']]);
    const good = runProgram(box, pull, `${agent}\n${robot}\n`);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, `AGENT_ID=${AGENT_ID}\nAGENT_REVISION=ra\nROBOT_ID=${ROBOT_ID}\nROBOT_REVISION=rr\nROBOTEAM_ID=${OLD_ROBOTEAM_ID}\n`);
    assert.deepEqual(box.calls(), [`podman pull -q ${agent}`, `podman pull -q ${robot}`, `podman tag ${agent} ${AGENT_REPO}:runtime`, `podman tag ${robot} ${ROBOT_REPO}:runtime`]);
    const refusals = [
        [`${AGENT_REPO}:runtime`, robot],
        [agent, `${ROBOT_REPO}:runtime`],
        [robot, agent],
        [`docker.io/other/scriptahub-agent@sha256:${'1'.repeat(64)}`, robot],
        [`${AGENT_REPO}@sha256:${'1'.repeat(63)}`, robot],
        [agent, `${ROBOT_REPO}@sha256:${'2'.repeat(65)}`],
        [`${AGENT_REPO}@sha256:${'1'.repeat(63)}G`, robot],
        [agent, `${ROBOT_REPO}@sha256:${'2'.repeat(63)};`],
        ['$(touch pwned)', robot],
        [agent, ''],
        ['', ''],
    ];
    for (const [first, second] of refusals) {
        const other = makeBox(t);
        const result = runProgram(other, pull, `${first}\n${second}\n`);
        assert.notEqual(result.status, 0, `${first} ${second}`);
        assert.deepEqual(other.calls(), [], `${first} ${second}`);
        assert.equal(fs.existsSync(path.join(other.ws, 'pwned')), false);
    }
    assert.notEqual(runProgram(makeBox(t), pull, `${agent}\n`).status, 0, 'one reference is not two');

    const tagged = makeBox(t);
    tagged.images([[`${ROBOT_REPO}:runtime`, ROBOT_ID, 'r', '-'], [ROBOTEAM_TAG, OLD_ROBOTEAM_ID, 'x', '-']]);
    assert.equal(runProgram(tagged, tag, `${ROBOT_ID}\n`).status, 0);
    assert.deepEqual(tagged.calls(), [`podman tag ${ROBOT_ID} ${ROBOTEAM_TAG}`]);
    for (const id of ['', 'abc', 'F'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), `${'f'.repeat(63)};`, '$(touch pwned)', `${ROBOT_ID} extra`]) {
        const other = makeBox(t);
        assert.notEqual(runProgram(other, tag, `${id}\n`).status, 0, id);
        assert.deepEqual(other.calls(), [], id);
    }
});

test('ScriptaHub flow: a source and image change moves the checkout, tags the robot image and restarts the whole workspace once', (t) => {
    const box = scriptaBox(t);
    const result = runScriptaFlow(box);
    assert.equal(result.status, 0, logOf(result));
    const env = exported(box);
    inOrder(result.stdout, [
        new RegExp(`\\[deploy-qa-scriptahub\\] main main@${box.head}; robot image revision ${box.imageRevision}; agent image revision ${box.base}; copied trees equal\\n`),
        new RegExp(`\\[deploy-qa-scriptahub\\] checkout ${box.base} -> ${box.head}\\n`),
        new RegExp(`\\[deploy-qa-scriptahub\\] agent image ${AGENT_ID}; robot image ${ROBOT_ID}; roboteam-agent:runtime before ${OLD_ROBOTEAM_ID}\\n`),
        /\[deploy-qa-scriptahub\] restart result: whole\n/,
        new RegExp(`\\[deploy-qa-scriptahub\\] container ${PREFIX.scripta}new image ${AGENT_ID} started \\d+\\n`),
        new RegExp(`\\[deploy-qa-scriptahub\\] container ${PREFIX.roboteam}new image ${ROBOT_ID} started \\d+\\n`),
        new RegExp(`\\[deploy-qa-scriptahub\\] container ${PREFIX.robowork}new image ${ROBOT_ID} started \\d+\\n`),
        /\[deploy-qa\] free disk after prune: 20 GiB\n/,
    ]);
    assert.equal(env.SCRIPTA_HEAD, box.head);
    assert.equal(checkoutHead(box), box.head);
    const mutations = box.calls().filter((line) => /^podman (?:pull|tag)|^ploinky (?:restart|var|update|enable|add|start)/.test(line));
    assert.deepEqual(mutations, [
        `podman pull -q ${AGENT_REPO}@${box.agentIndex}`,
        `podman pull -q ${ROBOT_REPO}@${box.robotIndex}`,
        `podman tag ${AGENT_REPO}@${box.agentIndex} ${AGENT_REPO}:runtime`,
        `podman tag ${ROBOT_REPO}@${box.robotIndex} ${ROBOT_REPO}:runtime`,
        `podman tag ${ROBOT_ID} ${ROBOTEAM_TAG}`,
        'ploinky restart',
    ]);
    assert.equal(box.calls().some((line) => line.startsWith('ploinky var')), false, 'ScriptaHub sets no value');
    // The Box held the previous images only by tag; the tag now names the new robot image.
    assert.match(fs.readFileSync(path.join(box.stub, 'images'), 'utf8'), new RegExp(`^${ROBOTEAM_TAG.replace(/[.]/g, '\\.')} ${ROBOT_ID} `, 'm'));

    // A second run finds the checkout at the head, the images equal and the containers on them: nothing at all.
    const before = box.calls().length;
    const again = scriptaRestartAgain(box);
    assert.equal(again.status, 0, logOf(again));
    assert.match(again.stdout, new RegExp(`checkout ${box.head} -> ${box.head}\\n`));
    assert.match(again.stdout, /restart result: none\n/);
    assert.doesNotMatch(again.stdout, /\[deploy-qa-scriptahub\] container /);
    assert.deepEqual(box.calls().slice(before).filter((line) => /^podman tag .*roboteam-agent|^podman image rm|^ploinky (?:restart|var)/.test(line)), []);
    assert.equal(checkoutHead(box), box.head);
});

test('ScriptaHub flow: equal heads and image IDs make no restart, and a robot image running anywhere else does', (t) => {
    const noop = scriptaBox(t, { old: 'head', localRobot: true });
    noop.images([[ROBOTEAM_TAG, ROBOT_ID, 'x', '-'], [`${ROBOT_REPO}:runtime`, ROBOT_ID, noop.imageRevision, `${ROBOT_REPO}@${noop.robotIndex}`]]);
    for (const key of ['roboteam', 'robowork']) noop.ps(PREFIX[key], [`${ROBOT_ID} ${epoch() - 3600} ${PREFIX[key]}abc`]);
    noop.ps(PREFIX.scripta, [`${AGENT_ID} ${epoch() - 3600} ${PREFIX.scripta}abc`]);
    const result = runScriptaFlow(noop);
    assert.equal(result.status, 0, logOf(result));
    assert.match(result.stdout, /restart result: none\n/);
    assert.deepEqual(noop.calls().filter((line) => /^podman tag .*roboteam-agent|^podman image rm|^ploinky (?:restart|var)/.test(line)), []);
    assert.equal(checkoutHead(noop), noop.head);

    // The tag already names the robot image, but RoboTeam still runs another one: whole restart, not a no-op.
    for (const [name, mutate] of Object.entries({
        'RoboTeam runs another image': (box) => box.ps(PREFIX.roboteam, [`${hex('9')} ${epoch() - 3600} ${PREFIX.roboteam}abc`]),
        'RoboWork runs another image': (box) => box.ps(PREFIX.robowork, [`${hex('9')} ${epoch() - 3600} ${PREFIX.robowork}abc`]),
        'the agent runs another image': (box) => box.ps(PREFIX.scripta, [`${hex('9')} ${epoch() - 3600} ${PREFIX.scripta}abc`]),
    })) {
        const box = scriptaBox(t, { old: 'head' });
        box.images([[ROBOTEAM_TAG, ROBOT_ID, 'x', '-']]);
        box.ps(PREFIX.scripta, [`${AGENT_ID} ${epoch() - 3600} ${PREFIX.scripta}abc`]);
        for (const key of ['roboteam', 'robowork']) box.ps(PREFIX[key], [`${ROBOT_ID} ${epoch() - 3600} ${PREFIX[key]}abc`]);
        mutate(box);
        const run = runScriptaFlow(box);
        assert.equal(run.status, 0, `${name}: ${logOf(run)}`);
        assert.match(run.stdout, /restart result: whole\n/, name);
        assert.deepEqual(box.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart'], name);
    }
});

test('ScriptaHub flow: the disk gate asks for 5 GiB when the Box holds the published index and 16 GiB otherwise, and fails safe', (t) => {
    const attempt = (gib, options) => {
        const box = scriptaBox(t, options);
        box.freeGib(gib);
        return { box, result: runScriptaFlow(box) };
    };
    const held = attempt(6, { localRobot: true });
    assert.equal(held.result.status, 0, logOf(held.result));
    assert.match(held.result.stdout, /restart result: whole/);

    const missing = attempt(15, { localRobot: false });
    assert.notEqual(missing.result.status, 0);
    assert.match(missing.result.stdout, /::error::Free disk 15 GiB is below the 16 GiB this run needs; nothing moved\. The previous ScriptaHub agent image is freed only by a restart: dispatch deploy-explorer-qa-ploinky\.yml, which restarts before it pulls the robot image\./);
    noScriptaMutation(missing.box, missing.box.base);

    // Exactly 16 GiB passes; 15.99 GiB is 15 and does not.
    assert.equal(attempt(16, {}).result.status, 0);
    const just = attempt(15.99, {});
    assert.notEqual(just.result.status, 0);
    assert.match(just.result.stdout, /Free disk 15 GiB is below the 16 GiB/);

    // Another local robot image, or an inspect that fails, is "not held".
    const otherDigest = scriptaBox(t, {});
    otherDigest.images([[ROBOTEAM_TAG, OLD_ROBOTEAM_ID, 'x', '-'], [`${ROBOT_REPO}:runtime`, hex('9'), 'r', `${ROBOT_REPO}@sha256:${'9'.repeat(64)}`]]);
    otherDigest.freeGib(15);
    const stale = runScriptaFlow(otherDigest);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout, /below the 16 GiB/);
    noScriptaMutation(otherDigest, otherDigest.base);

    // The floor of the full deploy still applies first.
    const low = attempt(4, { localRobot: true });
    assert.notEqual(low.result.status, 0);
    assert.match(low.result.stdout, /::error::Free disk 4 GiB is below 5 GiB; no agent or repository moved yet\./);
    noScriptaMutation(low.box, low.box.base);
});

test('ScriptaHub flow: every refusal stops the run before the first pull, tag, merge or restart', (t) => {
    const cases = {
        'status fails': { setup: (box) => fs.rmSync(path.join(box.stub, 'status.txt')), message: /::error::Status failed/ },
        'the Box is absent': { setup: (box) => box.write('status.txt', `Ploinky Box: absent\n${statusText()}`), message: /::error::There is no QA Box\./ },
        'a runtime is stopped': { setup: (box) => box.status({ scriptahubAgent: 'stopped' }), message: /::error::Runtime scriptahubAgent is not running.*deploy-explorer-qa-ploinky\.yml/ },
        'a runtime is missing': { setup: (box) => box.status({ roboTeamAgent: 'absent' }), message: /::error::Runtime roboTeamAgent is not running/ },
        'ScriptaHub is not installed at the workspace root': { setup: (box) => fs.rmSync(box.clone, { recursive: true, force: true }), message: /::error::The product check failed: ScriptaHubAgent must be a clean checkout/ },
        'the QA checkout has an edit': { setup: (box) => fs.writeFileSync(path.join(box.clone, 'README.md'), 'edited\n'), message: /::error::The product check failed/ },
        'the QA checkout has another origin': { setup: (box) => vcs(box.clone, 'config', 'remote.origin.url', 'https://example.test/x.git'), message: /::error::The product check failed/ },
        'the QA checkout is on another branch': { setup: (box) => vcs(box.clone, 'checkout', '--quiet', '-b', 'work'), message: /::error::The product check found the QA checkout on 'work'/ },
        'the QA checkout is at a known commit main does not contain': {
            setup: (box) => {
                vcs(box.source, 'checkout', '--quiet', '-b', 'side', box.base);
                vcs(box.source, 'commit', '--quiet', '--allow-empty', '-m', 'side');
                vcs(box.source, 'checkout', '--quiet', 'main');
                vcs(box.clone, 'fetch', '--quiet', 'origin', 'side');
                vcs(box.clone, 'reset', '--quiet', '--hard', 'FETCH_HEAD');
            },
            message: /QA checkout has commits main lacks\)\. Nothing was changed\./,
        },
        'the QA checkout commit is absent from the runner history': { setup: (box) => vcs(box.clone, 'commit', '--quiet', '--allow-empty', '-m', 'local'), message: /QA checkout has commits main lacks\)\. Nothing was changed\./ },
        'no agent container runs': { setup: (box) => box.ps(PREFIX.scripta, []), message: /Expected exactly one scripta container, found 0\.\n.*::error::The product check found no single running scripta container/s },
        'two RoboTeam containers run': { setup: (box) => box.ps(PREFIX.roboteam, [`${hex('1')} 1 a`, `${hex('1')} 2 b`]), message: /Expected exactly one roboteam container, found 2\./ },
        'no RoboWork container runs': { setup: (box) => box.ps(PREFIX.robowork, []), message: /Expected exactly one robowork container, found 0\./ },
        'the routes are unhealthy': { setup: (box) => box.routes('303 200 503'), message: /::error::QA routes are not healthy before this run \(explorer=303 bizanso=200 scriptahub=503\)/ },
    };
    for (const [name, scenario] of Object.entries(cases)) {
        const box = scriptaBox(t);
        scenario.setup(box);
        const before = fs.existsSync(box.clone) ? checkoutHead(box) : null;
        const result = runScriptaFlow(box);
        assert.notEqual(result.status, 0, `${name}: ${logOf(result)}`);
        assert.match(logOf(result), scenario.message, name);
        assert.deepEqual(box.calls().filter((line) => /^podman (?:pull|tag|image rm)|^ploinky (?:restart|var)/.test(line)), [], name);
        if (before !== null) assert.equal(checkoutHead(box), before, `${name}: the QA checkout did not move`);
    }
});

test('ScriptaHub flow: a moved tag, a corrupted checkout or a lock held stop the run with what is left changed', (t) => {
    const moved = scriptaBox(t, { robotRevisionPulled: 'b'.repeat(40) });
    const tagMoved = runScriptaFlow(moved);
    assert.notEqual(tagMoved.status, 0);
    assert.match(tagMoved.stdout, /::error::The pulled robot image carries revision 'b{40}', not [0-9a-f]{40}, so the published tag moved during this run\. The images were pulled and the :runtime tags of docker\.io\/assistos\/scriptahub-agent and docker\.io\/assistos\/scriptahub-robot now name the pulled images; the checkout and the agents were not changed\./);
    assert.equal(checkoutHead(moved), moved.base);
    assert.deepEqual(moved.calls().filter((line) => /^podman tag.*roboteam|^ploinky restart/.test(line)), []);

    const corrupted = scriptaBox(t);
    const bad = runScriptaFlow(corrupted, { SCRIPTA_COPIED_TREES: `${'1'.repeat(40)} ${'2'.repeat(40)} ${'3'.repeat(40)}` });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /::error::Post-mutation failure: the ScriptaHub checkout moved to [0-9a-f]{40}, but its copied trees .* are not the ones the robot image was built from .* The images were pulled and the :runtime tags of docker\.io\/assistos\/scriptahub-agent and docker\.io\/assistos\/scriptahub-robot now name the pulled images\. roboteam-agent:runtime was not retagged and nothing was restarted; the checkout is left moved\./);
    assert.equal(checkoutHead(corrupted), corrupted.head);
    assert.deepEqual(corrupted.calls().filter((line) => line.includes(ROBOTEAM_TAG) || /^ploinky restart/.test(line)), []);

    const busy = scriptaBox(t);
    busy.write('flock-busy', 'ploinky restart');
    const locked = runScriptaFlow(busy);
    assert.equal(locked.status, 75, logOf(locked));
    assert.match(locked.stdout, /::error::Another Explorer QA operation holds the host lock\./);
    assert.match(locked.stdout, /::error::Post-mutation failure: the ScriptaHub checkout is at [0-9a-f]{40} and the images are pulled and tagged \(the :runtime tags of .*\), but the whole-workspace restart did not complete \(exit 75\)\./);
    assert.deepEqual(busy.calls().filter((line) => /^ploinky restart/.test(line)), []);

    // A container that does not reach the new image fails the check, and the failure names the whole restart.
    const stuck = scriptaBox(t);
    stuck.hook('whole', 'exit 0');
    const result = runScriptaFlow(stuck);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`::error::The ScriptaHub agent container runs image ${OLD_AGENT_ID}, not ${AGENT_ID}\\.`));
    assert.match(result.stdout, /::error::ScriptaHubAgent\/scriptahubAgent is not ready after a whole-workspace restart \(exit 0\)\. Recover with deploy-explorer-qa-ploinky\.yml\./);
    assert.deepEqual(stuck.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart']);
});

test('ScriptaHub flow: a whole restart that stops on a refused drain ends with the accept command and no further restart', (t) => {
    const box = scriptaBox(t);
    box.hook('whole', `echo "[start] ScriptaHubAgent/scriptahubAgent: keeping its stopped runtime after a refused targeted drain instead of replacing it; it stays unavailable"; exit 1`);
    writeJson(box, 'agents.json', { x: { type: 'agent', agentName: 'scriptahubAgent', repoName: 'ScriptaHubAgent', containerId: AGENTS_JSON_ID } });
    const result = runScriptaFlow(box);
    assert.equal(result.status, 1, logOf(result));
    assert.match(result.stdout, new RegExp(`ploinky restart ScriptaHubAgent/scriptahubAgent --accept-failed-drain ${AGENTS_JSON_ID}`));
    assert.deepEqual(box.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart']);
    assert.equal(box.calls().some((line) => line.includes('--accept-failed-drain')), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Validation, preflight and the final route check

const FINGERPRINT = 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA';
test('validation: a missing secret, an unpinned target or a host key with another fingerprint stops the run before anything else', (t) => {
    const keys = { bizanso: ['SSH_KEY', 'BIZANSO_DEPLOY_KEY'], scriptahub: ['SSH_KEY'] };
    for (const key of KEYS) {
        const script = stepScript(workflow(key), 'Validate GitHub configuration');
        const box = makeBox(t);
        fs.writeFileSync(path.join(box.bin, 'ssh-keyscan'), '#!/bin/bash\necho "$SSH_HOST ssh-ed25519 AAAA"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(box.bin, 'ssh-keygen'), `#!/bin/bash\necho "256 \${FAKE_FINGERPRINT} $SSH_HOST (ED25519)"\n`, { mode: 0o755 });
        const env = { SSH_KEY: 'k', BIZANSO_DEPLOY_KEY: 'k', FAKE_FINGERPRINT: FINGERPRINT, SSH_ED25519_FINGERPRINT: FINGERPRINT };
        const good = box.exec(script, env);
        assert.equal(good.status, 0, logOf(good));
        assert.match(good.stdout, /Validated the pinned Explorer QA SSH host identity\./);
        for (const name of keys[key]) {
            const missing = box.exec(script, { ...env, [name]: '' });
            assert.notEqual(missing.status, 0, name);
            assert.match(missing.stdout, name === 'SSH_KEY' ? /::error::Missing required repository secret EXPLORER_QA_SSH_KEY/ : /::error::Missing required repository secret EXPLORER_QA_BIZANSO_DEPLOY_KEY/);
        }
        for (const change of [{ SSH_HOST: '203.0.113.9' }, { SSH_USER: 'root' }, { WORKSPACE: 'soulGateway' }, { ROUTER_PORT: '8080' }]) {
            const result = box.exec(script, { ...env, ...change });
            assert.notEqual(result.status, 0, JSON.stringify(change));
            assert.match(result.stdout, /::error::Explorer QA target identity is not the pinned admin@45\.136\.70\.141\/explorerQaWorkspace target/);
        }
        const url = box.exec(script, { ...env, PUBLIC_URL: 'https://example.test' });
        assert.notEqual(url.status, 0);
        assert.match(url.stdout, /::error::PUBLIC_URL and PUBLIC_HOST must identify the fixed Explorer QA hostname/);
        const mismatch = box.exec(script, { ...env, FAKE_FINGERPRINT: 'SHA256:other' });
        assert.notEqual(mismatch.status, 0);
        assert.match(mismatch.stdout, /::error::Explorer QA ED25519 host fingerprint did not match the pinned identity/);
    }
});

test('preflight: it checks the host and reads the Ploinky checkout without creating or moving anything', (t) => {
    for (const key of KEYS) {
        const body = deployBody(key);
        const remote = body.split("<<'REMOTE'")[1].split('\nREMOTE\n')[0].replace(/^[^\n]*\n/, '');
        const nodeBlock = block(workflow(key), 'node').split('\n').map((line) => line.slice(10)).join('\n');
        assert.ok(remote.includes(nodeBlock));
        const run = (setup = () => {}) => {
            const box = makeBox(t);
            const home = path.join(box.dir, 'home/admin');
            const tools = path.join(home, '.qa-deployment-tools');
            const checkout = path.join(tools, 'ploinky');
            fs.mkdirSync(path.join(home, 'explorerQaWorkspace'), { recursive: true });
            fs.mkdirSync(checkout, { recursive: true });
            vcs(checkout, 'init', '--quiet');
            vcs(checkout, 'remote', 'add', 'origin', 'https://github.com/AssistOS-AI/ploinky.git');
            vcs(checkout, 'commit', '--quiet', '--allow-empty', '-m', 'ploinky');
            fs.writeFileSync(path.join(box.bin, 'id'), '#!/bin/bash\necho admin\n', { mode: 0o755 });
            setup({ box, home, tools, checkout });
            // The pinned Node install downloads from the network; here it is replaced by its result.
            const script = remote.replace(nodeBlock, 'QA_NODE_HOME=NODE_HOME_PLACEHOLDER').replaceAll('/home/admin', home).replace('NODE_HOME_PLACEHOLDER', `${tools}/node-v24.19.0-linux-x64`);
            const head = () => (fs.existsSync(path.join(checkout, '.git')) ? vcs(checkout, 'rev-parse', 'HEAD') : null);
            const before = head();
            const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: box.env({ HOME: home }) });
            return { result, box, home, checkout, before, after: head };
        };
        const ok = run();
        assert.equal(ok.result.status, 0, `${key} ${ok.result.signal} ${ok.result.error} ${logOf(ok.result)}`);
        assert.match(ok.result.stdout, new RegExp(`^PLOINKY_COMMIT=${ok.before.slice(0, 7)}\\nQA_NODE_HOME=.*node-v24\\.19\\.0-linux-x64\\n$`));
        assert.equal(ok.after(), ok.before);
        const refusals = {
            'the workspace is missing': [({ home }) => fs.rmSync(path.join(home, 'explorerQaWorkspace'), { recursive: true }), /the workspace is not an existing real directory/],
            'the workspace is a symlink': [({ home }) => { fs.rmSync(path.join(home, 'explorerQaWorkspace'), { recursive: true }); fs.mkdirSync(path.join(home, 'elsewhere')); fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'explorerQaWorkspace')); }, /the workspace is not an existing real directory/],
            'the older workflows parked state': [({ home }) => { fs.mkdirSync(path.join(home, '.qa-deployment-state')); fs.writeFileSync(path.join(home, '.qa-deployment-state/policy'), 'x'); }, /holds state from deploy-explorer-qa\.yml/],
            'the Ploinky checkout is missing': [({ checkout }) => fs.rmSync(checkout, { recursive: true }), /the Ploinky checkout is missing or a symlink/],
            'the Ploinky checkout is a symlink': [({ checkout, tools }) => { fs.renameSync(checkout, path.join(tools, 'real')); fs.symlinkSync(path.join(tools, 'real'), checkout); }, /the Ploinky checkout is missing or a symlink/],
            'the Ploinky checkout has another origin': [({ checkout }) => vcs(checkout, 'remote', 'set-url', 'origin', 'https://example.test/x.git'), /unexpected Ploinky checkout origin/],
            'the identity is not admin': [({ box }) => fs.writeFileSync(path.join(box.bin, 'id'), '#!/bin/bash\necho root\n', { mode: 0o755 }), /the remote identity is not the pinned admin account/],
        };
        for (const [name, [setup, message]] of Object.entries(refusals)) {
            const refused = run(setup);
            assert.notEqual(refused.result.status, 0, `${key}: ${name}`);
            assert.match(refused.result.stdout, message, `${key}: ${name}`);
            assert.equal(refused.after(), refused.before);
        }
        // Nothing is created: the workspace is not made, the checkout is not cloned.
        const missing = run(({ home, checkout }) => { fs.rmSync(path.join(home, 'explorerQaWorkspace'), { recursive: true }); fs.rmSync(checkout, { recursive: true }); });
        assert.equal(fs.existsSync(path.join(missing.home, 'explorerQaWorkspace')), false);
        assert.equal(fs.existsSync(missing.checkout), false);
    }
});

test('the final route check passes on three healthy paths and fails after 60 tries when one is not', (t) => {
    for (const key of KEYS) {
        const script = stepScript(workflow(key), 'Verify the QA routes');
        const healthy = makeBox(t);
        const ok = healthy.exec(script);
        assert.equal(ok.status, 0, logOf(ok));
        assert.match(ok.stdout, /The Explorer login, Bizanso and ScriptaHub answer through the public edge\./);
        for (const plan of ['200:EDGE_GENERATION_INACTIVE 200 200', '303 200 503']) {
            const box = makeBox(t);
            box.routes(plan);
            const failed = box.exec(script);
            assert.notEqual(failed.status, 0, plan);
            assert.match(failed.stdout, /::error::The QA routes did not answer; last HTTP codes explorer=/);
            assert.equal(fs.readFileSync(path.join(box.stub, 'poll.n'), 'utf8').trim(), '60');
        }
    }
});

test('restart_product: a product missing from the runtime block never settles', (t) => {
    const box = makeBox(t);
    box.status({ scriptahubAgent: 'absent' });
    const result = box.exec(restartScript(box, 'scriptahub', { mode: 'whole' }));
    assert.deepEqual(outcome(result), { status: 1, result: 'failed' });
    assert.equal(box.calls().filter((line) => line === 'ploinky status').length, 3);
});

test('restart_product: only a drain line that names the product counts in a whole restart, and Box-written values are printed sanitized', (t) => {
    const box = makeBox(t);
    box.status({ scriptahubAgent: 'stopped' });
    box.hook('whole', `echo "[start] demo/worker: keeping its stopped runtime after a refused targeted drain instead of replacing it"; echo "${DRAIN_TEXT}"; exit 1`);
    writeJson(box, 'agents.json', { x: { type: 'agent', agentName: 'scriptahubAgent', repoName: 'ScriptaHubAgent', containerId: AGENTS_JSON_ID } });
    const result = box.exec(restartScript(box, 'scriptahub', { mode: 'whole' }));
    assert.deepEqual(outcome(result), { status: 1, result: 'failed' });
    assert.match(result.stdout, /::error::ScriptaHubAgent\/scriptahubAgent is not ready after a whole-workspace restart \(exit 1\)\. Recover with deploy-explorer-qa-ploinky\.yml\./);
    assert.doesNotMatch(result.stdout, /::error::The targeted drain/);

    const named = makeBox(t);
    named.status({ scriptahubAgent: 'stopped' });
    named.hook('whole', 'echo "[start] ScriptaHubAgent/scriptahubAgent: keeping its stopped runtime after a refused targeted drain instead of replacing it"; exit 1');
    writeJson(named, 'agents.json', { x: { type: 'agent', agentName: 'scriptahubAgent', repoName: 'ScriptaHubAgent', containerId: AGENTS_JSON_ID } });
    const refused = named.exec(restartScript(named, 'scriptahub', { mode: 'whole' }));
    assert.match(refused.stdout, new RegExp(`--accept-failed-drain ${AGENTS_JSON_ID}$`, 'm'));

    const weird = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    const up = `printf '%s %s %s\\n' ${hex('b')} "$(date +%s)" 'ploinky_bizanso_bizanso_a;b$(x)' > "$STUB/ps.${BIZ_PREFIX}"`;
    weird.hook('bizanso_bizanso', up);
    const flow = runBizansoFlow(weird);
    assert.equal(flow.status, 0, logOf(flow));
    assert.match(flow.stdout, /container ploinky_bizanso_bizanso_a\?b\?\?x\? image b{64} started \d+ >= copy \d+\n/);
});

test('a container that runs the new image but started before the copy or the update fails the product check', (t) => {
    // Bizanso: the targeted restart leaves a container that started an hour ago; the whole restart repairs it.
    const biz = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
    biz.hook('bizanso_bizanso', `printf '%s %s %s\\n' ${hex('b')} "$(( $(date +%s) - 3600 ))" ${BIZ_PREFIX}old > "$STUB/ps.${BIZ_PREFIX}"`);
    const result = runBizansoFlow(biz);
    assert.equal(result.status, 0, logOf(result));
    assert.match(result.stdout, /::error::The bizanso container started at \d+, before the copy at \d+\./);
    assert.match(result.stdout, /restart result: whole-after-targeted\n/);
    assert.deepEqual(biz.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart bizanso/bizanso', 'ploinky restart']);

    // A start 2 s before the copy is within the 5 s of clock skew that is tolerated; 40 s before it is not.
    const edge = (seconds) => {
        const box = bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } });
        box.hook('bizanso_bizanso', `printf '%s %s %s\\n' ${hex('b')} "$(( $(date +%s) - ${seconds} ))" ${BIZ_PREFIX}new > "$STUB/ps.${BIZ_PREFIX}"`);
        return runBizansoFlow(box);
    };
    assert.match(edge(2).stdout, /restart result: targeted\n/);
    assert.match(edge(40).stdout, /::error::The bizanso container started at/);

    // ScriptaHub: the agent runs the new image, but it started before the update, so the whole restart did not recreate it.
    const scripta = scriptaBox(t);
    scripta.hook('whole', ['scripta', 'roboteam', 'robowork'].map((key) => `printf '%s %s %s\\n' ${key === 'scripta' ? AGENT_ID : ROBOT_ID} "$(( $(date +%s) - 3600 ))" ${PREFIX[key]}old > "$STUB/ps.${PREFIX[key]}"`).join('\n'));
    const stale = runScriptaFlow(scripta);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout, /::error::The ScriptaHub agent started at \d+, before the update at \d+\./);
    assert.deepEqual(scripta.calls().filter((line) => /^ploinky restart/.test(line)), ['ploinky restart']);

    // And a RoboWork container still on the old robot image fails it too.
    const robowork = scriptaBox(t);
    robowork.hook('whole', ['scripta', 'roboteam'].map((key) => `printf '%s %s %s\\n' ${key === 'scripta' ? AGENT_ID : ROBOT_ID} "$(date +%s)" ${PREFIX[key]}new > "$STUB/ps.${PREFIX[key]}"`).join('\n'));
    const old = runScriptaFlow(robowork);
    assert.notEqual(old.status, 0);
    assert.match(old.stdout, new RegExp(`::error::The robowork container runs image ${OLD_ROBOTEAM_ID}, not the robot image ${ROBOT_ID}\\.`));
});

test('ScriptaHub flow: a checkout that cannot be fast-forwarded, or a robot image that cannot be tagged, stops the run and names what was left changed', (t) => {
    const moves = 'the :runtime tags of docker\\.io\\/assistos\\/scriptahub-agent and docker\\.io\\/assistos\\/scriptahub-robot now name the pulled images';
    // The fetch of the move fails after every refusal passed.
    const fetchFails = scriptaBox(t);
    vcs(fetchFails.clone, 'config', `url.${path.join(fetchFails.dir, 'nowhere')}.insteadOf`, SCRIPTA_URL);
    vcs(fetchFails.clone, 'config', '--unset', `url.${fetchFails.source}.insteadOf`);
    const first = runScriptaFlow(fetchFails);
    assert.notEqual(first.status, 0, logOf(first));
    assert.match(first.stdout, new RegExp(`::error::Post-mutation failure: the images were pulled and ${moves}, but the ScriptaHub checkout could not be fast-forwarded to [0-9a-f]{40} \\(it stays at ${fetchFails.base} unless Git moved it\\)\\. roboteam-agent:runtime was not retagged and nothing was restarted\\.`));
    assert.equal(checkoutHead(fetchFails), fetchFails.base);
    assert.deepEqual(fetchFails.calls().filter((line) => line.includes(ROBOTEAM_TAG) || /^ploinky restart/.test(line)), []);

    // The retag fails after the checkout moved.
    const tagFails = scriptaBox(t);
    tagFails.write('tag-fail', '1');
    const second = runScriptaFlow(tagFails);
    assert.notEqual(second.status, 0);
    assert.match(second.stdout, new RegExp(`::error::Post-mutation failure: the ScriptaHub checkout is at ${tagFails.head}, but the robot image could not be tagged as roboteam-agent:runtime \\(${moves}\\)\\. Nothing was restarted\\.`));
    assert.equal(checkoutHead(tagFails), tagFails.head);
    assert.deepEqual(tagFails.calls().filter((line) => /^ploinky restart/.test(line)), []);
});

test('ScriptaHub resolve: nothing but regex-checked values reaches GITHUB_ENV, and a hostile agent label becomes unknown', (t) => {
    const injected = `${'a'.repeat(40)}\nSCRIPTA_ROBOT_INDEX=sha256:${'0'.repeat(64)}\nSCRIPTA_HEAD=${'0'.repeat(40)}`;
    for (const label of [injected, `${'a'.repeat(40)}\n`, 'x'.repeat(41), `${'A'.repeat(40)}`, '']) {
        const box = scriptaBox(t, { agentJson: platformJson(label) });
        const { result, env } = resolveScripta(box);
        assert.equal(result.status, 0, logOf(result));
        assert.equal(env.SCRIPTA_AGENT_REVISION, 'unknown', JSON.stringify(label));
        const lines = fs.readFileSync(box.githubEnv, 'utf8').split('\n').filter(Boolean);
        assert.deepEqual(lines.map((line) => line.split('=')[0]), ['SCRIPTA_HEAD', 'SCRIPTA_BRANCH', 'SCRIPTA_ROBOT_REVISION', 'SCRIPTA_ROBOT_INDEX', 'SCRIPTA_AGENT_INDEX', 'SCRIPTA_COPIED_TREES', 'SCRIPTA_AGENT_REVISION']);
        assert.equal(env.SCRIPTA_ROBOT_INDEX, box.robotIndex);
        assert.equal(env.SCRIPTA_HEAD, box.head);
    }
    const good = scriptaBox(t);
    const resolved = resolveScripta(good);
    assert.equal(resolved.env.SCRIPTA_AGENT_REVISION, good.base);
    const shapes = { SCRIPTA_HEAD: /^[0-9a-f]{40}$/, SCRIPTA_BRANCH: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, SCRIPTA_ROBOT_REVISION: /^[0-9a-f]{40}$/, SCRIPTA_ROBOT_INDEX: /^sha256:[0-9a-f]{64}$/, SCRIPTA_AGENT_INDEX: /^sha256:[0-9a-f]{64}$/, SCRIPTA_COPIED_TREES: /^[0-9a-f]{40}( [0-9a-f]{40}){2}$/, SCRIPTA_AGENT_REVISION: /^(?:[0-9a-f]{40}|unknown)$/ };
    for (const [name, shape] of Object.entries(shapes)) assert.match(resolved.env[name], shape, name);
    // The Bizanso step writes four values, each checked or built from the runner's own temp path.
    const biz = bizansoBox(t);
    const { env } = resolveBizanso(biz);
    assert.deepEqual(Object.keys(env), ['BIZANSO_SOURCE_COMMIT', 'BIZANSO_IMAGE', 'BIZANSO_SOURCE_TREE', 'BIZANSO_INCOMING_DIR']);
    assert.match(env.BIZANSO_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
    assert.match(env.BIZANSO_SOURCE_TREE, /^sha256:[0-9a-f]{64}$/);
    assert.equal(env.BIZANSO_INCOMING_DIR, path.join(biz.runner, 'qa-bizanso-incoming'));
});

test('refusal 5: a malformed live container line, and a draining route on any agent, stop both flows before any mutation', (t) => {
    const cases = [
        ['bizanso', 'a podman date string for StartedAt', (box) => box.ps(BIZ_PREFIX, [`${hex('a')} 2026-11-09 17:00:00 +0000 UTC ${BIZ_PREFIX}abc`]), /::error::The product check read a malformed bizanso container line \(image ID or start time\)\. Nothing was changed\./],
        ['bizanso', 'a short image ID', (box) => box.ps(BIZ_PREFIX, [`abc123 1700000000 ${BIZ_PREFIX}abc`]), /malformed bizanso container line/],
        ['bizanso', 'a draining route on another agent', (box) => writeJson(box, 'routing.json', { routes: { dpuAgent: { container: 'ploinky_AchillesIDE_dpuAgent_x', draining: true } } }), /::error::A route in \.ploinky\/routing\.json is draining, or the routes could not be read\. Nothing was changed\./],
        ['bizanso', 'an unreadable routing file', (box) => fs.writeFileSync(path.join(box.ws, '.ploinky/routing.json'), 'not json'), /A route in \.ploinky\/routing\.json is draining, or the routes could not be read/],
        ['scriptahub', 'a podman date string for StartedAt', (box) => box.ps(PREFIX.roboteam, [`${OLD_ROBOTEAM_ID} 2026-11-09 17:00:00 +0000 UTC ${PREFIX.roboteam}abc`]), /::error::The product check read a malformed roboteam container line \(image ID or start time\)\. Nothing was changed\./],
        ['scriptahub', 'a non-hex image ID', (box) => box.ps(PREFIX.scripta, [`${'z'.repeat(64)} 1700000000 ${PREFIX.scripta}abc`]), /malformed scripta container line/],
        ['scriptahub', 'a draining route on another agent', (box) => writeJson(box, 'routing.json', { routes: { emailAgent: { draining: true } } }), /::error::A route in \.ploinky\/routing\.json is draining, or the routes could not be read\. Nothing was changed\./],
        ['scriptahub', 'an unreadable routing file', (box) => fs.writeFileSync(path.join(box.ws, '.ploinky/routing.json'), '[1'), /A route in \.ploinky\/routing\.json is draining, or the routes could not be read/],
    ];
    for (const [key, name, setup, message] of cases) {
        const box = key === 'bizanso' ? bizansoBox(t, { source: { 'bizanso/src/runtime.mjs': 'export default 2;\n' } }) : scriptaBox(t);
        setup(box);
        const before = key === 'scriptahub' ? checkoutHead(box) : null;
        const result = key === 'bizanso' ? runBizansoFlow(box) : runScriptaFlow(box);
        assert.notEqual(result.status, 0, `${key}: ${name}: ${logOf(result)}`);
        assert.match(result.stdout, message, `${key}: ${name}`);
        assert.deepEqual(box.calls().filter((line) => /^podman (?:pull|tag|image rm)|^ploinky (?:restart|var)/.test(line)), [], `${key}: ${name}`);
        if (key === 'bizanso') assert.equal(fs.existsSync(path.join(box.ws, '.ploinky/.qa-private-copy')), false, name);
        else assert.equal(checkoutHead(box), before, name);
    }
});

test('restart_product: a drain timeout counts as a refused drain, and the error says whether the container is still running', (t) => {
    const TIMEOUT_TEXT = "targeted drain for 'bizanso' exceeded 35000ms and the container remains running; refusing SIGKILL, removal, recreate, or selector activation";
    const run = (running) => {
        const box = makeBox(t);
        writeJson(box, 'agents.json', AGENT_RECORDS);
        box.hook('bizanso_bizanso', `echo "${TIMEOUT_TEXT}"; exit 1`);
        if (running) box.write(`running.${AGENTS_JSON_ID}`, `${AGENTS_JSON_ID}\n`);
        return { box, result: box.exec(restartScript(box, 'bizanso')) };
    };
    const still = run(true);
    assert.deepEqual(outcome(still.result), { status: 1, result: 'failed' });
    assert.deepEqual(restartCalls(still.box), ['ploinky restart bizanso/bizanso']);
    assert.match(still.result.stdout, new RegExp(`::error::The targeted drain of bizanso/bizanso timed out: its container ${AGENTS_JSON_ID} is still running.*The container must exit first; then an operator must run, under the host lock: ploinky restart bizanso/bizanso --accept-failed-drain ${AGENTS_JSON_ID}$`, 'm'));
    assert.doesNotMatch(still.result.stdout, /Ploinky keeps its stopped container/);
    const stopped = run(false);
    assert.deepEqual(outcome(stopped.result), { status: 1, result: 'failed' });
    assert.match(stopped.result.stdout, /Ploinky keeps its stopped container/);
    assert.doesNotMatch(stopped.result.stdout, /still running/);
    assert.equal(stopped.box.calls().some((line) => line.includes('--accept-failed-drain')), false);
    // The timeout code alone is enough too.
    const code = makeBox(t);
    code.hook('bizanso_bizanso', 'echo "TARGETED_DRAIN_TIMEOUT"; exit 1');
    const coded = code.exec(restartScript(code, 'bizanso'));
    assert.deepEqual(restartCalls(code), ['ploinky restart bizanso/bizanso']);
    assert.match(coded.stdout, /::error::The targeted drain of bizanso\/bizanso/);
});
