import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const marker = workflow.indexOf('const [alaRoot] = process.argv.slice(2);');
const start = workflow.lastIndexOf("<<'NODE'\n", marker) + "<<'NODE'\n".length;
const end = workflow.indexOf('\n          NODE', marker);
const script = workflow.slice(start, end).replace(/^ {10}/gm, '');

test('QA provisions exact default-branch ALA before admission without a dependency install or binding', () => {
    assert.ok(marker > 0 && end > start, 'ALA preflight heredoc must exist and close');
    assert.match(workflow, /ALA_BRANCH="\$\(resolve_default_branch "\$ALA_URL"\)"/);
    assert.match(workflow, /ALA_COMMIT="\$\(git ls-remote --exit-code --heads/);
    assert.match(workflow, /\[ -e "\$ALA_DIR" \] \|\| \[ -L "\$ALA_DIR" \]/);
    assert.match(workflow, /git clone --single-branch --branch "\$ALA_BRANCH" "\$ALA_URL" "\$ALA_DIR"/);
    assert.match(workflow, /node --input-type=module - "\$WORK_DIR\/AdvancedLanguageAgent" <<'NODE'/);
    // The checkout is verified only in the source sandbox, once the QA Box is prepared:
    // clean, at its reviewed origin, on the selected branch, commit and upstream.
    assert.doesNotMatch(workflow, /git -C "\$ALA_DIR"/);
    assert.match(workflow, /const \{ pin, upstream \} = productionAdapters\(\)\.sourceCheck\(directory, \{ engine, image \}\);/);
    assert.match(workflow, /if \(pin\.commit !== commit \|\| pin\.branch !== branch \|\| upstream !== `origin\/\$\{branch\}`\) process\.exit\(1\);/);
    const calls = [...workflow.matchAll(/^          verify_ala_checkout$/gm)].map(match => match.index);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(index => index > workflow.indexOf('prepareBoxForCommand')));
    assert.ok(marker < workflow.indexOf('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'));
    assert.doesNotMatch(script, /npm|git clone|node_modules|symlinkSync|achilles-loader|selectedAgentLib/);
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ala-bootstrap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ala = path.join(root, 'AdvancedLanguageAgent');
    fs.mkdirSync(path.join(ala, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ala, 'package.json'), JSON.stringify({ name: 'advanced-language-agent' }));
    fs.writeFileSync(path.join(ala, 'bin/ala.mjs'), "console.log('--home --cwd --MCPServers');\n", { mode: 0o755 });
    return { ala, run: () => spawnSync(process.execPath, ['--input-type=module', '-', ala], {
        input: script, encoding: 'utf8', timeout: 30000,
    }) };
}

test('dependency-free ALA preflight succeeds repeatedly without creating node_modules', t => {
    const f = fixture(t);
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Dependency-free ALA supports/);
        assert.equal(fs.existsSync(path.join(f.ala, 'node_modules')), false);
    }
});

for (const kind of ['missing-checkout', 'symlink-checkout', 'wrong-package', 'dependencies', 'optionalDependencies', 'peerDependencies', 'symlink-bin', 'missing-executable', 'symlink-executable', 'non-executable', 'old-cli', 'failed-cli']) {
    test(`ALA preflight rejects ${kind}`, t => {
        const f = fixture(t);
        const executable = path.join(f.ala, 'bin/ala.mjs');
        if (kind === 'missing-checkout') fs.renameSync(f.ala, `${f.ala}-absent`);
        if (kind === 'symlink-checkout') {
            fs.renameSync(f.ala, `${f.ala}-real`);
            fs.symlinkSync(`${f.ala}-real`, f.ala);
        }
        if (kind === 'wrong-package') fs.writeFileSync(path.join(f.ala, 'package.json'), JSON.stringify({ name: 'another-package' }));
        if (['dependencies', 'optionalDependencies', 'peerDependencies'].includes(kind)) {
            fs.writeFileSync(path.join(f.ala, 'package.json'), JSON.stringify({ name: 'advanced-language-agent', [kind]: { unexpected: '*' } }));
        }
        if (kind === 'symlink-bin') {
            fs.renameSync(path.join(f.ala, 'bin'), path.join(f.ala, 'real-bin'));
            fs.symlinkSync('real-bin', path.join(f.ala, 'bin'));
        }
        if (kind === 'missing-executable') fs.unlinkSync(executable);
        if (kind === 'symlink-executable') {
            fs.renameSync(executable, `${executable}.real`);
            fs.symlinkSync('ala.mjs.real', executable);
        }
        if (kind === 'non-executable') fs.chmodSync(executable, 0o644);
        if (kind === 'old-cli') fs.writeFileSync(executable, "console.log('--home --cwd');\n");
        if (kind === 'failed-cli') fs.writeFileSync(executable, 'process.exit(2);\n');
        const result = f.run();
        assert.notEqual(result.status, 0, `${kind} unexpectedly passed`);
        assert.equal(result.stdout.includes('Dependency-free ALA supports'), false);
        assert.equal(fs.existsSync(path.join(f.ala, 'node_modules')), false);
    });
}
