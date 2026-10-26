import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readLiveSkillsCodeHashes as candidate } from './copilot-live-skills-runtime.mjs';

// Baseline reproduction loads only the self-contained helper, without product imports.
const baseline = process.env.LIVE_SKILLS_BASELINE_HELPER;
const read = baseline ? Function(`return ${fs.readFileSync(baseline, 'utf8').split('export async function readLiveSkillsCodeHashes')[1]
    .split('// Executed inside the already pinned Box.')[0].replace(/^/, 'async function readLiveSkillsCodeHashes')}`)() : candidate;
const files = ['server/one.mjs', 'copilot/src/two.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, { alias = true, size = 17 } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code identity ü space ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesCLI`, source = `${repository}/roboTeamAgent`, code = alias ? `${root}/code` : source;
    for (const file of files) {
        fs.mkdirSync(path.dirname(`${source}/${file}`), { recursive: true });
        fs.writeFileSync(`${source}/${file}`, Buffer.alloc(size, 97));
    }
    if (alias) fs.mkdirSync(code);
    // Model only the enumerated canonical bind names. Every observation, open and read
    // uses the real backing object. Copies and symlink backing paths cannot qualify.
    const aliases = new Map(alias ? [[code, source], ...files.map(file => [`${code}/${file}`, `${source}/${file}`])] : []);
    const backing = file => aliases.get(file) || file;
    const descriptors = new Map(), reads = [];
    const api = { ...fs,
        realpathSync(file) {
            const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/);
            if (match) {
                const opened = descriptors.get(Number(match[1]));
                const actual = process.platform === 'linux' ? fs.realpathSync(file) : fs.realpathSync(opened.backing);
                return actual === opened.backing ? opened.filename : actual;
            }
            const actual = fs.realpathSync(backing(file));
            return aliases.has(file) && actual === backing(file) ? file : actual;
        },
        lstatSync(file, options) { return fs.lstatSync(backing(file), options); },
        openSync(file, flags) {
            const fd = fs.openSync(backing(file), flags);
            descriptors.set(fd, { filename: file, backing: backing(file) });
            return fd;
        },
        readFileSync(fd) { reads.push(descriptors.get(fd).filename); return fs.readFileSync(fd); },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
    };
    const run = async (args = {}, options = {}) => {
        try { return await read({ expectedRepository: repository, contractFiles: files, ...args }, { codeRoot: code, fsApi: api, ...options }); }
        finally { assert.equal(descriptors.size, 0, 'Every acquired descriptor must close.'); }
    };
    return { root, repository, source, code, api, aliases, descriptors, reads, run };
}

test('canonical direct aliases hash runtime descriptors and preserve bytes across unchanged reads', async t => {
    const f = fixture(t), before = files.map(file => fs.readFileSync(`${f.source}/${file}`));
    const expected = Object.fromEntries(files.map((file, i) => [file, hash(before[i])]));
    assert.deepEqual(await f.run(), expected);
    assert.deepEqual(await f.run(), expected);
    assert.deepEqual(f.reads, [...files, ...files].map(file => `${f.code}/${file}`));
    assert.deepEqual(files.map(file => fs.readFileSync(`${f.source}/${file}`)), before);
});

for (const size of [0, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1]) {
    test(`same-path roots enforce the ${size}-byte boundary`, async t => {
        const f = fixture(t, { alias: false, size });
        if (size > 4 * 1024 * 1024) await assert.rejects(f.run());
        else assert.deepEqual(await f.run(), Object.fromEntries(files.map(file => [file, hash(Buffer.alloc(size, 97))])));
    });
}

for (const [name, mutate] of Object.entries({
    'same-content root copy': f => { fs.cpSync(f.source, `${f.root}/copy`, { recursive: true }); f.aliases.set(f.code, `${f.root}/copy`); },
    'same-content file copy': f => { const copy = `${f.root}/copy.mjs`; fs.copyFileSync(`${f.source}/${files[0]}`, copy); f.aliases.set(`${f.code}/${files[0]}`, copy); },
    'another source file': f => f.aliases.set(`${f.code}/${files[0]}`, `${f.source}/${files[1]}`),
    'symlink root': f => { fs.renameSync(f.source, `${f.source}-real`); fs.symlinkSync(`${f.source}-real`, f.source); },
    'symlink intermediate': f => { fs.renameSync(`${f.source}/server`, `${f.source}/real`); fs.symlinkSync(`${f.source}/real`, `${f.source}/server`); },
    'symlink file': f => { fs.renameSync(`${f.source}/${files[0]}`, `${f.root}/external.mjs`); fs.symlinkSync(`${f.root}/external.mjs`, `${f.source}/${files[0]}`); },
    'hardlink file': f => fs.linkSync(`${f.source}/${files[0]}`, `${f.root}/hardlink.mjs`),
    'missing root': f => fs.rmSync(f.source, { recursive: true }),
    'missing intermediate': f => fs.rmSync(`${f.source}/server`, { recursive: true }),
    'missing file': f => fs.unlinkSync(`${f.source}/${files[0]}`),
})) {
    test(`identity rejects ${name}`, async t => { const f = fixture(t); mutate(f); await assert.rejects(f.run()); });
}

