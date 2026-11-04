import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

import { createGithubRepository } from '../../lib/git/github-remotes.mjs';
import { createGitService } from '../../lib/git-service.mjs';

const request = { owner: 'Example', name: 'new-app', token: 'fixture-token', visibility: 'private' };
const unknownOutcome = 'GitHub repository creation outcome is unknown. Verify the repository on GitHub before retrying.';

function repository(overrides = {}) {
    return {
        id: 42,
        owner: { login: 'Example', type: 'Organization' },
        name: 'new-app',
        full_name: 'Example/new-app',
        private: true,
        archived: false,
        disabled: false,
        fork: false,
        clone_url: 'https://untrusted.example/ignored.git',
        ...overrides,
    };
}

async function withGithub(run, { post = () => Response.json({ message: 'Server Error' }, { status: 500 }), lookup = () => Response.json(repository()), branches = () => Response.json([]), user = () => Response.json({ login: 'current-user' }) } = {}) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    let created = false;
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), ...options });
        if (url === 'https://api.github.com/user') return user(options);
        if (options.method === 'POST') {
            created = true;
            return post(options);
        }
        assert.equal(created, true, 'lookup is only allowed after the create attempt');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, `Bearer ${request.token}`);
        if (url === 'https://api.github.com/repos/Example/new-app') return lookup(options);
        assert.equal(url, 'https://api.github.com/repos/Example/new-app/branches?per_page=1');
        return branches(options);
    };
    try {
        return await run(calls);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function withWorkspace(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'github-create-recovery-'));
    try {
        return await run(await fs.realpath(root));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

function git(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('POST creates remote then returns Server Error: reconcile and initialize local origin', async () => {
    await withWorkspace(async (root) => withGithub(async (calls) => {
        const service = createGitService({ validatePath: async (value) => value });
        const result = await service.gitCreateGithubRepository({ ...request, path: root });
        assert.equal(result.ok, true);
        assert.equal(result.reconciled, true);
        assert.equal(result.repository.id, 42);
        assert.equal(git(result.repoPath, ['remote', 'get-url', 'origin']), 'https://github.com/Example/new-app.git');
        assert.equal(git(result.repoPath, ['rev-parse', '--is-inside-work-tree']), 'true');
        assert.equal(calls.length, 4);
        await assert.rejects(service.gitCreateGithubRepository({ ...request, path: root }), /directory already exists/);
        assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'occupied retry cannot create again');
    }));
});

test('normal creation keeps two requests and marks its result unreconciled', async () => {
    await withGithub(async (calls) => {
        const result = await createGithubRepository(request);
        assert.equal(result.reconciled, false);
        assert.equal(calls.length, 2);
        assert.deepEqual(JSON.parse(calls[1].body), { name: request.name, private: true, auto_init: false });
    }, { post: () => Response.json(repository(), { status: 201 }) });
});

test('transport and successful POST body failures recover without replaying POST', async () => {
    for (const post of [
        () => { throw new Error('transport fixture-token'); },
        () => new Response('{', { status: 201 }),
        () => ({ ok: true, status: 201, json: async () => { throw new Error('body fixture-token'); } }),
    ]) {
        await withGithub(async (calls) => {
            assert.equal((await createGithubRepository(request)).reconciled, true);
            assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
        }, { post });
    }
});

test('explicit client errors and GET user errors never trigger lookup', async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
        await withGithub(async (calls) => {
            await assert.rejects(createGithubRepository(request), /explicit rejection/);
            assert.equal(calls.length, 2);
        }, { post: () => Response.json({ message: 'explicit rejection' }, { status }) });
    }
    await withGithub(async (calls) => {
        await assert.rejects(createGithubRepository(request), /user unavailable/);
        assert.equal(calls.length, 1);
    }, { user: () => Response.json({ message: 'user unavailable' }, { status: 500 }) });
});

test('matching identity is case insensitive and public visibility is strict', async () => {
    await withGithub(async () => {
        const result = await createGithubRepository({ ...request, visibility: 'public' });
        assert.equal(result.reconciled, true);
        assert.equal(result.repository.cloneUrl, 'https://github.com/example/NEW-app.git');
    }, { lookup: () => Response.json(repository({ owner: { login: 'example' }, name: 'NEW-app', full_name: 'EXAMPLE/new-APP', private: false })) });
});

test('unsafe identity, flags, and privacy cannot turn an ambiguous create into success', async () => {
    for (const change of [
        { id: 0 }, { id: -1 }, { id: '42' }, { id: Number.MAX_SAFE_INTEGER + 1 },
        { owner: { login: 'other' } }, { name: 'other' }, { full_name: 'other/new-app' },
        { private: false }, { private: 'true' }, { archived: true }, { disabled: true }, { fork: true },
        { archived: undefined }, { disabled: undefined }, { fork: undefined },
    ]) {
        await withGithub(async (calls) => {
            await assert.rejects(createGithubRepository(request), { message: unknownOutcome });
            assert.equal(calls.length, 3, JSON.stringify(change));
        }, { lookup: () => Response.json(repository(change)) });
    }
});

