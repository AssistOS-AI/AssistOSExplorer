import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const section = workflow.match(/# BEGIN QA isolated Node runtime\n([\s\S]*?)# END QA isolated Node runtime/)[1].replace(/^ {10}/gm, '');
const x64Sha = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
const dist = 'node-v24.19.0-linux-x64';

function fixture(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-node-runtime-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const root = path.join(folder, 'tools');
    const shims = path.join(folder, 'shims');
    const archiveRoot = path.join(folder, 'archive');
    const archive = path.join(folder, 'node.tar.xz');
    fs.mkdirSync(shims);
    fs.mkdirSync(path.join(archiveRoot, dist, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, dist, 'bin/node'), '#!/bin/sh\nif [ "$1" = --version ]; then echo v24.19.0; else exec "$QA_REAL_NODE" "$@"; fi\n', { mode: 0o755 });
    execFileSync('tar', ['-cJf', archive, '-C', archiveRoot, dist]);
    fs.writeFileSync(path.join(shims, 'uname'), '#!/bin/sh\necho x86_64\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shims, 'curl'), '#!/bin/sh\nfor argument do destination="$argument"; done\necho fetch >> "$QA_FETCH_LOG"\ncp "$QA_FIXTURE_ARCHIVE" "$destination"\n', { mode: 0o755 });
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const source = 'set -euo pipefail\n' + section.replaceAll('/home/admin/.qa-deployment-tools', root).replaceAll(x64Sha, checksum);
    const run = (script = source) => spawnSync('bash', ['-c', script], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${shims}:${path.dirname(process.execPath)}:${process.env.PATH}`,
            QA_REAL_NODE: process.execPath, QA_FIXTURE_ARCHIVE: archive, QA_FETCH_LOG: path.join(folder, 'fetches') },
    });
    return { folder, root, source, run, node: path.join(root, dist, 'bin/node'), archive: path.join(root, `${dist}.tar.xz`) };
}

test('QA scoped Node installs a verified archive and reuses the exact validated binary', t => {
    const f = fixture(t);
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

test('QA scoped Node refuses a tampered cached binary before executing it', t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    const marker = path.join(f.folder, 'executed');
    fs.writeFileSync(f.node, `#!/bin/sh\ntouch '${marker}'\necho v24.19.0\n`);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.node-install-')), false);
});

test('QA scoped Node refuses checksum mismatch and unsafe tool roots without publishing a runtime', t => {
    const f = fixture(t);
    const badChecksum = f.source.replace(/QA_NODE_SHA=[a-f0-9]{64}/, `QA_NODE_SHA=${'0'.repeat(64)}`);
    assert.notEqual(f.run(badChecksum).status, 0);
    assert.equal(fs.existsSync(f.node), false);
    assert.equal(fs.existsSync(f.archive), false);
    fs.rmSync(f.root, { recursive: true });
    fs.symlinkSync(path.join(f.folder, 'archive'), f.root);
    assert.notEqual(f.run().status, 0);
    assert.equal(fs.existsSync(path.join(f.folder, 'archive', `${dist}.tar.xz`)), false);
});

test('QA Node pinning precedes recovery capture and never replaces the shared host installation', () => {
    assert.match(section, /https:\/\/nodejs\.org\/dist\/v24\.19\.0\//);
    assert.ok(section.includes(x64Sha));
    assert.ok(section.includes('01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc'));
    assert.match(section, /export PATH="\$QA_NODE_HOME\/bin:\$PATH"/);
    assert.match(section, /cmp -s/);
    assert.doesNotMatch(section, /sudo|apt-get|\/usr\/bin\/node|\/usr\/local\/bin\/node/);
    const start = workflow.indexOf('# BEGIN QA isolated Node runtime');
    assert(start > workflow.indexOf('// END QA capacity admission'));
    assert(start < workflow.indexOf('capture "$QA_BACKUP_DIR" --lock-held'));
    assert.match(workflow, /printf '%s\\n' "\$QA_NODE_HOME" > "\$QA_HELPER_DIR\/node-runtime-path"/);
});