test('malformed roots and contract paths fail before opening descriptors', async t => {
    const f = fixture(t);
    for (const codeRoot of ['', '/', 'relative', `${f.code}/`, `${f.code}/../code`, null]) await assert.rejects(f.run({}, { codeRoot }));
    for (const expectedRepository of ['', '/', 'relative', `${f.repository}/`, `${f.repository}/../AchillesCLI`, null]) await assert.rejects(f.run({ expectedRepository }));
    for (const contractFiles of [[], [files[0], files[0]], [''], ['../one.mjs'], ['/one.mjs'], ['server/./one.mjs'], ['server//one.mjs'], ['server/../one.mjs'], ['one.js'], [null]]) {
        await assert.rejects(f.run({ contractFiles }));
    }
});

for (const [name, mutate] of Object.entries({
    'source pathname replacement': f => { fs.renameSync(`${f.source}/${files[0]}`, `${f.root}/old.mjs`); fs.writeFileSync(`${f.source}/${files[0]}`, Buffer.alloc(17, 97)); },
    'runtime pathname replacement': f => { const copy = `${f.root}/replacement.mjs`; fs.writeFileSync(copy, Buffer.alloc(17, 97)); f.aliases.set(`${f.code}/${files[0]}`, copy); },
    'root replacement': f => { fs.renameSync(f.source, `${f.source}-old`); fs.mkdirSync(f.source); },
    'symlink retargeting': f => { fs.renameSync(`${f.source}/server`, `${f.source}/old`); fs.symlinkSync(`${f.source}/old`, `${f.source}/server`); },
    'same-length mutation': f => fs.writeFileSync(`${f.source}/${files[0]}`, Buffer.alloc(17, 98)),
    'source append': f => fs.appendFileSync(`${f.source}/${files[0]}`, 'x'),
    'new hardlink': f => fs.linkSync(`${f.source}/${files[0]}`, `${f.root}/new-link.mjs`),
})) {
    test(`post-open fences reject ${name}`, async t => {
        const f = fixture(t), original = f.api.readFileSync;
        f.api.readFileSync = fd => { const bytes = original(fd); mutate(f); return bytes; };
        await assert.rejects(f.run());
        assert.equal(f.reads.length, 1, 'Reject without retry or reading later contracts.');
    });
}

for (const [method, occurrence] of [['openSync', 2], ['openSync', 4], ['fstatSync', 1], ['fstatSync', 8], ['lstatSync', 4], ['readFileSync', 1], ['realpathSync', 6], ['realpathSync', 10]]) {
    test(`failure at ${method} call ${occurrence} closes every descriptor`, async t => {
        const f = fixture(t), original = f.api[method]; let calls = 0;
        f.api[method] = (...args) => { if (++calls === occurrence) throw new Error('injected checkpoint failure'); return original(...args); };
        await assert.rejects(f.run(), /injected checkpoint failure/);
        assert.equal(calls, occurrence);
    });
}

for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
    test(`dual file observations reject mismatched ${field}`, async t => {
        const f = fixture(t), original = f.api.lstatSync;
        f.api.lstatSync = (file, options) => {
            const stat = original(file, options);
            if (file === `${f.code}/${files[0]}`) stat[field] += 1n;
            return stat;
        };
        await assert.rejects(f.run());
    });
}

test('nanosecond timestamp changes fail even within a millisecond', async t => {
    const f = fixture(t), original = f.api.fstatSync; let changed = false;
    const readBytes = f.api.readFileSync;
    f.api.readFileSync = fd => { const bytes = readBytes(fd); changed = true; return bytes; };
    f.api.fstatSync = (...args) => { const stat = original(...args); if (changed && stat.isFile()) stat.mtimeNs += 1n; return stat; };
    await assert.rejects(f.run());
});

for (const target of ['root', 'file']) {
    test(`descriptor realpath rejects a third canonical ${target} name`, async t => {
        const f = fixture(t), original = f.api.realpathSync;
        f.api.realpathSync = file => {
            const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/);
            if (match) {
                const opened = f.descriptors.get(Number(match[1]));
                if (opened.filename === (target === 'root' ? f.code : `${f.code}/${files[0]}`)) return `${f.root}/third-canonical-name`;
            }
            return original(file);
        };
        await assert.rejects(f.run(), /descriptor changed/);
    });
}

test('a short runtime read is rejected without reading another contract', async t => {
    const f = fixture(t), original = f.api.readFileSync;
    f.api.readFileSync = fd => original(fd).subarray(1);
    await assert.rejects(f.run(), /changed during its read/);
    assert.equal(f.reads.length, 1);
});

test('read opens require no-follow and nonblocking flags, with directory qualification for both roots', async t => {
    const f = fixture(t), original = f.api.openSync; let calls = 0;
    f.api.openSync = (file, flags) => {
        const expected = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (++calls <= 2 ? fs.constants.O_DIRECTORY : 0);
        assert.equal(flags & expected, expected);
        assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
        return original(file, flags);
    };
    await f.run();
    assert.equal(calls, 2 + 2 * files.length);
});

test('serialized helper has no ambient dependencies and retains production defaults', async t => {
    const f = fixture(t, { alias: false });
    const serialized = Function(`return (${candidate.toString()})`)();
    assert.deepEqual(await serialized({ expectedRepository: f.repository, contractFiles: files }, { codeRoot: f.code, fsApi: f.api }), await f.run());
    assert.match(candidate.toString(), /codeRoot = '\/code'/);
    assert.doesNotMatch(candidate.toString(), /import\(['"](?:\/code|\.\/)/);
});
