import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeLiveSkillReceiptSource, validateLiveSkillReceiptSource, validateLiveSkillsTurn, liveSkillsHash } from './copilot-live-skills.mjs';
import { currentLiveSkillsCase } from './copilot-live-skills-test-fixture.mjs';

// This maps enumerated namespace names to real backing files. It exercises the observer's
// inode, hash, mount-info and race checks; it is not a real bind or sandbox enforcement proof.
function model(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill alias ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = `${root}/repository`, canonicalSource = `${source}/receipt.mjs`, alias = '/workspace/roboteam-skill-0';
    const homeSource = `${root}/home`, homeTarget = '/home/owned-robot', invokedPath = `${root}/work/.agents/skills/owned/receipt.mjs`;
    fs.mkdirSync(source); fs.mkdirSync(homeSource); fs.mkdirSync(path.dirname(invokedPath), { recursive: true });
    fs.writeFileSync(canonicalSource, 'export const helper = true;\n'); fs.symlinkSync(`${alias}/receipt.mjs`, invokedPath);
    const state = { source, mountInfo: `1 0 0:1 / / ro - tmpfs tmpfs ro\n2 1 0:2 / ${alias} ro - tmpfs tmpfs ro\n`, homeSource };
    const descriptors = new Map();
    const backing = file => file === invokedPath ? `${state.source}/receipt.mjs`
        : file === alias || file.startsWith(`${alias}/`) ? state.source + file.slice(alias.length)
            : file === homeTarget ? state.homeSource : file;
    const fsApi = { ...fs,
        lstatSync(file, options) { return fs.lstatSync(backing(file), options); },
        realpathSync(file) {
            const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/);
            if (match) {
                const opened = descriptors.get(Number(match[1]));
                const actual = process.platform === 'linux' ? fs.realpathSync(file) : fs.realpathSync(opened.backing);
                return actual === opened.backing ? opened.filename : actual;
            }
            if (file === invokedPath) return `${alias}/receipt.mjs`;
            const actual = fs.realpathSync(backing(file));
            return actual === backing(file) ? file : actual;
        },
        openSync(file, flags) { const fd = fs.openSync(backing(file), flags); descriptors.set(fd, { filename: file, backing: backing(file) }); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        readFileSync(file, options) { return file === '/proc/self/mountinfo' ? state.mountInfo : fs.readFileSync(file, options); },
    };
    const args = { canonicalSource, resolvedSource: `${alias}/receipt.mjs`, invokedPath, homeTarget };
    const read = async (overrides = {}) => { try { return await observeLiveSkillReceiptSource({ ...args, ...overrides },
        { fsApi, env: { HOME: homeTarget, USER: 'owned-robot' } }); } finally { assert.equal(descriptors.size, 0); } };
    const identity = file => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map(key => [key, String(fs.statSync(file, { bigint: true })[key])]));
    return { root, args, state, source, canonicalSource, homeSource, homeTarget, alias, fsApi, read, identity };
}

test('alias filesystem model joins the readonly native file to its canonical source and the native home object', async t => {
    const c = model(t), proof = await c.read();
    assert.deepEqual(proof.sourceIdentity, c.identity(c.canonicalSource));
    assert.deepEqual(proof.runtimeIdentity, proof.sourceIdentity);
    assert.deepEqual(proof.home, { target: c.homeTarget, identity: c.identity(c.homeSource) });
    validateLiveSkillReceiptSource({ receipt: { resolvedSource: c.args.resolvedSource, sourceBinding: proof },
        link: { target: c.alias }, canonicalSource: c.canonicalSource, canonicalIdentity: c.identity(c.canonicalSource),
        helperSha256: liveSkillsHash(fs.readFileSync(c.canonicalSource)), homeBinding: { homeTarget: c.homeTarget, identity: c.identity(c.homeSource) } });
});

for (const [name, mutate] of Object.entries({
    'same-byte copy at the alias': c => { fs.cpSync(c.source, `${c.root}/copy`, { recursive: true }); c.state.source = `${c.root}/copy`; },
    'writable alias': c => { c.state.mountInfo = c.state.mountInfo.replace(`${c.alias} ro`, `${c.alias} rw`); },
    'writable canonical source': c => { c.state.mountInfo = c.state.mountInfo.replace('/ / ro', '/ / rw'); },
    'file shadow below the source alias': c => { c.state.mountInfo += `3 2 0:3 / ${c.alias}/receipt.mjs ro - tmpfs tmpfs ro\n`; },
    'ambiguous exact alias mounts': c => { c.state.mountInfo += `3 2 0:3 / ${c.alias} ro - tmpfs tmpfs ro\n`; },
    'symlink source file': c => { fs.renameSync(c.canonicalSource, `${c.source}/real.mjs`); fs.symlinkSync(`${c.source}/real.mjs`, c.canonicalSource); },
    'hardlinked source file': c => fs.linkSync(c.canonicalSource, `${c.root}/hardlink.mjs`),
    'foreign native home': c => { fs.mkdirSync(`${c.root}/other-home`); c.state.homeSource = `${c.root}/other-home`; },
})) test(`alias filesystem model rejects ${name}`, async t => {
    const c = model(t); mutate(c);
    if (name === 'foreign native home') {
        const proof = await c.read();
        assert.throws(() => validateLiveSkillReceiptSource({ receipt: { resolvedSource: c.args.resolvedSource, sourceBinding: proof },
            link: { target: c.alias }, canonicalSource: c.canonicalSource, canonicalIdentity: c.identity(c.canonicalSource),
            helperSha256: liveSkillsHash(fs.readFileSync(c.canonicalSource)), homeBinding: { homeTarget: c.homeTarget, identity: c.identity(c.homeSource) } }), /owned RoboWork home/);
    } else await assert.rejects(c.read());
});

