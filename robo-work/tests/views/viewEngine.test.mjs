import assert from 'node:assert/strict';
import test from 'node:test';

import { D2_DECISION } from '../../server/views/d2Decision.mjs';
import { createViewEngine, ROOT_NODE_ID } from '../../server/views/viewEngine.mjs';
import { createFakeBacking } from './helpers/fakeBacking.mjs';

// Builds an engine over a fake backing with a small project tree.
function rig(limits = {}) {
    const fake = createFakeBacking();
    fake.writeFile('src/main.js', 'console.log(1);');
    fake.writeFile('D/inner/file.txt', 'inner data');
    fake.writeFile('D/note.txt', 'note');
    fake.writeFile('F.txt', 'file data');
    fake.mkdirp('.ploinky');
    const engine = createViewEngine({ backing: fake.backing, limits });
    return { fake, engine };
}

const serve = (result) => {
    assert.equal(result.outcome, 'serve', JSON.stringify(result));
    return result;
};
const node = (engine, parent, name) => serve(engine.lookup(parent, name)).nodeId;
const backingCalls = (fake, method) => fake.calls.filter((call) => call === method).length;

// ---------------------------------------------------------------------------------------------------------------------
// Operand-name rules reach the backing only for ordinary names, and a late-created protected name stays invisible.

test('protected names created after the view started are absent, omitted from listings, and never reach the backing', () => {
    const { fake, engine } = rig();
    const dir = serve(engine.opendir(ROOT_NODE_ID)).fh;
    assert.ok(engine.readdir(dir).entries.includes('F.txt'));
    // Another writer creates protected names, in folded spellings too, and one ordinary file as the positive control.
    for (const name of ['.env', 'master-key', 'x.secrets', '.data', '.ploinky-box', '.roboteam', '.ENV.', 'MAſter-key']) fake.writeFile(name, 'secret');
    fake.writeFile('plain.txt', 'visible');
    fake.clearCalls();
    for (const name of ['.env', 'master-key', 'x.secrets', '.data', '.ploinky-box', '.roboteam', '.ENV.', 'MAſter-key', '.ploinky']) {
        const result = engine.lookup(ROOT_NODE_ID, name);
        assert.equal(result.outcome, 'absent', name);
        assert.equal(result.errnoHint, 'ENOENT', name);
    }
    assert.equal(backingCalls(fake, 'identityAt') + backingCalls(fake, 'openAt'), 0, 'the backing was not asked about a protected name');
    const listing = engine.readdir(dir);
    assert.deepEqual([...listing.entries].sort(), ['D', 'F.txt', 'plain.txt', 'src']);
    assert.ok(listing.omitted >= 8);
    assert.equal(engine.lookup(ROOT_NODE_ID, 'plain.txt').outcome, 'serve');
});

test('a protected name answers the same whether or not the entry exists, and the reply equals a missing entry', () => {
    const { fake, engine } = rig();
    fake.writeFile('.env', 'x');
    const exists = engine.lookup(ROOT_NODE_ID, '.env');
    const missing = engine.lookup(ROOT_NODE_ID, '.data');
    const ordinaryMissing = engine.lookup(ROOT_NODE_ID, 'nothing-here');
    for (const result of [exists, missing, ordinaryMissing]) {
        assert.equal(result.outcome, 'absent');
        assert.equal(result.errnoHint, 'ENOENT');
    }
    fake.clearCalls();
    const createExisting = engine.create(ROOT_NODE_ID, '.env');
    const createMissing = engine.create(ROOT_NODE_ID, '.data');
    assert.deepEqual([createExisting.outcome, createExisting.code], [createMissing.outcome, createMissing.code]);
    assert.equal(createExisting.outcome, 'refused');
    assert.equal(backingCalls(fake, 'createAt'), 0);
});

