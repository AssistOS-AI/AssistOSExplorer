// Streamed to the pinned Node on the QA host. All HTTP requests bypass Cloudflare.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { realpathSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const host = 'explorer-qa.axiologic.dev';
const port = 8097;
const base = '/base-agent-additional-server/bizanso/8787';
const cdn = 'cloudflare-cdn-cache-control';
const workspace = '/home/admin/explorerQaWorkspace';
const checkout = '/home/admin/.qa-deployment-tools/ploinky';
const box = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
const agent = 'bizanso/bizanso';

function check(condition, message) {
    if (!condition) throw new Error(message);
}

export function expectedHeader(settings) {
    check(settings?.version === 1 && isRecord(settings.applications) && isRecord(settings.held),
        'Invalid Router cache settings.');
    const app = settings.applications[agent];
    if (app === undefined) return 'no-store';
    check(typeof app?.enabled === 'boolean' && [60, 120, 300].includes(app.pageSeconds),
        'Invalid Bizanso cache settings.');
    return app.enabled && !Object.hasOwn(settings.held, agent)
        ? `max-age=${app.pageSeconds}, stale-if-error=900` : 'no-store';
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function originRequest(path, readBody = false) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            hostname: '127.0.0.1', port, path: base + path, headers: { Host: host },
            signal: AbortSignal.timeout(15000),
        }, response => {
            response.on('error', reject);
            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 8 * 1024 * 1024) {
                    response.destroy(new Error('Origin response exceeds the probe limit.'));
                } else if (readBody) chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: response.statusCode, headers: response.headersDistinct,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        request.on('error', reject);
    });
}

function header(response, key) {
    const values = response.headers[key];
    if (!values) return undefined;
    check(values.length === 1, `Ambiguous ${key} at the origin.`);
    return values[0];
}

