import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService } from '../../lib/git-service.mjs';
import { LARGE_FILE_WARNING_BYTES } from '../../lib/git/large-files.mjs';
import { runGitWithLargeFileWarning, requestLargeFileConsent } from '../../IDE-plugins/git-tool-button/utils/git-large-file-warning.js';
import { createGitCommitService } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-service.js';
import { GitLargeFilesModal } from '../../IDE-plugins/git-tool-button/components/git-large-files-modal/git-large-files-modal.js';

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
}

async function withRepo(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-large-files-'));
    try {
        const repo = path.join(root, 'repo');
        const remote = path.join(root, 'remote.git');
        git(root, 'init', '--bare', '--initial-branch=main', remote);
        git(root, 'init', '--initial-branch=main', repo);
        git(repo, 'config', 'user.name', 'Test');
        git(repo, 'config', 'user.email', 'test@example.com');
        await fs.writeFile(path.join(repo, 'README.md'), 'initial\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'Initial');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '-u', 'origin', 'main');
        const service = createGitService({ validatePath: async (value) => {
            const real = await fs.realpath(value);
            assert.equal(real, await fs.realpath(repo));
            return real;
        } });
        await run({ root, repo, remote, service });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function largeFile(repo, name = 'large file ș.bin', size = LARGE_FILE_WARNING_BYTES) {
    const handle = await fs.open(path.join(repo, name), 'w');
    try { await handle.truncate(size); } finally { await handle.close(); }
    return name;
}

test('commit warns on staged blob size, preserves HEAD/index, and only accepts approved blob IDs', async () => {
    await withRepo(async ({ repo, service }) => {
        const name = await largeFile(repo, 'large\nfile ș.bin');
        git(repo, 'add', '--', name);
        const before = { head: git(repo, 'rev-parse', 'HEAD'), index: git(repo, 'ls-files', '--stage', '-z') };
        // Working-tree size is deliberately different from the version being committed.
        await fs.writeFile(path.join(repo, name), 'small unstaged replacement');
        const warning = await service.gitCommit({ path: repo, message: 'Large addition' });
        assert.equal(warning.code, 'large_files_warning');
        assert.equal(warning.files[0].path, name);
        assert.equal(warning.files[0].sizeBytes, LARGE_FILE_WARNING_BYTES);
        assert.deepEqual({ head: git(repo, 'rev-parse', 'HEAD'), index: git(repo, 'ls-files', '--stage', '-z') }, before);
        assert.equal((await service.gitCommit({ path: repo, message: 'Still denied', approvedLargeFileOids: ['0'.repeat(40)] })).ok, false);
        await assert.rejects(() => service.gitCommit({ path: repo, message: 'Invalid', approvedLargeFileOids: true }), /array of Git blob IDs/);
        assert.equal((await service.gitCommit({ path: repo, message: 'Approved', approvedLargeFileOids: [warning.files[0].oid] })).ok, true);
        assert.equal(await fs.readFile(path.join(repo, name), 'utf8'), 'small unstaged replacement');
    });
});

test('untracked/unstaged large files and blobs below the threshold do not warn', async () => {
    await withRepo(async ({ repo, service }) => {
        await largeFile(repo, 'untracked.bin');
        await fs.writeFile(path.join(repo, 'README.md'), 'small staged content');
        git(repo, 'add', 'README.md');
        await largeFile(repo, 'README.md');
        assert.equal((await service.gitCommit({ path: repo, message: 'Small' })).ok, true);
        await largeFile(repo, 'almost.bin', LARGE_FILE_WARNING_BYTES - 1);
        git(repo, 'add', 'almost.bin');
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'commit' })).ok, true);
    });
});

test('push warns on a deleted historical blob and leaves the remote untouched until approval', async () => {
    await withRepo(async ({ repo, remote, service }) => {
        const name = await largeFile(repo);
        git(repo, 'add', name);
        git(repo, 'commit', '-m', 'Large file');
        git(repo, 'rm', name);
        git(repo, 'commit', '-m', 'Delete it');
        const before = git(remote, 'rev-parse', 'refs/heads/main');
        const warning = await service.gitPush({ path: repo });
        assert.equal(warning.code, 'large_files_warning');
        assert.equal(warning.files[0].path, name);
        assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), before);
        assert.equal((await service.gitPush({ path: repo, approvedLargeFileOids: warning.files.map((file) => file.oid) })).ok, true);
        assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(repo, 'rev-parse', 'HEAD'));
        assert.equal((await service.gitPush({ path: repo })).ok, true);
    });
});

