// Ploinky binds /code directly from this already verified repository mount.
// This helper is serialized with the snapshot reader; keep its imports local.
export async function readLiveSkillsCodeHashes({ expectedRepository, contractFiles, agentName = 'roboTeamAgent' }, { codeRoot = '/code', fsApi } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const cleanAbsolute = value => typeof value === 'string' && path.isAbsolute(value)
        && path.normalize(value) === value && value !== '/' && !value.endsWith('/');
    assert.ok(cleanAbsolute(expectedRepository) && cleanAbsolute(codeRoot));
    assert.ok(['roboTeamAgent', 'roboWorkAgent'].includes(agentName), 'Invalid evidence owner.');
    const sourceRoot = `${expectedRepository}/${agentName}`;
    assert.ok(Array.isArray(contractFiles) && contractFiles.length > 0 && new Set(contractFiles).size === contractFiles.length);
    for (const file of contractFiles) {
        assert.ok(typeof file === 'string' && /^[a-zA-Z0-9/.-]+\.mjs$/.test(file)
            && !path.isAbsolute(file) && file.split('/').every(part => part && part !== '.' && part !== '..'));
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const sameFile = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
    const observe = filename => {
        assert.equal(fs.realpathSync(filename), filename, 'Contract path must remain canonical without symlinks.');
        return fs.lstatSync(filename, { bigint: true });
    };
    const descriptors = [];
    const open = (filename, extra = 0) => {
        const fd = fs.openSync(filename, flags | extra);
        descriptors.push(fd);
        return fd;
    };
    const close = fd => {
        descriptors.splice(descriptors.indexOf(fd), 1);
        fs.closeSync(fd);
    };
    try {
        const roots = [sourceRoot, codeRoot].map(filename => ({ filename, before: observe(filename) }));
        for (const root of roots) {
            assert.ok(root.before.isDirectory(), 'Contract root must be a directory.');
            root.fd = open(root.filename, fs.constants.O_DIRECTORY);
            const pinned = fs.fstatSync(root.fd, { bigint: true });
            assert.ok(pinned.isDirectory() && sameObject(root.before, pinned), 'Contract root changed while opening.');
        }
        assert.ok(sameObject(roots[0].before, roots[1].before), 'Runtime root is not the verified source directory object.');
        const fenceRoots = () => {
            for (const root of roots) {
                const current = observe(root.filename), pinned = fs.fstatSync(root.fd, { bigint: true });
                assert.ok(current.isDirectory() && pinned.isDirectory() && sameObject(root.before, current)
                    && sameObject(root.before, pinned), 'Contract root changed during its read.');
                assert.equal(fs.realpathSync(`/proc/self/fd/${root.fd}`), root.filename, 'Contract root descriptor changed.');
            }
        };
        const hashes = {};
        for (const file of contractFiles) {
            fenceRoots();
            const entries = roots.map(root => ({ filename: `${root.filename}/${file}` }));
            for (const entry of entries) {
                entry.before = observe(entry.filename);
                assert.ok(entry.before.isFile() && entry.before.nlink === 1n && entry.before.size <= 4n * 1024n * 1024n,
                    'Contract file must be a bounded single-link regular file.');
            }
            try {
                for (const entry of entries) {
                    entry.fd = open(entry.filename);
                    const pinned = fs.fstatSync(entry.fd, { bigint: true });
                    assert.ok(pinned.isFile() && sameFile(entry.before, pinned), 'Contract file changed while opening.');
                }
                assert.ok(sameFile(entries[0].before, entries[1].before), 'Runtime file is not the verified source file object.');
                const data = fs.readFileSync(entries[1].fd);
                assert.equal(BigInt(data.length), entries[1].before.size, 'Contract file changed during its read.');
                for (const entry of entries) {
                    assert.ok(sameFile(entry.before, fs.fstatSync(entry.fd, { bigint: true }))
                        && sameFile(entry.before, observe(entry.filename)), 'Contract file changed during its read.');
                    assert.equal(fs.realpathSync(`/proc/self/fd/${entry.fd}`), entry.filename, 'Contract file descriptor changed during its read.');
                    assert.ok(sameFile(entry.before, observe(entry.filename)), 'Contract pathname changed during its read.');
                }
                fenceRoots();
                hashes[file] = createHash('sha256').update(data).digest('hex');
            } finally {
                for (const entry of entries) if (entry.fd !== undefined) close(entry.fd);
            }
        }
        fenceRoots();
        return hashes;
    } finally {
        let failure;
        for (const fd of descriptors.reverse()) {
            try { fs.closeSync(fd); } catch (error) { failure ||= error; }
        }
        if (failure) throw failure;
    }
}
