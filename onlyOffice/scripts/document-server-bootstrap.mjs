import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function readLinuxProcessIdentity(pid, procRoot = '/proc') {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid bootstrap process.');
    const stat = await readFile(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const bootId = (await readFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
    if (!stat.startsWith(`${pid} (`) || !/^[1-9][0-9]*$/.test(fields[19] || '')
        || !/^[RSDIT]$/.test(fields[0] || '') || !uuidPattern.test(bootId)) {
        throw new Error('Bootstrap process is absent, exited or malformed.');
    }
    return { pid, startTime: fields[19], bootId };
}

export function createBootstrapBarrier({
    stateDirectory = '/run/onlyoffice-agent-bootstrap',
    readIdentity = readLinuxProcessIdentity,
} = {}) {
    const startupFile = path.join(stateDirectory, 'startup.json');
    const readyFile = path.join(stateDirectory, 'ready.json');

    async function checkDirectory(create = false) {
        if (create) await mkdir(stateDirectory, { mode: 0o700, recursive: true });
        const info = await lstat(stateDirectory);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
            || info.uid !== process.getuid() || await realpath(stateDirectory) !== path.resolve(stateDirectory)) {
            throw new Error('Unsafe bootstrap state directory.');
        }
    }

    function validate(record) {
        if (!record || Object.keys(record).sort().join(',') !== 'bootId,nonce,pid,startTime,version'
            || record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
            || typeof record.startTime !== 'string' || !/^[1-9][0-9]*$/.test(record.startTime) || !uuidPattern.test(record.bootId)
            || !uuidPattern.test(record.nonce)) throw new Error('Malformed bootstrap state.');
        return record;
    }

    async function readRecord(file) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
                || info.uid !== process.getuid() || info.size > 1024) throw new Error('Unsafe bootstrap state file.');
            return validate(JSON.parse(await handle.readFile('utf8')));
        } finally {
            await handle.close();
        }
    }

    async function writeRecord(file, record) {
        const temporary = `${file}.${randomUUID()}`;
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(record)}\n`);
            } finally {
                await handle.close();
            }
            await rename(temporary, file);
        } finally {
            await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    function sameRecord(left, right) {
        return ['version', 'pid', 'startTime', 'bootId', 'nonce'].every((key) => left[key] === right[key]);
    }

    async function assertCurrentProcess(record) {
        const identity = await readIdentity(record.pid);
        if (['pid', 'startTime', 'bootId'].some((key) => record[key] !== identity[key])) {
            throw new Error('Bootstrap state belongs to an earlier process.');
        }
    }

    return {
        async begin(pid) {
            await checkDirectory(true);
            await unlink(readyFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
            const record = validate({ version: 1, ...await readIdentity(pid), nonce: randomUUID() });
            await writeRecord(startupFile, record);
            return record.nonce;
        },
        async complete(pid, nonce) {
            await checkDirectory();
            const record = await readRecord(startupFile);
            if (record.pid !== pid || record.nonce !== nonce) throw new Error('Bootstrap startup was replaced.');
            await assertCurrentProcess(record);
            await writeRecord(readyFile, record);
            if (!sameRecord(record, await readRecord(startupFile))) throw new Error('Bootstrap startup changed during completion.');
        },
        async verify(expectedNonce) {
            await checkDirectory();
            const started = await readRecord(startupFile);
            const ready = await readRecord(readyFile);
            if (!sameRecord(started, ready)) throw new Error('Bootstrap has not completed for this startup.');
            if (expectedNonce !== undefined && started.nonce !== expectedNonce) throw new Error('Bootstrap startup changed during readiness.');
            await assertCurrentProcess(ready);
            if (!sameRecord(started, await readRecord(startupFile))) throw new Error('Bootstrap startup changed during readiness.');
            return started.nonce;
        },
    };
}

export async function runBootstrapCommand(args, options) {
    const barrier = createBootstrapBarrier(options);
    const [command, pidText, nonce] = args;
    if (command === 'begin' && args.length === 2 && /^[1-9][0-9]*$/.test(pidText)) {
        return barrier.begin(Number(pidText));
    }
    if (command === 'complete' && args.length === 3 && /^[1-9][0-9]*$/.test(pidText) && uuidPattern.test(nonce)) {
        await barrier.complete(Number(pidText), nonce);
        return;
    }
    if (command === 'verify' && (args.length === 1 || (args.length === 2 && uuidPattern.test(pidText)))) {
        return barrier.verify(pidText);
    }
    throw new Error('Invalid bootstrap command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const result = await runBootstrapCommand(process.argv.slice(2));
        if (result) process.stdout.write(`${result}\n`);
    } catch {
        process.stderr.write('OnlyOffice DocumentServer bootstrap is incomplete or invalid.\n');
        process.exitCode = 1;
    }
}
