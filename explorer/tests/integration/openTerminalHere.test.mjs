import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPodmanHarness } from '../../../../ploinky/tests/e2e/ploinkyBox/nativeHelpers.mjs';

const ROOT = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const BOX = 'docker.io/assistos/ploinky-box@sha256:8ebee099206b3996fdf2a0ffb1987d411b575ab76a93dc058509c72b8995ea66';
const BOX_ID = 'd56a212e46e2a1cc0b08b589fe397823f54ea89289f4cc84413e8f6c84739735';
const SEEDED_IMAGES = [
    ['docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669', '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1'],
    ['docker.io/assistos/roboteam-agent@sha256:96ca8fef95c0c48dcecf2eeba809f729f6167f66774eba481bee8f599011e0f8', 'b6f2e1ecdf00d4dcf3da0156b7352b26189501dbae856f2a7222b2b9a4fda9ea'],
];
const require = createRequire(path.join(ROOT, 'tests/smoke/package.json'));
const SOURCES = ['explorer/web-components/pages/file-exp/file-exp.js',
    'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.js',
    'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.html',
    'explorer/utils/liveSessionSource.mjs', 'roboWorkAgent/server/terminal-profiles.mjs',
    'roboWorkAgent/server/http-server.mjs', 'roboWorkAgent/manifest.json',
    'roboWorkAgent/IDE-plugins/terminal-profile-source/config.json'];
const BROWSER_ENTRIES = ['explorer/web-components/pages/file-exp/file-exp.js',
    'explorer/web-components/modals/terminal-target-modal/terminal-target-modal.js'];
// Static module specifiers: `import x from '..'`, `import '..'`, `export ... from '..'`.
const STATIC_SPECIFIER = /(?:^|[\n;{}])\s*(?:import|export)\s*(?:[^'"`;]*?[\s}*]from\s*|\s*)(['"])([^'"\n]+)\1/g;

// Walks relative static imports from the real entry modules and returns every
// reached file (plus .html/.css siblings of each module, which Explorer components load at runtime).
function browserClosure(entries) {
    const reached = new Set();
    const visit = (relative) => {
        if (reached.has(relative)) return;
        const absolute = path.join(ROOT, relative);
        assert.ok(fs.existsSync(absolute), `browser module ${relative} is missing`);
        reached.add(relative);
        const text = fs.readFileSync(absolute, 'utf8');
        for (const match of text.matchAll(STATIC_SPECIFIER)) {
            const specifier = match[2];
            assert.ok(/^\.{1,2}\//.test(specifier), `${relative} imports non-relative specifier ${specifier}`);
            visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
        }
        const base = relative.replace(/\.(?:mjs|js)$/, '');
        for (const extension of ['.html', '.css']) {
            if (base !== relative && fs.existsSync(path.join(ROOT, `${base}${extension}`))) reached.add(`${base}${extension}`);
        }
    };
    entries.forEach(visit);
    return [...reached].sort();
}
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function freePort(udp = false) {
    const socket = udp ? dgram.createSocket('udp4') : net.createServer();
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        const ready = () => { const selected = socket.address().port; socket.close(() => resolve(selected)); };
        if (udp) socket.bind(0, '0.0.0.0', ready);
        else socket.listen(0, '127.0.0.1', ready);
    });
}

