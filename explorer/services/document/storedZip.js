function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function appendUint16(target, value) {
    target.push(value & 0xff, (value >>> 8) & 0xff);
}

function appendUint32(target, value) {
    target.push(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff
    );
}

function appendBytes(target, bytes) {
    for (const byte of bytes) {
        target.push(byte);
    }
}

export function buildStoredZip(parts) {
    const encoder = new TextEncoder();
    const archive = [];
    const centralDirectory = [];

    for (const [name, content] of Object.entries(parts)) {
        const nameBytes = encoder.encode(name);
        const contentBytes = encoder.encode(content);
        const checksum = crc32(contentBytes);
        const localOffset = archive.length;

        appendUint32(archive, 0x04034b50);
        appendUint16(archive, 20);
        appendUint16(archive, 0);
        appendUint16(archive, 0);
        appendUint16(archive, 0);
        appendUint16(archive, 0);
        appendUint32(archive, checksum);
        appendUint32(archive, contentBytes.length);
        appendUint32(archive, contentBytes.length);
        appendUint16(archive, nameBytes.length);
        appendUint16(archive, 0);
        appendBytes(archive, nameBytes);
        appendBytes(archive, contentBytes);

        appendUint32(centralDirectory, 0x02014b50);
        appendUint16(centralDirectory, 20);
        appendUint16(centralDirectory, 20);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint32(centralDirectory, checksum);
        appendUint32(centralDirectory, contentBytes.length);
        appendUint32(centralDirectory, contentBytes.length);
        appendUint16(centralDirectory, nameBytes.length);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint16(centralDirectory, 0);
        appendUint32(centralDirectory, 0);
        appendUint32(centralDirectory, localOffset);
        appendBytes(centralDirectory, nameBytes);
    }

    const centralOffset = archive.length;
    appendBytes(archive, centralDirectory);
    appendUint32(archive, 0x06054b50);
    appendUint16(archive, 0);
    appendUint16(archive, 0);
    appendUint16(archive, Object.keys(parts).length);
    appendUint16(archive, Object.keys(parts).length);
    appendUint32(archive, centralDirectory.length);
    appendUint32(archive, centralOffset);
    appendUint16(archive, 0);
    return Uint8Array.from(archive);
}

