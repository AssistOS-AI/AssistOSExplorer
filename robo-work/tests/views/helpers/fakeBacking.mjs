// An in-memory fake of the backing file system for the view engine, with injectable renames and step hooks.
//
// Identity is the object's inode string. A descriptor refers to the object, not to a path, as on a real file system:
// renaming or moving the object by anybody leaves the descriptor valid and attached to it. That is what makes the
// protected-rename scenarios meaningful: the held data stays reachable through the descriptor unless the engine refuses.
//
// Hooks: before(method, fn) and after(method, fn) run around the next call of a backing method (one-shot by default).
// A test uses after('read', ...) to rename between the backing read and the post-check.

function fail(code) {
    return Object.assign(new Error(code), { code });
}

export function createFakeBacking() {
    let inode = 100;
    const newObject = (kind) => {
        inode += 1;
        return { inode: `fake:${inode}`, kind, children: kind === 'dir' ? new Map() : null, data: Buffer.alloc(0) };
    };
    const rootObject = newObject('dir');
    const descriptors = new Map();
    let nextDescriptor = 3;
    const calls = [];
    const hooks = { before: new Map(), after: new Map() };
    const failures = new Map();

    const openDescriptor = (object) => {
        const desc = nextDescriptor;
        nextDescriptor += 1;
        descriptors.set(desc, object);
        return desc;
    };
    const rootDescriptor = openDescriptor(rootObject);
    const objectOf = (desc) => {
        const object = descriptors.get(desc);
        if (!object) throw fail('EBADF');
        return object;
    };

    function runHooks(kind, method, args) {
        const list = hooks[kind].get(method);
        if (!list || list.length === 0) return;
        const entry = list[0];
        if (entry.once) list.shift();
        entry.fn(...args);
    }

    // Wraps a method: log, before hook, injected failure, the call, after hook.
    function step(method, implementation) {
        return (...args) => {
            calls.push(method);
            runHooks('before', method, args);
            if (failures.has(method)) {
                const code = failures.get(method);
                failures.delete(method);
                throw fail(code);
            }
            const result = implementation(...args);
            runHooks('after', method, args);
            return result;
        };
    }

    const walk = (names, from = rootObject) => {
        let current = from;
        for (const name of names) {
            if (current.kind !== 'dir' || !current.children.has(name)) throw fail('ENOENT');
            current = current.children.get(name);
        }
        return current;
    };
    const split = (path) => (path === '' ? [] : path.split('/'));

    const backing = {
        rootDescriptor,
        identityAt: step('identityAt', (dir, name) => {
            const parent = objectOf(dir);
            const child = parent.kind === 'dir' ? parent.children.get(name) : undefined;
            return child ? { identity: child.inode, kind: child.kind } : null;
        }),
        identityOf: step('identityOf', (desc) => objectOf(desc).inode),
        openAt: step('openAt', (dir, name) => {
            const parent = objectOf(dir);
            if (name === '.') return openDescriptor(parent);
            const child = parent.kind === 'dir' ? parent.children.get(name) : undefined;
            if (!child) throw fail('ENOENT');
            return openDescriptor(child);
        }),
        close: step('close', (desc) => {
            if (!descriptors.delete(desc)) throw fail('EBADF');
        }),
        read: step('read', (desc, offset, length) => objectOf(desc).data.subarray(offset, offset + length)),
        write: step('write', (desc, offset, data) => {
            const object = objectOf(desc);
            const next = Buffer.alloc(Math.max(object.data.length, offset + data.length));
            object.data.copy(next);
            Buffer.from(data).copy(next, offset);
            object.data = next;
            return data.length;
        }),
        listDir: step('listDir', (desc) => [...objectOf(desc).children.keys()]),
        listChildren: step('listChildren', (dir, relNames) => {
            const directory = walk(relNames, objectOf(dir));
            if (directory.kind !== 'dir') throw fail('ENOTDIR');
            return [...directory.children].map(([name, child]) => ({ name, isDirectory: child.kind === 'dir' }));
        }),
        createAt: step('createAt', (dir, name, { directory }) => {
            const parent = objectOf(dir);
            if (parent.children.has(name)) throw fail('EEXIST');
            parent.children.set(name, newObject(directory ? 'dir' : 'file'));
        }),
        removeAt: step('removeAt', (dir, name) => {
            const parent = objectOf(dir);
            if (!parent.children.delete(name)) throw fail('ENOENT');
        }),
        renameAt: step('renameAt', (dir, name, newDir, newName, { exchange }) => {
            const from = objectOf(dir);
            const to = objectOf(newDir);
            const moved = from.children.get(name);
            if (!moved) throw fail('ENOENT');
            if (exchange) {
                const other = to.children.get(newName);
                if (!other) throw fail('ENOENT');
                from.children.set(name, other);
                to.children.set(newName, moved);
                return;
            }
            from.children.delete(name);
            to.children.set(newName, moved);
        }),
        linkAt: step('linkAt', (sourceDesc, newDir, newName) => {
            objectOf(newDir).children.set(newName, objectOf(sourceDesc));
        })
    };

    return {
        backing,
        calls,
        // Tree setup and independent writers (these are not backing calls and are not logged).
        mkdirp(path) {
            let current = rootObject;
            for (const name of split(path)) {
                if (!current.children.has(name)) current.children.set(name, newObject('dir'));
                current = current.children.get(name);
            }
            return current;
        },
        writeFile(path, text) {
            const names = split(path);
            const parent = this.mkdirp(names.slice(0, -1).join('/'));
            const object = parent.children.get(names.at(-1)) ?? newObject('file');
            object.data = Buffer.from(text);
            parent.children.set(names.at(-1), object);
            return object;
        },
        // Another writer renames or moves an entry directly in the backing.
        externalRename(fromPath, toPath) {
            const from = split(fromPath);
            const to = split(toPath);
            const source = walk(from.slice(0, -1));
            const target = walk(to.slice(0, -1));
            const moved = source.children.get(from.at(-1));
            if (!moved) throw fail('ENOENT');
            source.children.delete(from.at(-1));
            target.children.set(to.at(-1), moved);
        },
        externalRemove(path) {
            const names = split(path);
            walk(names.slice(0, -1)).children.delete(names.at(-1));
        },
        // Replaces the entry with a new, different object of the same name (identity changes).
        externalReplace(path) {
            const names = split(path);
            const parent = walk(names.slice(0, -1));
            const old = parent.children.get(names.at(-1));
            parent.children.set(names.at(-1), newObject(old ? old.kind : 'file'));
        },
        read(path) {
            return walk(split(path)).data.toString();
        },
        exists(path) {
            try {
                walk(split(path));
                return true;
            } catch {
                return false;
            }
        },
        identityOfPath: (path) => walk(split(path)).inode,
        openDescriptorCount: () => descriptors.size,
        // A held descriptor of the object currently at `path`, as an operand-only server would still hold it.
        descriptorOf(path) {
            const object = walk(split(path));
            for (const [desc, held] of descriptors) if (held === object) return desc;
            return null;
        },
        before(method, fn, { once = true } = {}) {
            if (!hooks.before.has(method)) hooks.before.set(method, []);
            hooks.before.get(method).push({ fn, once });
        },
        after(method, fn, { once = true } = {}) {
            if (!hooks.after.has(method)) hooks.after.set(method, []);
            hooks.after.get(method).push({ fn, once });
        },
        failNext(method, code) {
            failures.set(method, code);
        },
        clearFailures() {
            failures.clear();
        },
        clearCalls() {
            calls.length = 0;
        }
    };
}
