import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeLiveSkillReceiptSource } from './copilot-live-skills.mjs';

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

test('alias filesystem model fences a same-length source mutation during its descriptor read', async t => {
    const c = model(t), read = c.fsApi.readFileSync; let changed = false;
    c.fsApi.readFileSync = (...args) => { const bytes = read(...args); if (!changed && typeof args[0] === 'number') {
        changed = true; fs.writeFileSync(c.canonicalSource, Buffer.alloc(bytes.length, 98));
    } return bytes; };
    await assert.rejects(c.read(), /bytes differ|changed during capture/);
});
