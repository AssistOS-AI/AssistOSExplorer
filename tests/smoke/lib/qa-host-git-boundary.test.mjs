// Contract: the QA tooling never runs Git in the host process inside a
// repository a Box can write, because Box-written Git configuration (fsmonitor,
// filters, hooks) would then run on the host. Every `git` word in the code of
// the QA workflows and of the scripts they invoke must match one reviewed entry
// below, with its exact count; any new mention fails this test until reviewed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../../../', import.meta.url);
// A bare `git` word: not part of an identifier, a `.git` path or URL suffix, or `--git-…`.
const TOKEN = /(?<![\w.-])git(?!\w)/;

// The code of one line: whole-line shell, YAML and JS comments and trailing ` // ` comments are dropped.
function code(line) {
    const text = line.trim();
    if (/^(?:#|\/\/|\*|\/\*)/.test(text)) return '';
    return text.replace(/(^|\s)\/\/\s.*$/, '');
}

function gitMentions(text) {
    return text.split('\n').map((line, index) => ({ index, text: code(line) })).filter(row => TOKEN.test(row.text));
}

// [file, line pattern, count, why]
const REVIEWED = [
    ['.github/workflows/deploy-explorer-qa.yml', /git ls-remote/, 5, 'remote query; no local repository'],
    ['.github/workflows/deploy-explorer-qa.yml', /^for tool in git node curl; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git check-ref-format --branch "\$default_branch"/, 1, 'ref-name syntax; no repository'],
    // The ancestry proof reads a bare, remote-less clone of the remote history in a private temporary directory.
    ['.github/workflows/deploy-explorer-qa.yml', /git clone --bare --filter=tree:0|git -C "\$QA_ANCESTRY_DIR\/history"/, 5, 'private temporary clone of remote history, outside any workspace'],
    ['.github/workflows/deploy-explorer-qa.yml', /ERROR: managed runtime path is not a Ploinky git checkout/, 1, 'message text'],
    ['.github/workflows/deploy-explorer-qa.yml', /git (?:clone --no-checkout https:\/\/github\.com\/AssistOS-AI\/ploinky\.git |-C )"\$RUNTIME_DIR"/, 8, 'PRE_BOX'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git clone --single-branch --branch "\$ALA_BRANCH" "\$ALA_URL" "\$ALA_DIR"$/, 1, 'PRE_BOX'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git -C "\$WORK_DIR\/\.ploinky\/repos\/\$repository_name" /, 5, 'IN_BOX'],
    // The Ploinky workflows' checkout lies outside the workspace, and a Box mounts it read-only.
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^for tool in git node curl podman flock; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /git ls-remote --symref "\$PLOINKY_URL" HEAD|^git clone --quiet --branch "\$BRANCH" "\$PLOINKY_URL" "\$CHECKOUT"$|git -C "\$CHECKOUT" /, 7, 'BOOTSTRAP_OUTSIDE_BOX'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^git -C "\$GITHUB_WORKSPACE\/\.qa-bizanso-source" archive --format=tar HEAD \| run_in_box "\$COPY_PROGRAM"$/, 1, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^source_git\(\) \{ git -C "\$SOURCE" "\$@"; \}$/, 1, 'SCRIPTA_RUNNER_CHECKOUT'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}$/, 1, 'SCRIPTA_BOX_CHECK'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^if \[ ! -e ScriptaHubAgent \]; then git clone --quiet "\$url" ScriptaHubAgent; fi$|^test "\$\(git -C ScriptaHubAgent remote get-url origin\)" = "\$url"'$/, 2, 'a program run inside the Box through podman exec, never on the host'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^PROMOTIONSCOUT_BRANCH="\$\(git -C "\$PROMOTIONSCOUT_SOURCE" symbolic-ref --short HEAD\)"$|^git -C "\$PROMOTIONSCOUT_SOURCE" bundle create - "refs\/heads\/\$PROMOTIONSCOUT_BRANCH" \| run_in_box "\$BUNDLE_PROGRAM"$/, 2, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^heads=\$\(git bundle list-heads |^git -c core\.hooksPath=\/dev\/null clone --quiet --branch |^git -C "\$stage\/clone" remote set-url |git -C PromotionScoutV2 (?:remote get-url|symbolic-ref)|git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C PromotionScoutV2 (?:fetch --quiet|status --porcelain|merge-base --is-ancestor|merge --quiet --ff-only)/, 9, 'a program run inside the Box through podman exec, never on the host; every Git call there is a reviewed fixed form'],
    // The product workflows only read the Ploinky checkout (outside the workspace, mounted read-only by a Box) and never move it.
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /^for tool in git node curl podman flock; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /git -C "\$CHECKOUT" (?:remote get-url origin|rev-parse --short HEAD)/, 2, 'read-only queries of the Ploinky checkout outside the workspace; no fetch, checkout or merge'],
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /git -C "\$SOURCE" (?:rev-parse HEAD|archive --format=tar HEAD)|^(?:if ! )?git -C "\$GITHUB_WORKSPACE\/\.qa-bizanso-source" archive --format=tar HEAD \| run_in_box "\$COPY_PROGRAM"(?:; then)?$/, 3, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^for tool in git node curl podman flock; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /git -C "\$CHECKOUT" (?:remote get-url origin|rev-parse --short HEAD)/, 2, 'read-only queries of the Ploinky checkout outside the workspace; no fetch, checkout or merge'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^source_git\(\) \{ git -C "\$SOURCE" "\$@"; \}$|^runner_git\(\) \{ git -C "\$GITHUB_WORKSPACE\/\.qa-scriptahub-source" "\$@"; \}$/, 2, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}$/, 2, 'a program run inside the Box through podman exec, never on the host; every Git call there goes through this hooks-off, fsmonitor-off wrapper'],
    ['.github/workflows/destroy-explorer-qa-ploinky.yml', /git ls-remote --symref "\$PLOINKY_URL" HEAD|^git clone --quiet --branch "\$BRANCH" "\$PLOINKY_URL" "\$CHECKOUT"$|git -C "\$CHECKOUT" /, 7, 'BOOTSTRAP_OUTSIDE_BOX'],
    ['.github/scripts/rollback-explorer-qa.mjs', /./, 7, 'IN_SANDBOX'],
    ['.github/scripts/rollback-explorer-qa.mjs', /'--entrypoint=\/usr\/bin\/git', image,/, 1, 'sandbox container entrypoint'],
    ['.github/scripts/update-explorer-qa.mjs', /operation: `git-\$\{args\[0\]\}`/, 1, 'failure label of a sandboxed command'],
    ['.github/scripts/update-explorer-qa.mjs', /'git-objects-only'/, 1, 'receipt label: the fetch changes only Git objects'],
    // Tests the QA workflows run on the GitHub runner. None touches a Box or a workspace.
    ['tests/smoke/lib/deploy-qa-destroy-workflow.test.mjs', /'podman', 'docker', 'sudo', 'git', 'ploinky'/, 1, 'stub tool names the destroy test proves are never run'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /assert\.equal\(spawnSync\('git', args, \{ cwd: root \}\)\.status, 0\);|^git\(\) \{ case "\$\*" in \*symbolic-ref\*\) echo main ;; \*\) echo archive ;; esac; \}$/, 2, 'a temporary repository and a stub function in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /git\((?:source|repo), |^const git = \(cwd, \.\.\.args\) => \{$|spawnSync\('git', \['-c', 'user\.email|spawnSync\('git', \['-C', source, 'bundle'/, 16, 'a temporary repository and its bundle in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-product-workflows.test.mjs', /spawnSync\('git', \['-C', ROOT, 'show'|spawnSync\('git', \['-c', 'user\.email/, 2, 'reads this repository\'s base revision and builds temporary repositories in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-product-workflows.test.mjs', /\/git -C "\\\$CHECKOUT"|\/git \(\?:-c |\/git \[\^|PLOINKY_COMMIT=%s.*git -C/, 5, 'regular expressions of the assertions that the product workflows only read the Ploinky checkout; they run no Git'],
    ['tests/smoke/lib/qa-teardown.test.mjs', /spawnSync\('git', \['-C', REPOSITORY, 'show'/, 1, 'reads this repository\'s own history on the runner; no Box'],
    ['tests/smoke/lib/retired-source-absence.test.mjs', /execFileSync\('git', \['ls-files'/, 1, 'GitHub-hosted runner over the repository checkout; no Box'],
];

// The QA workflows, every script directory they invoke under .github, and every
// other repository file they invoke.
function targets() {
    const workflows = fs.readdirSync(new URL('.github/workflows/', ROOT)).map(name => `.github/workflows/${name}`);
    const files = new Set(workflows), directories = new Set();
    for (const workflow of workflows) {
        for (const [, relative] of fs.readFileSync(new URL(workflow, ROOT), 'utf8')
            .matchAll(/(?:(?<![\w$/.-])|(?<=\$GITHUB_WORKSPACE\/))((?:\.github|tests|scripts|explorer|shared)\/[\w./-]+\.(?:mjs|cjs|js|sh|py))/g)) {
            if (!fs.existsSync(new URL(relative, ROOT))) continue;
            if (relative.startsWith('.github/')) directories.add(relative.slice(0, relative.lastIndexOf('/')));
            else files.add(relative);
        }
    }
    for (const directory of directories) {
        for (const name of fs.readdirSync(new URL(`${directory}/`, ROOT))) files.add(`${directory}/${name}`);
    }
    return [...files].sort();
}

function sandboxRegion(file, text) {
    if (file !== '.github/scripts/rollback-explorer-qa.mjs') return () => false;
    const lines = text.split('\n');
    const start = lines.findIndex(line => line.startsWith('export const SOURCE_CHECK_SCRIPT = `'));
    const end = lines.findIndex((line, index) => index > start && line.startsWith('`;'));
    return index => start >= 0 && index > start && index < end;
}

test('the scanner flags every Git invocation form, but not .git suffixes, identifiers or comments', () => {
    // The six forms the review found to slip past the former subcommand list, verbatim, then more.
    for (const form of ["execSync('git -C ' + dir + ' status')", "const program = 'git';", 'git --git-dir="$D/.git" status',
        'git --no-pager log', 'cd "$D" && git describe', 'git ls-files', "run('git -C ' + dir);", "const program = 'git';", 'git --git-dir=/w/.git status', 'git --no-pager log',
        'out="$(git describe --tags)"', 'git ls-files -z', 'spawnSync("/usr/bin/git", args)', '`git` + args', 'exec git status']) {
        assert.equal(gitMentions(form).length, 1, form);
    }
    for (const benign of ['https://github.com/AssistOS-AI/ploinky.git', "path.join(dir, '.git')", 'gitAgent/manifest.json',
        '# git clone in a comment', '// git status in a comment', ' * git in JSDoc', "const remote = 'origin'; // git fetch later", 'mirror.git']) {
        assert.equal(gitMentions(benign).length, 0, benign);
    }
});

test('the scan covers the QA workflows, the script directories they invoke, and the other files they invoke', () => {
    const files = targets();
    for (const expected of ['.github/workflows/deploy-explorer-qa.yml', '.github/workflows/destroy-explorer-qa.yml',
        '.github/scripts/rollback-explorer-qa.mjs', '.github/scripts/update-explorer-qa.mjs', '.github/scripts/qa-teardown.mjs',
        '.github/scripts/qa-teardown-privileged.mjs', '.github/scripts/quiesce-explorer-qa.mjs',
        'tests/smoke/lib/retired-source-absence.test.mjs']) {
        assert.ok(files.includes(expected), expected);
    }
});

test('Q1: every Git mention in that code is a reviewed site that cannot run Git inside a Box-writable repository, with its exact count', () => {
    const unreviewed = [], counts = new Map(REVIEWED.map(entry => [entry, 0]));
    for (const file of targets()) {
        const text = fs.readFileSync(new URL(file, ROOT), 'utf8'), lines = text.split('\n'), inSandbox = sandboxRegion(file, text);
        for (const row of gitMentions(text)) {
            const entry = REVIEWED.find(([name, pattern, , why]) => name === file
                && (why === 'IN_SANDBOX' ? inSandbox(row.index) : pattern.test(row.text)));
            if (!entry) { unreviewed.push(`${file}:${row.index + 1}: ${row.text}`); continue; }
            counts.set(entry, counts.get(entry) + 1);
            if (entry[3] === 'IN_BOX') {
                // Runs inside the QA Box through container exec, never in the host process.
                assert.match(lines.slice(Math.max(0, row.index - 4), row.index).join('\n'), /container exec[\s\S]*\\$/,
                    `${file}:${row.index + 1} is not an in-Box exec`);
            }
            if (entry[3] === 'PRE_BOX') {
                // Fresh host checkouts staged after the teardown removed every QA container and the
                // regenerable workspace state and before the recreated workspace's Box is prepared:
                // no Box can write them yet.
                const at = lines.slice(0, row.index).join('\n').length;
                assert.ok(at > text.indexOf('qa-teardown.mjs" execute --scope') && at < text.indexOf('prepareBoxForCommand'),
                    `${file}:${row.index + 1} runs host Git outside the pre-Box staging window`);
            }
        }
    }
    assert.deepEqual(unreviewed, [], 'unreviewed Git mentions');
    for (const [entry, count] of counts) assert.equal(count, entry[2], `${entry[0]} ${entry[1]}: ${entry[3]}`);
});

test('Q1: full deploy ScriptaHub source checks run on the runner and inside the Box at their reviewed sites', () => {
    const workflow = fs.readFileSync(new URL('.github/workflows/deploy-explorer-qa-ploinky.yml', ROOT), 'utf8');
    const checkout = workflow.split('      - name: Check out ScriptaHub\n')[1].split('\n      - name: ')[0];
    assert.match(checkout, /uses: actions\/checkout@v4\n\s+with:\n\s+repository: Axiologic\/ScriptaHubAgent\n\s+path: \.qa-scriptahub-source\n\s+persist-credentials: false\n\s+fetch-depth: 0/);
    const resolve = workflow.split('      - name: Resolve the ScriptaHub source and the published images\n')[1].split('\n      - name: ')[0];
    assert.match(resolve, /SOURCE="\$GITHUB_WORKSPACE\/\.qa-scriptahub-source"\n[\s\S]*?source_git\(\) \{ git -C "\$SOURCE" "\$@"; \}/);
    const calls = [...resolve.matchAll(/\bsource_git (?:rev-parse HEAD|symbolic-ref --short HEAD|cat-file -e "\$AGENT_REVISION\^\{commit\}"|merge-base --is-ancestor "\$AGENT_REVISION" "\$HEAD_COMMIT"|rev-parse "\$(?:HEAD_COMMIT|AGENT_REVISION):\$path")/g)];
    assert.equal(calls.length, 6);
    assert.equal((workflow.match(/\bsource_git /g) || []).length, 6);
    assert.ok(workflow.indexOf('      - name: Check out ScriptaHub\n') < workflow.indexOf('      - name: Resolve the ScriptaHub source and the published images\n'));
    assert.equal((workflow.match(/run_in_box\(\) \{/g) || []).length, 1);
    assert.match(workflow, /run_in_box\(\) \{\n\s+"\$\{SSH\[@\]\}" "exec flock -n -E 75 --close '\$LOCK' podman container exec -i --user podman --workdir '\$WORK_DIR' --env 'PLOINKY_WORKSPACE_ROOT=\$WORK_DIR' ploinky-box-explorerqaworkspace-7a31ab7775eb sh -c '\$1' sh"\n\s+\}/);
    const checks = workflow.match(/\| run_in_box '(set -eu\n\s+read -r head\n\s+read -r expected\n\s+g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}\n\s+test -z "\$\(g status --porcelain\)"\n\s+test "\$\(g rev-parse HEAD\)" = "\$head"\n\s+actual=\$\(g rev-parse HEAD:skills HEAD:scriptahubAgent\/deployment HEAD:scriptahubAgent\/site\/reader\/reader\.css\)\n\s+test "\$\(echo \$actual\)" = "\$expected")'; then/g) || [];
    assert.equal(checks.length, 1);
    assert.equal((workflow.match(/\bg /g) || []).length, 3);
});

test('Q1: the managed sources are proven only in the sandbox, and the fresh checkouts are verified only once the Box is prepared', () => {
    const workflow = fs.readFileSync(new URL('.github/workflows/deploy-explorer-qa.yml', ROOT), 'utf8');
    // The root admission runs no Git at all; the sandboxed proof is part of the admission function.
    const admission = workflow.split('// BEGIN QA preservation admission')[1].split('// END QA preservation admission')[0];
    assert.doesNotMatch(admission, /execFileSync|spawnSync|child_process|['"`]git['"`]/);
    assert.match(workflow, /\/\/ END QA preservation admission\n\s+NODE\n\s+qa_prove_managed_sources\n\s+\}\n/);
    assert.match(workflow, /adapters\.sourceCheck\(path\.join\(workspace, relative\), \{ engine, image \}\)/);
    // The fresh ALA checkout is never verified before the Box is prepared, and only in the sandbox.
    assert.match(workflow, /\[ -e "\$ALA_DIR" \] \|\| \[ -L "\$ALA_DIR" \]; then\n\s+echo "\[deploy-qa\] ERROR: ALA requires an exact default-branch commit and an absent fresh checkout\."/);
    const prepared = workflow.indexOf('prepareBoxForCommand');
    const verifications = [...workflow.matchAll(/\n {10}verify_ala_checkout\n/g)].map(match => match.index);
    assert.ok(verifications.length === 2 && verifications.every(index => index > prepared));
    assert.match(workflow, /QA_RUNTIME_HEAD="\$\(qa_sandboxed_git "\$RUNTIME_DIR" rev-parse HEAD\)"/);
    assert.match(workflow, /productionAdapters\(\)\.sourceCheck\(directory, \{ engine, image \}\)/);
});