test('create, link and rename onto a protected name are refused without touching the backing; ordinary ones work', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    fake.clearCalls();
    assert.equal(engine.create(ROOT_NODE_ID, '.Env.').outcome, 'refused');
    assert.equal(engine.create(ROOT_NODE_ID, '.roboteam', { directory: true }).outcome, 'refused');
    assert.equal(engine.link(file, ROOT_NODE_ID, 'x.secrets').outcome, 'refused');
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, '.data').outcome, 'refused');
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'master-key', { exchange: true }).outcome, 'refused');
    for (const method of ['createAt', 'linkAt', 'renameAt']) assert.equal(backingCalls(fake, method), 0, method);
    assert.equal(fake.exists('F.txt'), true);
    const created = serve(engine.create(ROOT_NODE_ID, 'new.txt'));
    assert.equal(created.created, true);
    assert.equal(fake.exists('new.txt'), true);
    serve(engine.link(file, ROOT_NODE_ID, 'copy.txt'));
    assert.equal(fake.exists('copy.txt'), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Binding chain (plan section 5.4): a cwd or held directory descriptor inside a directory that another writer renames.

for (const [label, destination] of [['renamed to .data', '.data'], ['moved under .ploinky', '.ploinky/D']]) {
    test(`binding chain: a cwd and a held directory handle inside D ${label} reach nothing afterwards`, () => {
        const { fake, engine } = rig();
        const dir = node(engine, ROOT_NODE_ID, 'D');
        const inner = node(engine, dir, 'inner');
        const heldHandle = serve(engine.opendir(dir)).fh;
        const innerHandle = serve(engine.opendir(inner)).fh;
        assert.equal(engine.readdir(heldHandle).outcome, 'serve', 'positive control before the rename');

        fake.externalRename('D', destination);
        fake.writeFile(`${destination}/created-after.txt`, 'new secret');
        fake.clearCalls();

        // Lookups through the cwd node and the nested node: absent, whatever the name.
        for (const parent of [dir, inner]) {
            for (const name of ['created-after.txt', 'note.txt', 'file.txt', 'inner', 'nope']) {
                const result = engine.lookup(parent, name);
                assert.equal(result.outcome, 'absent', `${parent}/${name}`);
                assert.equal(result.errnoHint, 'ENOENT');
            }
        }
        assert.equal(engine.getattr(dir).outcome, 'absent');
        assert.equal(engine.getattr(inner).outcome, 'absent');
        assert.equal(engine.opendir(dir).outcome, 'absent');
        assert.equal(engine.chainState(dir), 'protected');
        assert.equal(engine.chainState(inner), 'protected');
        // The directory handles opened before the rename: refused, and no data comes back.
        for (const fh of [heldHandle, innerHandle]) {
            const listing = engine.readdir(fh);
            assert.equal(listing.outcome, 'refused');
            assert.equal(listing.code, 'handle_observed_protected');
            assert.equal(listing.entries, undefined);
        }
        // Creates through the cwd node are refused and have no backing effect.
        assert.equal(engine.create(dir, 'planted.txt').outcome, 'refused');
        assert.equal(engine.create(inner, 'planted.txt', { directory: false }).outcome, 'refused');
        assert.equal(fake.exists(`${destination}/planted.txt`), false);
        assert.equal(backingCalls(fake, 'createAt'), 0);
        // Files the robot can still reach are untouched: the positive control at the root.
        assert.equal(engine.lookup(ROOT_NODE_ID, 'F.txt').outcome, 'serve');
    });
}

test('binding chain: an ancestor higher up the chain is enough, and the root and unrelated siblings keep working', () => {
    const { fake, engine } = rig();
    fake.writeFile('a/b/c/d.txt', 'deep');
    const a = node(engine, ROOT_NODE_ID, 'a');
    const b = node(engine, a, 'b');
    const c = node(engine, b, 'c');
    const file = node(engine, c, 'd.txt');
    const handle = serve(engine.open(file)).fh;
    assert.equal(serve(engine.read(handle, 0, 4)).data.toString(), 'deep');
    fake.externalRename('a/b', '.env');
    assert.equal(engine.read(handle, 0, 4).outcome, 'refused');
    assert.equal(engine.chainState(c), 'protected');
    assert.equal(engine.chainState(a), 'ok', 'the part of the chain above the break is still ordinary');
    assert.equal(engine.lookup(a, 'other').outcome, 'absent', 'not_found for a missing ordinary entry');
    assert.equal(engine.lookup(ROOT_NODE_ID, 'F.txt').outcome, 'serve');
});

test('binding chain: taint is sticky, a rename back does not restore access, and a fresh lookup is a fresh node', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    fake.externalRename('D', '.data');
    assert.equal(engine.getattr(dir).outcome, 'absent');
    fake.externalRename('.data', 'D');
    assert.equal(engine.getattr(dir).outcome, 'absent', 'the old node stays tainted');
    const fresh = node(engine, ROOT_NODE_ID, 'D');
    assert.notEqual(fresh, dir);
    assert.equal(engine.getattr(fresh).outcome, 'serve');
});

test('binding chain: a replaced directory of the same name is not the bound object', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    fake.externalReplace('D');
    assert.equal(engine.getattr(dir).outcome, 'absent');
    assert.equal(engine.chainState(dir), 'protected');
    assert.equal(engine.lookup(ROOT_NODE_ID, 'D').outcome, 'serve');
});

test('binding chain: a rename to an ordinary name also stops the old node (the binding cannot be proven under its recorded name)', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    fake.externalRename('D', 'E');
    assert.equal(engine.getattr(dir).outcome, 'absent');
    assert.equal(node(engine, ROOT_NODE_ID, 'E') > 0, true, 'a fresh lookup under the new name works');
});

test('binding chain: a rename through the view keeps the recorded bindings, an independent one does not', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const handle = serve(engine.open(file)).fh;
    serve(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'G.txt'));
    assert.equal(fake.exists('G.txt'), true);
    assert.equal(engine.getattr(file).outcome, 'serve');
    assert.equal(serve(engine.read(handle, 0, 4)).data.toString(), 'file');
    fake.externalRename('G.txt', 'H.txt');
    assert.equal(engine.read(handle, 0, 4).outcome, 'refused');
});

test('binding chain: a tainted node cannot be linked or renamed under an ordinary name', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const note = node(engine, dir, 'note.txt');
    fake.externalRename('D', '.data');
    fake.clearCalls();
    const linked = engine.link(note, ROOT_NODE_ID, 'laundered.txt');
    assert.equal(linked.outcome, 'refused');
    assert.equal(engine.rename(dir, 'note.txt', ROOT_NODE_ID, 'laundered.txt').outcome, 'refused');
    assert.equal(backingCalls(fake, 'linkAt') + backingCalls(fake, 'renameAt'), 0);
    assert.equal(fake.exists('laundered.txt'), false);
});

test('binding chain: an identity that cannot be obtained refuses now, is not sticky, and a deep chain is refused explicitly', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    fake.failNext('identityOf', 'EIO');
    const refused = engine.getattr(dir);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.code, 'binding_unproven');
    assert.equal(engine.getattr(dir).outcome, 'serve', 'a transient failure is not a taint');
    fake.failNext('identityAt', 'EIO');
    assert.equal(engine.getattr(dir).code, 'binding_unproven');

    const shallow = rig({ maxBindingChainDepth: 2 });
    shallow.fake.writeFile('a/b/c/d.txt', 'x');
    const a = node(shallow.engine, ROOT_NODE_ID, 'a');
    const b = node(shallow.engine, a, 'b');
    const c = node(shallow.engine, b, 'c');
    assert.equal(shallow.engine.getattr(b).outcome, 'serve');
    assert.equal(shallow.engine.getattr(c).code, 'binding_unproven', 'depth three exceeds the bound of two');
});