test('a previously approved blob does not approve a changed large version', async () => {
    await withRepo(async ({ repo, service }) => {
        const name = await largeFile(repo);
        git(repo, 'add', name);
        const first = await service.gitCheckLargeFiles({ path: repo, operation: 'commit' });
        await fs.appendFile(path.join(repo, name), 'x');
        git(repo, 'add', name);
        const next = await service.gitCommit({ path: repo, message: 'Changed', approvedLargeFileOids: [first.files[0].oid] });
        assert.equal(next.code, 'large_files_warning');
        assert.notEqual(next.files[0].oid, first.files[0].oid);
    });
});

test('push checks explicit and configured source branches, not only checked-out HEAD', async () => {
    await withRepo(async ({ repo, service }) => {
        git(repo, 'checkout', '-b', 'feature');
        const name = await largeFile(repo);
        git(repo, 'add', name);
        git(repo, 'commit', '-m', 'Feature with large blob');
        git(repo, 'checkout', 'main');
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'push' })).ok, true);
        assert.equal((await service.gitPush({ path: repo, branch: 'feature:feature' })).code, 'large_files_warning');
        git(repo, 'config', 'remote.origin.push', 'refs/heads/feature:refs/heads/feature');
        assert.equal((await service.gitPush({ path: repo })).code, 'large_files_warning');
        git(repo, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
        assert.equal((await service.gitPush({ path: repo })).code, 'large_files_warning');
        // Explicit --set-upstream ignores the configured push refspecs.
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'push', setUpstream: true })).ok, true);
        git(repo, 'config', '--unset', 'remote.origin.push');
        git(repo, 'config', 'push.default', 'matching');
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'push' })).code, 'large_files_warning');
        git(repo, 'config', 'push.default', 'simple');
        git(repo, 'config', 'remote.origin.mirror', 'true');
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'push' })).code, 'large_files_warning');
    });
});

test('warnings occur before any GitHub request and unsupported operations fail', async () => {
    await withRepo(async ({ repo, service }) => {
        const name = await largeFile(repo);
        git(repo, 'add', name);
        git(repo, 'commit', '-m', 'Large');
        git(repo, 'remote', 'set-url', 'origin', 'https://github.com/test/absent.git');
        const oldFetch = globalThis.fetch;
        globalThis.fetch = () => { throw new Error('Unexpected GitHub call'); };
        try {
            assert.equal((await service.gitPush({ path: repo })).code, 'large_files_warning');
            await assert.rejects(() => service.gitCheckLargeFiles({ path: repo, operation: 'delete' }), /operation/);
        } finally { globalThis.fetch = oldFetch; }
    });
});

test('submodule gitlinks are not treated as missing blobs; unreadable staged blobs fail closed', async () => {
    await withRepo(async ({ repo, service }) => {
        const missing = 'b'.repeat(40);
        git(repo, 'update-index', '--add', '--cacheinfo', `160000,${missing},external`);
        assert.equal((await service.gitCheckLargeFiles({ path: repo, operation: 'commit' })).ok, true);
        git(repo, 'update-index', '--add', '--cacheinfo', `100644,${missing},corrupt.bin`);
        const before = git(repo, 'rev-parse', 'HEAD');
        await assert.rejects(() => service.gitCommit({ path: repo, message: 'Must stop' }), /Could not inspect Git object/);
        assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    });
});

const warning = { ok: false, code: 'large_files_warning', operation: 'commit', thresholdBytes: LARGE_FILE_WARNING_BYTES,
    files: [{ oid: 'a'.repeat(40), path: 'archive.bin', sizeBytes: LARGE_FILE_WARNING_BYTES }] };
const raw = (json) => ({ content: [{ type: 'text', text: JSON.stringify(json) }] });

test('Abort/dismiss never calls commit/push or remote setup and stops AutoSync', async () => {
    for (const toolName of ['git_commit', 'git_push']) {
        const calls = [];
        await assert.rejects(() => runGitWithLargeFileWarning({
            toolName, args: { path: '/workspace/repo' },
            callAgentTool: async (_agent, tool) => { calls.push(tool); return raw(warning); },
            confirm: async () => false,
            beforeMutation: () => calls.push('remote setup'),
            onAbort: () => calls.push('stop AutoSync')
        }), { code: 'large_files_aborted' });
        assert.deepEqual(calls, ['git_check_large_files', 'stop AutoSync']);
    }
});