function releaseAsset(page) {
    check(page.status === 200 && /^text\/html(?:;|$)/i.test(header(page, 'content-type') ?? '') &&
        /<title\b[^>]*>[^<]*\bBizanso\b[^<]*<\/title>/i.test(page.body),
    'The origin did not serve the Bizanso home page.');
    const assets = [...page.body.matchAll(/(?:href|src)=["'][^"']*?\/static\/releases\/([a-f0-9]{24})\/([a-zA-Z0-9_./-]+\.(?:css|js))(?:[?#][^"']*)?["']/gi)];
    check(assets.length && new Set(assets.map(match => match[1])).size === 1,
        'Expected one frontend release in the Bizanso home page.');
    const [, release, file] = assets[0];
    check(file.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid release asset path.');
    return { release, file };
}

async function docsCacheHeader(request) {
    const docs = await request('/docs');
    check(docs.status === 200 || ([301, 302, 307, 308].includes(docs.status) &&
        ['/docs/', base + '/docs/'].includes(header(docs, 'location'))), 'Unexpected Bizanso /docs status.');
    const docsHeader = header(docs, cdn);
    check(docsHeader === undefined || docsHeader === 'no-store', 'Expected CDN no-store on Bizanso /docs.');
    return docsHeader;
}

export async function probeOrigin({ phase, request = originRequest, settings, forceFailure = false, expectedRelease }) {
    if (phase === 'pre') {
        // The caller has already admitted the Box. Only the old HTTP origin is optional.
        try {
            return await docsCacheHeader(request) === undefined ? 'legacy' : 'supported';
        } catch {
            return 'unverified';
        }
    }
    const docsHeader = await docsCacheHeader(request);
    const home = await request('/', true);
    const { release, file } = releaseAsset(home);
    check(release === expectedRelease, 'The QA Router served a different Bizanso release.');
    // Bizanso serves a versioned file only for its current release. Also reject a fallback
    // page or a server that serves the same file for an arbitrary release ID.
    const path = id => `/static/releases/${id}/${file}`;
    const asset = await request(path(release));
    const type = file.endsWith('.css') ? /^text\/css(?:;|$)/i : /^(?:text|application)\/(?:java|ecma)script(?:;|$)/i;
    check(asset.status === 200 && type.test(header(asset, 'content-type') ?? ''), 'Current Bizanso release asset failed.');
    const old = (release[0] === '0' ? '1' : '0') + release.slice(1);
    check((await request(path(old))).status === 404, 'Bizanso served an unknown frontend release.');

    const page = await request('/how-it-works/');
    check(page.status === 200 && /^text\/html(?:;|$)/i.test(header(page, 'content-type') ?? ''), 'Bizanso how-it-works failed.');
    if (docsHeader === undefined) {
        check(header(home, cdn) === undefined && header(page, cdn) === undefined,
            'Inconsistent CDN headers on the QA origin.');
        check(!forceFailure, 'Forced QA origin gate failure.');
        return 'legacy';
    }
    const expected = forceFailure ? 'deliberately-invalid-t9' : expectedHeader(await settings());
    check(header(page, cdn) === expected && !forceFailure, 'Bizanso how-it-works CDN header failed the deploy gate.');
    return 'verified';
}

function podman(args) {
    return execFileSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
}

// The existing full deploy can start a completely new Box. Distinguish this from
// a failed inventory command, SSH failure, or a running Box with the wrong bind.
function runningBox() {
    const id = podman(['ps', '--no-trunc', '--quiet', '--filter', `name=^${box}$`]);
    if (!id) return '';
    check(/^[0-9a-f]{64}$/.test(id), 'Ambiguous QA Box.');
    const [info] = JSON.parse(podman(['inspect', id]));
    const labels = info.Config?.Labels;
    const binds = info.HostConfig?.PortBindings?.['8080/tcp'];
    check(info.Id === id && info.Name?.replace(/^\//, '') === box && info.State?.Running === true &&
        labels?.['io.assistos.ploinky-box.path-hash'] === '7a31ab7775eb' &&
        labels?.['io.assistos.ploinky-box.role'] === 'box' &&
        binds?.length === 1 && binds[0].HostIp === '127.0.0.1' && binds[0].HostPort === String(port),
    'QA Box identity or Router binding mismatch.');
    check(realpathSync(workspace) === workspace && realpathSync(checkout) === checkout &&
        info.Mounts?.some(m => m.Source === workspace && m.Destination === workspace) &&
        info.Mounts?.some(m => m.Source === checkout && m.Destination === '/opt/ploinky' && m.RW === false),
    'QA workspace or Ploinky checkout mount mismatch.');
    return id;
}

function readSettings(id) {
    // Read as the workspace user inside the Box. Only ENOENT means the documented default.
    const code = `try {
        process.stdout.write(require('node:fs').readFileSync('.ploinky/data/cache-settings.json'));
    } catch (error) {
        if (error.code !== 'ENOENT') process.exit(1);
        process.stdout.write('{"version":1,"applications":{},"held":{}}');
    }`;
    return JSON.parse(podman(['exec', '--user', 'podman', '--workdir', workspace, id, 'node', '-e', code]));
}

// Compare the release inputs inside the running agent with the runner's checkout.
export function sourceFingerprint(root) {
    const tree = createHash('sha256');
    function addFile(relative) {
        const bytes = readFileSync(join(root, relative));
        tree.update(relative).update('\0').update(createHash('sha256').update(bytes).digest());
    }
    function visit(relative) {
        const directory = join(root, relative);
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const child = join(relative, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile()) addFile(child);
            else throw new Error('Unexpected frontend release input.');
        }
    }
    addFile('src/server/frontend-release.mjs');
    visit('static');
    return tree.digest('hex');
}

export async function runningRelease(expected, fingerprint, readPage) {
    if (!/^[a-f0-9]{64}$/.test(expected) || fingerprint !== expected) {
        throw new Error('The running Bizanso frontend differs from the incoming checkout.');
    }
    const body = await readPage();
    const ids = new Set([...body.matchAll(/\/static\/releases\/([0-9a-f]{24})\//g)].map(match => match[1]));
    if (ids.size !== 1) throw new Error('Ambiguous release in the running Bizanso container.');
    return [...ids][0];
}

if (process.argv[1] === '-' && process.argv[2] === 'running') {
    try {
        const id = await runningRelease(process.argv[3], sourceFingerprint('/code'), async () => {
            const response = await fetch('http://127.0.0.1:8787/', { redirect: 'error', signal: AbortSignal.timeout(15000) });
            if (response.status !== 200) throw new Error('Bizanso did not serve its home page.');
            return response.text();
        });
        console.log(id);
    } catch {
        console.error('Running Bizanso frontend release verification failed.');
        process.exitCode = 1;
    }
} else if (process.argv[1] === '-') {
    try {
        const [phase, publicHost, routerPort, t9, expectedRelease, expectedBox] = process.argv.slice(2);
        check(['identify', 'pre', 'post'].includes(phase) && publicHost === host && routerPort === String(port) &&
            ['true', 'false'].includes(t9), 'Invalid QA origin probe arguments.');
        const id = runningBox();
        if (!id) {
            check(phase === 'pre', 'The QA Box is absent after deployment.');
            console.log('absent');
        } else if (phase === 'identify') {
            console.log(id);
        } else {
            check(phase === 'pre' || id === expectedBox, 'QA Box changed during the origin probe.');
            const result = await probeOrigin({ phase, forceFailure: t9 === 'true', expectedRelease,
                settings: () => readSettings(id) });
            console.log(`${result} ${id}`);
        }
    } catch (error) {
        // Subprocess errors can include arbitrary container output. Emit only our own messages.
        console.error(error.constructor === Error && !error.code && !error.cmd ? error.message : 'QA origin probe failed.');
        process.exitCode = 1;
    }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(sourceFingerprint(process.argv[2]));
}