test('alias filesystem model fences a same-length source mutation during its descriptor read', async t => {
    const c = model(t), read = c.fsApi.readFileSync; let changed = false;
    c.fsApi.readFileSync = (...args) => { const bytes = read(...args); if (!changed && typeof args[0] === 'number') {
        changed = true; fs.writeFileSync(c.canonicalSource, Buffer.alloc(bytes.length, 98));
    } return bytes; };
    await assert.rejects(c.read(), /bytes differ|changed during capture/);
});

function aliasCase() {
    const input = currentLiveSkillsCase(), snapshot = input.snapshot;
    snapshot.sourceMapping = 'aliases';
    snapshot.homeBinding = { robotId: input.fixture.robotId, robotName: input.fixture.robotName, homeTarget: `/home/${input.fixture.robotId}`,
        identity: { dev: '1', ino: '2', uid: '0', gid: '0', mode: '16832' } };
    snapshot.catalog.links.forEach((link, index) => {
        link.target = `/workspace/roboteam-skill-${index}`;
        snapshot.liveLinks[link.name].linkTarget = link.target;
        const identity = { dev: '1', ino: String(10 + index), uid: '0', gid: '0', mode: '33152' };
        snapshot.capturedFiles[link.name].sourceIdentity = identity;
        const receipt = snapshot.receipts[`${input.phase}-${link.name}.json`];
        receipt.resolvedSource = `${link.target}/receipt.mjs`;
        receipt.sourceBinding = { version: 1, alias: link.target, canonicalSource: `${link.source}/receipt.mjs`,
            sourceIdentity: identity, runtimeIdentity: { ...identity }, helperSha256: receipt.helperSha256,
            readOnly: true, home: { target: snapshot.homeBinding.homeTarget, identity: { ...snapshot.homeBinding.identity } } };
    });
    snapshot.session.skillExecution.mounts = snapshot.catalog.links.map(link => ({ source: link.source, target: link.target, expose: true }));
    const revision = liveSkillsHash(snapshot.catalog.links);
    snapshot.catalog.revision = snapshot.session.skillExecution.revision = input.inventory.lastRevision = revision;
    return input;
}

test('synthetic live alias receipt requires the exact captured source, readonly grant and owned native home', () => {
    assert.equal(validateLiveSkillsTurn(aliasCase()).selected.length, 2);
});

for (const [name, mutate] of Object.entries({
    'canonical-only receipt': (input, receipt) => { receipt.resolvedSource = receipt.sourceBinding.canonicalSource; delete receipt.sourceBinding; },
    'foreign alias': (_input, receipt) => { receipt.sourceBinding.alias = '/workspace/roboteam-skill-99'; },
    'foreign canonical source': (_input, receipt) => { receipt.sourceBinding.canonicalSource += '-other'; },
    'foreign native inode': (_input, receipt) => { receipt.sourceBinding.runtimeIdentity.ino = '999'; },
    'foreign captured inode': (_input, receipt) => { receipt.sourceBinding.sourceIdentity = receipt.sourceBinding.runtimeIdentity = { ...receipt.sourceBinding.sourceIdentity, ino: '999' }; },
    'wrong helper hash': (_input, receipt) => { receipt.sourceBinding.helperSha256 = '0'.repeat(64); },
    'writable grant': (_input, receipt) => { receipt.sourceBinding.readOnly = false; },
    'different native home': (_input, receipt) => { receipt.sourceBinding.home.identity.ino = '999'; },
    'different visible home': (_input, receipt) => { receipt.sourceBinding.home.target = '/home/foreign'; },
})) test(`live alias evidence rejects ${name}`, () => {
    const input = aliasCase(), receipt = input.snapshot.receipts[`${input.phase}-${input.selected[0].name}.json`];
    mutate(input, receipt); assert.throws(() => validateLiveSkillsTurn(input));
});