async function nextLine(lines, processExit, label) {
    let timer;
    try {
        return await Promise.race([
            lines.next().then((result) => {
                assert.equal(result.done, false, `${label}: fixture closed its output`);
                return JSON.parse(result.value);
            }),
            processExit.then((result) => { throw new Error(`${label}: fixture exited ${JSON.stringify(result)}`); }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out`)), 120_000); }),
        ]);
    } finally { clearTimeout(timer); }
}

test('Open Terminal Here launches a real shell in the selected running agent with the original robot home', {
    timeout: 15 * 60_000,
}, async (t) => {
    const harness = createPodmanHarness(t, BOX);
    const port = await freePort();
    let mediaPort = await freePort(true);
    while (mediaPort === port) mediaPort = await freePort(true);
    const source = path.join(harness.workspace, 'fixture-source');
    fs.mkdirSync(source);
    const closure = browserClosure(BROWSER_ENTRIES);
    assert.ok(closure.includes('explorer/imports.js') && closure.some(name => name.startsWith('explorer/services/')), 'closure must include imports.js and services');
    for (const name of closure) {
        fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, name), path.join(source, name), fs.constants.COPYFILE_EXCL);
    }
    for (const entry of ['roboWorkAgent/server', 'roboWorkAgent/IDE-plugins/terminal-profile-source']) {
        fs.cpSync(path.join(ROOT, entry), path.join(source, entry), { recursive: true, errorOnExist: true });
    }
    const artifacts = process.env.OPEN_TERMINAL_ARTIFACTS
        || fs.mkdtempSync(path.join(os.tmpdir(), 'open-terminal-artifacts-'));
    fs.mkdirSync(artifacts, { recursive: true });
    t.diagnostic(`artifacts: ${artifacts}`);
    fs.copyFileSync(path.join(ROOT, 'roboWorkAgent/manifest.json'), path.join(source, 'roboWorkAgent/manifest.json'));
    const fixture = path.join(harness.workspace, 'terminalLaunchFixture.mjs');
    fs.copyFileSync(new URL('../fixtures/terminalLaunchFixture.mjs', import.meta.url), fixture);
    const nonce = crypto.randomBytes(16).toString('hex');
    let child;
    let fullStderr = '';
    const fixtureStderr = () => fullStderr;
    let browser;
    let context;
    try {
        const image = harness.runner.query('podman', ['image', 'inspect', BOX]);
        assert.equal(image.ok, true, image.stderr);
        const [inspectedImage] = JSON.parse(image.stdout);
        assert.equal(inspectedImage.Id.replace(/^sha256:/, ''), BOX_ID);
        assert.equal(inspectedImage.Digest, BOX.split('@')[1]);
        const prepared = await harness.supervisor.prepareBoxForCommand({ explicitPort: port, explicitMediaPort: mediaPort, imageRef: BOX });
        assert.equal(prepared.ownership.handles.container.runtime.imageId.replace(/^sha256:/, ''), BOX_ID);
        const inspection = harness.runner.query('podman', ['container', 'inspect', prepared.containerId]);
        assert.equal(inspection.ok, true, inspection.stderr);
        const mount = JSON.parse(inspection.stdout)[0].Mounts.find(entry => entry.Destination === '/opt/ploinky');
        assert.equal(mount?.Type, 'bind');
        assert.equal(fs.realpathSync(mount.Source), fs.realpathSync(path.join(ROOT, '../ploinky')));
        assert.equal(mount.RW, false);
        // The Box's nested store starts empty. Copy each pinned image from the host store by
        // local save/load (no registry pull); the harness proxy admits only the Box image.
        const hostPodman = (args) => {
            const r = spawnSync('podman', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
            return { ok: r.status === 0 && !r.error && !r.signal, stdout: r.stdout || '', stderr: r.stderr || String(r.error || r.signal || '') };
        };
        for (const [reference, id] of SEEDED_IMAGES) {
            const host = hostPodman(['image', 'inspect', reference]);
            assert.equal(host.ok, true, host.stderr);
            const [hostImage] = JSON.parse(host.stdout);
            assert.equal(hostImage.Id.replace(/^sha256:/, ''), id);
            assert.equal(hostImage.Digest, reference.split('@')[1]);
            const archive = path.join(harness.workspace, `seed-${id.slice(0, 12)}.oci.tar`);
            const saved = hostPodman(['image', 'save', '--format', 'oci-archive', '-o', archive, id]);
            assert.equal(saved.ok, true, saved.stderr);
            const loaded = harness.runner.query('podman', ['container', 'exec', '--user', 'podman', prepared.containerId,
                '/usr/bin/podman', 'load', '-i', archive], { timeoutMs: 300_000 });
            assert.equal(loaded.ok, true, loaded.stderr);
            fs.rmSync(archive);
        }
        child = spawn('podman', ['container', 'exec', '--user', 'podman', '-i', prepared.containerId,
            '/usr/local/bin/node', fixture, harness.workspace, source, String(port), nonce], {
            env: harness.engineEnvironment, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384); fullStderr = (fullStderr + chunk).slice(-1048576); });
        const exit = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        const ready = await nextLine(lines, exit, 'fixture startup');
        assert.equal(ready.phase, 'ready', stderr);
        assert.deepEqual(ready.sources, Object.fromEntries(SOURCES.map(name => [name, digest(path.join(ROOT, name))])));
        const ploinkyRoot = path.join(ROOT, '../ploinky');
        assert.ok(Object.keys(ready.coreSources).length > 20);
        assert.deepEqual(ready.coreSources, Object.fromEntries(Object.keys(ready.coreSources)
            .map(name => [name, digest(path.join(ploinkyRoot, name))])));
        for (const name of ['cli/server/handlers/webtty.js', 'cli/server/browserMutationSecurity.js', 'cli/server/edgeRoutePlan.js',
            'cli/server/webtty/sessionManager.mjs', 'cli/server/webtty/homeMountBroker.mjs', 'cli/server/webtty/homeMountHelper.py']) {
            assert.ok(ready.coreSources[name], `core source ${name} must be pinned`);
        }
        const { chromium } = require('playwright');
        browser = await chromium.launch({ headless: true });
        const origin = `http://127.0.0.1:${port}`;
        context = await browser.newContext({ baseURL: origin });
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        const pageErrors = [];
        const watch = (label, target) => {
            target.on('pageerror', (error) => pageErrors.push(`${label} pageerror: ${error.message}`));
            target.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`${label} console: ${message.text()}`); });
        };
        watch('opener', page);
        await page.goto(`${origin}/`);
        await page.waitForFunction(() => window.__moduleLoad !== 'pending', null, { timeout: 30_000 });
        assert.equal(await page.evaluate(() => window.__moduleLoad), 'ok', `browser modules failed to load: ${JSON.stringify(pageErrors)}`);
        await page.click('#open-terminal');
        await page.locator('#terminalTargetRobot option').nth(1).waitFor({ state: 'attached' });
        await page.waitForFunction(() => {
            const select = document.querySelector('#terminalTargetRobot');
            return select && !select.disabled && select.options.length > 1;
        });
        await page.selectOption('#terminalTargetRobot', { label: 'Robot A' });
        await page.locator('#terminalTargetList button').filter({ hasText: 'terminalTarget' }).waitFor();
        await page.locator('#terminalTargetList button').filter({ hasText: 'terminalTarget' }).click();
        await page.screenshot({ path: path.join(artifacts, 'chooser.png') });
        const sessionRequest = page.context().waitForEvent('request', request => request.url().endsWith('/webtty/sessions') && request.method() === 'POST');
        const popupPromise = page.waitForEvent('popup');
        await page.click('#terminalTargetOpen');
        const popup = await popupPromise;
        watch('popup', popup);
        await popup.waitForURL(/\/webtty\//);
        await popup.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
        await popup.screenshot({ path: path.join(artifacts, 'terminal-connected.png') });
        const projection = await page.request.get('/fixture/projection');
        assert.equal(projection.status(), 200, await projection.text());
        const pinned = (await projection.json()).receipt;
        assert.equal(pinned.stage, 'attached');
        const launchBody = (await sessionRequest).postDataJSON();
        const csrf = await page.evaluate(() => document.cookie.split('; ').find(item => item.startsWith('ploinky_browser_csrf='))?.split('=')[1]);
        assert.ok(csrf);
        const replay = await page.request.post('/webtty/sessions', { data: launchBody,
            headers: { origin, 'x-ploinky-browser-csrf-token': csrf } });
        assert.equal(replay.status(), 404);
        const member = await page.request.get('/webtty/live-sessions', { headers: { 'x-fixture-member': '1' } });
        assert.equal(member.status(), 403);
        const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
        const proof = [
            `printf '${nonce}' > "$HOME/browser-writeback";`,
            '{ pwd; stat -Lc "%d:%i" .; stat -Lc "%d:%i" "$HOME"; cat "$HOME/original-marker";',
            `cat /tmp/started-marker; test ! -r ${quoted(`${ready.privateRoot}/robots/robot-b/home/sibling-marker`)}; printf 'sibling:%s\\n' "$?";`,
            `test ! -r ${quoted(`${ready.privateParent}/parent-marker`)}; printf 'parent:%s\\n' "$?";`,
            'test ! -r "$HOME/escape"; printf "escape:%s\\n" "$?"; } > terminal-proof',
        ].join(' ');
        await popup.locator('#terminal .xterm-helper-textarea').pressSequentially(proof);
        await popup.locator('#terminal .xterm-helper-textarea').press('Enter');
        const response = await page.request.get(`/fixture/result?nonce=${nonce}`);
        assert.equal(response.status(), 200);
        const evidence = await response.json();
        assert.equal(evidence.ok, true, JSON.stringify(evidence));
        assert.deepEqual(pageErrors, []);
        assert.equal(JSON.stringify((await (await page.request.get('/fixture/projection')).json()).receipt), JSON.stringify(pinned));
        await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
        context = null;
        await browser.close();
        browser = null;
        child.stdin.end('{"action":"finish"}\n');
        const result = await nextLine(lines, exit, 'fixture cleanup');
        assert.equal(result.phase, 'closed', stderr);
        assert.equal(result.cleanup, true, JSON.stringify(result));
        assert.deepEqual(await exit, { code: 0, signal: null });
        t.diagnostic(JSON.stringify({ boxImageId: BOX_ID, appSources: ready.sources, coreSources: ready.coreSources, ...evidence, cleanup: result.cleanup, projection: pinned.destination.path, artifacts }));
    } finally {
        if (context) await context.tracing.stop({ path: path.join(artifacts, 'trace-failed.zip') }).catch(() => {});
        await browser?.close();
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        try { fs.writeFileSync(path.join(artifacts, 'fixture-stderr.log'), fixtureStderr()); } catch (_) {}
        await harness.cleanup();
    }
});
