import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { smokeConfig } from './config.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from './conversation-skills.mjs';
import { readLedger, nested } from './robowork-e2e.mjs';
import { waitFor, markerOf, workerProcesses } from './robowork-scenarios.mjs';

// Gate selection requires explicit opt-ins, including destructive restart cases; never infer authorization from GATE alone.
export function requireRoboWorkGateFlags(env, flags) {
    if (env.GATE !== '1') return;
    const missing = flags.filter((flag) => env[flag] !== '1');
    assert.equal(missing.length, 0, `GATE=1 requires explicit opt-in flags for the selected suite: ${missing.map((flag) => `${flag}=1`).join(', ')}. No restart is automatically authorized or performed.`);
}

export const CODING_AGENT_DISCOVERY_COMMAND = `for rw_tool in opencode claude codex pi; do
    rw_path=$(command -v "$rw_tool"); rw_status=$?
    if [ "$rw_status" -eq 0 ] && [ -n "$rw_path" ] && [ "\${rw_path#/}" != "$rw_path" ] && [ -f "$rw_path" ] && [ -x "$rw_path" ]; then
        printf 'RW_AGENT\\t%s\\t0\\t%s\\n' "$rw_tool" "$rw_path"
    else
        printf 'RW_AGENT\\t%s\\t1\\t%s\\n' "$rw_tool" "$rw_path"
    fi
done`;

export function assertCodingAgentDiscovery(transcript) {
    const records = String(transcript).replaceAll('\r', '').split('\n').filter((line) => line.startsWith('RW_AGENT\t'));
    assert.equal(records.length, 4, 'Exactly four coding-agent executable discovery records are required');
    const found = {};
    for (const tool of ['opencode', 'claude', 'codex', 'pi']) {
        const matches = records.filter((line) => line.split('\t')[1] === tool);
        assert.equal(matches.length, 1, `${tool} has exactly one discovery record`);
        const fields = matches[0].split('\t');
        assert.equal(fields.length, 4, `${tool} discovery record has the expected shape`);
        assert.equal(fields[2], '0', `${tool} resolves successfully to an executable regular file inside the terminal sandbox`);
        assert.ok(path.posix.isAbsolute(fields[3]) && fields[3] !== '/', `${tool} resolves to an absolute executable path`);
        found[tool] = fields[3];
    }
    return found;
}

// Full file hashes and directory/symlink identities, including absent or newly created .agents/.claude trees.
// Never follows a fixture symlink into another project or a managed checkout.
export function projectManifest(root) {
    const rows = [];
    function walk(directory, prefix = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const relative = path.posix.join(prefix, name);
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) rows.push({ path: relative, link: fs.readlinkSync(file) });
            else if (stat.isDirectory()) { rows.push({ path: `${relative}/` }); walk(file, relative); }
            else if (stat.isFile()) rows.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
            else throw new Error(`Unexpected fixture entry: ${relative}`);
        }
    }
    walk(root);
    return { files: rows, skillPaths: rows.filter((row) => row.path.split('/').some((part) => /^\.(agents|claude)/u.test(part))) };
}

// Record candidate and image identities without opening Ploinky-managed source checkouts.
// The deployment's exact-source binding remains the final runner's preflight obligation.
export function runtimeIdentity(containers) {
    const git = (args) => execFileSync('git', ['-C', smokeConfig.repoRoot, ...args], { cwd: '/', encoding: 'utf8' }).trim();
    return {
        sourceHead: git(['rev-parse', 'HEAD']), sourceChanges: git(['status', '--short']),
        expectedDeployedHead: process.env.SMOKE_EXPECT_EXPLORER_COMMIT || null,
        deployedSourceVerified: false,
        box: execFileSync('podman', ['inspect', '--format', '{{.Id}} {{.Image}}', containers.box], { encoding: 'utf8' }).trim(),
        worker: execFileSync('podman', ['exec', containers.box, 'podman', 'inspect', '--format', '{{.Id}} {{.Image}}', containers.worker], { encoding: 'utf8' }).trim(),
    };
}