test('uncertain lookup and nonempty repositories return safe verification guidance', async () => {
    for (const options of [
        { lookup: () => new Response('', { status: 404 }) },
        { lookup: () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example' } }) },
        { lookup: () => { throw new Error('redirect fixture-token'); } },
        { lookup: () => new Response('{') },
        { branches: () => Response.json([{ name: 'main' }]) },
        { branches: () => Response.json({}) },
        { branches: () => new Response('{') },
        { branches: () => new Response('', { status: 403 }) },
        { branches: () => new Response('', { status: 302 }) },
        { post: () => { throw new Error('transport fixture-token'); }, lookup: () => { throw new Error('lookup fixture-token'); } },
    ]) {
        await withGithub(async (calls) => {
            await assert.rejects(createGithubRepository(request), { message: unknownOutcome });
            assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
        }, options);
    }
});

test('one five-second deadline covers lookup fetch and body reads', async (t) => {
    const originalSetTimeout = globalThis.setTimeout;
    const requestedDelays = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        requestedDelays.push(delay);
        return originalSetTimeout(callback, delay === 5000 ? 50 : delay, ...args);
    });
    for (const stage of ['lookup', 'lookupBody', 'branches', 'branchesBody']) {
        let signal;
        const never = () => new Promise(() => {});
        const options = stage === 'lookup' ? { lookup: (opts) => { signal = opts.signal; return never(); } }
            : stage === 'lookupBody' ? { lookup: (opts) => { signal = opts.signal; return { ok: true, json: never }; } }
                : stage === 'branches' ? { branches: (opts) => { signal = opts.signal; return never(); } }
                    : { branches: (opts) => { signal = opts.signal; return { ok: true, json: never }; } };
        await withGithub(async (calls) => {
            const before = requestedDelays.length;
            await assert.rejects(createGithubRepository(request), { message: unknownOutcome });
            assert.equal(requestedDelays.length - before, 1, 'both reads share one deadline');
            assert.equal(requestedDelays.at(-1), 5000);
            assert.equal(signal.aborted, true);
            const reads = calls.filter((call) => call.signal);
            assert.ok(reads.every((call) => call.signal === signal));
        }, options);
    }
});

test('simultaneous local mkdir loser preserves the winner repository and files', async (t) => {
    await withWorkspace(async (root) => {
        const originalMkdir = fs.mkdir;
        t.mock.method(fs, 'mkdir', async (target, options) => {
            const result = await originalMkdir(target, options);
            if (target === path.join(root, request.name)) {
                await fs.writeFile(path.join(target, 'winner.txt'), 'preserve me');
            }
            return result;
        });
        let arrived = 0;
        let release;
        const barrier = new Promise((resolve) => { release = resolve; });
        await withGithub(async (calls) => {
            const service = createGitService({ validatePath: async (value) => value });
            const results = await Promise.allSettled([
                service.gitCreateGithubRepository({ ...request, path: root }),
                service.gitCreateGithubRepository({ ...request, path: root }),
            ]);
            assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
            const loser = results.find((result) => result.status === 'rejected');
            assert.equal(loser.reason.code, 'EEXIST');
            const target = path.join(root, request.name);
            assert.equal(await fs.readFile(path.join(target, 'winner.txt'), 'utf8'), 'preserve me');
            assert.equal(git(target, ['remote', 'get-url', 'origin']), 'https://github.com/Example/new-app.git');
            assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
        }, { branches: async () => {
            arrived += 1;
            if (arrived === 2) release();
            await barrier;
            return Response.json([]);
        } });
    });
});

const menuSource = (await fs.readFile(new URL('../../IDE-plugins/git-menu-contributions/menu-contributions.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '')
    .replaceAll('export async function', 'async function');

test('executed menu reports connected or created, refreshes once and releases loader', async () => {
    for (const reconciled of [false, true]) {
        const statuses = [];
        let loaders = 0;
        let refreshes = 0;
        const action = vm.runInNewContext(`${menuSource}\nexecuteMenuAction;`, {
            callAgentTool: async (_agent, name) => name === 'git_info' ? { ok: false } : { ok: true, reconciled, repository: { fullName: 'Example/new-app' } },
            parseToolResult: (raw) => raw,
            beginRepositoryLoader: () => { loaders += 1; },
            endRepositoryLoader: () => { loaders -= 1; },
            assistOS: { UI: { showModal: async () => ({ name: 'new-app', owner: 'Example' }) } },
        });
        await action({ action: 'add-repository', context: { currentFsPath: '/workspace' }, host: {
            showStatus: (value) => statuses.push(value),
            refreshDirectory: async () => { assert.equal(loaders, 1); refreshes += 1; },
        } });
        assert.deepEqual(statuses, [`${reconciled ? 'Connected' : 'Created'} GitHub repository: Example/new-app.`]);
        assert.equal(refreshes, 1);
        assert.equal(loaders, 0);
    }
});

test('executed menu releases loader after unknown creation outcome without refreshing', async () => {
    let loaders = 0;
    const action = vm.runInNewContext(`${menuSource}\nexecuteMenuAction;`, {
        callAgentTool: async (_agent, name) => name === 'git_info' ? { ok: false } : { ok: false, error: unknownOutcome },
        parseToolResult: (raw) => raw,
        beginRepositoryLoader: () => { loaders += 1; },
        endRepositoryLoader: () => { loaders -= 1; },
        assistOS: { UI: { showModal: async () => ({ name: 'new-app', owner: 'Example' }) } },
    });
    await assert.rejects(action({ action: 'add-repository', context: { currentFsPath: '/workspace' }, host: {
        refreshDirectory: () => assert.fail('failed creation cannot refresh as success'),
        showStatus: () => assert.fail('failed creation cannot report success'),
    } }), { message: unknownOutcome });
    assert.equal(loaders, 0);
});
