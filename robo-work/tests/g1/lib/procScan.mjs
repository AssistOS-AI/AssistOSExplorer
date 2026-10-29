// G1 /proc scanner (plan g4-apparatus-target-plan, "Files to create": procScan.mjs).
//
// Every read goes through `procRoot`, so the Mac selftests can point the scanner at a synthetic tree. The scanner
// fails closed: an entry that exists but cannot be read is recorded in `unreadable`, and the record layer grades any
// record with a non-empty `unreadable` list as FAIL. A process that disappears between listing and reading (its
// /proc/<pid> directory is gone) is recorded in `vanished` instead, because that is a normal race and not a hidden
// entry.
import fs from 'node:fs';
import path from 'node:path';

export const CAP_FIELDS = Object.freeze(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']);

export function createScanner({ procRoot = '/proc' } = {}) {
    const unreadable = [];
    const vanished = [];

    function classify(rel, error) {
        const pidMatch = /^(\d+)\//.exec(rel);
        if (error.code === 'ENOENT' && pidMatch && !fs.existsSync(path.join(procRoot, pidMatch[1]))) {
            vanished.push({ pid: Number(pidMatch[1]), path: rel });
            return;
        }
        unreadable.push({ path: path.join(procRoot, rel), code: error.code ?? 'ERR' });
    }

    function read(rel) {
        try {
            return fs.readFileSync(path.join(procRoot, rel), 'utf8');
        } catch (error) {
            classify(rel, error);
            return null;
        }
    }

    function readLink(rel) {
        try {
            return fs.readlinkSync(path.join(procRoot, rel));
        } catch (error) {
            classify(rel, error);
            return null;
        }
    }

    function listPids() {
        try {
            return fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
        } catch (error) {
            unreadable.push({ path: procRoot, code: error.code ?? 'ERR' });
            return [];
        }
    }

    function cmdline(pid) {
        const text = read(`${pid}/cmdline`);
        return text === null ? null : text.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1);
    }

    return {
        unreadable,
        vanished,
        read,
        readLink,
        listPids,
        status(pid) {
            const text = read(`${pid}/status`);
            return text === null ? null : parseStatus(text);
        },
        idMap(pid, kind) {
            if (kind !== 'uid_map' && kind !== 'gid_map') throw new TypeError(`unknown id map ${kind}`);
            const text = read(`${pid}/${kind}`);
            return text === null ? null : parseIdMap(text);
        },
        mountinfo(pid) {
            const text = read(`${pid}/mountinfo`);
            return text === null ? null : parseMountinfo(text);
        },
        limits(pid) {
            const text = read(`${pid}/limits`);
            return text === null ? null : parseLimits(text);
        },
        cmdline,
        netTable(pid, proto) {
            if (!['tcp', 'tcp6', 'udp', 'udp6'].includes(proto)) throw new TypeError(`unknown table ${proto}`);
            const text = read(`${pid}/net/${proto}`);
            return text === null ? null : parseProcNet(text, proto);
        },
        // Every process whose namespace link of `kind` equals `link` (for example "net:[4026532001]").
        namespaceMembers(kind, link) {
            const members = [];
            for (const pid of listPids()) {
                const value = readLink(`${pid}/ns/${kind}`);
                if (value !== null && value === link) members.push(pid);
            }
            return members;
        },
        fdInventory(pid) {
            let names;
            try {
                names = fs.readdirSync(path.join(procRoot, String(pid), 'fd'));
            } catch (error) {
                classify(`${pid}/fd`, error);
                return null;
            }
            return names.filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
                .map((fd) => ({ fd, target: readLink(`${pid}/fd/${fd}`) }));
        },
        // Processes whose argv contains `marker` as a substring of any argument.
        markerScan(marker, { exclude = [] } = {}) {
            if (typeof marker !== 'string' || marker.length < 8) throw new TypeError('marker must be a string of at least 8 characters');
            const hits = [];
            for (const pid of listPids()) {
                if (exclude.includes(pid)) continue;
                const argv = cmdline(pid);
                if (argv !== null && argv.some((arg) => arg.includes(marker))) hits.push({ pid, argv });
            }
            return hits;
        },
    };
}

