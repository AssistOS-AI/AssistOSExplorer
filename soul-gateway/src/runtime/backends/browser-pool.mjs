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
        if (signal?.aborted) {
            throw signal.reason || new Error('Aborted');
        }

        const slot = this._slots.find((s) => !s.busy && s.browser?.isConnected());
        if (slot) return this._checkout(slot, signal);

        const crashed = this._slots.find((s) => !s.busy && !s.browser?.isConnected());
        if (crashed) {
            crashed.browser = await this._launchBrowser();
            return this._checkout(crashed, signal);
        }

        return this._enqueue(signal);
    }

    async release(handle) {
        if (!handle?._slot || handle._released) return;
        handle._released = true;
        const slot = handle._slot;

        if (handle._signal && handle._abortListener) {
            handle._signal.removeEventListener('abort', handle._abortListener);
        }

        if (handle._context) {
            await handle._context.close().catch(() => {});
        }

        slot.busy = false;
        slot.lastUsed = Date.now();
        this._drainNext(slot);
    }

    _drainNext(slot) {
        if (this._closed || slot.busy) return;
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
            '--disable-setuid-sandbox',
            '--no-sandbox',
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
        if (signal?.aborted) {
            throw signal.reason || new Error('Aborted');
        }

        if (!slot.browser?.isConnected()) {
            slot.browser = await this._launchBrowser();
        }

        slot.busy = true;
        let context = null;
        let abortListener = null;

        try {
            const ua = USER_AGENTS[this._uaIndex % USER_AGENTS.length];
            this._uaIndex++;

            context = await slot.browser.createBrowserContext();
            const page = await context.newPage();
            await page.setUserAgent(ua);
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            if (signal) {
                abortListener = () => {
                    context.close().catch(() => {});
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }

            return {
                browser: slot.browser,
                context,
                page,
                _slot: slot,
                _context: context,
                _signal: signal || null,
                _abortListener: abortListener,
                _released: false,
            };
        } catch (err) {
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
            if (context) {
                await context.close().catch(() => {});
            }
            slot.busy = false;
            slot.lastUsed = Date.now();
            this._drainNext(slot);
            throw err;
        }
    }

    _enqueue(signal) {
        if (signal?.aborted) {
            return Promise.reject(signal.reason || new Error('Aborted'));
        }

        return new Promise((resolve, reject) => {
            let timer = null;
            let abortListener = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
            };
            const entry = {
                signal,
                resolve(value) {
                    cleanup();
                    resolve(value);
                },
                reject(err) {
                    cleanup();
                    reject(err);
                },
            };
            this._waitQueue.push(entry);

            timer = setTimeout(() => {
                const idx = this._waitQueue.indexOf(entry);
                if (idx !== -1) this._waitQueue.splice(idx, 1);
                entry.reject(new Error('Browser pool acquire timeout'));
            }, ACQUIRE_TIMEOUT_MS);

            if (signal) {
                abortListener = () => {
                    const idx = this._waitQueue.indexOf(entry);
                    if (idx !== -1) this._waitQueue.splice(idx, 1);
                    entry.reject(signal.reason || new Error('Aborted'));
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }
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