test('negative control: a server that checked only the operand name would have answered through the renamed directory', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const held = fake.descriptorOf('D');
    fake.externalRename('D', '.data');
    fake.writeFile('.data/created-after.txt', 'leak');
    // What an operand-only server does: resolve (held parent, ordinary name) and answer.
    const leaked = fake.backing.identityAt(held, 'created-after.txt');
    assert.ok(leaked && leaked.kind === 'file', 'the scenario is real: the entry is reachable through the held descriptor');
    assert.equal(engine.lookup(dir, 'created-after.txt').outcome, 'absent', 'the binding-chain rule closes it');
});

// ---------------------------------------------------------------------------------------------------------------------
// Handle state machine and post-read sequencing.

test('a handle whose file is renamed to a protected name refuses every later operation, with no backing call, and stays refused', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const handle = serve(engine.open(file)).fh;
    assert.equal(serve(engine.read(handle, 0, 4)).data.toString(), 'file');
    fake.externalRename('F.txt', '.env');
    fake.clearCalls();
    for (const attempt of [() => engine.read(handle, 0, 4), () => engine.mappingFault(handle, 0, 4), () => engine.write(handle, 0, Buffer.from('zz'))]) {
        const result = attempt();
        assert.equal(result.outcome, 'refused');
        assert.equal(result.code, 'handle_observed_protected');
        assert.equal(result.data, undefined);
    }
    assert.equal(backingCalls(fake, 'read') + backingCalls(fake, 'write'), 0, 'no data operation reached the backing');
    fake.externalRename('.env', 'F.txt');
    assert.equal(engine.read(handle, 0, 4).outcome, 'refused', 'sticky: a rename back does not lift it');
    assert.equal(fake.read('F.txt'), 'file data', 'nothing was written');
});

test('post-read sequencing: the check runs after the backing read, and data from a read that raced a protected rename is discarded', () => {
    const { fake, engine } = rig();
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    fake.after('read', () => fake.externalRename('F.txt', '.env'));
    fake.clearCalls();
    const result = engine.read(handle, 0, 9);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.data, undefined, 'no bytes are returned');
    const readIndex = fake.calls.indexOf('read');
    const lastCheck = fake.calls.lastIndexOf('identityAt');
    assert.ok(readIndex >= 0, 'the backing read happened');
    assert.ok(fake.calls.slice(0, readIndex).includes('identityAt'), 'a check precedes the read');
    assert.ok(lastCheck > readIndex, 'a check follows the read');
    fake.clearCalls();
    assert.equal(engine.read(handle, 0, 9).code, 'handle_observed_protected');
    assert.equal(backingCalls(fake, 'read'), 0, 'the handle is tainted for later operations');
});

test('negative control: without the post-read check the same interleaving would have returned the bytes', () => {
    const { fake } = rig();
    const handleDesc = fake.backing.openAt(fake.descriptorOf('') ?? fake.backing.rootDescriptor, 'F.txt', { directory: false });
    fake.after('read', () => fake.externalRename('F.txt', '.env'));
    const weak = fake.backing.read(handleDesc, 0, 9);
    assert.equal(weak.toString(), 'file data');
    assert.equal(fake.exists('.env'), true, 'the rename really happened between the read and a would-be check');
});

test('a write that took effect is reported with its true byte count, then the handle is tainted', () => {
    const { fake, engine } = rig();
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    fake.after('write', () => fake.externalRename('F.txt', '.env'));
    const result = engine.write(handle, 0, Buffer.from('ZZZZ'));
    assert.equal(result.outcome, 'serve', 'never reported as refused');
    assert.equal(result.written, 4);
    assert.equal(result.tainted, true);
    assert.equal(result.postCheck, 'handle_observed_protected');
    assert.equal(fake.read('.env'), 'ZZZZ data', 'the backing write took effect');
    fake.clearCalls();
    assert.equal(engine.write(handle, 0, Buffer.from('YY')).outcome, 'refused');
    assert.equal(engine.read(handle, 0, 4).outcome, 'refused');
    assert.equal(backingCalls(fake, 'write') + backingCalls(fake, 'read'), 0);
});

test('a write whose pre-check already finds a protected name is refused and changes nothing', () => {
    const { fake, engine } = rig();
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    fake.externalRename('F.txt', '.data');
    const result = engine.write(handle, 0, Buffer.from('ZZZZ'));
    assert.equal(result.outcome, 'refused');
    assert.equal(fake.read('.data'), 'file data');
});

test('a backing error is reported as the backing error, not as a check result', () => {
    const { fake, engine } = rig();
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    fake.failNext('write', 'ENOSPC');
    const result = engine.write(handle, 0, Buffer.from('q'));
    assert.equal(result.outcome, 'backing_error');
    assert.equal(result.code, 'ENOSPC');
    fake.failNext('read', 'EIO');
    assert.equal(engine.read(handle, 0, 1).outcome, 'backing_error');
    assert.equal(engine.read(handle, 0, 1).outcome, 'serve');
});

test('a listing is subject to the same post-check as a read', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const handle = serve(engine.opendir(dir)).fh;
    fake.after('listDir', () => fake.externalRename('D', '.data'));
    const result = engine.readdir(handle);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.entries, undefined);
});

test('open: the descriptor must be the node, and a binding that breaks during the open refuses and releases it', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const before = engine.ledger.inUse();
    fake.after('openAt', () => fake.externalRename('F.txt', '.env'));
    const result = engine.open(file);
    assert.notEqual(result.outcome, 'serve');
    assert.equal(engine.ledger.inUse(), before, 'the transient open descriptor was released');
    assert.equal(engine.handleCount(), 0);
});

