import { readLiveSkillsCodeHashes } from './copilot-live-skills-runtime.mjs';

export const ROBO_WORK_CONTRACT_FILES = Object.freeze([
    'server/main.mjs', 'server/caller.mjs', 'server/run-manager.mjs', 'server/launch.mjs', 'server/run-channels.mjs',
]);

// Executed only in the exact source/mount/generation-verified RoboWork runtime.
// Project metadata may select an ID but never supplies the authoritative record.
export async function readResidentRunRecords(options, { fsApi, codeRoot = '/code', dataRoot = '/data' } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { expectedRepository, contractFiles, contractHashes, robotId, cwd } = options;
    assert.ok(path.isAbsolute(expectedRepository) && path.normalize(expectedRepository) === expectedRepository);
    assert.ok(!expectedRepository.split(path.sep).some((part, index, parts) => part === '.ploinky' && parts[index + 1] === 'repos'),
        'Managed source checkouts cannot establish original source identity.');
    assert.match(robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
    assert.ok(path.isAbsolute(cwd) && cwd !== '/' && path.normalize(cwd) === cwd);
    const hashes = await readLiveSkillsCodeHashes({ expectedRepository, contractFiles, agentName: 'roboWorkAgent' }, { codeRoot, fsApi });
    assert.deepEqual(hashes, contractHashes, 'RoboWork source differs from the frozen candidate.');
    const same = (first, second) => ['dev', 'ino', 'uid', 'gid', 'mode'].every(key => first[key] === second[key]);
    const directories = [];
    const directory = name => {
        assert.equal(fs.realpathSync(name), name, 'Private evidence directory contains a symlink.');
        const stat = fs.lstatSync(name, { bigint: true });
        assert.ok(stat.isDirectory() && (stat.mode & 0o022n) === 0n, 'Private evidence directory is writable by another owner.');
        directories.push({ name, stat });
        return stat;
    };
    const owner = directory(dataRoot).uid;
    const root = path.join(dataRoot, 'runs'); assert.equal(directory(root).uid, owner);
    const names = fs.readdirSync(root, { withFileTypes: true });
    assert.ok(names.length <= 512, 'Resident run inventory exceeded its bound.');
    const records = [], pinned = [];
    for (const entry of names) {
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(entry.name), 'Invalid resident run directory.');
        const parent = path.join(root, entry.name); assert.equal(directory(parent).uid, owner);
        const file = path.join(parent, 'meta.json');
        assert.equal(fs.realpathSync(file), file);
        const before = fs.lstatSync(file, { bigint: true });
        assert.ok(before.isFile() && before.nlink === 1n && before.uid === owner && (before.mode & 0o777n) === 0o600n
            && before.size > 0n && before.size <= 128n * 1024n, 'Invalid private run metadata.');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let record;
        try {
            const opened = fs.fstatSync(fd, { bigint: true });
            assert.ok(same(before, opened) && before.nlink === opened.nlink && before.size === opened.size);
            assert.equal(fs.realpathSync(`/proc/self/fd/${fd}`), file);
            const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
            assert.ok(same(opened, after) && opened.nlink === after.nlink && opened.size === after.size
                && opened.mtimeNs === after.mtimeNs && opened.ctimeNs === after.ctimeNs && BigInt(bytes.length) === before.size);
            assert.equal(fs.realpathSync(`/proc/self/fd/${fd}`), file);
            record = JSON.parse(bytes.toString('utf8'));
        } finally { fs.closeSync(fd); }
        const bound = fs.lstatSync(file, { bigint: true });
        assert.ok(same(before, bound) && before.size === bound.size && before.mtimeNs === bound.mtimeNs && before.ctimeNs === bound.ctimeNs,
            'Private run metadata changed during read.');
        pinned.push({ file, before });
        assert.equal(record.runId, entry.name);
        assert.match(record.robotId || '', /^[a-z0-9][a-z0-9-]{2,63}$/u);
        assert.ok(['starting', 'running', 'stopping', 'exited', 'interrupted'].includes(record.state));
        if (record.robotId !== robotId || record.cwd !== cwd || !['running', 'stopping'].includes(record.state)) continue;
        assert.ok(['copilot', 'task'].includes(record.tag?.kind));
        for (const field of ['sessionId', 'turnId']) {
            assert.match(record.ala?.[field] || '', /^[A-Za-z0-9_-]{1,128}$/u);
            assert.equal(record.tag[field], record.ala[field], 'Trusted run tag and ALA identity disagree.');
        }
        for (const key of ['pid', 'servicePid']) assert.ok(Number.isSafeInteger(record[key]) && record[key] > 0);
        assert.match(record.pidStamp || '', /^[1-9][0-9]{0,19}$/u);
        assert.match(record.launchId || '', /^[a-f0-9-]{36}$/u);
        assert.ok(record.tag.ownerPrincipal === null || record.tag.ownerPrincipal === undefined
            || /^user:.{1,200}$/u.test(record.tag.ownerPrincipal));
        records.push({ runId: record.runId, robotId: record.robotId, cwd: record.cwd, state: record.state,
            kind: record.tag.kind, sessionId: record.ala.sessionId, turnId: record.ala.turnId,
            ownerPrincipal: record.tag.ownerPrincipal || null, pid: record.pid, servicePid: record.servicePid,
            pidStamp: record.pidStamp, launchId: record.launchId });
    }
    for (const { name, stat } of directories) {
        assert.equal(fs.realpathSync(name), name);
        assert.ok(same(stat, fs.lstatSync(name, { bigint: true })), 'Private evidence directory changed.');
    }
    for (const { file, before } of pinned) {
        const after = fs.lstatSync(file, { bigint: true });
        assert.equal(fs.realpathSync(file), file);
        assert.ok(same(before, after) && before.nlink === after.nlink && before.size === after.size
            && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'Private run metadata changed before settlement.');
    }
    assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles, agentName: 'roboWorkAgent' }, { codeRoot, fsApi }), hashes);
    assert.equal(new Set(records.map(record => `${record.sessionId}:${record.turnId}`)).size, records.length, 'Ambiguous resident session/turn.');
    return { codeHashes: hashes, records: records.sort((first, second) => first.runId.localeCompare(second.runId)) };
}

export function buildResidentRunProgram(options) {
    return `const readLiveSkillsCodeHashes = ${readLiveSkillsCodeHashes.toString()};\n(${readResidentRunRecords.toString()})(${JSON.stringify(options)})\n`
        + '.then(value => process.stdout.write(JSON.stringify(value))).catch(() => { console.error("Invalid private resident-run evidence"); process.exitCode = 1; });\n';
}
