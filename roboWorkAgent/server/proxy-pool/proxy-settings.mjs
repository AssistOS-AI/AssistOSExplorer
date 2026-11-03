import fs from 'node:fs/promises';
import path from 'node:path';

// The administrator's global Use Proxy switch. It defaults to on, and a missing or unreadable
// file reads as on, so proxies are used whenever proxyAgent offers them unless an administrator
// turned them off. Turning it off keeps every lease, so a robot gets the same proxy back.
export class ProxySettings {
    constructor({ file }) {
        this.file = file;
        this.cached = null;
    }

    async useProxy() {
        if (this.cached === null) {
            try { this.cached = JSON.parse(await fs.readFile(this.file, 'utf8')).useProxy !== false; }
            catch { this.cached = true; }
        }
        return this.cached;
    }

    async setUseProxy(value) {
        const useProxy = value === true;
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify({ useProxy })}\n`, { mode: 0o600 });
        await fs.rename(temporary, this.file);
        this.cached = useProxy;
        return useProxy;
    }
}