test('lifecycle notifications on a tainted node and handle are honoured, so tainted handles do not leak descriptors', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const handle = serve(engine.open(file)).fh;
    fake.externalRename('F.txt', '.env');
    assert.equal(engine.read(handle, 0, 1).outcome, 'refused');
    const released = engine.release(handle);
    assert.equal(released.outcome, 'serve');
    assert.equal(released.noDataIo, true);
    engine.forget(file, 1);
    assert.equal(engine.ledger.inUse(), 0);
    assert.equal(engine.nodeCount(), 0);
    assert.equal(fake.openDescriptorCount(), 1, 'only the inherited root descriptor remains');
});

test('D2 is decided as option (a) in the engine and mappings are only reads that are refused after taint', () => {
    const { fake, engine } = rig();
    assert.equal(engine.d2, D2_DECISION);
    assert.equal(engine.d2.decided, true);
    assert.equal(engine.d2.option, 'a');
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    assert.equal(engine.mappingFault(handle, 0, 4).outcome, 'serve');
    fake.externalRename('F.txt', '.env');
    assert.equal(engine.mappingFault(handle, 0, 4).code, 'handle_observed_protected');
});

// ---------------------------------------------------------------------------------------------------------------------
// Descriptor cap.

test('at the cap a new lookup is refused explicitly (EMFILE), no live node is evicted, and nothing is tainted', () => {
    const { fake, engine } = rig({ descriptorCap: 3 });
    const d = node(engine, ROOT_NODE_ID, 'D');
    const f = node(engine, ROOT_NODE_ID, 'F.txt');
    const src = node(engine, ROOT_NODE_ID, 'src');
    assert.equal(engine.ledger.inUse(), 3);
    const descriptorsBefore = fake.openDescriptorCount();
    const reused = serve(engine.lookup(ROOT_NODE_ID, 'F.txt'));
    assert.equal(reused.nodeId, f, 'an already tracked entry is reused and needs no descriptor');
    engine.forget(f, 1);
    const overflow = engine.lookup(d, 'inner');
    assert.equal(overflow.outcome, 'refused');
    assert.equal(overflow.code, 'descriptor_cap');
    assert.equal(overflow.errnoHint, 'EMFILE');
    assert.equal(fake.openDescriptorCount(), descriptorsBefore, 'the refusal closed nothing and opened nothing');
    assert.equal(engine.nodeCount(), 3);
    for (const live of [d, f, src]) assert.equal(engine.getattr(live).outcome, 'serve', 'live nodes still answer');
    assert.equal(engine.chainState(d), 'ok');
    assert.equal(engine.ledger.stats().refusals, 1);
    assert.equal(engine.ledger.stats().peak, 3);
    // Once a descriptor is released the same lookup succeeds: the refusal changed nothing.
    engine.forget(src, 1);
    assert.equal(engine.lookup(d, 'inner').outcome, 'serve');
});

test('at the cap, open and opendir are refused explicitly and leave no handle', () => {
    const { fake, engine } = rig({ descriptorCap: 2 });
    const f = node(engine, ROOT_NODE_ID, 'F.txt');
    node(engine, ROOT_NODE_ID, 'src');
    fake.clearCalls();
    assert.equal(engine.open(f).code, 'descriptor_cap');
    assert.equal(engine.opendir(ROOT_NODE_ID).code, 'descriptor_cap');
    assert.equal(engine.handleCount(), 0);
    assert.equal(backingCalls(fake, 'openAt'), 0, 'the backing was not asked to open');
});

test('at the cap the create has no effect and a protected name is still absent, not a cap error', () => {
    const { fake, engine } = rig({ descriptorCap: 2 });
    node(engine, ROOT_NODE_ID, 'F.txt');
    node(engine, ROOT_NODE_ID, 'src');
    fake.writeFile('.data', 'x');
    fake.clearCalls();
    const refused = engine.create(ROOT_NODE_ID, 'new.txt');
    assert.equal(refused.code, 'descriptor_cap');
    assert.equal(backingCalls(fake, 'createAt'), 0);
    assert.equal(fake.exists('new.txt'), false);
    assert.equal(engine.lookup(ROOT_NODE_ID, '.data').code, 'protected_name');
    assert.equal(engine.lookup(ROOT_NODE_ID, 'nothing').code, 'not_found');
});

test('forget releases a descriptor only when the lookup count reaches zero and no child or handle depends on the node', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const again = node(engine, ROOT_NODE_ID, 'D');
    assert.equal(again, dir, 'the same entry is the same node');
    const inner = node(engine, dir, 'inner');
    assert.equal(engine.ledger.inUse(), 2);
    engine.forget(dir, 1);
    assert.equal(engine.ledger.inUse(), 2, 'one lookup is still outstanding');
    engine.forget(dir, 1);
    assert.equal(engine.ledger.inUse(), 2, 'the child depends on the parent descriptor');
    assert.equal(engine.getattr(inner).outcome, 'serve', 'the child still has its whole chain');
    engine.forget(inner, 1);
    assert.equal(engine.ledger.inUse(), 0, 'the child released, then the parent');
    assert.equal(fake.openDescriptorCount(), 1);
    assert.throws(() => engine.forget(inner, 1), TypeError, 'the node is gone');
});

test('an open handle keeps its node alive, and release frees the whole chain', () => {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const file = node(engine, dir, 'note.txt');
    const handle = serve(engine.open(file)).fh;
    assert.equal(engine.ledger.inUse(), 3);
    engine.forget(file, 1);
    engine.forget(dir, 1);
    assert.equal(engine.ledger.inUse(), 3, 'the handle holds the file node and its ancestors');
    engine.release(handle);
    assert.equal(engine.ledger.inUse(), 0);
    assert.equal(fake.openDescriptorCount(), 1);
});

