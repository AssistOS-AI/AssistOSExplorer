/**
 * BrowserPool — fixed-size pool of puppeteer-core browser instances.
 *
 * All puppeteer-core imports are lazy (dynamic import inside warmUp /
 * _launchBrowser) so the module can be imported without puppeteer-core
 * installed — the pool simply stays disabled.
 *
 * @module runtime/backends/browser-pool
 */

const IDLE_TIMEOUT_MS = 5 * 60_000;
const ACQUIRE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

export class BrowserPool {
    constructor({ poolSize, executablePath, headlessMode, proxyUrl, userDataDir, log }) {
        this._poolSize = poolSize;
        this._executablePath = executablePath;
        this._headlessMode = headlessMode || 'new';
        this._proxyUrl = proxyUrl || null;
        this._userDataDir = userDataDir || null;
        this._log = log;

        this._puppeteer = null;
        /** @type {Array<{ browser: object, busy: boolean, lastUsed: number }>} */
        this._slots = [];
        this._waitQueue = [];
        this._idleTimer = null;
        this._closed = false;
        this._uaIndex = 0;
    }

    async warmUp() {
        this._puppeteer = (await import('puppeteer-core')).default;

        for (let i = 0; i < this._poolSize; i++) {
            const browser = await this._launchBrowser();
            this._slots.push({ browser, busy: false, lastUsed: Date.now() });
        }

        this._startIdleTimer();
        this._log.info('browser pool warmed up', { size: this._poolSize });
    }

    async acquire(signal) {
        if (this._closed) throw new Error('Browser pool is closed');

        const slot = this._slots.find((s) => !s.busy && s.browser?.isConnected());
        if (slot) return this._checkout(slot, signal);

        const crashed = this._slots.find((s) => !s.busy && !s.browser?.isConnected());
        if (crashed) {
            crashed.browser = await this._launchBrowser();
            return this._checkout(crashed, signal);
        }

        return this._enqueue(signal);
    }

    release(handle) {
        if (!handle?._slot) return;
        const slot = handle._slot;

        if (handle._context) {
            handle._context.close().catch(() => {});
        }

        slot.busy = false;
        slot.lastUsed = Date.now();

        const waiter = this._waitQueue.shift();
        if (waiter) {
            this._checkout(slot, waiter.signal)
                .then(waiter.resolve)
                .catch(waiter.reject);
        }
    }

    status() {
        const available = this._slots.filter((s) => !s.busy && s.browser?.isConnected()).length;
        const busy = this._slots.filter((s) => s.busy).length;
        return {
            total: this._poolSize,
            available,
            busy,
        };
    }

    async closeAll() {
        this._closed = true;
        if (this._idleTimer) clearInterval(this._idleTimer);

        for (const waiter of this._waitQueue) {
            waiter.reject(new Error('Browser pool shutting down'));
        }
        this._waitQueue.length = 0;

        const shutdowns = this._slots.map(async (slot) => {
            if (!slot.browser) return;
            const pid = slot.browser.process()?.pid;
            try {
                await Promise.race([
                    slot.browser.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('close timeout')), SHUTDOWN_GRACE_MS)
                    ),
                ]);
            } catch {
                if (pid) {
                    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
                }
            }
        });

        await Promise.allSettled(shutdowns);
        this._slots.length = 0;
    }

    async _launchBrowser() {
        const args = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
        ];
        if (this._proxyUrl) {
            args.push(`--proxy-server=${this._proxyUrl}`);
        }

        const launchOptions = {
            executablePath: this._executablePath,
            headless: this._headlessMode === 'new' ? 'new' : true,
            args,
        };
        if (this._userDataDir) {
            launchOptions.userDataDir = this._userDataDir;
        }

        const browser = await this._puppeteer.launch(launchOptions);
        return browser;
    }

    async _checkout(slot, signal) {
        if (!slot.browser?.isConnected()) {
            slot.browser = await this._launchBrowser();
        }

        slot.busy = true;

        const ua = USER_AGENTS[this._uaIndex % USER_AGENTS.length];
        this._uaIndex++;

        const context = await slot.browser.createBrowserContext();
        const page = await context.newPage();
        await page.setUserAgent(ua);
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                context.close().catch(() => {});
                slot.busy = false;
            }, { once: true });
        }

        return { browser: slot.browser, context, page, _slot: slot, _context: context };
    }

    _enqueue(signal) {
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal };
            this._waitQueue.push(entry);

            const timer = setTimeout(() => {
                const idx = this._waitQueue.indexOf(entry);
                if (idx !== -1) this._waitQueue.splice(idx, 1);
                reject(new Error('Browser pool acquire timeout'));
            }, ACQUIRE_TIMEOUT_MS);

            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    const idx = this._waitQueue.indexOf(entry);
                    if (idx !== -1) this._waitQueue.splice(idx, 1);
                    reject(signal.reason || new Error('Aborted'));
                }, { once: true });
            }

            entry._timer = timer;
        });
    }

    _startIdleTimer() {
        this._idleTimer = setInterval(() => {
            const now = Date.now();
            for (const slot of this._slots) {
                if (!slot.busy && slot.browser?.isConnected() && (now - slot.lastUsed > IDLE_TIMEOUT_MS)) {
                    slot.browser.close().catch(() => {});
                    slot.browser = null;
                    this._log.info('browser pool idle slot closed');
                }
            }
        }, 60_000);

        if (this._idleTimer.unref) this._idleTimer.unref();
    }
}