export function parseStatus(text) {
    const fields = {};
    for (const line of String(text).split('\n')) {
        const index = line.indexOf(':');
        if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1).trim();
    }
    const caps = {};
    for (const name of CAP_FIELDS) caps[name] = fields[name] ?? null;
    const toInt = (value) => (value === undefined || !/^\d+$/.test(value) ? null : Number(value));
    const ids = (value) => (value === undefined ? null : value.split(/\s+/).map(Number));
    return {
        fields,
        caps,
        noNewPrivs: toInt(fields.NoNewPrivs),
        seccomp: toInt(fields.Seccomp),
        uid: ids(fields.Uid),
        gid: ids(fields.Gid),
    };
}

// True only when all five capability sets are present and zero. A missing set is not zero.
export function capsAllZero(caps) {
    return CAP_FIELDS.every((name) => typeof caps?.[name] === 'string' && /^0+$/.test(caps[name]));
}

export function capSetNonZero(value) {
    return typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && !/^0+$/.test(value);
}

export function parseIdMap(text) {
    return String(text).split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => line.split(/\s+/).map(Number));
}

function unescapeMount(value) {
    return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

// /proc/<pid>/mountinfo: id parent major:minor root mountpoint options [optional...] - fstype source superoptions
export function parseMountinfo(text) {
    const entries = [];
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split(' ');
        const separator = parts.indexOf('-', 6);
        if (separator < 0 || parts.length < separator + 3) throw new Error(`malformed mountinfo line: ${line}`);
        entries.push({
            mountId: Number(parts[0]),
            parentId: Number(parts[1]),
            root: unescapeMount(parts[3]),
            mountPoint: unescapeMount(parts[4]),
            options: parts[5].split(','),
            fsType: parts[separator + 1],
            source: unescapeMount(parts[separator + 2]),
            superOptions: (parts[separator + 3] ?? '').split(',').filter(Boolean),
        });
    }
    return entries;
}

// The mount that covers `target`: the longest mount point that is a path prefix; a later entry with the same mount
// point stacks over an earlier one.
export function mountFor(entries, target) {
    let best = null;
    for (const entry of entries) {
        const point = entry.mountPoint;
        const covers = point === '/' || target === point || target.startsWith(`${point}/`);
        if (covers && (best === null || point.length >= best.mountPoint.length)) best = entry;
    }
    return best;
}

function decodeIpv4(hex) {
    const n = parseInt(hex, 16);
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

function decodeIpv6(hex) {
    const words = [];
    for (let i = 0; i < 32; i += 8) {
        const word = hex.slice(i, i + 8);
        const bytes = word.match(/../g).reverse().join('');
        words.push(bytes.slice(0, 4), bytes.slice(4, 8));
    }
    return words.map((word) => word.replace(/^0+(?=.)/, '').toLowerCase()).join(':');
}

function decodeAddress(value, proto) {
    const [addrHex, portHex] = value.split(':');
    if (!addrHex || !portHex) throw new Error(`malformed socket address ${value}`);
    return { addr: proto.endsWith('6') ? decodeIpv6(addrHex) : decodeIpv4(addrHex), port: parseInt(portHex, 16) };
}

// /proc/net/{tcp,tcp6,udp,udp6}
export function parseProcNet(text, proto) {
    const lines = String(text).split('\n').filter((line) => line.trim());
    if (lines.length === 0 || !/^\s*sl\s+local_address/.test(lines[0])) throw new Error(`missing ${proto} table header`);
    return lines.slice(1).map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) throw new Error(`malformed ${proto} line: ${line}`);
        return {
            proto,
            local: decodeAddress(parts[1], proto),
            remote: decodeAddress(parts[2], proto),
            state: parts[3].toUpperCase(),
            uid: Number(parts[7]),
            inode: Number(parts[9]),
        };
    });
}

// UDP has no listen state: any socket bound to the port receives on it. TCP counts only LISTEN (0A).
export function boundOnPort(entries, port) {
    return entries.filter((entry) => entry.local.port === port && (entry.proto.startsWith('udp') || entry.state === '0A'));
}

export function parseLimits(text) {
    const limits = {};
    const lines = String(text).split('\n');
    for (const line of lines.slice(1)) {
        const match = /^(.+?)\s{2,}(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line);
        if (match) limits[match[1].trim()] = { soft: match[2], hard: match[3], units: match[4] ?? '' };
    }
    return limits;
}

// /proc/net/route: the default route's gateway, decoded from little-endian hex.
export function defaultGateway(routeText) {
    for (const line of String(routeText).split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] === '00000000' && parts[2] !== '00000000') return decodeIpv4(parts[2]);
    }
    return null;
}