test('forget beyond the lookup count is a protocol error, not a silent clamp', () => {
    const { engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    assert.throws(() => engine.forget(file, 2), RangeError);
    assert.throws(() => engine.forget(file, 0), RangeError);
    assert.throws(() => engine.forget(file, 1.5), RangeError);
});

test('the ledger and the backing agree after a mixed sequence, and the peak is recorded for G6', () => {
    const { fake, engine } = rig({ descriptorCap: 16 });
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const inner = node(engine, dir, 'inner');
    const file = node(engine, inner, 'file.txt');
    const handles = [serve(engine.open(file)).fh, serve(engine.opendir(dir)).fh];
    serve(engine.create(dir, 'c.txt'));
    assert.equal(engine.ledger.inUse(), fake.openDescriptorCount() - 1, 'every derived descriptor is counted');
    assert.ok(engine.ledger.stats().peak >= 6);
    for (const fh of handles) engine.release(fh);
    for (const id of [file, inner, dir]) engine.forget(id, 1);
    // c.txt was created and looked up once by create: release it too.
    const created = engine.lookup(dir, 'c.txt');
    engine.forget(created.nodeId, 2);
    assert.equal(engine.ledger.inUse(), 0);
    assert.equal(fake.openDescriptorCount(), 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Unlink, rmdir and directory rename with hidden descendants (decision record DR-1).

test('rmdir and directory rename are refused when a protected entry hides below, and when that cannot be established', () => {
    const { fake, engine } = rig();
    fake.writeFile('H/deep/.env', 'secret');
    fake.mkdirp('Clean/sub');
    const h = node(engine, ROOT_NODE_ID, 'H');
    node(engine, ROOT_NODE_ID, 'Clean');
    fake.clearCalls();
    assert.equal(engine.remove(ROOT_NODE_ID, 'H', { directory: true }).code, 'hidden_descendants');
    assert.equal(engine.rename(ROOT_NODE_ID, 'H', ROOT_NODE_ID, 'H2').code, 'hidden_descendants');
    assert.equal(backingCalls(fake, 'removeAt') + backingCalls(fake, 'renameAt'), 0);
    assert.equal(fake.exists('H/deep/.env'), true);
    fake.failNext('listChildren', 'EIO');
    assert.equal(engine.remove(ROOT_NODE_ID, 'Clean', { directory: true }).code, 'hidden_descendants_unknown');
    serve(engine.remove(ROOT_NODE_ID, 'Clean', { directory: true }));
    assert.equal(fake.exists('Clean'), false);
    assert.equal(engine.getattr(h).outcome, 'serve');
});

test('a scan beyond its entry budget refuses', () => {
    const { fake, engine } = rig({ maxDescendantScanEntries: 3 });
    for (let index = 0; index < 6; index += 1) fake.writeFile(`Big/f${index}`, 'x');
    assert.equal(engine.remove(ROOT_NODE_ID, 'Big', { directory: true }).code, 'hidden_descendants_unknown');
});

test('unlink of a protected name is absent and has no backing effect; unlink of an ordinary file works', () => {
    const { fake, engine } = rig();
    fake.writeFile('.env', 'x');
    fake.clearCalls();
    const result = engine.remove(ROOT_NODE_ID, '.env');
    assert.equal(result.outcome, 'absent');
    assert.equal(backingCalls(fake, 'removeAt'), 0);
    assert.equal(fake.exists('.env'), true);
    serve(engine.remove(ROOT_NODE_ID, 'F.txt'));
    assert.equal(fake.exists('F.txt'), false);
});

test('the engine rejects a backing without a readable root identity', () => {
    const fake = createFakeBacking();
    const broken = { ...fake.backing, identityOf: () => null };
    assert.throws(() => createViewEngine({ backing: broken }), /grant root identity/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Review findings F2 (exchange target resolved afresh) and F3 (link lookup accounting).

test('F2 probe B: an exchange with an UNTRACKED directory target that hides an .env is refused and nothing moves', () => {
    const { fake, engine } = rig();
    fake.writeFile('dirB/.env', 'SECRET=1');
    node(engine, ROOT_NODE_ID, 'F.txt');
    fake.clearCalls();
    const result = engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'dirB', { exchange: true });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'hidden_descendants');
    assert.equal(backingCalls(fake, 'renameAt'), 0);
    assert.equal(fake.exists('dirB/.env'), true);
    assert.equal(fake.exists('F.txt/.env'), false);
});

test('F2 probe C: a tracked file target replaced by a directory holding .env after its lookup is refused', () => {
    const { fake, engine } = rig();
    fake.writeFile('b', 'file');
    node(engine, ROOT_NODE_ID, 'F.txt');
    node(engine, ROOT_NODE_ID, 'b');
    fake.externalRemove('b');
    fake.writeFile('b/.env', 'S');
    fake.clearCalls();
    const result = engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'b', { exchange: true });
    assert.equal(result.outcome, 'refused');
    assert.equal(backingCalls(fake, 'renameAt'), 0);
    assert.equal(fake.exists('F.txt/.env'), false, 'the directory with the hidden entry did not move to the source name');
});

test('F2 control: a tracked directory target that was looked up first is also refused when it hides an entry', () => {
    const { fake, engine } = rig();
    fake.writeFile('dirB/.env', 'S');
    node(engine, ROOT_NODE_ID, 'F.txt');
    node(engine, ROOT_NODE_ID, 'dirB');
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'dirB', { exchange: true }).code, 'hidden_descendants');
});

test('F2 positive controls: an exchange of two files, and of a clean directory, is served and the bindings follow', () => {
    const { fake, engine } = rig();
    fake.writeFile('G.txt', 'g');
    const f = node(engine, ROOT_NODE_ID, 'F.txt');
    const g = node(engine, ROOT_NODE_ID, 'G.txt');
    serve(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'G.txt', { exchange: true }));
    assert.equal(fake.read('F.txt'), 'g');
    assert.equal(fake.read('G.txt'), 'file data');
    assert.equal(engine.getattr(f).outcome, 'serve', 'the moved node keeps a proven binding under its new name');
    assert.equal(engine.getattr(g).outcome, 'serve');
    fake.mkdirp('Clean/x');
    node(engine, ROOT_NODE_ID, 'Clean');
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'Clean', { exchange: true }).outcome, 'serve');
});