// Use the request context for expected refusals, keeping them out of page console diagnostics.
export async function webttyRequest(page, route, { method = 'POST', body } = {}) {
    await page.request.get('/webtty/live-sessions');
    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === 'ploinky_browser_csrf')?.value;
    assert.ok(csrf, 'Authenticated browser mutation cookie is present');
    const response = await page.request.fetch(route, {
        method, headers: { origin: new URL(page.url()).origin, 'x-ploinky-browser-csrf-token': csrf },
        ...(body === undefined ? {} : { data: body }), timeout: 60_000,
    });
    return { status: response.status(), payload: await response.json().catch(() => ({})) };
}

export async function robotTarget(page, robot) {
    assert.ok(new URL(page.url()).pathname.startsWith(ROBOTEAM_BASE_PATH));
    const reply = await roboTeamApi(page, { method: 'POST', path: 'api/worker/robots/terminal-target', body: { robotId: robot.id } });
    assert.equal(reply.status, 200, `Robot terminal target: ${JSON.stringify(reply.payload)}`);
    return reply.payload;
}

export async function launchTerminal(page, target, { directory = '', onCreated = () => {} } = {}) {
    const discovery = await webttyRequest(page, '/webtty/target-discoveries', { body: { dir: directory } });
    assert.equal(discovery.status, 201, `Discovery: ${JSON.stringify(discovery.payload)}`);
    const row = discovery.payload.discovery.targets.find((entry) => entry.kind === 'provider' && entry.targetId === target.targetId && entry.provider === target.provider);
    assert.ok(row, 'Discovery identifies the exact worker robot and provider');
    const startedMs = Date.now();
    const reply = await webttyRequest(page, '/webtty/sessions', { body: { launch: row.launch, cols: 80, rows: 24, closePolicy: 'keep' } });
    const latencyMs = Date.now() - startedMs;
    if (reply.status !== 201) return { ...reply, startedMs, latencyMs };
    const terminal = { ...reply.payload, startedMs, latencyMs };
    onCreated(terminal); // Register before attaching or checking the response, so failure still closes the session.
    await page.evaluate(({ id, view }) => {
        window.__roboworkTerminals ??= {};
        const record = { output: '', outputChars: 0, exits: [], errors: 0, gaps: 0 };
        const source = new EventSource(`/webtty/sessions/${id}/stream?view=${view}`);
        record.source = source;
        source.addEventListener('output', (event) => {
            const data = JSON.parse(event.data).data;
            record.outputChars += data.length;
            record.output = (record.output + data).slice(-2 * 1024 * 1024);
        });
        source.addEventListener('gap', () => { record.gaps += 1; });
        source.addEventListener('exit', (event) => { record.exits.push(JSON.parse(event.data)); source.close(); });
        source.onerror = () => { record.errors += 1; };
        window.__roboworkTerminals[id] = record;
    }, { id: terminal.session.id, view: terminal.view.id });
    return { status: 201, ...terminal };
}

export const terminalSnapshot = (page, terminal) => page.evaluate((id) => {
    const record = window.__roboworkTerminals?.[id];
    return record ? { output: record.output, outputChars: record.outputChars, exits: record.exits, errors: record.errors, gaps: record.gaps } : null;
}, terminal.session.id);

export async function terminalInput(page, terminal, data) {
    const reply = await webttyRequest(page, `/webtty/sessions/${terminal.session.id}/input`, { body: { data } });
    assert.equal(reply.status, 200, `Terminal input: ${JSON.stringify(reply.payload)}`);
}

// Delimiters do not appear contiguously in the echoed shell input. A shell that merely echoes input cannot satisfy an assertion.
export async function terminalCommand(page, terminal, command, { timeoutMs = 30_000 } = {}) {
    const token = crypto.randomBytes(12).toString('hex');
    const start = `START_${token}`;
    const end = `END_${token}`;
    await terminalInput(page, terminal, `printf '\\n%s%s\\n' START_ ${token}; {\n${command}\n}; printf '\\n%s%s\\n' END_ ${token}\n`);
    const output = await waitFor('terminal command output and end delimiter', async () => {
        const snapshot = await terminalSnapshot(page, terminal);
        const text = snapshot?.output.replace(/\r/g, '') ?? '';
        const from = text.indexOf(`${start}\n`);
        const to = from < 0 ? -1 : text.indexOf(`\n${end}`, from + start.length);
        return to < 0 ? null : { text: text.slice(from + start.length + 1, to) };
    }, { timeoutMs, intervalMs: 100 });
    return output.text;
}

