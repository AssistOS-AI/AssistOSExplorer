import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export const SOCKET_PATHS = Object.freeze([
    '/dev/shm/roboteam-live/registry.sock',
]);
const LIMIT = 4096;
const DEADLINE = 5000;
const nonce = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const validNonce = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const stat = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export async function processIdentity() {
    return { pid: process.pid, uid: process.getuid(), mountNamespace: await fs.readlink('/proc/self/ns/mnt') };
}

function validIdentity(value) {
    return value && Number.isSafeInteger(value.pid) && value.pid > 0
        && Number.isSafeInteger(value.uid) && value.uid >= 0
        && /^mnt:\[\d+\]$/.test(value.mountNamespace);
}

export function readRecord(socket) {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(() => finish(new Error('Probe protocol deadline')), DEADLINE);
        const finish = (error, value) => {
            clearTimeout(timer);
            socket.off('data', data); socket.off('error', fail); socket.off('end', ended);
            if (error) { socket.destroy(); reject(error); } else resolve(value);
        };
        const fail = () => finish(new Error('Probe connection failed'));
        const ended = () => finish(new Error('Probe record incomplete'));
        const data = chunk => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > LIMIT) return finish(new Error('Probe record oversized'));
            const end = bytes.indexOf(10);
            if (end < 0) return;
            if (end !== bytes.length - 1) return finish(new Error('Probe permits one record'));
            try { finish(null, JSON.parse(bytes.subarray(0, end).toString('utf8'))); }
            catch { finish(new Error('Probe JSON invalid')); }
        };
        socket.on('data', data); socket.once('error', fail); socket.once('end', ended);
    });
}

function record(socket, value) {
    const encoded = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(encoded) > LIMIT) throw new Error('Probe record oversized');
    socket.write(encoded);
}

function report(value) {
    console.log('[live-sessions-spike] ' + JSON.stringify(value));
}

// Explicit paths and identities are injectable only for isolated unit tests. Runtime
// entrypoints call the fixed wrappers below without arguments.
export async function listenProbe(socketPath, identity, emit = () => {}) {
    const directory = path.dirname(socketPath);
    const parent = path.dirname(directory);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) {
        throw new Error('Probe parent must be a real directory');
    }
    await fs.mkdir(directory, { mode: 0o700 }); // EEXIST refuses files, links and existing directories.
    const directoryStat = await fs.lstat(directory);
    if (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o777) !== 0o700) {
        throw new Error(`Probe directory ownership or mode mismatch: uid=${directoryStat.uid}, mode=${(directoryStat.mode & 0o777).toString(8)}, expectedUid=${process.getuid()}`);
    }
    const incarnation = nonce();
    const connections = new Set();
    const server = net.createServer(socket => {
        connections.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => connections.delete(socket));
        const timer = setTimeout(() => socket.destroy(), DEADLINE);
        socket.once('close', () => clearTimeout(timer));
        void (async () => {
            const challenge = await readRecord(socket);
            if (Object.keys(challenge || {}).sort().join(',') !== 'challenge,version'
                || challenge.version !== 1 || !validNonce(challenge.challenge)) throw new Error('Invalid challenge');
            record(socket, { version: 1, challenge: challenge.challenge, incarnation, ...identity });
            socket.end();
            emit({ kind: 'service-response', socketPath, ...identity, challengeDigest: digest(challenge.challenge), incarnationDigest: digest(incarnation) });
        })().catch(() => socket.destroy());
    });
    let socketStat;
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { server.off('error', reject); resolve(); });
        });
        await fs.chmod(socketPath, 0o600);
        socketStat = await fs.lstat(socketPath);
        if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o777) !== 0o600) {
            throw new Error(`Probe socket ownership or mode mismatch: isSocket=${socketStat.isSocket()}, uid=${socketStat.uid}, mode=${(socketStat.mode & 0o777).toString(8)}, expectedUid=${process.getuid()}`);
        }
    } catch (error) {
        server.unref();
        // Do not adopt or remove an unknown socket after a failed bind.
        if (!(await stat(socketPath)) && same(await stat(directory), directoryStat)) await fs.rmdir(directory);
        throw error;
    }
    server.on('error', () => { throw new Error('Live sessions diagnostic listener failed'); });
    emit({ kind: 'service-ready', socketPath, ...identity, incarnationDigest: digest(incarnation) });
    let closed = false;
    return { socketPath, incarnationDigest: digest(incarnation), async close() {
        if (closed) return;
        // Node unlinks a Unix listener on close. Refuse close when its saved
        // pathname identity changed, rather than removing a replacement.
        if (!same(await stat(directory), directoryStat) || !same(await stat(socketPath), socketStat)) {
            server.unref();
            for (const socket of connections) socket.destroy();
            throw new Error('Probe cleanup refused changed identity');
        }
        closed = true;
        for (const socket of connections) socket.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (same(await stat(directory), directoryStat)) await fs.rmdir(directory);
    } };
}

export async function connectProbe(socketPath, identity, expectedIncarnation) {
    const challenge = nonce();
    const socket = net.connect(socketPath);
    const responsePromise = readRecord(socket);
    record(socket, { version: 1, challenge });
    try {
        const response = await responsePromise;
        if (Object.keys(response || {}).sort().join(',') !== 'challenge,incarnation,mountNamespace,pid,uid,version'
            || response.version !== 1 || response.challenge !== challenge || !validNonce(response.incarnation)
            || !validIdentity(response) || response.uid !== identity.uid || response.mountNamespace !== identity.mountNamespace
            || (expectedIncarnation && digest(response.incarnation) !== expectedIncarnation)) {
            throw new Error('Probe identity, challenge or incarnation mismatch');
        }
        return { kind: 'cli-connected', socketPath, client: identity,
            service: { pid: response.pid, uid: response.uid, mountNamespace: response.mountNamespace },
            challengeDigest: digest(challenge), incarnationDigest: digest(response.incarnation) };
    } finally { socket.destroy(); }
}

export async function startServiceProbe() {
    const identity = await processIdentity();
    const listeners = [];
    try {
        for (const socketPath of SOCKET_PATHS) listeners.push(await listenProbe(socketPath, identity, report));
    } catch (error) {
        await Promise.all(listeners.map(listener => listener.close()));
        throw error;
    }
    return { async close() { for (const listener of listeners) await listener.close(); } };
}

export async function runCliProbe() {
    const identity = await processIdentity();
    for (const socketPath of SOCKET_PATHS) report(await connectProbe(socketPath, identity));
}