test('F2: an exchange target whose identity cannot be resolved, or whose kind is unknown, is refused as unknown', () => {
    const missing = rig();
    node(missing.engine, ROOT_NODE_ID, 'F.txt');
    assert.equal(missing.engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'nothing-here', { exchange: true }).code, 'hidden_descendants_unknown');

    const { fake } = rig();
    fake.writeFile('T', 'x');
    const odd = { ...fake.backing, identityAt: (dir, name) => (name === 'T' ? { identity: 'fake:odd', kind: 'other' } : fake.backing.identityAt(dir, name)) };
    const engine = createViewEngine({ backing: odd });
    node(engine, ROOT_NODE_ID, 'F.txt');
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'T', { exchange: true }).code, 'hidden_descendants_unknown');

    const noIdentity = rig();
    noIdentity.fake.writeFile('T', 'x');
    const blind = { ...noIdentity.fake.backing, identityAt: (dir, name) => (name === 'T' ? { identity: null, kind: 'file' } : noIdentity.fake.backing.identityAt(dir, name)) };
    const blindEngine = createViewEngine({ backing: blind });
    node(blindEngine, ROOT_NODE_ID, 'F.txt');
    assert.equal(blindEngine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'T', { exchange: true }).code, 'hidden_descendants_unknown');
});

test('F2: a tracked target that is no longer the object at that name is refused unless the scan proves it clean, and is not re-bound', () => {
    const { fake, engine } = rig();
    fake.writeFile('b', 'file');
    node(engine, ROOT_NODE_ID, 'F.txt');
    const stale = node(engine, ROOT_NODE_ID, 'b');
    fake.externalReplace('b');
    // A replacement file: the scan of a file cannot prove false, so the fail-closed rule refuses.
    assert.equal(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'b', { exchange: true }).code, 'hidden_descendants_unknown');
    // Replaced by a clean directory: the scan proves false, the exchange goes through and the stale node is cut off.
    fake.externalRemove('b');
    fake.mkdirp('b/clean');
    serve(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'b', { exchange: true }));
    assert.equal(engine.getattr(stale).outcome, 'absent', 'the stale node does not follow the new object');
});

test('F3: link counts as a kernel lookup of the linked node, so lookup, link and forget(2) balance and the ledger drains', () => {
    const { fake, engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const linked = serve(engine.link(file, ROOT_NODE_ID, 'g.txt'));
    assert.equal(linked.nodeId, file, 'the reply names the linked node');
    assert.equal(engine.ledger.inUse(), 1);
    engine.forget(file, 2);
    assert.equal(engine.ledger.inUse(), 0, 'the descriptor is released once both lookups are forgotten');
    assert.equal(engine.nodeCount(), 0);
    assert.equal(fake.openDescriptorCount(), 1);
    assert.throws(() => engine.forget(file, 1), TypeError);
});

test('F3 negative control: forgetting only once after a link leaves the node alive, as the kernel still holds a reference', () => {
    const { engine } = rig();
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    serve(engine.link(file, ROOT_NODE_ID, 'g.txt'));
    engine.forget(file, 1);
    assert.equal(engine.ledger.inUse(), 1);
    assert.equal(engine.getattr(file).outcome, 'serve');
});

// Review delta D1: the exchange target is resolved only after the policy accepted the operands and the chains.
function countingEngine(fake) {
    const asked = [];
    const backing = { ...fake.backing, identityAt: (dir, name) => { asked.push(name); return fake.backing.identityAt(dir, name); } };
    return { engine: createViewEngine({ backing }), asked };
}

test('D1: an exchange onto a protected name never asks the backing about the target name', () => {
    const { fake } = rig();
    fake.writeFile('.env', 'S');
    const { engine, asked } = countingEngine(fake);
    node(engine, ROOT_NODE_ID, 'F.txt');
    for (const protectedName of ['.env', '.Data.', 'x.secrets', '.roboteam', '.e‌nv']) {
        asked.length = 0;
        fake.clearCalls();
        const result = engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, protectedName, { exchange: true });
        assert.equal(result.outcome, 'refused', protectedName);
        assert.equal(result.code, 'protected_operand', protectedName);
        assert.equal(asked.includes(protectedName), false, `${protectedName} reached the backing`);
        assert.equal(backingCalls(fake, 'renameAt'), 0);
    }
});

test('D1: an exchange into a protected new-parent chain never asks the backing about the target name', () => {
    const { fake } = rig();
    fake.writeFile('D/target-name', 'y');
    const { engine, asked } = countingEngine(fake);
    node(engine, ROOT_NODE_ID, 'F.txt');
    const dir = node(engine, ROOT_NODE_ID, 'D');
    node(engine, dir, 'target-name');
    fake.externalRename('D', '.data');
    asked.length = 0;
    const result = engine.rename(ROOT_NODE_ID, 'F.txt', dir, 'target-name', { exchange: true });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'node_under_protected_component');
    assert.equal(asked.includes('target-name'), false, 'the target name was not resolved in the protected directory');
});