export async function closeTerminal(page, terminal) {
    const reply = await webttyRequest(page, `/webtty/sessions/${terminal.session.id}`, { method: 'DELETE' });
    assert.ok([200, 404].includes(reply.status), `Terminal close returned ${reply.status}`);
    await page.evaluate((id) => window.__roboworkTerminals?.[id]?.source.close(), terminal.session.id);
}

export async function settledTerminals({ workspaceRoot, scratchDir, robotName, executionIds, containers, timeoutMs = 20_000 }) {
    return waitFor('terminal admissions ended, blockers released, process markers absent', () => {
        const rows = readLedger({ workspaceRoot, scratchDir, robotName }).executions.filter((row) => executionIds.includes(row.execution_id));
        if (rows.length !== executionIds.length || !rows.length) return null;
        if (rows.some((row) => ['queued', 'running', 'ending'].includes(row.state) || !row.blockers.length || row.blockers.some((blocker) => blocker.release_state !== 'released'))) return null;
        const markers = rows.flatMap((row) => row.blockers.filter((blocker) => blocker.process_bearing).map(markerOf)).filter(Boolean);
        assert.ok(markers.length, 'Terminal executions have process-bearing marker evidence');
        if (markers.some((marker) => workerProcesses(containers, marker).length)) return null;
        return rows;
    }, { timeoutMs, intervalMs: 250 });
}

export function workerMainPid(containers) {
    const source = `const fs = require('fs'); const pids = fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)); const matches = pids.filter(p => { try { const a = fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0'); return a.some(x => x === '/code/server/main.mjs' || x === 'server/main.mjs'); } catch { return false; } }); if(matches.length !== 1) throw Error('Expected one worker main PID, got '+matches.length); console.log(matches[0]);`;
    return Number(nested(containers, containers.worker, ['node', '-e', source]).trim());
}

// Signed probes stay inside the worker. Only status, latency, and RSS cross the container boundary; no key or token is printed.
// Admin is the positive control for exactly the same body/path; non-admin reaches the real provider handler directly.
export function providerProbe(containers, roles = ['user']) {
    const source = `
        import crypto from 'node:crypto';
        import fs from 'node:fs';
        import { computeRchHttp, rawBodyHash } from '/code/server/coordinatorAuth.mjs';
        const roles = ${JSON.stringify(roles)};
        const path = '/v1/terminal-control/targets';
        const body = JSON.stringify({ project: null });
        const iat = Math.floor(Date.now()/1000);
        const actor = { kind: 'user', id: 'user:terminal-live-probe', roles };
        const payload = { typ: 'router-request', iss: 'ploinky-router', aud: process.env.PLOINKY_AGENT_ID, tool: '__provider_terminal_targets__', method: 'POST', path,
            rch: computeRchHttp({ method: 'POST', path, query: '', bodyHash: rawBodyHash(Buffer.from(body)) }),
            sub: actor.id, actor, jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat+30 };
        const input = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
        const key = Buffer.from(process.env.PLOINKY_AGENT_SECRET || '', 'hex');
        if(key.length !== 32) throw Error('Worker per-agent signing prerequisite unavailable');
        const token = input+'.'+crypto.createHmac('sha256',key).update(input).digest('base64url');
        const start = performance.now();
        const response = await fetch('http://127.0.0.1:'+(process.env.ROBO_WORK_PROVIDER_PORT || '7300')+path, { method:'POST',
            headers: { 'content-type':'application/json', 'x-ploinky-auth-info':JSON.stringify({invocationToken:token}) }, body, signal:AbortSignal.timeout(5000) });
        await response.arrayBuffer();
        console.log(JSON.stringify({ status:response.status, latencyMs:performance.now()-start }));
    `;
    return JSON.parse(nested(containers, containers.worker, ['node', '--input-type=module', '-'], { input: source }));
}

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
