import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');

function block(name) {
    const match = workflow.match(new RegExp(`// BEGIN QA ${name}\\n([\\s\\S]*?)// END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-preservation-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    const backups = path.join(root, 'backups');
    const backup = path.join(backups, 'redeploy-Ab123456');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.join(backup, 'helpers'));
    fs.writeFileSync(path.join(backup, 'rollback-authority.json'), '{}', { mode: 0o600 });
    fs.writeFileSync(path.join(backup, 'prior-containers.txt'), '', { mode: 0o600 });
    const write = (relative, value = relative) => {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, value);
    };
    const read = relative => fs.readFileSync(path.join(target, relative), 'utf8');
    const execute = (name, command = execFileSync) => {
        const source = block(name)
            .replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(target))
            .replace("'/home/admin/.qa-deployment-backups'", JSON.stringify(backups));
        // The workflow runs this helper as root for mixed-UID database files.
        // The fixture uses its current owner; only the operator-ID prerequisite
        // is substituted, while all filesystem operations run on real files.
        const operator = { argv: ['node', '-', target, backup], getuid: () => 0 };
        const run = (program, args, options) => command(program,
            program === 'cp' && process.platform === 'darwin'
                ? args.filter(argument => argument !== '--reflink=auto') : args, options);
        new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
            assert, fs, path, run, operator, { log() {} },
        );
    };
    return { root, target, backup, write, read, execute };
}

test('ordinary QA redeploy retains documents, local skills, databases and the key/account set', t => {
    const f = fixture(t);
    const durable = ['.data/dpu-data/blobs/one', '.data/umamiAgent/postgres/PG_VERSION',
        '.data/umamiAgent/postgres/pg_wal/one', '.data/soul-gateway/data.sqlite-wal',
        '.data/roboTeamAgent/robots/default/copilot/sessions/one.json',
        'project/notes.txt', 'project/.agents/skills/local/SKILL.md', '.agents/skills/root/SKILL.md',
        '.ploinky/master-key', '.ploinky/.secrets', '.ploinky/passwords.enc',
        '.ploinky/ploinky_subject_identity_ed25519_v1.enc', '.ploinky/profile', '.ploinky/code/local.mjs',
        '.ploinky/skills/authored/SKILL.md', '.ploinky/servers.json', '.ploinky/repo_sources.json',
        '.ploinky/enabled_repos.json', '.ploinky/ploinky_history', '.ploinky/operator-notes.md',
        '.ploinky/data/custom-store/authored.txt'];
    for (const name of durable) f.write(name, `original:${name}`);
    for (const name of ['.ploinky/agents.json', '.ploinky/running/old.pid', '.ploinky/data/edge-routing/active.json',
        '.ploinky/run/edge-topology/current.json', '.runtime/ploinky/old-source', 'AdvancedLanguageAgent/old-source']) f.write(name);
    f.execute('durable workspace preservation');
    for (const name of durable) {
        assert.equal(f.read(name), `original:${name}`);
        assert.equal(fs.readFileSync(path.join(f.backup, 'workspace', name), 'utf8'), `original:${name}`);
    }
    for (const name of ['.ploinky/agents.json', '.ploinky/running', '.ploinky/data/edge-routing',
        '.ploinky/run', '.runtime', 'AdvancedLanguageAgent']) assert.equal(fs.existsSync(path.join(f.target, name)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.backup, 'preservation.json'))).exactCopiesVerified, true);
});

test('QA preservation refuses missing encryption identity before moving durable data', t => {
    const f = fixture(t);
    f.write('.data/dpu-data/blobs/one', 'ciphertext');
    assert.throws(() => f.execute('durable workspace preservation'));
    assert.equal(f.read('.data/dpu-data/blobs/one'), 'ciphertext');
    assert.equal(fs.existsSync(path.join(f.backup, 'workspace')), false);
});

test('QA preservation retains dangling and container-namespace symlink targets verbatim', t => {
    const f = fixture(t);
    fs.mkdirSync(f.target);
    fs.symlinkSync('future-project', path.join(f.target, 'project-link'));
    fs.symlinkSync('/workspace/source', path.join(f.target, 'container-link'));
    f.write('project/notes.txt', 'durable');
    fs.symlinkSync('../missing-helper', path.join(f.target, 'project/helper'));
    f.execute('durable workspace preservation');
    assert.equal(fs.readlinkSync(path.join(f.target, 'project-link')), 'future-project');
    assert.equal(fs.readlinkSync(path.join(f.target, 'container-link')), '/workspace/source');
    assert.equal(fs.readlinkSync(path.join(f.target, 'project/helper')), '../missing-helper');
});

test('QA bootstrap preserves operator env formatting and extra settings exactly', t => {
    const f = fixture(t);
    const value = '# Operator configuration\r\nCUSTOM_SETTING=retained\r\nPLOINKY_MASTER_KEY=prior-bootstrap-value\r\n';
    f.write('.env', value);
    const execute = () => new Function('fs', 'process', block('bootstrap environment'))(fs, {
        argv: ['node', '-', path.join(f.target, '.env')],
        env: { PLOINKY_MASTER_KEY: 'a'.repeat(64) }, getuid: () => fs.statSync(f.target).uid,
    });
    execute();
    assert.equal(f.read('.env'), value);
    fs.unlinkSync(path.join(f.target, '.env'));
    execute();
    assert.equal(f.read('.env'), `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
});

test('QA admission rejects unsafe env and modified managed sources before any retirement', t => {
    const f = fixture(t);
    f.write('.env', '# retained operator config');
    f.execute('preservation admission');
    fs.unlinkSync(path.join(f.target, '.env'));
    fs.symlinkSync('missing', path.join(f.target, '.env'));
    assert.throws(() => f.execute('preservation admission'), /Unsafe operator/);
    fs.unlinkSync(path.join(f.target, '.env'));
    const runtime = path.join(f.target, '.runtime/ploinky');
    fs.mkdirSync(runtime, { recursive: true });
    execFileSync('git', ['init', '-q', runtime]);
    execFileSync('git', ['-C', runtime, 'remote', 'add', 'origin', 'https://github.com/AssistOS-AI/ploinky.git']);
    f.execute('preservation admission');
    f.write('.runtime/ploinky/local-skill.mjs', 'authored source');
    assert.throws(() => f.execute('preservation admission'), /Local managed source edits/);
    assert.equal(f.read('.runtime/ploinky/local-skill.mjs'), 'authored source');
    assert.ok(workflow.indexOf('// END QA preservation admission') < workflow.indexOf('Stopping nested QA services'));
});

test('failed QA copy retains the complete predecessor and emits no successful receipt', t => {
    const f = fixture(t);
    f.write('.data/dpu-data/blob', 'ciphertext');
    f.write('.ploinky/master-key', 'original-key');
    assert.throws(() => f.execute('durable workspace preservation', () => { throw new Error('Injected copy failure'); }), /Injected copy failure/);
    assert.equal(fs.readFileSync(path.join(f.backup, 'workspace/.data/dpu-data/blob'), 'utf8'), 'ciphertext');
    assert.equal(fs.readFileSync(path.join(f.backup, 'workspace/.ploinky/master-key'), 'utf8'), 'original-key');
    assert.equal(fs.existsSync(path.join(f.backup, 'preservation.json')), false);
});

test('cold QA preservation creates empty state and never overwrites an earlier backup', t => {
    const f = fixture(t);
    f.execute('durable workspace preservation');
    assert.equal(fs.statSync(path.join(f.target, '.ploinky')).isDirectory(), true);
    const receipt = fs.readFileSync(path.join(f.backup, 'preservation.json'));
    assert.throws(() => f.execute('durable workspace preservation'), /backup must contain only/);
    assert.deepEqual(fs.readFileSync(path.join(f.backup, 'preservation.json')), receipt);
});

test('QA policy restore retains revocations and audit while excluding old compiled generations', t => {
    const f = fixture(t);
    const files = ['policy-state.json', 'sessions-revocations.json', 'policy-audit.log', 'policy-audit-archive/old.log'];
    for (const name of files) f.write(`.ploinky/data/router-security/${name}`, `retained:${name}`);
    f.write('.ploinky/data/edge-routing/active.json', 'obsolete-generation');
    f.execute('durable workspace preservation');
    assert.throws(() => f.execute('policy restoration'), /Initialize fresh routing sources/);
    f.write('.ploinky/data/router-security/policy-state.json', '{}');
    f.execute('policy restoration');
    for (const name of files) assert.equal(f.read(`.ploinky/data/router-security/${name}`), `retained:${name}`);
    assert.equal(fs.existsSync(path.join(f.target, '.ploinky/data/edge-routing/active.json')), false);
});

test('QA workflow quiesces before backup, retains the old runtime, and restores policy before activation', () => {
    const shutdown = workflow.indexOf("printf '%s' \"$QA_QUIESCE_SOURCE\" | \"$engine\" container exec");
    assert.ok(shutdown > 0 && shutdown < workflow.indexOf('"$engine" container stop --time 30'));
    assert.ok(workflow.indexOf('capture "$QA_BACKUP_DIR" --lock-held') < shutdown);
    assert.ok(workflow.indexOf('result.rollbackSupported !== true') < shutdown);
    assert.ok(workflow.indexOf('// END QA capacity admission') < shutdown);
    assert.ok(workflow.indexOf('"$engine" container stop --time 30') < workflow.indexOf('// BEGIN QA durable workspace preservation'));
    assert.ok(workflow.indexOf('// END QA durable workspace preservation') < workflow.indexOf('"$engine" container rename "$container_id"'));
    assert.ok(workflow.indexOf('// END QA policy restoration') < workflow.indexOf('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'));
    assert.ok(workflow.indexOf('timed out waiting for stable 14/14') < workflow.indexOf('// BEGIN QA prior selection restoration'));
    assert.doesNotMatch(workflow, /fs\.rmSync\(target, \{ recursive: true/);
    assert.doesNotMatch(workflow, /-X POST|CLOUDFLARE_TUNNEL_CREATED='true'/);
});

test('capacity admission refuses a full QA disk before any workspace move', t => {
    const f = fixture(t);
    const run = available => new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console',
        block('capacity admission').replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(f.target)))(
        assert, { ...fs, statfsSync: () => ({ bavail: available, bsize: 1n }) }, path,
        () => '25000000000 workspace', { argv: ['node', '-', f.target] }, { log() {} },
    );
    assert.throws(() => run(375000000n), /Insufficient QA capacity/);
    assert.equal(fs.existsSync(f.target), false);
    run(30n * 1024n ** 3n);
    f.write('operator-file', 'retained');
    assert.throws(() => run(26n * 1024n ** 3n), /Insufficient QA capacity/);
    assert.equal(f.read('operator-file'), 'retained');
});

test('selected QA tunnel must exist with its exact identity before token retrieval', t => {
    const marker = workflow.indexOf("const tunnels = payload?.success === true ? payload.result : null;");
    const start = workflow.lastIndexOf("<<'NODE'\n", marker) + "<<'NODE'\n".length;
    const end = workflow.indexOf('\n          NODE', marker);
    const script = workflow.slice(start, end).replace(/^ {10}/gm, '');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-selected-tunnel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const inventory = path.join(root, 'inventory.json');
    const id = '89dd05b5-05a7-4bd4-9626-ec4343b07c67';
    const run = result => {
        fs.writeFileSync(inventory, JSON.stringify({ success: true, result }));
        return spawnSync(process.execPath, ['--input-type=module', '-', inventory], {
            input: script, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_SELECTED_TUNNEL_ID: id, CLOUDFLARE_TUNNEL_NAME: 'explorer-qa' },
        });
    };
    assert.equal(run([{ id, name: 'explorer-qa' }]).stdout, id);
    for (const result of [[], [{ id: 'wrong', name: 'explorer-qa' }], [{ id, name: 'other' }],
        [{ id, name: 'explorer-qa', deleted_at: 'yesterday' }], [{ id }, { id }]]) {
        const observed = run(result);
        assert.notEqual(observed.status, 0);
        assert.match(observed.stderr, /deployment cannot create a tunnel/);
    }
});
