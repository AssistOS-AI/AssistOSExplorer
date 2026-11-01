// A second independent /proc proof for the controller. The run ID and exact
// incarnation come from service-owned RoboWork metadata, never a project file.
export async function collectControllerProducer(initPid, record, options, io = null) {
    const assert = (await import('node:assert/strict')).default;
    const fs = io || await import('node:fs');
    const { createHash } = await import('node:crypto');
    assert.ok(Number.isSafeInteger(initPid) && initPid >= 1);
    assert.ok(Number.isSafeInteger(record?.producer?.pid) && record.producer.pid > 0);
    assert.match(record.producer.startStamp || '', /^[1-9][0-9]{0,19}$/u);
    assert.match(record.runId || '', /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
    assert.ok(['copilot', 'task'].includes(record.kind));
    const attach = options.attach === true;
    if (attach) assert.equal(record.kind, 'task', 'Only robot-task has the trusted attach-run command.');
    const script = `${record.kind === 'copilot' ? options.codeRoot : options.workflowCodeRoot || options.codeRoot}/server/${record.kind === 'copilot' ? 'robot-cli' : 'robot-task'}.mjs`;
    assert.ok(script.startsWith('/') && !script.includes('/../') && !script.includes('//'));
    assert.match(options.scriptSha256 || '', /^[a-f0-9]{64}$/u);
    const bounded = (file, limit = 65536) => {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const buffer = Buffer.alloc(limit + 1); let length = 0;
            while (length < buffer.length) {
                const size = fs.readSync(fd, buffer, length, buffer.length - length, null);
                if (!size) break; length += size;
            }
            assert.ok(length <= limit, 'Bounded controller metadata exceeded.');
            return buffer.subarray(0, length);
        } finally { fs.closeSync(fd); }
    };
    const identity = pid => {
        const stat = bounded(`/proc/${pid}/stat`).toString('utf8');
        const close = stat.lastIndexOf(')'), fields = stat.slice(close + 1).trim().split(/\s+/u);
        assert.equal(Number(stat.slice(0, stat.indexOf('(')).trim()), pid);
        assert.ok(close > 0 && fields.length >= 20 && fields[0] !== 'Z');
        assert.match(fields[1], /^(?:0|[1-9][0-9]*)$/u); assert.match(fields[19], /^[1-9][0-9]{0,19}$/u);
        const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`); assert.match(pidNamespace, /^pid:\[[1-9][0-9]*\]$/u);
        return { pid, ppid: Number(fields[1]), startToken: fields[19], pidNamespace };
    };
    const namespacePid = pid => {
        const matches = [...bounded(`/proc/${pid}/status`).toString('utf8').matchAll(/^NSpid:\s*([0-9]+(?:[\t ]+[0-9]+)*)\s*$/gmu)];
        assert.equal(matches.length, 1, 'Missing or ambiguous namespace PID.');
        const ids = matches[0][1].trim().split(/\s+/u).map(Number);
        assert.ok(ids.length <= 32 && ids.every(value => Number.isSafeInteger(value) && value > 0));
        return ids.at(-1);
    };
    const init = identity(initPid), names = fs.readdirSync('/proc').filter(name => /^[1-9][0-9]*$/u.test(name));
    assert.ok(names.length <= 8192);
    const matches = [];
    for (const name of names) {
        const pid = Number(name); let row;
        try { row = identity(pid); }
        catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
        if (row.pidNamespace !== init.pidNamespace) continue;
        if (attach) {
            const bytes = bounded(`/proc/${pid}/cmdline`);
            assert.ok(!bytes.length || bytes.at(-1) === 0 && bytes.toString('utf8').isWellFormed());
            const args = bytes.length ? bytes.toString('utf8').slice(0, -1).split('\0') : [];
            const index = args.indexOf('--attach-run');
            if (args[1] === script && index > 1 && args[index + 1] === record.runId) matches.push(row);
        } else if (namespacePid(pid) === record.producer.pid && row.startToken === record.producer.startStamp) matches.push(row);
    }
    assert.equal(matches.length, 1, 'Missing, dead or ambiguous trusted RoboTeam producer.');
    const producer = matches[0]; assert.notEqual(producer.pid, initPid);
    const bytes = bounded(`/proc/${producer.pid}/cmdline`);
    assert.ok(bytes.length > 0 && bytes.at(-1) === 0 && bytes.toString('utf8').isWellFormed());
    const argv = bytes.toString('utf8').slice(0, -1).split('\0');
    assert.equal(argv[1], script, 'Trusted producer has the wrong deployed script.');
    const executable = fs.readlinkSync(`/proc/${producer.pid}/exe`); assert.match(executable, /(?:^|\/)(?:node|nodejs|bun)$/u);
    const value = flag => {
        assert.equal(argv.filter(argument => argument === flag || argument.startsWith(flag + '=')).length, 1);
        const offset = argv.indexOf(flag); assert.ok(offset > 1 && argv[offset + 1] && !argv[offset + 1].startsWith('--'));
        return argv[offset + 1];
    };
    assert.equal(value(record.kind === 'copilot' ? '--dir' : '--cwd'), record.cwd);
    if (record.kind === 'task') {
        assert.equal(value('--session-id'), record.sessionId);
        assert.equal(argv.filter(argument => argument === '--control-stdin').length, 1);
        if (attach) assert.equal(value('--attach-run'), record.runId, 'Reattached task names another resident run.');
    }
    const chain = [producer], seen = new Set([producer.pid]); let cursor = producer;
    while (cursor.ppid !== initPid) {
        assert.ok(cursor.ppid > 1 && !seen.has(cursor.ppid) && chain.length < 256, 'Producer is not a descendant of the exact RoboTeam init.');
        cursor = identity(cursor.ppid); assert.equal(cursor.pidNamespace, init.pidNamespace);
        seen.add(cursor.pid); chain.push(cursor);
    }
    const sourcePath = `/proc/${producer.pid}/root${script}`;
    const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let sha256;
    try {
        const before = fs.fstatSync(sourceFd, { bigint: true });
        assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 4n * 1024n * 1024n);
        const buffer = Buffer.alloc(4 * 1024 * 1024 + 1); let length = 0;
        while (length < buffer.length) {
            const size = fs.readSync(sourceFd, buffer, length, buffer.length - length, null);
            if (!size) break; length += size;
        }
        assert.ok(length <= 4 * 1024 * 1024, 'Bounded controller source exceeded.');
        const source = buffer.subarray(0, length), after = fs.fstatSync(sourceFd, { bigint: true });
        for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(before[key], after[key]);
        assert.equal(BigInt(source.length), before.size);
        sha256 = createHash('sha256').update(source).digest('hex'); assert.equal(sha256, options.scriptSha256);
    } finally { fs.closeSync(sourceFd); }
    for (const row of [init, ...chain]) assert.deepEqual(identity(row.pid), row, 'Controller ancestry changed during observation.');
    if (!attach) assert.equal(namespacePid(producer.pid), record.producer.pid);
    assert.equal(fs.readlinkSync(`/proc/${producer.pid}/exe`), executable);
    assert.deepEqual(bounded(`/proc/${producer.pid}/cmdline`), bytes);
    return { runId: record.runId, ...(attach ? { attachRun: record.runId } : {}), containerInit: init,
        producer: { ...producer, kind: record.kind === 'task' ? 'workflow' : 'copilot', script, sha256 },
        producerAncestry: chain };
}

export function buildControllerProducerProgram(initPid, record, options) {
    return `(${collectControllerProducer.toString()})(${JSON.stringify(initPid)},${JSON.stringify(record)},${JSON.stringify(options)})\n`
        + '.then(value => process.stdout.write(JSON.stringify(value))).catch(() => { console.error("Invalid exact controller-producer evidence"); process.exitCode = 1; });\n';
}

// Inventory wrappers independently of resident metadata. These observations
// block settlement; they never establish a native run or a user owner.
export async function collectControllerProducerCensus(initPid, options, io = null) {
    const assert = (await import('node:assert/strict')).default;
    const fs = io || await import('node:fs');
    assert.ok(Number.isSafeInteger(initPid) && initPid >= 1);
    const root = options.workflowCodeRoot || options.codeRoot;
    assert.ok(typeof root === 'string' && root.startsWith('/') && !root.endsWith('/')
        && !root.split('/').slice(1).some(part => ['', '.', '..'].includes(part)));
    assert.ok(typeof options.cwd === 'string' && options.cwd.startsWith('/') && options.cwd !== '/');
    assert.match(options.scriptSha256 || '', /^[a-f0-9]{64}$/u);
    const script = `${root}/server/robot-task.mjs`;
    const bounded = file => {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const buffer = Buffer.alloc(65537); let length = 0;
            while (length < buffer.length) {
                const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
                if (!count) break; length += count;
            }
            assert.ok(length <= 65536, 'Bounded controller census metadata exceeded.');
            const bytes = buffer.subarray(0, length), text = bytes.toString('utf8');
            assert.ok(text.isWellFormed() && Buffer.from(text).equals(bytes), 'Malformed controller census metadata.');
            return text;
        } finally { fs.closeSync(fd); }
    };
    const identity = pid => {
        const text = bounded(`/proc/${pid}/stat`), fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
        assert.equal(Number(text.slice(0, text.indexOf('(')).trim()), pid);
        assert.ok(fields.length >= 20);
        if (fields[0] === 'Z') throw Object.assign(Error('Process ended.'), { code: 'ESRCH' });
        assert.match(fields[1], /^(?:0|[1-9][0-9]*)$/u); assert.match(fields[19], /^[1-9][0-9]{0,19}$/u);
        const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`); assert.match(pidNamespace, /^pid:\[[1-9][0-9]*\]$/u);
        return { pid, ppid: Number(fields[1]), startToken: fields[19], pidNamespace };
    };
    const init = identity(initPid), rows = [], names = fs.readdirSync('/proc').filter(name => /^[1-9][0-9]*$/u.test(name));
    assert.ok(names.length <= 8192);
    for (const name of names) {
        let row;
        try { row = identity(Number(name)); }
        catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
        if (row.pidNamespace !== init.pidNamespace) continue;
        const text = bounded(`/proc/${row.pid}/cmdline`);
        assert.ok(!text.length || text.endsWith('\0') && text.isWellFormed());
        const args = text ? text.slice(0, -1).split('\0') : [];
        const advertised = args.some(value => value === '--control-stdin' || value.startsWith('--control-stdin='));
        if (args[1] !== script) {
            assert.equal(advertised, false, 'Unknown controller control-stdin producer.');
            continue;
        }
        assert.match(fs.readlinkSync(`/proc/${row.pid}/exe`), /(?:^|\/)(?:node|nodejs|bun)$/u);
        assert.equal(args.some(value => value === '--turn-id' || value.startsWith('--turn-id=')), false);
        const value = flag => {
            assert.equal(args.filter(argument => argument === flag || argument.startsWith(flag + '=')).length, 1);
            const offset = args.indexOf(flag); assert.ok(offset > 1);
            if (flag === '--control-stdin') return;
            assert.ok(args[offset + 1] && !args[offset + 1].startsWith('--') && args[offset + 1].length <= 4096
                && !/[\u0000-\u001f\u007f]/u.test(args[offset + 1]));
            return args[offset + 1];
        };
        value('--control-stdin');
        const cwd = value('--cwd'), sessionId = value('--session-id');
        assert.match(sessionId, /^[A-Za-z0-9_-]{1,128}$/u);
        if (cwd !== options.cwd) continue;
        const status = bounded(`/proc/${row.pid}/status`), matches = [...status.matchAll(/^NSpid:\s*([0-9]+(?:[\t ]+[0-9]+)*)\s*$/gmu)];
        assert.equal(matches.length, 1);
        const ids = matches[0][1].trim().split(/\s+/u).map(Number);
        assert.ok(ids.length <= 32 && ids.every(value => Number.isSafeInteger(value) && value > 0));
        // This temporary selector proves only the observed process and source.
        // Its placeholder run ID is never returned or used for association.
        const proof = await collectControllerProducer(initPid, { runId: 'observed-producer', kind: 'task', cwd, sessionId,
            producer: { pid: ids.at(-1), startStamp: row.startToken } }, { ...options, codeRoot: root }, fs);
        for (const key of ['pid', 'ppid', 'startToken', 'pidNamespace']) assert.equal(proof.producer[key], row[key]);
        rows.push({ kind: 'producer-pending', ...row, script, cwd, sessionId });
    }
    assert.ok(rows.length <= 512);
    assert.deepEqual(identity(initPid), init);
    for (const row of rows) {
        const current = identity(row.pid);
        for (const key of ['pid', 'ppid', 'startToken', 'pidNamespace']) assert.equal(current[key], row[key]);
    }
    return rows.sort((first, second) => first.pid - second.pid);
}

export function buildControllerProducerCensusProgram(initPid, options) {
    return `const collectControllerProducer = ${collectControllerProducer.toString()};\n`
        + `(${collectControllerProducerCensus.toString()})(${JSON.stringify(initPid)},${JSON.stringify(options)})\n`
        + '.then(value => process.stdout.write(JSON.stringify(value))).catch(() => { console.error("Invalid exact controller-producer census"); process.exitCode = 1; });\n';
}