test('Continue passes only explicit blob approvals and re-prompts for a newly discovered blob', async () => {
    const calls = [];
    let prompts = 0;
    await runGitWithLargeFileWarning({
        toolName: 'git_commit', args: { path: '/workspace/repo', message: 'Keep draft' },
        callAgentTool: async (_agent, tool, args) => {
            calls.push({ tool, args });
            if (calls.length === 1) return raw(warning);
            if (calls.length === 2) return raw({ ...warning, files: [{ ...warning.files[0], oid: 'b'.repeat(40) }] });
            return raw({ ok: true, stdout: 'Committed' });
        },
        confirm: async () => { prompts++; return true; }
    });
    assert.equal(prompts, 2);
    assert.deepEqual(calls[1].args.approvedLargeFileOids, ['a'.repeat(40)]);
    assert.deepEqual(calls[2].args.approvedLargeFileOids, ['a'.repeat(40), 'b'.repeat(40)]);
    assert.equal(calls[2].args.message, 'Keep draft');
});

test('preflight errors fail closed and a closed view invalidates approval', async () => {
    await assert.rejects(() => runGitWithLargeFileWarning({
        toolName: 'git_commit', args: { path: '/workspace/repo' },
        callAgentTool: async () => raw({ ok: false, error: 'Object scan failed' })
    }), /Object scan failed/);
    let active = true;
    let calls = 0;
    await assert.rejects(() => runGitWithLargeFileWarning({
        toolName: 'git_commit', args: { path: '/workspace/repo' },
        callAgentTool: async () => { calls++; return raw(warning); },
        isActive: () => active, confirm: async () => { active = false; return true; }
    }), { code: 'large_files_aborted' });
    assert.equal(calls, 1);
});

test('service pushes only after approval and remote setup; plain successes remain JSON text', async () => {
    const calls = [];
    const service = createGitCommitService({ callAgentTool: async (_agent, tool) => {
        calls.push(tool);
        return raw(tool === 'git_check_large_files' ? warning : { ok: true, stdout: 'Pushed' });
    } });
    const result = await service.gitPush({ path: '/workspace/repo' }, {
        confirm: async () => { calls.push('approval'); return true; },
        beforeMutation: async () => calls.push('remote setup')
    });
    assert.deepEqual(calls, ['git_check_large_files', 'approval', 'remote setup', 'git_push']);
    assert.equal(JSON.parse(result).ok, true);
});

test('modal requires Continue; escapes paths and X/Escape abort', async () => {
    const previous = globalThis.assistOS;
    let output;
    let listener;
    const payload = { repoPath: '/workspace/știri', ...warning,
        files: [{ ...warning.files[0], path: '<img src=x onerror=alert(1)>' }] };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const element = {
        getAttribute: () => encoded, closest: () => null,
        addEventListener: (_name, fn) => { listener = fn; }, removeEventListener() {}
    };
    globalThis.assistOS = { UI: {
        closeModal: (_element, result) => { output = result; },
        showModal: async (_component, props) => {
            assert.equal(JSON.parse(decodeURIComponent(escape(atob(props.payload)))).repoPath, payload.repoPath);
            return output;
        }
    } };
    try {
        const presenter = new GitLargeFilesModal(element, () => {});
        assert.match(presenter.files, /&lt;img/);
        assert.doesNotMatch(presenter.files, /<img/);
        presenter.abort();
        assert.equal(await requestLargeFileConsent({ repoPath: payload.repoPath, warning }), false);
        presenter.continueOperation();
        assert.equal(await requestLargeFileConsent({ repoPath: payload.repoPath, warning }), true);
        listener({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
        assert.deepEqual(output, { policy: 'abort' });
        output = undefined;
        assert.equal(await requestLargeFileConsent({ repoPath: payload.repoPath, warning }), false);
    } finally { globalThis.assistOS = previous; }
});

test('MCP contracts and every AutoSync mutation use the large-file gate', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const tools = Array.isArray(config) ? config : config.tools;
    assert.ok(tools.find((tool) => tool.name === 'git_check_large_files'));
    for (const name of ['git_commit', 'git_push']) {
        assert.equal(tools.find((tool) => tool.name === name).inputSchema.approvedLargeFileOids.type, 'array');
    }
    const source = await fs.readFile(new URL('../../IDE-plugins/git-tool-button/git-tool-button-controller.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /callAgentTool\('gitAgent', 'git_(commit|push)'/);
    assert.match(source, /onAbort: showAutocommitStopped/);
});
