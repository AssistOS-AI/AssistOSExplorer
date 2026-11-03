import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RUNTIME_BUNDLE_FILES, RuntimeBundle, STATIC_BWRAP } from '../server/runtime-bundle.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-bundle-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'tool-cache');
    await fs.mkdir(cache);
    const calls = [], generations = [];
    // The cache stub runs the plan's own install and validation into one directory, as the real cache does into a staging one.
    const toolCache = { root: cache, podmanCommand: 'fixture-podman', _once: (_key, operation) => operation(),
        _prepare: async (name, operation) => {
            const plan = await operation();
            const directory = path.join(cache, `${name}-generation`);
            await fs.mkdir(directory);
            await plan.install(directory); await plan.validate(directory);
            generations.push({ name, identity: plan.identity, versions: plan.versions });
            return plan.result(directory);
        },
        execFileImpl: async (command, args) => {
            calls.push({ command, args });
            if (args[0] === 'run') {
                const out = args[args.indexOf('-v') + 1].split(':')[0];
                await fs.mkdir(path.join(out, 'bin'), { recursive: true });
                await fs.writeFile(path.join(out, 'bin', 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
            }
            return { stdout: '' };
        } };
    return { root, cache, calls, generations, toolCache };
}

async function alaPackage(directory) {
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    await fs.mkdir(path.join(directory, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(directory, 'bin', 'ala.mjs'), '#!/usr/bin/env node\n');
    await fs.writeFile(path.join(directory, 'src', 'deep', 'x.mjs'), 'export {};\n');
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'advanced-language-agent', version: '1.2.3' }));
    await fs.mkdir(path.join(directory, 'tests'));
    await fs.writeFile(path.join(directory, 'tests', 'not-runtime.mjs'), '');
    return path.join(directory, 'bin', 'ala.mjs');
}

test('the static Bubblewrap is built on a digest-pinned image from a checksum-checked release and verified as static', async t => {
    const f = await fixture(t);
    const alaEntry = await alaPackage(path.join(f.root, 'workspace', 'ala'));
    const bundle = new RuntimeBundle({ toolCache: f.toolCache, workspaceRoot: path.join(f.root, 'workspace'), alaEntry, log: () => {} });
    const prepared = await bundle.prepare();
    const build = f.calls.find(call => call.args[0] === 'run');
    assert.equal(build.command, 'fixture-podman');
    assert.match(STATIC_BWRAP.builder, /@sha256:[0-9a-f]{64}$/u);
    assert.match(STATIC_BWRAP.sha256, /^[0-9a-f]{64}$/u);
    const { args } = build;
    assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
    assert.equal(args[args.indexOf('--ipc') + 1], 'none');
    assert.equal(args[args.indexOf('--user') + 1], '0:0');
    assert.match(args[args.indexOf('-v') + 1], /^.+:\/out$/u);
    assert.equal(args[args.indexOf('-v') + 1].split(':')[0], path.dirname(prepared.bwrap.bin).replace(/\/bin$/u, ''));
    assert.equal(args[args.indexOf(STATIC_BWRAP.builder) + 1], 'sh');
    const script = args.at(-1);
    assert.ok(script.includes(STATIC_BWRAP.source));
    assert.ok(script.includes(`printf '%s  %s\\n' ${STATIC_BWRAP.sha256} /tmp/bubblewrap.tar.xz | sha256sum -c -`), 'the download is checked against the pinned checksum');
    assert.ok(script.indexOf('sha256sum -c') < script.indexOf('tar '), 'the archive is checked before it is unpacked');
    assert.match(script, /^set -eux/u);
    assert.match(script, /readelf -d build\/bwrap \| grep -q NEEDED; then echo "bwrap is not static"[^\n]*exit 1/u);
    assert.match(script, /-Dc_link_args=-static/u);
    assert.deepEqual(f.generations.find(entry => entry.name === 'bwrap').versions, { bwrap: STATIC_BWRAP.version });
    assert.equal(f.generations.find(entry => entry.name === 'bwrap').identity.sha256, STATIC_BWRAP.sha256);
    // The prepared binary is run once to prove it works.
    assert.deepEqual(f.calls.at(-1).args, ['--version']);
    assert.equal(f.calls.at(-1).command, prepared.bwrap.bin);
});

test('no Node.js is built or shipped, and the workspace ALA checkout is used as it is', async t => {
    const f = await fixture(t);
    const workspace = path.join(f.root, 'workspace');
    const alaEntry = await alaPackage(path.join(workspace, 'ala'));
    const bundle = new RuntimeBundle({ toolCache: f.toolCache, workspaceRoot: workspace, alaEntry, log: () => {} });
    const prepared = await bundle.prepare();
    assert.deepEqual(Object.keys(prepared).sort(), ['ala', 'bwrap', 'root']);
    assert.equal(prepared.ala.source, 'workspace');
    assert.equal(prepared.ala.entry, alaEntry); assert.equal(prepared.ala.path, path.dirname(path.dirname(alaEntry)));
    assert.equal(f.generations.some(entry => entry.name === 'ala'), false, 'nothing is copied');
    assert.deepEqual(Object.keys(RUNTIME_BUNDLE_FILES).sort(), ['ala', 'bwrap']);
    assert.equal(JSON.stringify([RUNTIME_BUNDLE_FILES, f.generations]).match(/\bnode\b|\bnpm\b/u), null);
    const script = f.calls.find(call => call.args[0] === 'run').args.at(-1);
    assert.equal(/\bnode(js)?\b|\bnpm\b/u.test(script), false);
});

test('an ALA outside the workspace is copied as its runtime files only', async t => {
    const f = await fixture(t);
    const alaEntry = await alaPackage(path.join(f.root, 'elsewhere', 'ala'));
    const bundle = new RuntimeBundle({ toolCache: f.toolCache, workspaceRoot: path.join(f.root, 'workspace'), alaEntry, log: () => {} });
    const { ala } = await bundle.prepare();
    assert.equal(ala.source, 'tool-cache');
    assert.equal(path.dirname(ala.path), f.cache);
    assert.equal(ala.entry, path.join(ala.path, 'bin', 'ala.mjs'));
    assert.deepEqual((await fs.readdir(ala.path)).sort(), ['bin', 'package.json', 'src']);
    await fs.access(path.join(ala.path, 'src', 'deep', 'x.mjs'));
    assert.equal(f.generations.find(entry => entry.name === 'ala').versions.ala, '1.2.3');
    // A package that is not ALA is refused.
    await fs.writeFile(path.join(f.root, 'elsewhere', 'ala', 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
    await assert.rejects(new RuntimeBundle({ toolCache: f.toolCache, workspaceRoot: path.join(f.root, 'workspace'), alaEntry, log: () => {} }).prepareAla(),
        /not advanced-language-agent/u);
});
