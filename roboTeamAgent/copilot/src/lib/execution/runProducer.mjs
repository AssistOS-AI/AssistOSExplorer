import fs from 'node:fs/promises';

// Evidence only: this identity links the trusted controller process to a
// resident run. It grants no product authority and never enters robot context.
export async function captureRunProducer({ readFile = fs.readFile } = {}) {
    try {
        const stat = await readFile('/proc/self/stat', 'utf8');
        const end = stat.lastIndexOf(') ');
        const pid = stat.slice(0, stat.indexOf(' '));
        const fields = stat.slice(end + 2).trim().split(/\s+/u);
        if (end < 0 || pid !== String(process.pid) || !/^[A-Za-z]$/u.test(fields[0] || '')
            || !/^\d+$/u.test(fields[19] || '')) throw new Error('Invalid own process stat');
        return { pid: process.pid, startStamp: fields[19] };
    } catch {
        throw Object.assign(new Error('The RoboTeam producer process identity is unavailable.'), { code: 'PRODUCER_IDENTITY_UNAVAILABLE' });
    }
}
