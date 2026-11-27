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
    // The Ploinky workflows' checkout lies outside the workspace, and a Box mounts it read-only.
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^for tool in git node curl podman flock; do$/, 2, 'prerequisite presence checks of the two host bootstrap sessions'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /git ls-remote --symref "\$PLOINKY_URL" HEAD|^git clone --quiet --branch "\$BRANCH" "\$PLOINKY_URL" "\$CHECKOUT"$|git -C "\$CHECKOUT" /, 7, 'BOOTSTRAP_OUTSIDE_BOX'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^git -C "\$GITHUB_WORKSPACE\/\.qa-bizanso-source" archive --format=tar HEAD \| run_in_box "\$COPY_PROGRAM"$/, 1, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^COMMIT="\$\(git -C "\$SOURCE" rev-parse HEAD\)"$|^if ! git -C "\$SOURCE" cat-file -e "\$COMMIT:csvMailAgent\/manifest\.json"; then$|^git -C "\$GITHUB_WORKSPACE\/\.qa-csvmail-source" archive --format=tar "\$CSVMAIL_COMMIT" csvMailAgent \| run_in_box "\$CSVMAIL_PLACE_PROGRAM"$/, 3, 'runs on the GitHub runner, in the simpleCSVMailSend checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^source_git\(\) \{ git -C "\$SOURCE" "\$@"; \}$/, 1, 'SCRIPTA_RUNNER_CHECKOUT'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}$/, 1, 'SCRIPTA_BOX_CHECK'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^if \[ ! -e ScriptaHubAgent \]; then git clone --quiet "\$url" ScriptaHubAgent; fi$|^test "\$\(git -C ScriptaHubAgent remote get-url origin\)" = "\$url"'$/, 2, 'a program run inside the Box through podman exec, never on the host'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^PROMOTIONSCOUT_BRANCH="\$\(git -C "\$PROMOTIONSCOUT_SOURCE" symbolic-ref --short HEAD\)"$|^git -C "\$PROMOTIONSCOUT_SOURCE" bundle create - "refs\/heads\/\$PROMOTIONSCOUT_BRANCH" \| run_in_box "\$BUNDLE_PROGRAM"$/, 2, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^fp_git\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C "\$repo" "\$@"; \}$/, 2, 'the ScriptaHub dependency fingerprint block: in the resolve step on the runner against the actions/checkout copy, and in the pre-restart program run inside the Box through podman exec; it only reads objects, through this hooks-off, fsmonitor-off wrapper'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^link_git\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C "\$name" "\$@"; \}$/, 1, 'a program run inside the Box through podman exec, never on the host; every Git call there goes through this hooks-off, fsmonitor-off wrapper, checks the expanded origin and fetches only the literal AssistOS-AI https URL'],
    ['.github/workflows/deploy-explorer-qa-ploinky.yml', /^heads=\$\(git bundle list-heads |^git -c core\.hooksPath=\/dev\/null clone --quiet --branch |^git -C "\$stage\/clone" remote set-url |git -C PromotionScoutV2 (?:remote get-url|symbolic-ref)|git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C PromotionScoutV2 (?:fetch --quiet|status --porcelain|merge-base --is-ancestor|merge --quiet --ff-only)/, 9, 'a program run inside the Box through podman exec, never on the host; every Git call there is a reviewed fixed form'],
    // The product workflows only read the Ploinky checkout (outside the workspace, mounted read-only by a Box) and never move it.
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /^for tool in git node curl podman flock; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /git -C "\$CHECKOUT" (?:remote get-url origin|rev-parse --short HEAD)/, 2, 'read-only queries of the Ploinky checkout outside the workspace; no fetch, checkout or merge'],
    ['.github/workflows/deploy-explorer-qa-bizanso.yml', /git -C "\$SOURCE" (?:rev-parse HEAD|archive --format=tar HEAD)|^(?:if ! )?git -C "\$GITHUB_WORKSPACE\/\.qa-bizanso-source" archive --format=tar HEAD \| run_in_box "\$COPY_PROGRAM"(?:; then)?$/, 3, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^for tool in git node curl podman flock; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /git -C "\$CHECKOUT" (?:remote get-url origin|rev-parse --short HEAD)/, 2, 'read-only queries of the Ploinky checkout outside the workspace; no fetch, checkout or merge'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^source_git\(\) \{ git -C "\$SOURCE" "\$@"; \}$|^runner_git\(\) \{ git -C "\$GITHUB_WORKSPACE\/\.qa-scriptahub-source" "\$@"; \}$/, 2, 'runs on the GitHub runner, in a checkout actions/checkout just created; no Box can write it'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}$/, 2, 'a program run inside the Box through podman exec, never on the host; every Git call there goes through this hooks-off, fsmonitor-off wrapper'],
    ['.github/workflows/deploy-explorer-qa-scriptahub.yml', /^fp_git\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C "\$repo" "\$@"; \}$/, 2, 'the ScriptaHub dependency fingerprint block: in the resolve step on the runner against the actions/checkout copy, and in the read program run inside the Box through podman exec; it only reads objects, through this hooks-off, fsmonitor-off wrapper'],
    ['.github/workflows/destroy-explorer-qa-ploinky.yml', /git ls-remote --symref "\$PLOINKY_URL" HEAD|^git clone --quiet --branch "\$BRANCH" "\$PLOINKY_URL" "\$CHECKOUT"$|git -C "\$CHECKOUT" /, 7, 'BOOTSTRAP_OUTSIDE_BOX'],
    // Tests the QA workflows run on the GitHub runner. None touches a Box or a workspace.
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /assert\.equal\(spawnSync\('git', args, \{ cwd: root \}\)\.status, 0\);|^git\(\) \{ case "\$\*" in \*symbolic-ref\*\) echo main ;; \*\) echo archive ;; esac; \}$/, 2, 'a temporary repository and a stub function in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /git\((?:source|repo), |^const git = \(cwd, \.\.\.args\) => \{$|spawnSync\('git', \['-c', 'user\.email|spawnSync\('git', \['-C', source, 'bundle'/, 18, 'a temporary repository and its bundle in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /^const git = \(\.\.\.args\) => \{$|^const result = spawnSync\('git', \['-C', source, \.\.\.args\], \{ encoding: 'utf8' \}\);$|^git\('(?:init|add|-c)', |^return \{ source, commit: git\('rev-parse', 'HEAD'\) \};$|^const archive = 'git -C "\$GITHUB_WORKSPACE\/\.qa-csvmail-source" archive /, 10, 'temporary simpleCSVMailSend and fingerprint repositories in the test, on the runner, and the expected archive line as text; no Box'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /^git\((?:upstream\(name\)|workspace|checkout\((?:name|docs)\)),|^const head = \(name\) => git\(checkout\(name\), 'rev-parse', 'HEAD'\);$|^const realGit = spawnSync\('sh', \['-c', 'command -v git'\]|^fs\.writeFileSync\(path\.join\(bin, 'git'\), `#!\/bin\/sh$/, 21, 'temporary repositories and a PATH git shim for the link-install program test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', /^const result = spawnSync\('git', \['-c', 'core\.autocrlf=false', '-c', 'user\.email=t@example\.test'|^git\('commit', '--quiet', '--allow-empty', '-m', message\);$|^return git\('rev-parse', 'HEAD'\);$|^return \{ root, repo, git, commit \};$/, 4, 'the temporary ScriptaHub repository (gitRepo) of the pre-restart fingerprint test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-cache-workflows.test.mjs', /^const beforeGit = session\.slice\(0, session\.indexOf\('git ls-remote'\)\);$|^assert\.match\(beforeGit, \/for tool in git node curl podman flock; do/, 2, 'text of assertions on the bootstrap session source, on the runner; they run no Git'],
    ['tests/smoke/lib/deploy-qa-product-workflows.test.mjs', /spawnSync\('git', \['-C', ROOT, 'show'|spawnSync\('git', \['-c', 'user\.email/, 2, 'reads this repository\'s base revision and builds temporary repositories in the test, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-product-workflows.test.mjs', /^const gitLines = FP_BLOCK\.split|^assert\.deepEqual\(gitLines\.map|^const git = \(\.\.\.args\) => \{$|^const result = spawnSync\('git', \['-c', 'core\.autocrlf=false'|^git\('(?:init|add|commit)', |^for \(const \[name, sha\] of Object\.entries\(gitlinks\)\) git\('update-index'|^return \{ dir, rev: git\('rev-parse', 'HEAD'\), git \};$/, 9, 'the temporary repository (fixtureRepo) of the fingerprint tests and the assertion that the block runs Git only through fp_git, on the runner; no Box'],
    ['tests/smoke/lib/deploy-qa-product-workflows.test.mjs', /\/git -C "\\\$CHECKOUT"|\/git \(\?:-c |\/git \[\^|PLOINKY_COMMIT=%s.*git -C/, 5, 'regular expressions of the assertions that the product workflows only read the Ploinky checkout; they run no Git'],
    // Preflight inventory executes only in the isolated reader container; publication runs on the runner.
    ['.github/scripts/qaSourceInventory.mjs', /^const result = spawnSync\('git', \['-c', 'core\.fsmonitor=false'/, 1, 'reader container only, with mounted sources read-only and network disabled'],
    ['.github/scripts/qaSourceInventory.mjs', /^const raw = value\.trim\(\)\.replace\(\/\^git|^if \(url\.password.*url\.username !== 'git'/, 2, 'origin string validation only'],
    ['.github/scripts/qaPublication.mjs', /^const git = \(\.\.\.args\) => run\('git', args\);$|^git\('check-ref-format',/, 2, 'runner Git wrapper and branch validation'],
    ['.github/scripts/qaPublication.mjs', /^const match = \/\^.*git@github/, 1, 'origin validation regular expression, no Git invocation'],
    ['.github/scripts/qaPublication.mjs', /^if \(git\('-C', repo, 'rev-parse', '--is-shallow-repository'\)|^const lines = git\('-C', repo, 'rev-list', ref\)|^const branch = validateBranch\(git\('-C', repo, 'symbolic-ref'|^const head = git\('-C', repo, 'rev-parse', '--verify', 'HEAD\^\{commit\}'\);$/, 5, 'runner-owned immutable checkout or fresh scratch bare repository only'],
    ['.github/scripts/qaPublication.mjs', /^const result = git\('ls-remote', '--symref', url, 'HEAD'\);$|^git\('init', '--bare', dir\);$|^git\('-C', dir, '-c', 'protocol\.version=2', 'fetch'/, 3, 'runner fetches validated GitHub origin into fresh scratch bare repository'],
    ['.github/scripts/qaPublication.mjs', /^const archive = run\('git', \['-C', repo, 'archive'/, 1, 'archives runner-owned checkout only'],
    ['tests/smoke/lib/qa-unpublished-acceptance.test.mjs', /^const result = spawnSync\('git', args, \{ cwd, encoding: 'utf8'/, 1, 'temporary test repositories only'],
    ['tests/smoke/lib/qa-publication.test.mjs', /^function git\(dir, \.\.\.args\) \{$|^const result = spawnSync\('git', \['-C', dir, \.\.\.args\]|^git\((?:repo|biz|csv), '(?:init|config|add|commit)'|^return git\(repo, 'rev-parse', 'HEAD'\);$/, 14, 'temporary runner test repositories only'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^function git\(cwd, \.\.\.args\) \{$|^const result = spawnSync\('git', args, \{ cwd|^git\((?:target|checkout), |git\(checkout, '(?:add|commit|rev-parse)'/, 14, 'temporary runner test repositories only'],

    ['tests/smoke/lib/qa-predeploy.test.mjs', /command\((?:checkout|workspace|target|published|dirty|biz|source|promo), 'git', '(?:init|add|-c|clone|remote|rev-parse|show-ref|diff|fetch|merge|restore)'/, 16, 'temporary test fixtures and their local clones on the runner'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /git\(tooling, '(?:update-index|rev-parse|config)'/, 5, 'temporary inventory fixture repository on the runner'],

    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'config', '--add', 'remote\.origin\.url', 'https:\/\/example\.invalid\/active'\);$/, 1, 'temporary inventory fixture repository'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'add', 'agent'\); git\(source, 'commit', '-qm', 'agent'\);$/, 2, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(catalog, 'add', 'skills'\); git\(catalog, 'commit', '-qm', 'skill'\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'add', '\.agents\/\.ploinky-skill-exports\.json'\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'reset', '-q', 'HEAD', '--', '\.agents\/\.ploinky-skill-exports\.json'\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(catalog, 'rm', '-q', 'skills\/example\/SKILL\.md'\); git\(catalog, 'commit', '-qm', 'remove skill'\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'config', 'extensions\.worktreeConfig', 'true'\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],
    ['tests/smoke/lib/qa-source-inventory.test.mjs', /^git\(source, 'config', '--worktree', 'core\.excludesFile', excludes\);$/, 1, 'temporary default-skill export or worktree configuration fixture'],

];

// The QA workflows, every script directory they invoke under .github, and every
// other repository file they invoke.
function targets() {
    const workflows = fs.readdirSync(new URL('.github/workflows/', ROOT)).map(name => `.github/workflows/${name}`);
    const explicit = [
        '.github/scripts/qaPredeploy.mjs', '.github/scripts/qaPreflightHost.sh',
        '.github/scripts/qaSourceInventory.mjs', '.github/scripts/qaCopyManifest.mjs',
        '.github/scripts/qaSourceReport.mjs', '.github/scripts/qaPublication.mjs',
        'tests/smoke/lib/qa-unpublished-acceptance.test.mjs', 'tests/smoke/lib/qa-predeploy.test.mjs',
        'tests/smoke/lib/qa-copy-manifest.test.mjs', 'tests/smoke/lib/qa-source-inventory.test.mjs',
        'tests/smoke/lib/qa-publication.test.mjs',
    ];
    const files = new Set([...workflows, ...explicit.filter(file => fs.existsSync(new URL(file, ROOT)))]), directories = new Set();
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
    for (const expected of ['.github/workflows/deploy-explorer-qa-ploinky.yml', '.github/workflows/destroy-explorer-qa-ploinky.yml',
        '.github/workflows/deploy-explorer-qa-bizanso.yml', '.github/workflows/deploy-explorer-qa-scriptahub.yml',
        'tests/smoke/lib/deploy-qa-ploinky-workflows.test.mjs', 'tests/smoke/lib/deploy-qa-product-workflows.test.mjs',
        '.github/scripts/qaPreflightHost.sh', '.github/scripts/qaSourceInventory.mjs', '.github/scripts/qaPublication.mjs',
        '.github/scripts/qaCopyManifest.mjs', '.github/scripts/qaSourceReport.mjs', '.github/scripts/qaPredeploy.mjs',
        'tests/smoke/lib/qa-unpublished-acceptance.test.mjs', 'tests/smoke/lib/qa-predeploy.test.mjs', 'tests/smoke/lib/qa-copy-manifest.test.mjs',
        'tests/smoke/lib/qa-source-inventory.test.mjs', 'tests/smoke/lib/qa-publication.test.mjs']) {
        assert.ok(files.includes(expected), expected);
    }
});

test('Q1: every Git mention in that code is a reviewed site that cannot run Git inside a Box-writable repository, with its exact count', () => {
    const unreviewed = [], counts = new Map(REVIEWED.map(entry => [entry, 0]));
    for (const file of targets()) {
        const text = fs.readFileSync(new URL(file, ROOT), 'utf8');
        for (const row of gitMentions(text)) {
            const entry = REVIEWED.find(([name, pattern]) => name === file && pattern.test(row.text));
            if (!entry) { unreviewed.push(`${file}:${row.index + 1}: ${row.text}`); continue; }
            counts.set(entry, counts.get(entry) + 1);
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
    const calls = [...resolve.matchAll(/\bsource_git (?:rev-parse HEAD|symbolic-ref --short HEAD|cat-file -e "\$AGENT_REVISION\^\{commit\}"|merge-base --is-ancestor "\$AGENT_REVISION" "\$HEAD_COMMIT"|diff --name-only --no-renames "\$AGENT_REVISION" "\$HEAD_COMMIT" --|cat-file blob "\$HEAD_COMMIT:scriptahubAgent\/deployment\/dependency-inputs\.txt")/g)];
    assert.equal(calls.length, 6);
    assert.equal((workflow.match(/\bsource_git /g) || []).length, 6);
    assert.ok(workflow.indexOf('      - name: Check out ScriptaHub\n') < workflow.indexOf('      - name: Resolve the ScriptaHub source and the published images\n'));
    // The registry check defines it once more, identically, before its first use there.
    assert.equal((workflow.match(/run_in_box\(\) \{/g) || []).length, 2);
    assert.match(workflow, /run_in_box\(\) \{\n\s+"\$\{SSH\[@\]\}" "exec flock -n -E 75 --close '\$LOCK' podman container exec -i --user podman --workdir '\$WORK_DIR' --env 'PLOINKY_WORKSPACE_ROOT=\$WORK_DIR' ploinky-box-explorerqaworkspace-7a31ab7775eb sh -c '\$1' sh"\n\s+\}/);
    const preRestart = workflow.split("| run_in_box 'set -eu\n          read -r head\n          read -r expected")[1].split("'; then")[0];
    assert.match(preRestart, /g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}/);
    assert.match(preRestart, /test -z "\$\(g status --porcelain\)"\s+test "\$\(g rev-parse HEAD\)" = "\$head"/);
    assert.match(preRestart, /actual=\$\(scripta_dependency_fingerprint ScriptaHubAgent "\$head"\) \|\| exit 1\s+test "\$actual" = "\$expected"/);
    const checks = workflow.match(/\| run_in_box '(set -eu\n\s+read -r head\n\s+read -r expected\n\s+case "\$head" in ""\|\*\[!0-9a-f\]\*\) exit 1 ;; esac\n\s+test "\$\{#head\}" -eq 40\n\s+case "\$expected" in ""\|\*\[!0-9a-f\]\*\) exit 1 ;; esac\n\s+test "\$\{#expected\}" -eq 64\n\s+g\(\) \{ git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C ScriptaHubAgent "\$@"; \}\n\s+test -z "\$\(g status --porcelain\)"\n\s+test "\$\(g rev-parse HEAD\)" = "\$head"\n\s+# BEGIN ScriptaHub dependency fingerprint\n[\s\S]*?# END ScriptaHub dependency fingerprint\n\s+actual=\$\(scripta_dependency_fingerprint ScriptaHubAgent "\$head"\) \|\| exit 1\n\s+test "\$actual" = "\$expected")'; then/g) || [];
    assert.equal(checks.length, 1);
    assert.equal((workflow.match(/\bg /g) || []).length, 2);
    // The fingerprint block only reads objects: fp_git runs no other subcommand, in either workflow.
    for (const name of ['deploy-explorer-qa-ploinky.yml', 'deploy-explorer-qa-scriptahub.yml']) {
        const text = fs.readFileSync(new URL(`.github/workflows/${name}`, ROOT), 'utf8');
        const uses = [...text.matchAll(/\bfp_git (\S+)/g)].map(match => match[1]);
        assert.equal(uses.length, 8, name);
        assert.deepEqual([...new Set(uses)].sort(), ['cat-file', 'hash-object', 'ls-tree', 'rev-parse'], name);
    }
});

test('Q1: preflight sends the reviewed reader into an isolated container on the host', () => {
    const runner = fs.readFileSync(new URL('.github/scripts/qaPredeploy.mjs', ROOT), 'utf8');
    const host = fs.readFileSync(new URL('.github/scripts/qaPreflightHost.sh', ROOT), 'utf8');
    assert.match(runner, /spawnSync\('tar', \['-C', scripts, '-cf', '-', 'qaSourceInventory\.mjs', 'qaCopyManifest\.mjs'\]\)/);
    assert.match(runner, /request\('inspect', scope, readerBundle\(\)\)/);
    assert.match(host, /tar -xf - -C "\$scratch" qaSourceInventory\.mjs qaCopyManifest\.mjs/);
    assert.match(host, /podman run --rm --pull=never --network=none --read-only --read-only-tmpfs=false/);
    assert.match(host, /--volume "\$scratch:\/qa-reader:ro" "\$\{mounts\[@\]\}" --entrypoint node "\$image"\s*\\\n\s*\/qa-reader\/qaSourceInventory\.mjs/);
    assert.match(host, /mounts\+=\(--volume "\$workspace:\$workspace:ro"\)/);
    assert.match(host, /mounts\+=\(--volume "\$tools\/ploinky:\$tools\/ploinky:ro"\)/);
});


test('Q1: dependency fingerprint Git wrappers stay in the runner checkout or the Box programs', () => {
    const full = fs.readFileSync(new URL('.github/workflows/deploy-explorer-qa-ploinky.yml', ROOT), 'utf8');
    const product = fs.readFileSync(new URL('.github/workflows/deploy-explorer-qa-scriptahub.yml', ROOT), 'utf8');
    const block = /# BEGIN ScriptaHub dependency fingerprint[\s\S]*?# END ScriptaHub dependency fingerprint/g;
    const fullBlocks = [...full.matchAll(block)].map(match => match[0]);
    const productBlocks = [...product.matchAll(block)].map(match => match[0]);
    assert.equal(fullBlocks.length, 2);
    assert.equal(productBlocks.length, 2);
    for (const value of [...fullBlocks, ...productBlocks]) {
        assert.equal(value, fullBlocks[0]);
        assert.match(value, /repo=\$1\s+rev=\$2/);
        assert.equal((value.match(/\bfp_git (?:cat-file|rev-parse|hash-object|ls-tree)\b/g) || []).length, 4);
    }
    for (const workflow of [full, product]) {
        const resolve = workflow.split('      - name: Resolve the ScriptaHub source and the published images\n')[1].split('\n      - name: ')[0];
        assert.match(resolve, /SOURCE="\$GITHUB_WORKSPACE\/\.qa-scriptahub-source"/);
        assert.match(resolve, /scripta_dependency_fingerprint "\$SOURCE" "\$AGENT_REVISION"/);
        assert.match(resolve, /scripta_dependency_fingerprint "\$SOURCE" "\$HEAD_COMMIT"/);
        assert.ok(resolve.includes(fullBlocks[0]));
    }
    const fullBox = full.split("| run_in_box 'set -eu\n          read -r head\n          read -r expected")[1].split("'; then")[0];
    assert.ok(fullBox.includes(fullBlocks[0]));
    const productBox = product.split("SCRIPTAHUB_READ_PROGRAM='")[1].split("'\n")[0];
    assert.ok(productBox.includes(fullBlocks[0]));
    assert.match(productBox, /scripta_dependency_fingerprint ScriptaHubAgent "\$head"/);
    assert.match(product, /run_in_box "\$SCRIPTAHUB_READ_PROGRAM"/);
});