test('D1 control: an exchange onto an ordinary name does resolve the target name, so the assertions above can fail', () => {
    const { fake } = rig();
    fake.writeFile('G.txt', 'g');
    const { engine, asked } = countingEngine(fake);
    node(engine, ROOT_NODE_ID, 'F.txt');
    asked.length = 0;
    serve(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'G.txt', { exchange: true }));
    assert.equal(asked.includes('G.txt'), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Decision D-S5-10 (DR-1, decided): both sides of an exchange, and the documented residual.

test('D-S5-10: an exchange whose SOURCE directory hides an .env is refused and nothing moves', () => {
    const { fake, engine } = rig();
    fake.writeFile('H/.env', 'SECRET=1');
    node(engine, ROOT_NODE_ID, 'H');
    node(engine, ROOT_NODE_ID, 'F.txt');
    fake.clearCalls();
    const result = engine.rename(ROOT_NODE_ID, 'H', ROOT_NODE_ID, 'F.txt', { exchange: true });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.code, 'hidden_descendants');
    assert.equal(backingCalls(fake, 'renameAt'), 0);
    assert.equal(fake.exists('H/.env'), true);
    assert.equal(fake.read('F.txt'), 'file data');
});

test('D-S5-10 positive control: the same source-side exchange with a clean directory is served', () => {
    const { fake, engine } = rig();
    fake.writeFile('H/plain.txt', 'x');
    node(engine, ROOT_NODE_ID, 'H');
    node(engine, ROOT_NODE_ID, 'F.txt');
    serve(engine.rename(ROOT_NODE_ID, 'H', ROOT_NODE_ID, 'F.txt', { exchange: true }));
    assert.equal(fake.exists('F.txt/plain.txt'), true);
});

test('D-S5-10 residual (documented, not exclusion): an .env created after the scan read its directory is moved along', () => {
    const { fake, engine } = rig();
    fake.mkdirp('Clean/sub');
    node(engine, ROOT_NODE_ID, 'Clean');
    // An independent writer adds a protected entry right after the scan listed the directory.
    fake.after('listChildren', () => fake.writeFile('Clean/.env', 'x'));
    const result = engine.rename(ROOT_NODE_ID, 'Clean', ROOT_NODE_ID, 'Clean2');
    assert.equal(result.outcome, 'serve', 'the scan is not atomic against independent writers (DR-1 text)');
    assert.equal(fake.exists('Clean2/.env'), true, 'the residual is real: the late entry moved with the directory');
});

// ---------------------------------------------------------------------------------------------------------------------
// Root revocation (decision D-S5-6): the keeper's SIGTERM, modelled as engine.revokeRoot().

function revokedRig() {
    const { fake, engine } = rig();
    const dir = node(engine, ROOT_NODE_ID, 'D');
    const file = node(engine, ROOT_NODE_ID, 'F.txt');
    const fileHandle = serve(engine.open(file)).fh;
    const dirHandle = serve(engine.opendir(dir)).fh;
    return { fake, engine, dir, file, fileHandle, dirHandle };
}

test('root revocation: every node is protected, queries are absent, handles and creates are refused, with no backing call', () => {
    const { fake, engine, dir, file, fileHandle, dirHandle } = revokedRig();
    assert.equal(serve(engine.read(fileHandle, 0, 4)).data.toString(), 'file', 'negative control: the same read is served right before');
    assert.equal(engine.rootState(), 'ok');
    assert.deepEqual(engine.revokeRoot(), { outcome: 'serve', code: 'allowed', alreadyRevoked: false });
    fake.clearCalls();
    assert.equal(engine.rootState(), 'protected');
    for (const id of [ROOT_NODE_ID, dir, file]) assert.equal(engine.chainState(id), 'protected', String(id));
    for (const [parent, name] of [[ROOT_NODE_ID, 'F.txt'], [ROOT_NODE_ID, 'nothing'], [dir, 'note.txt']]) {
        const result = engine.lookup(parent, name);
        assert.equal(result.outcome, 'absent', name);
        assert.equal(result.errnoHint, 'ENOENT', name);
    }
    for (const id of [ROOT_NODE_ID, dir, file]) assert.equal(engine.getattr(id).outcome, 'absent');
    for (const attempt of [() => engine.read(fileHandle, 0, 4), () => engine.write(fileHandle, 0, Buffer.from('zz')),
        () => engine.mappingFault(fileHandle, 0, 4), () => engine.readdir(dirHandle)]) {
        const result = attempt();
        assert.equal(result.outcome, 'refused');
        assert.equal(result.code, 'handle_observed_protected');
        assert.equal(result.data, undefined);
        assert.equal(result.entries, undefined);
    }
    assert.equal(engine.create(ROOT_NODE_ID, 'new.txt').outcome, 'refused');
    assert.equal(engine.create(dir, 'new-dir', { directory: true }).outcome, 'refused');
    assert.notEqual(engine.open(file).outcome, 'serve');
    assert.notEqual(engine.opendir(ROOT_NODE_ID).outcome, 'serve');
    assert.notEqual(engine.remove(ROOT_NODE_ID, 'F.txt').outcome, 'serve');
    assert.notEqual(engine.rename(ROOT_NODE_ID, 'F.txt', ROOT_NODE_ID, 'G.txt').outcome, 'serve');
    assert.notEqual(engine.link(file, ROOT_NODE_ID, 'copy.txt').outcome, 'serve');
    assert.deepEqual(fake.calls, [], 'no backing call of any kind after the revocation');
    assert.equal(fake.exists('new.txt'), false);
    assert.equal(fake.read('F.txt'), 'file data');
    // Lifecycle requests are served (DR-3) and drain the descriptors.
    assert.equal(engine.release(fileHandle).outcome, 'serve');
    assert.equal(engine.releasedir(dirHandle).outcome, 'serve');
    assert.equal(engine.forget(file, 1).outcome, 'serve');
    assert.equal(engine.forget(dir, 1).outcome, 'serve');
    assert.equal(engine.ledger.inUse(), 0);
    assert.equal(fake.openDescriptorCount(), 1);
});

test('root revocation is sticky and idempotent: a second call reports alreadyRevoked and queues nothing new', () => {
    const { engine } = revokedRig();
    engine.revokeRoot();
    assert.ok(engine.takeInvalidations().length > 0);
    assert.deepEqual(engine.revokeRoot(), { outcome: 'serve', code: 'allowed', alreadyRevoked: true });
    assert.deepEqual(engine.takeInvalidations(), []);
    assert.equal(engine.lookup(ROOT_NODE_ID, 'F.txt').outcome, 'absent');
    assert.deepEqual(engine.takeInvalidations(), [], 'later refusals queue nothing either');
});

test('D2 post-read under root revocation: data from a read that the revocation overtook is discarded', () => {
    const { fake, engine, fileHandle } = revokedRig();
    fake.after('read', () => engine.revokeRoot());
    const result = engine.read(fileHandle, 0, 9);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.data, undefined);
    assert.ok(fake.calls.includes('read'), 'the backing read did happen');
});

