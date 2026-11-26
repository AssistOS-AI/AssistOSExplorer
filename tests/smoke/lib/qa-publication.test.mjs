import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublication, incomingCopies, previousCopies } from '../../../.github/scripts/qaPublication.mjs';

function git(dir, ...args) {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function fixture(t, name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pub-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    return { root, repo };
}
function commit(repo, file, contents) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), contents);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'test');
    return git(repo, 'rev-parse', 'HEAD');
}

test('private publication uses runner checkout history and rejects wrong origin or branch', async t => {
    const { root, repo } = fixture(t, '.qa-promotionscout-source');
    const first = commit(repo, 'a', 'one');
    const second = commit(repo, 'a', 'two');
    const publication = createPublication({ runnerWorkspace: root, scratch: root });
    const input = { name: 'PromotionScoutV2', origin: 'https://github.com/AssistOS-AI/PromotionScoutV2.git', branch: 'main' };
    const result = await publication(input);
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.commits, new Set([second, first]));
    await assert.rejects(publication({ ...input, origin: 'https://github.com/evil/repo.git' }));
    await assert.rejects(publication({ ...input, deploymentBranch: 'other' }));
    await assert.rejects(publication({ ...input, origin: 'https://token@github.com/AssistOS-AI/PromotionScoutV2.git' }));
});

test('copy manifests archive committed data, restrict CSV subtree, and verify previous ancestry', t => {
    const { root, repo } = fixture(t, '.qa-csvmail-source');
    const first = commit(repo, 'csvMailAgent/file', 'old');
    commit(repo, 'data/private', 'must not appear');
    commit(repo, 'csvMailAgent/file', 'new');
    const options = { scope: 'full', runnerWorkspace: root, scratch: root };
    const biz = path.join(root, '.qa-bizanso-source');
    fs.mkdirSync(biz);
    git(biz, 'init', '-b', 'main');
    git(biz, 'config', 'user.name', 'Test');
    git(biz, 'config', 'user.email', 'test@example.com');
    commit(biz, 'file', 'biz');
    fs.writeFileSync(path.join(repo, 'csvMailAgent/file'), 'uncommitted');
    const incoming = incomingCopies(options);
    assert.deepEqual(incoming.simpleCSVMailSend.map(x => x.path), ['file']);
    const previous = previousCopies({ ...options, previousCommits: { simpleCSVMailSend: first } });
    assert.notEqual(previous.simpleCSVMailSend[0].sha256, incoming.simpleCSVMailSend[0].sha256);
    assert.throws(() => previousCopies({ ...options, previousCommits: { simpleCSVMailSend: 'a'.repeat(40) } }));
    assert.throws(() => previousCopies({ ...options, previousCommits: { simpleCSVMailSend: 'main' } }));
});


test('managed private copies use trusted runner history and require the selected branch', async t => {
    const { root, repo } = fixture(t, '.qa-bizanso-source');
    const first = commit(repo, 'file', 'first');
    const last = commit(repo, 'file', 'last');
    const publish = createPublication({ runnerWorkspace: root, scratch: root });
    const input = { name: '.ploinky/repos/bizanso', origin: 'https://github.com/Axiologic/bizanso.git', branch: 'main' };
    assert.deepEqual((await publish(input)).commits, new Set([last, first]));
    await assert.rejects(publish({ ...input, branch: 'other' }));
    await assert.rejects(publish({ ...input, origin: 'https://github.com/attacker/bizanso.git' }));
    const csv = path.join(root, '.qa-csvmail-source');
    fs.mkdirSync(csv);
    git(csv, 'init', '-b', 'main');
    git(csv, 'config', 'user.name', 'Test');
    git(csv, 'config', 'user.email', 'test@example.com');
    const csvHead = commit(csv, 'csvMailAgent/file', 'csv');
    assert.deepEqual((await publish({ name: '.ploinky/repos/simpleCSVMailSend', origin: 'https://github.com/Axiologic/simpleCSVMailSend.git', branch: 'main' })).commits, new Set([csvHead]));
});
