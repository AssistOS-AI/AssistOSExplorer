import fs from 'node:fs/promises';
import path from 'node:path';

// Bytes available to an unprivileged writer where `directory` is or will be created; a directory that does not exist yet is
// measured at its nearest existing parent.
export async function freeBytesAt(directory) {
    for (let current = directory; ; current = path.dirname(current)) {
        try {
            const stat = await fs.statfs(current);
            return stat.bavail * stat.bsize;
        } catch (error) {
            if (error.code !== 'ENOENT' || current === path.dirname(current)) throw error;
        }
    }
}