test('D2 truthful write under root revocation: a write that took effect during the drain is reported with its byte count', () => {
    const { fake, engine, fileHandle } = revokedRig();
    fake.after('write', () => engine.revokeRoot());
    const result = engine.write(fileHandle, 0, Buffer.from('ZZZZ'));
    assert.equal(result.outcome, 'serve', 'never relabelled as an authorization refusal');
    assert.equal(result.written, 4);
    assert.equal(result.tainted, true);
    assert.equal(fake.read('F.txt'), 'ZZZZ data');
});

test('D2 truthful partial write under root revocation: fewer bytes than asked are reported as the actual count, never as a refusal', () => {
    const fake = createFakeBacking();
    fake.writeFile('F.txt', 'file data');
    // A backing that completes only two bytes of the write, as a short write(2) can.
    const shortWrites = { ...fake.backing, write: (desc, offset, data) => fake.backing.write(desc, offset, Buffer.from(data).subarray(0, 2)) };
    const engine = createViewEngine({ backing: shortWrites });
    const handle = serve(engine.open(node(engine, ROOT_NODE_ID, 'F.txt'))).fh;
    fake.after('write', () => engine.revokeRoot());
    const result = engine.write(handle, 0, Buffer.from('ZZZZ'));
    assert.equal(result.outcome, 'serve');
    assert.equal(result.written, 2, 'the actual completed count');
    assert.equal(result.tainted, true);
    assert.equal(fake.read('F.txt'), 'ZZle data', 'exactly the reported bytes took effect');
    assert.equal(engine.write(handle, 0, Buffer.from('Y')).code, 'handle_observed_protected', 'later writes are refused before any effect');
    assert.equal(fake.read('F.txt'), 'ZZle data');
});

test('D2 invalidation intents: every live node once on root revocation, then nothing; an observed handle queues its node once', () => {
    const { engine, dir, file } = revokedRig();
    assert.deepEqual(engine.takeInvalidations(), [], 'nothing before any protected transition');
    engine.revokeRoot();
    const taken = engine.takeInvalidations();
    assert.deepEqual([...taken].sort((a, b) => a - b), [ROOT_NODE_ID, dir, file]);
    assert.ok(Object.isFrozen(taken));
    assert.deepEqual(engine.takeInvalidations(), []);

    const other = rig();
    const f = node(other.engine, ROOT_NODE_ID, 'F.txt');
    const handle = serve(other.engine.open(f)).fh;
    other.fake.externalRename('F.txt', '.env');
    other.engine.read(handle, 0, 1);
    other.engine.read(handle, 0, 1);
    assert.deepEqual(other.engine.takeInvalidations(), [f], 'queued once, deduplicated');
    other.engine.read(handle, 0, 1);
    assert.deepEqual(other.engine.takeInvalidations(), [], 'sticky state does not re-queue');
});

test('D2 invalidation is an intent only: outcomes are identical in a twin engine that never drains the queue', () => {
    const script = (engine, fake, drain) => {
        const outcomes = [];
        const record = (result) => { outcomes.push([result.outcome, result.code]); if (drain) engine.takeInvalidations(); return result; };
        const d = record(engine.lookup(ROOT_NODE_ID, 'D')).nodeId;
        const f = record(engine.lookup(ROOT_NODE_ID, 'F.txt')).nodeId;
        const h = record(engine.open(f)).fh;
        record(engine.read(h, 0, 4));
        fake.externalRename('D', '.data');
        record(engine.getattr(d));
        record(engine.lookup(d, 'note.txt'));
        record(engine.read(h, 0, 4));
        record(engine.revokeRoot());
        record(engine.read(h, 0, 4));
        record(engine.getattr(f));
        record(engine.release(h));
        return outcomes;
    };
    const drained = rig();
    const kept = rig();
    assert.deepEqual(script(drained.engine, drained.fake, true), script(kept.engine, kept.fake, false));
    assert.ok(kept.engine.takeInvalidations().length >= 3, 'the undrained twin did accumulate intents');
});

// Review r4 F3: a node created by an operation that the revocation overtook. Only the root check of chainState stops it.
test('root revocation overtaking a lookup: the node it creates is protected, and nothing reaches the backing afterwards', () => {
    const { fake, engine } = rig();
    // The keeper's SIGTERM lands after the lookup's backing identityAt, before the node is registered.
    fake.after('identityAt', () => engine.revokeRoot());
    const looked = engine.lookup(ROOT_NODE_ID, 'F.txt');
    assert.equal(engine.rootState(), 'protected', 'the revocation happened inside the lookup');
    // The lookup itself may still answer serve (residual: detection at the next server-visible operation).
    assert.equal(looked.outcome, 'serve');
    const overtaken = looked.nodeId;
    fake.clearCalls();
    assert.equal(engine.chainState(overtaken), 'protected');
    assert.equal(engine.getattr(overtaken).outcome, 'absent');
    const opened = engine.open(overtaken);
    assert.notEqual(opened.outcome, 'serve');
    assert.equal(opened.fh, undefined, 'no handle, so no read can be served');
    assert.notEqual(engine.link(overtaken, ROOT_NODE_ID, 'copy.txt').outcome, 'serve');
    assert.deepEqual(fake.calls, [], 'no backing call on the overtaken node');
    assert.equal(engine.forget(overtaken, 1).outcome, 'serve', 'lifecycle is still served');
});
