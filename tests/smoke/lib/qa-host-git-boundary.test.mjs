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
    ['.github/workflows/deploy-explorer-qa.yml', /git ls-remote/, 6, 'remote query; no local repository'],
    ['.github/workflows/deploy-explorer-qa.yml', /^for tool in git node curl; do$/, 1, 'prerequisite presence check'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git check-ref-format --branch "\$default_branch"/, 1, 'ref-name syntax; no repository'],
    ['.github/workflows/deploy-explorer-qa.yml', /"\$QA_LOCK_SOURCE"/, 5, 'cold lock runtime in the private helper directory, outside any workspace'],
    ['.github/workflows/deploy-explorer-qa.yml', /ERROR: managed runtime path is not a Ploinky git checkout/, 1, 'message text'],
    ['.github/workflows/deploy-explorer-qa.yml', /git (?:clone --no-checkout https:\/\/github\.com\/AssistOS-AI\/ploinky\.git |-C )"\$RUNTIME_DIR"/, 8, 'PRE_BOX'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git clone --single-branch --branch "\$ALA_BRANCH" "\$ALA_URL" "\$ALA_DIR"$/, 1, 'PRE_BOX'],
    ['.github/workflows/deploy-explorer-qa.yml', /^git -C "\$WORK_DIR\/\.ploinky\/repos\/\$repository_name" /, 4, 'IN_BOX'],
    // Destroy reads the dedicated runtime checkout whose Ploinky code the host then
    // runs for teardown. Every Box mounts that checkout read-only (D6).
    ['.github/workflows/destroy-explorer-qa.yml', /git -C "\$RUNTIME_DIR"/, 5, 'invoking Ploinky checkout executed by the host'],
    ['.github/workflows/destroy-explorer-qa.yml', /git ls-remote/, 1, 'remote query; no local repository'],
    ['.github/workflows/destroy-explorer-qa.yml', /^git check-ref-format --branch "\$default_branch"/, 1, 'ref-name syntax; no repository'],
    ['.github/workflows/destroy-explorer-qa.yml', /^for tool in git node curl; do$/, 1, 'prerequisite presence check'],
    ['.github/scripts/rollback-explorer-qa.mjs', /./, 7, 'IN_SANDBOX'],
    ['.github/scripts/rollback-explorer-qa.mjs', /'--entrypoint=\/usr\/bin\/git', image,/, 1, 'sandbox container entrypoint'],
    ['.github/scripts/update-explorer-qa.mjs', /operation: `git-\$\{args\[0\]\}`/, 1, 'failure label of a sandboxed command'],
    ['tests/smoke/lib/retired-source-absence.test.mjs', /execFileSync\('git', \['ls-files'/, 1, 'GitHub-hosted runner over the repository checkout; no Box'],
];

// The QA workflows, every script directory they invoke under .github, and every
// other repository file they invoke.
function targets() {
    const workflows = fs.readdirSync(new URL('.github/workflows/', ROOT)).map(name => `.github/workflows/${name}`);
    const files = new Set(workflows), directories = new Set();
    for (const workflow of workflows) {
        for (const [, relative] of fs.readFileSync(new URL(workflow, ROOT), 'utf8')
            .matchAll(/(?<![\w$/.-])((?:\.github|tests|scripts|explorer|shared)\/[\w./-]+\.(?:mjs|cjs|js|sh|py))/g)) {
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
        '.github/scripts/rollback-explorer-qa.mjs', '.github/scripts/update-explorer-qa.mjs', '.github/scripts/cleanup-explorer-host.mjs',
        '.github/scripts/verify-explorer-qa-runtime.mjs', '.github/scripts/quiesce-explorer-qa.mjs',
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
                // Fresh host checkouts staged after the prior workspace was retired and
                // before the recreated workspace's Box is prepared: no Box can write them yet.
                const at = lines.slice(0, row.index).join('\n').length;
                assert.ok(at > text.indexOf('// END QA durable workspace preservation') && at < text.indexOf('prepareBoxForCommand'),
                    `${file}:${row.index + 1} runs host Git outside the pre-Box staging window`);
            }
        }
    }
    assert.deepEqual(unreviewed, [], 'unreviewed Git mentions');
    for (const [entry, count] of counts) assert.equal(count, entry[2], `${entry[0]} ${entry[1]}: ${entry[3]}`);
});

test('Q1: the fresh runtime and ALA checkouts staged on the host are never copied from the retired workspace', () => {
    const workflow = fs.readFileSync(new URL('.github/workflows/deploy-explorer-qa.yml', ROOT), 'utf8');
    const preservation = workflow.split('// BEGIN QA durable workspace preservation')[1].split('// END QA durable workspace preservation')[0];
    assert.match(preservation, /const regenerated = new Set\(\['\.ploinky', '\.ploinky-box', '\.runtime', 'AdvancedLanguageAgent'\]\);/);
    assert.match(workflow, /\[ -e "\$ALA_DIR" \] \|\| \[ -L "\$ALA_DIR" \]; then\n\s+echo "\[deploy-qa\] ERROR: ALA requires an exact default-branch commit and an absent fresh checkout\."/);
    // After the Box is prepared, the workflow checks those checkouts only in the sandbox.
    const prepared = workflow.indexOf('prepareBoxForCommand');
    const verifications = [...workflow.matchAll(/\n {10}verify_ala_checkout\n/g)].map(match => match.index);
    assert.ok(verifications.length === 2 && verifications.every(index => index > prepared));
    assert.match(workflow, /QA_RUNTIME_HEAD="\$\(qa_sandboxed_git "\$RUNTIME_DIR" rev-parse HEAD\)"/);
    assert.match(workflow, /productionAdapters\(\)\.sourceCheck\(directory, \{ engine, image \}\)/);
});
