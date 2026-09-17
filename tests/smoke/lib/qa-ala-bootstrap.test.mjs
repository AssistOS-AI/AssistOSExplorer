import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const marker = workflow.indexOf('const [alaRoot, selectedAgentLib] = process.argv.slice(2);');
const start = workflow.lastIndexOf("<<'NODE'\n", marker) + "<<'NODE'\n".length;
const end = workflow.indexOf('\n          NODE', marker);
const script = workflow.slice(start, end).replace(/^ {10}/gm, '');

test('QA provisions exact default-branch ALA before admission without a private dependency install', () => {
    assert.ok(marker > 0 && end > start, 'ALA preflight heredoc must exist and close');
    assert.match(workflow, /ALA_BRANCH="\$\(resolve_default_branch "\$ALA_URL"\)"/);
    assert.match(workflow, /ALA_COMMIT="\$\(git ls-remote --exit-code --heads/);
    assert.match(workflow, /\[ -e "\$ALA_DIR" \] \|\| \[ -L "\$ALA_DIR" \]/);
    assert.match(workflow, /git clone --single-branch --branch "\$ALA_BRANCH" "\$ALA_URL" "\$ALA_DIR"/);
    assert.match(workflow, /node --input-type=module - "\$WORK_DIR\/AdvancedLanguageAgent" \/opt\/ploinky-agentlib/);
    assert.match(workflow, /\$\(git -C "\$ALA_DIR" rev-parse HEAD\)" != "\$ALA_COMMIT"/);
    assert.match(workflow, /git -C "\$ALA_DIR" status --porcelain/);
    assert.equal(workflow.match(/^          verify_ala_checkout$/gm)?.length, 3);
    assert.ok(marker < workflow.indexOf('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'));
    assert.doesNotMatch(script, /npm|git clone/);
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ala-bootstrap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ala = path.join(root, 'AdvancedLanguageAgent');
    const selected = path.join(root, 'selected-agentlib');
    fs.mkdirSync(path.join(ala, 'src'), { recursive: true });
    fs.mkdirSync(path.join(ala, 'bin'));
    fs.mkdirSync(selected);
    fs.writeFileSync(path.join(ala, 'package.json'), JSON.stringify({
        name: 'advanced-language-agent', dependencies: { 'ploinky-agent-lib': 'git+https://example.invalid/lib' },
    }));
    fs.writeFileSync(path.join(selected, 'package.json'), JSON.stringify({ name: 'ploinky-agent-lib', main: 'index.mjs' }));
    fs.writeFileSync(path.join(selected, 'index.mjs'), 'export class MainAgent {}\nexport class LLMAgent {}\n');
    fs.writeFileSync(path.join(ala, 'src/achilles-loader.mjs'), `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export async function loadAchillesAgentLib() {
    const entry = createRequire(import.meta.url).resolve('ploinky-agent-lib');
    return { entry, strategy: 'package', module: await import(pathToFileURL(entry).href) };
}
`);
    fs.writeFileSync(path.join(ala, 'bin/ala.mjs'), "console.log('--home --cwd --MCPServers');\n", { mode: 0o755 });
    return { ala, selected, run: () => spawnSync(process.execPath, ['--input-type=module', '-', ala, selected], {
        input: script, encoding: 'utf8', timeout: 30000,
    }) };
}

test('ALA preflight imports the selected library and is idempotent', (t) => {
    const f = fixture(t);
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /ALA imports the selected AgentLib/);
        assert.equal(fs.readlinkSync(path.join(f.ala, 'node_modules/ploinky-agent-lib')), f.selected);
    }
});

for (const kind of ['missing-checkout', 'symlink-checkout', 'new-dependency', 'symlink-modules', 'private-copy', 'wrong-binding', 'shadow-loader', 'missing-export', 'missing-executable', 'old-cli', 'failed-cli']) {
    test(`ALA preflight rejects ${kind}`, (t) => {
        const f = fixture(t);
        const binding = path.join(f.ala, 'node_modules/ploinky-agent-lib');
        if (kind === 'missing-checkout') fs.renameSync(f.ala, `${f.ala}-absent`);
        if (kind === 'symlink-checkout') {
            fs.renameSync(f.ala, `${f.ala}-real`);
            fs.symlinkSync(`${f.ala}-real`, f.ala);
        }
        if (kind === 'new-dependency') fs.writeFileSync(path.join(f.ala, 'package.json'), JSON.stringify({ name: 'advanced-language-agent', dependencies: { unexpected: '*' } }));
        if (kind === 'symlink-modules') fs.symlinkSync(f.selected, path.join(f.ala, 'node_modules'));
        if (kind === 'private-copy' || kind === 'wrong-binding') {
            fs.mkdirSync(path.dirname(binding));
            if (kind === 'private-copy') fs.mkdirSync(binding);
            else fs.symlinkSync('/does-not-exist', binding);
        }
        if (kind === 'shadow-loader') fs.writeFileSync(path.join(f.ala, 'src/achilles-loader.mjs'), "export async function loadAchillesAgentLib() { return { strategy: 'parent-directory' }; }\n");
        if (kind === 'missing-export') fs.writeFileSync(path.join(f.selected, 'index.mjs'), 'export class MainAgent {}\n');
        if (kind === 'missing-executable') fs.chmodSync(path.join(f.ala, 'bin/ala.mjs'), 0o644);
        if (kind === 'old-cli') fs.writeFileSync(path.join(f.ala, 'bin/ala.mjs'), "console.log('--home --cwd');\n");
        if (kind === 'failed-cli') fs.writeFileSync(path.join(f.ala, 'bin/ala.mjs'), 'process.exit(2);\n');
        const result = f.run();
        assert.notEqual(result.status, 0, `${kind} unexpectedly passed`);
        assert.equal(result.stdout.includes('ALA imports the selected AgentLib'), false);
    });
}
