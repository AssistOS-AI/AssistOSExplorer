// The Box can read kernel namespace links that a nondumpable launch wrapper
// hides from its container owner. Public source reads still belong to the owner.
export async function collectBoxProcReadProofs(initPid) {
    const fs = await import('node:fs');
    const assert = (await import('node:assert/strict')).default;
    assert.ok(Number.isSafeInteger(initPid) && initPid > 1);
    const stat = pid => {
        const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); assert.ok(Buffer.byteLength(text) <= 65536);
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
        assert.equal(Number(text.slice(0, text.indexOf('(')).trim()), pid);
        assert.ok(fields.length >= 20);
        if (fields[0] === 'Z') throw Object.assign(Error('Process ended.'), { code: 'ESRCH' });
        assert.match(fields[19], /^[1-9][0-9]{0,19}$/u);
        const ppid = Number(fields[1]); assert.ok(Number.isSafeInteger(ppid) && ppid >= 0);
        return { boxPid: pid, boxPpid: ppid, startToken: fields[19] };
    };
    const ids = pid => {
        const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); assert.ok(Buffer.byteLength(text) <= 65536);
        const matches = [...text.matchAll(/^NSpid:\s*([0-9]+(?:[\t ]+[0-9]+)*)\s*$/gmu)];
        assert.equal(matches.length, 1);
        const values = matches[0][1].trim().split(/\s+/u).map(Number);
        assert.ok(values.length <= 32 && values.every(value => Number.isSafeInteger(value) && value > 0));
        return values;
    };
    const namespace = pid => { const value = fs.readlinkSync(`/proc/${pid}/ns/pid`); assert.match(value, /^pid:\[[1-9][0-9]*\]$/u); return value; };
    const init = { ...stat(initPid), namespacePids: ids(initPid), pidNamespace: namespace(initPid) };
    const depth = init.namespacePids.length;
    const rows = new Map();
    const names = fs.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/u.test(value)); assert.ok(names.length <= 8192);
    for (const name of names) {
        try { const row = stat(Number(name)); rows.set(row.boxPid, row); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    const below = row => {
        const seen = new Set();
        while (row && !seen.has(row.boxPid) && seen.size < 256) {
            if (row.boxPid === initPid) return true;
            seen.add(row.boxPid); row = rows.get(row.boxPpid);
        }
        return false;
    };
    const processes = [];
    for (const row of rows.values()) {
        if (!below(row)) continue;
        try {
            assert.deepEqual(stat(row.boxPid), row);
            const pids = ids(row.boxPid); assert.ok(pids.length >= depth);
            const parent = row.boxPid === initPid ? 0 : ids(row.boxPpid)[depth - 1];
            assert.ok(Number.isSafeInteger(parent) && parent >= 0);
            const proof = { ...row, pid: pids[depth - 1], ppid: parent, pidNamespace: namespace(row.boxPid) };
            try { proof.executable = fs.readlinkSync(`/proc/${row.boxPid}/exe`); }
            catch (error) { if (error.code !== 'EACCES') throw error; }
            assert.deepEqual(stat(row.boxPid), row);
            assert.equal(namespace(row.boxPid), proof.pidNamespace);
            assert.deepEqual(ids(row.boxPid), pids);
            processes.push(proof);
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    assert.ok(processes.length <= 512 && new Set(processes.map(row => row.pid)).size === processes.length);
    assert.deepEqual({ ...stat(initPid), namespacePids: ids(initPid), pidNamespace: namespace(initPid) }, init);
    return { init, processes };
}

export function buildBoxProcReadProgram(initPid) {
    return `(${collectBoxProcReadProofs.toString()})(${JSON.stringify(initPid)}).then(value => { const text = JSON.stringify(value);`
        + 'if (Buffer.byteLength(text) > 65536) throw Error("Bounded process-link proof exceeded."); process.stdout.write(text); })'
        + '.catch(() => { console.error("Invalid exact Box process-link proof"); process.exitCode = 1; });';
}

export function residentProcReadBridge(fs, proofs) {
    if (proofs === undefined) return { io: fs, used: [] };
    if (!Array.isArray(proofs) || proofs.length > 512 || new Set(proofs.map(row => row.pid)).size !== proofs.length) throw Error('Invalid bounded owner process-link proof.');
    const used = new Set();
    const stat = pid => {
        const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (Buffer.byteLength(text) > 65536) throw Error('Bounded owner identity exceeded.');
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
        if (Number(text.slice(0, text.indexOf('(')).trim()) !== pid || fields.length < 20 || fields[0] === 'Z'
            || !/^(?:0|[1-9][0-9]*)$/u.test(fields[1]) || !/^[1-9][0-9]{0,19}$/u.test(fields[19])) throw Error('Invalid owner process incarnation.');
        return { pid, ppid: Number(fields[1]), startToken: fields[19] };
    };
    const io = { ...fs, readlinkSync(file, ...args) {
        try { return fs.readlinkSync(file, ...args); }
        catch (error) {
            if (error.code !== 'EACCES') throw error;
            const match = /^\/proc\/([1-9][0-9]*)\/(ns\/pid|exe)$/u.exec(file);
            const proof = match && proofs.find(row => row.pid === Number(match[1]));
            if (!proof) throw error;
            const current = stat(proof.pid);
            if (current.ppid !== proof.ppid || current.startToken !== proof.startToken) throw Error('Owner process incarnation changed.');
            const value = match[2] === 'ns/pid' ? proof.pidNamespace : proof.executable;
            if (typeof value !== 'string' || value.length > 4096 || (match[2] === 'ns/pid'
                ? !/^pid:\[[1-9][0-9]*\]$/u.test(value) : !value.startsWith('/'))) throw Error('Missing exact Box process-link value.');
            used.add(proof.pid);
            return value;
        }
    } };
    return { used, io, identity(pid) { return { ...stat(pid), pidNamespace: io.readlinkSync(`/proc/${pid}/ns/pid`) }; } };
}
