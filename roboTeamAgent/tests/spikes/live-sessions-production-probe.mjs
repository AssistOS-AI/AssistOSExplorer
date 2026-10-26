import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Trusted controls against the production Live Sessions IPC listener (G2).
// The production protocol does not report the service identity, so the
// listener is identified from the socket itself: /proc/net/unix names the
// listening socket inode for the exact path, and exactly one same-user process
// must hold that socket. A real hello/welcome exchange proves the listener
// speaks the production protocol. The incarnation is that process and socket
// inode, so before/after controls detect a replaced listener; /proc is read
// again after the exchange so a listener swapped during it is refused.
// The owning process's effective uid comes from /proc/<pid>/status.
const LIMIT = 4096;
const DEADLINE = 5000;
const LISTENING = '00010000';
const digest = value => createHash('sha256').update(value).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{32}$/u;

export function unixListenerInode(netUnix, socketPath) {
    const matches = String(netUnix).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/u))
        .filter(fields => fields[7] === socketPath && fields[3] === LISTENING);
    assert.equal(matches.length, 1, 'Exactly one listening Unix socket must own the production path');
    assert.match(matches[0][6], /^\d+$/u, 'Listening socket inode is required');
    return matches[0][6];
}

export async function socketListenerProcess(inode, { procRoot = '/proc' } = {}) {
    const owners = [];
    for (const name of await fs.readdir(procRoot)) {
        if (!/^\d+$/u.test(name)) continue;
        let descriptors;
        try { descriptors = await fs.readdir(path.join(procRoot, name, 'fd')); } catch { continue; }
        for (const descriptor of descriptors) {
            const target = await fs.readlink(path.join(procRoot, name, 'fd', descriptor)).catch(() => '');
            if (target === `socket:[${inode}]`) { owners.push(Number(name)); break; }
        }
    }
    assert.equal(owners.length, 1, 'Exactly one process must hold the listening socket');
    const pid = owners[0];
    const status = await fs.readFile(path.join(procRoot, String(pid), 'status'), 'utf8');
    const uids = /^Uid:\s+(\d+)\s+(\d+)/mu.exec(status);
    assert.ok(uids, 'Owning process uid is required');
    return { pid, uid: Number(uids[2]), mountNamespace: await fs.readlink(path.join(procRoot, String(pid), 'ns', 'mnt')) };
}

function welcome(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        let bytes = '';
        const timer = setTimeout(() => finish(new Error('Production probe deadline')), DEADLINE);
        const finish = (error, value) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error); else resolve(value);
        };
        socket.setEncoding('utf8');
        socket.once('error', () => finish(new Error('Production probe connection failed')));
        socket.once('end', () => finish(new Error('Production probe record incomplete')));
        socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'hello', pid: process.pid, start: 'g2-control', boot: 'g2-control' })}\n`));
        socket.on('data', chunk => {
            bytes += chunk;
            if (bytes.length > LIMIT) return finish(new Error('Production probe record oversized'));
            const end = bytes.indexOf('\n');
            if (end < 0) return;
            try { finish(null, JSON.parse(bytes.slice(0, end))); } catch { finish(new Error('Production probe JSON invalid')); }
        });
    });
}

export async function connectProductionProbe(socketPath, identity, expectedIncarnation, { procRoot = '/proc' } = {}) {
    const socketStat = await fs.lstat(socketPath);
    assert.ok(socketStat.isSocket(), 'Production path must be a socket');
    assert.equal(socketStat.uid, identity.uid, 'Production socket must belong to the service user');
    assert.equal(socketStat.mode & 0o777, 0o600, 'Production socket must be private');
    const listenerOf = async () => {
        const inode = unixListenerInode(await fs.readFile(path.join(procRoot, 'net', 'unix'), 'utf8'), socketPath);
        return { inode, service: await socketListenerProcess(inode, { procRoot }) };
    };
    const { inode, service } = await listenerOf();
    const response = await welcome(socketPath);
    const recheck = await listenerOf();
    if (recheck.inode !== inode || recheck.service.pid !== service.pid) throw new Error('Production probe listener changed during the exchange');
    if (Object.keys(response || {}).sort().join(',') !== 'publisherId,resumeToken,type' || response.type !== 'welcome'
        || !TOKEN.test(response.publisherId) || !TOKEN.test(response.resumeToken)
        || service.uid !== identity.uid || service.mountNamespace !== identity.mountNamespace) {
        throw new Error('Production probe identity or protocol mismatch');
    }
    const incarnationDigest = digest(`${service.pid}:${inode}`);
    if (expectedIncarnation && incarnationDigest !== expectedIncarnation) throw new Error('Production probe incarnation mismatch');
    return { kind: 'cli-connected', listener: 'production', socketPath, client: identity, service,
        challengeDigest: digest(response.publisherId), incarnationDigest };
}
