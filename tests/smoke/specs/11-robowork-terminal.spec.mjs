import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { test, expect, attachPageDiagnostics, assertPageDiagnosticsClean } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi, conversationFromSkillsURL } from '../lib/conversation-skills.mjs';
import { discoverContainers, createProjectFixture, readLedger, nested, nestedLogsMerged, startPoller, readPoll, stopPoller, bwrapMarkerProcesses, removeRunDirectory } from '../lib/robowork-e2e.mjs';
import { waitFor, apiOk, markerOf, workerProcesses } from '../lib/robowork-scenarios.mjs';
import { applySelectedModel, chatTurn, stopChatTurn, postQuietly } from '../lib/robowork-interaction.mjs';
import { projectManifest, runtimeIdentity, webttyRequest, robotTarget, launchTerminal, terminalCommand, terminalInput, terminalSnapshot, closeTerminal, settledTerminals, workerMainPid, providerProbe, shellQuote, requireRoboWorkGateFlags, CODING_AGENT_DISCOVERY_COMMAND, assertCodingAgentDiscovery } from '../lib/robowork-terminal.mjs';
import { collectExactRoutingServerIdentity, workspaceHash } from '../lib/webtty-runtime-evidence.mjs';
import { openExplorer, assertExplorerDirectory } from '../lib/explorer.mjs';
import { extendTerminalFixture, terminalMatrixSource, networkInventorySource } from '../lib/robowork-terminal-matrix.mjs';
import { deleteOwnRobotAfterUtilities } from '../lib/robowork-terminal-cleanup.mjs';
import { observeHSessionSelection } from '../lib/robowork-h-session-observer.mjs';
import { observeWebchatCleanup } from '../lib/webchat-cleanup.mjs';
import { throwScenarioFailures } from '../lib/robowork-skills-fixture.mjs';
import { runningL9Turn } from '../lib/robowork-l9-fixture.mjs';

// Fresh-deploy live suite. No restart is performed unless its specific flag is set.
// SMOKE_ROBOWORK_TERMINALS=1: L1-L6/L8, M-51 logs, M-54 Close terminals, project launch latency.
// SMOKE_ROBOWORK_TERMINAL_CONCURRENT=1: L9 and M-65 real terminal A plus terminal/task B, ptyleak watch.
// SMOKE_ROBOWORK_TERMINAL_RESTART=1: RoboTeam then worker restart (L7).
// SMOKE_ROBOWORK_TERMINAL_ROUTER_RESTART=1: exact Router crash, lease-bound cleanup (A40).
// SMOKE_ROBOWORK_TERMINAL_FLOOD=1: F-6, worker RSS and signed provider responsiveness during output flood.
// Close terminals is current-ownership-session only: it is never accepted here as proof old-session PTYs ended.
requireRoboWorkGateFlags(process.env, [
    'SMOKE_ROBOWORK_TERMINALS',
    'SMOKE_ROBOWORK_TERMINAL_CONCURRENT',
    'SMOKE_ROBOWORK_TERMINAL_RESTART',
    'SMOKE_ROBOWORK_TERMINAL_ROUTER_RESTART',
    'SMOKE_ROBOWORK_TERMINAL_FLOOD',
]);
const enabled = process.env.SMOKE_ROBOWORK_TERMINALS === '1';
const terminalIds = (ctx, robot) => readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: robot.name }).executions
    .filter((row) => row.kind === 'terminal' && row.created_at >= ctx.startedMs).map((row) => row.execution_id);

async function setup(page, label) {
    const workspaceRoot = smokeConfig.workspaceRoot;
    assert.ok(path.isAbsolute(workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
    const name = `e2e-term-${crypto.randomBytes(6).toString('hex')}`;
    const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || smokeConfig.artifactRoot, label, name);
    fs.mkdirSync(evidenceDir, { recursive: true });
    const ctx = { workspaceRoot, evidenceDir, name, robots: [], terminals: [], startedMs: Date.now(), containers: discoverContainers({ workspaceRoot }) };
    ctx.save = (file, value) => fs.writeFileSync(path.join(evidenceDir, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    ctx.save('environment.json', runtimeIdentity(ctx.containers));
    await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
    ctx.createRobot = async (suffix = '') => {
        const robot = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/robots', body: { name: `${name}${suffix}`, codingAgents: ['opencode'] } }, [201])).robot;
        ctx.robots.push(robot);
        await applySelectedModel(roboTeamApi, page, robot);
        return robot;
    };
    ctx.launch = async (robot, directory = '') => {
        const result = await launchTerminal(page, await robotTarget(page, robot), { directory, onCreated: (terminal) => ctx.terminals.push(terminal) });
        ctx.save(`launch-${ctx.terminals.length}-${Date.now()}.json`, { status: result.status, latencyMs: result.latencyMs, startedMs: result.startedMs });
        if (result.status !== 201) {
            // Project staging can outlast the Router's 10 s operation deadline. No successful launch is claimed.
            // If a late admission exists it must settle, with unclaimed classification, within the 15 s unclaimed bound.
            const failedAt = Date.now();
            const late = await waitFor('a refused launch admission or an explicit refusal without admission', () => {
                const rows = readLedger({ workspaceRoot, scratchDir: evidenceDir, robotName: robot.name }).executions.filter((row) => row.kind === 'terminal' && row.created_at >= result.startedMs);
                return rows.length ? rows : (Date.now() - failedAt > 15_000 ? [] : null);
            }, { timeoutMs: 20_000, intervalMs: 250 });
            if (late.length) {
                const settled = await settledTerminals({ ...ctx, scratchDir: evidenceDir, robotName: robot.name, executionIds: late.map((row) => row.execution_id), timeoutMs: 20_000 });
                ctx.save('late-launch-cleanup.json', { failedAt, observedAt: Date.now(), rows: settled });
                for (const row of settled) {
                    expect(JSON.stringify(row.end_payload) + row.result).toContain('unclaimed');
                    expect(row.updated_at - failedAt, 'late admission settles within the 15 s unclaimed bound after Router refusal').toBeLessThanOrEqual(15_000);
                }
            }
            assert.fail(`Terminal launch returned HTTP ${result.status} after ${result.latencyMs} ms; cleanup recorded, launch did not pass.`);
        }
        return result;
    };
    return ctx;
}

async function cleanup(ctx, page) {
    const failures = [];
    await stopChatTurn(page);
    for (const terminal of ctx.terminals) {
        try { await closeTerminal(page, terminal); } catch (error) { failures.push(String(error.message)); }
    }
    await page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' }).catch((error) => failures.push(String(error.message)));
    for (const robot of ctx.robots) {
        const deletion = [];
        try {
            const ids = terminalIds(ctx, robot);
            if (ids.length) ctx.save(`settled-${robot.name}.json`, await settledTerminals({ ...ctx, scratchDir: ctx.evidenceDir, robotName: robot.name, executionIds: ids }));
            await deleteOwnRobotAfterUtilities({
                robot, ownedNamePrefix: ctx.name,
                readLedger: () => readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: robot.name }),
                removeRobot: (robotId) => postQuietly(page, ROBOTEAM_BASE_PATH, 'api/control', { robotId, operation: 'robot-delete' }),
                record: (event) => deletion.push(event),
                confirmAbsent: async ({ workerRobotId, ledger }) => {
                    expect(fs.existsSync(path.join(ctx.workspaceRoot, '.data/robo-work/robots', workerRobotId)), 'Deleted worker robot directory is absent').toBe(false);
                    for (const row of ledger.executions) for (const blocker of row.blockers.filter((entry) => entry.process_bearing)) {
                        const marker = markerOf(blocker);
                        expect(marker, 'Released process-bearing resources have an identity marker').toBeTruthy();
                        expect(workerProcesses(ctx.containers, marker), 'Deleted robot has no marked terminal, task or utility process').toEqual([]);
                    }
                    const listed = await roboTeamApi(page, { path: 'api/robots' });
                    expect(listed.status).toBe(200);
                    expect(listed.payload.robots.some((entry) => entry.id === robot.id || entry.name === robot.name), 'Deleted RoboTeam robot record is absent').toBe(false);
                },
            });
        } catch (error) { failures.push(String(error.message)); }
        finally { ctx.save(`delete-${robot.name}.json`, deletion); }
    }
    ctx.save('cleanup.json', { failures, closeRobotScope: 'current ownership session; ledger and process checks cover all test admissions' });
    expect(failures, 'All test-owned terminal admissions settle; robots are removed').toEqual([]);
}

test.describe('RoboWork robot terminals', () => {
    test.skip(!enabled, 'Opt in with SMOKE_ROBOWORK_TERMINALS=1.');

    test('L1-L5: robot terminal sandbox, PTY controls, Close terminals and no terminal I/O in logs', async ({ page }) => {
        test.setTimeout(8 * 60_000);
        const ctx = await setup(page, 'terminals');
        const projectName = `${ctx.name}-project`;
        const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: projectName });
        const before = projectManifest(fixture.root);
        const sentinel = `TTY_PRIVATE_${crypto.randomBytes(24).toString('hex')}`;
        let polling = false;
        try {
            const robot = await ctx.createRobot();
            startPoller(ctx.containers);
            polling = true;
            const terminal = await ctx.launch(robot, projectName);
            const probe = await terminalCommand(page, terminal, "pwd; tr '\\0' ' ' </proc/1/cmdline; printf '\\n'; grep -E '^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):' /proc/self/status; test -t 0 && echo TTY_OK; stty size; echo SHELL=$$; awk '{print \"TPGID=\"$8, \"SESSION=\"$6}' /proc/$$/stat; cat README.md; stat -c %s .env; echo x >.env; ls -l /proc/$$/fd");
            ctx.save('sandbox-output.txt', probe);
            const discovery = await terminalCommand(page, terminal, CODING_AGENT_DISCOVERY_COMMAND);
            ctx.save('coding-agent-discovery.txt', discovery);
            ctx.save('coding-agent-paths.json', assertCodingAgentDiscovery(discovery));
            expect(probe).toContain('bwrap');
            expect(probe).toMatch(/\/projects\//u);
            for (const cap of ['Inh', 'Prm', 'Eff', 'Bnd', 'Amb']) expect(probe).toMatch(new RegExp(`Cap${cap}:\\s+0000000000000000`));
            expect(probe).toMatch(/NoNewPrivs:\s+1/u);
            expect(probe).toMatch(/Seccomp:\s+2/u);
            expect(probe).toContain('TTY_OK');
            expect(probe).toMatch(/24\s+80/u);
            const pid = /SHELL=(\d+)/u.exec(probe)?.[1];
            assert.ok(pid);
            expect(probe).toContain(`SESSION=${pid}`);
            expect(probe).toContain(fixture.mark.readme);
            expect(probe).toMatch(/\n0\n/u);
            expect(probe).toContain('Read-only file system');
            const fdNumbers = [...probe.matchAll(/\s(\d+) -> /gu)].map((match) => Number(match[1]));
            expect(fdNumbers.length).toBeGreaterThanOrEqual(3);
            expect(fdNumbers.filter((fd) => ![0, 1, 2, 255].includes(fd))).toEqual([]);
            const resized = await webttyRequest(page, `/webtty/sessions/${terminal.session.id}/resize`, { body: { cols: 100, rows: 40 } });
            expect(resized.status).toBe(200);
            expect(await terminalCommand(page, terminal, 'stty size')).toMatch(/40\s+100/u);
            // Begin only after a shell-generated marker, then time Ctrl-C through a new completed shell command.
            await terminalInput(page, terminal, "printf '%s%s\\n' SLEEP_ READY; sleep 60\n");
            await waitFor('sleep started', async () => (await terminalSnapshot(page, terminal)).output.includes('SLEEP_READY\r\n'), { intervalMs: 50 });
            const interruptMs = Date.now();
            await terminalInput(page, terminal, '\u0003');
            expect(await terminalCommand(page, terminal, 'echo INTERRUPTED', { timeoutMs: 2000 })).toContain('INTERRUPTED');
            expect(Date.now() - interruptMs).toBeLessThanOrEqual(2000);
            expect(await terminalCommand(page, terminal, `printf '%s\\n' '${sentinel}'`)).toContain(sentinel);
            const ledger = readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: robot.name });
            const rows = ledger.executions.filter((row) => row.kind === 'terminal');
            expect(rows.length).toBe(1);
            const markers = rows[0].blockers.filter((blocker) => blocker.kind === 'process-tree').map(markerOf);
            const processes = bwrapMarkerProcesses(readPoll(ctx.containers));
            expect(processes.some((process) => markers.includes(process.marker)), 'The terminal process carries its ledger reservation marker').toBe(true);
            ctx.save('bwrap-markers.json', processes);
            // Configuration refuses with an explicit terminal count until the administrator closes terminals.
            const busy = await postQuietly(page, ROBOTEAM_BASE_PATH, 'api/control', { robotName: robot.name, operation: 'robot-delete' });
            expect(busy.status).toBe(409);
            expect(JSON.stringify(busy.payload)).toMatch(/1 terminal.*open/u);
            const close = await roboTeamApi(page, { method: 'POST', path: 'api/worker/robots/terminals/close', body: { robotId: robot.id } });
            expect(close.status).toBe(200);
            expect(close.payload).toMatchObject({ closed: 1, unverified: 0 });
            await waitFor('SSE exit after Close terminals', async () => (await terminalSnapshot(page, terminal)).exits.length > 0, { timeoutMs: 20_000, intervalMs: 100 });
            const settled = await settledTerminals({ ...ctx, scratchDir: ctx.evidenceDir, robotName: robot.name, executionIds: rows.map((row) => row.execution_id) });
            ctx.save('ledger.json', settled);
            const logs = nestedLogsMerged(ctx.containers, ctx.containers.worker, new Date(ctx.startedMs).toISOString());
            ctx.save('worker.log', logs);
            expect(logs).not.toContain(sentinel);
            const roboTeamLogs = nestedLogsMerged(ctx.containers, ctx.containers.roboTeam, new Date(ctx.startedMs).toISOString());
            ctx.save('roboteam.log', roboTeamLogs);
            expect(roboTeamLogs).not.toContain(sentinel);
            const routerLogs = execFileSync('sh', ['-c', 'podman logs --since "$1" "$2" 2>&1', 'sh', new Date(ctx.startedMs).toISOString(), ctx.containers.box], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            ctx.save('router.log', routerLogs);
            expect(routerLogs).not.toContain(sentinel);
            expect(JSON.stringify(settled), 'No input/output bytes persisted in admission, result, events or blockers').not.toContain(sentinel);
            expect(settled.every((row) => !row.events.some((event) => event.type === 'ala'))).toBe(true);
            expect(projectManifest(fixture.root)).toEqual(before);
        } finally {
            if (polling) stopPoller(ctx.containers);
            await cleanup(ctx, page);
            removeRunDirectory({ workspaceRoot: ctx.workspaceRoot, name: projectName, prefixes: ['e2e-term-'] });
        }
    });

    test('L6/L8: non-admin discovery and legacy profiles refuse without terminal admissions', async ({ page, browser }) => {
        test.setTimeout(4 * 60_000);
        const ctx = await setup(page, 'terminal-refusals');
        const userContext = await browser.newContext({ baseURL: smokeConfig.baseURL });
        const userPage = await userContext.newPage();
        try {
            const robot = await ctx.createRobot();
            const initial = terminalIds(ctx, robot);
            const directNonAdmin = providerProbe(ctx.containers, ['user']);
            const directAdmin = providerProbe(ctx.containers, ['admin']);
            expect(directNonAdmin.status, 'A valid signed non-admin request directly to the provider refuses').toBe(403);
            expect(directAdmin.status, 'The identical path/body with an administrator is the positive control').toBe(200);
            await signIn(userPage, smokeConfig.secondaryUser, ROBOTEAM_BASE_PATH);
            const userCard = userPage.locator(`[data-robot-id="${robot.id}"]`);
            await expect(userCard).toBeVisible();
            await expect(userCard.locator('.open-terminal')).toBeHidden();
            await expect(userCard.locator('.close-terminals')).toBeHidden();
            const refused = await webttyRequest(userPage, '/webtty/target-discoveries', { body: { dir: '' } });
            expect(refused.status).toBe(403);
            const targetRefused = await postQuietly(userPage, ROBOTEAM_BASE_PATH, 'api/worker/robots/terminal-target', { robotId: robot.id });
            expect(targetRefused.status).toBe(403);
            const legacy = await webttyRequest(page, '/webtty/target-discoveries', { body: { dir: '', profile: { provider: 'roboTeamAgent', id: robot.id } } });
            expect(legacy.status).toBe(410);
            expect(JSON.stringify(legacy.payload)).toContain('legacy_terminal_profile');
            expect(terminalIds(ctx, robot)).toEqual(initial);
            ctx.save('refusals.json', { refused, targetRefused, legacy, directNonAdmin, directAdmin });
        } finally { await userContext.close(); await cleanup(ctx, page); }
    });

    test('F-5: protected-name matrix, late-name residual and next-launch mask, proc/keyctl and egress', async ({ page }) => {
        test.setTimeout(9 * 60_000);
        const ctx = await setup(page, 'terminal-mask-matrix');
        const projectName = `${ctx.name}-project`;
        const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: projectName });
        const matrix = extendTerminalFixture(fixture.root);
        let before = projectManifest(fixture.root);
        try {
            const robot = await ctx.createRobot();
            const terminal = await ctx.launch(robot, projectName);
            const peerRobot = await ctx.createRobot('-peer');
            const peer = await ctx.launch(peerRobot);
            const peerProgram = "require('net').createServer(s=>s.destroy()).listen(43127,'0.0.0.0')";
            await terminalCommand(page, peer, `node -e ${shellQuote(peerProgram)} >/dev/null 2>&1 &`);
            const peerAddress = (await terminalCommand(page, peer, "node -p \"Object.values(require('os').networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal).address\"" )).trim();
            assert.match(peerAddress, /^\d+\.\d+\.\d+\.\d+$/u);
            const peerControl = "const s=require('net').connect({host:'127.0.0.1',port:43127,timeout:2000});s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',e=>{console.log(e.code);process.exitCode=1});s.on('timeout',()=>{console.log('timeout');s.destroy();process.exitCode=1});";
            expect((await terminalCommand(page, peer, `node -e ${shellQuote(peerControl)}`)).trim()).toBe('connected');
            await terminalCommand(page, peer, 'printf peer >"$HOME/.terminal-peer-only"');
            expect((await terminalCommand(page, terminal, 'test ! -e "$HOME/.terminal-peer-only" && echo OTHER_HOME_HIDDEN')).trim()).toBe('OTHER_HOME_HIDDEN');
            const inventory = JSON.parse(nested(ctx.containers, ctx.containers.worker, ['node', '--input-type=module', '-'], { input: networkInventorySource }));
            ctx.save('network-positive-controls.json', inventory);
            // Closed targets cannot prove firewall enforcement. All live positive controls are required.
            for (const [name, state] of Object.entries(inventory.controls)) expect(state, `${name} reachable from the worker itself`).toBe('connected');
            const targets = [...inventory.targets, ['otherExecutionPeer', peerAddress, 43127], ['otherExecutionLoopback', '127.0.0.1', 43127], ['metadata', '169.254.169.254', 80], ['private10', '10.0.0.1', 443], ['private172', '172.16.0.1', 443], ['private192', '192.168.0.1', 443], ['ipv6Loopback', '::1', 7300]];
            const text = await terminalCommand(page, terminal, `node --input-type=module -e ${shellQuote(terminalMatrixSource({ ...matrix, targets }))}`, { timeoutMs: 60_000 });
            const probe = JSON.parse(text.trim());
            ctx.save('matrix.json', probe);
            const denied = ['EROFS', 'EACCES', 'EPERM', 'EBUSY'];
            for (const [file, facts] of Object.entries(probe.files)) {
                expect(facts.bytes, `${file} reads zero bytes`).toBe(0);
                for (const op of ['write', 'remove', 'rename']) expect(denied, `${file}: ${op}`).toContain(facts[op]);
            }
            for (const [directory, facts] of Object.entries(probe.directories)) {
                expect(facts.entries, `${directory} is empty`).toBe(0);
                for (const op of ['write', 'remove', 'rename']) expect(denied, `${directory}: ${op}`).toContain(facts[op]);
            }
            expect(probe.rootWrite).toBe('EROFS');
            expect(probe.normalWrite, 'Ordinary project writes succeed as a positive control').toBe('ok');
            expect(probe.homeNames).toEqual(['robot']);
            expect(probe.keyctl, 'Perl syscall probe is available in the pinned worker image; keyctl returns EPERM').toBe('-1 1');
            for (const [file, result] of Object.entries(probe.proc)) expect([0, 'EACCES', 'EPERM', 'ENOENT'], `${file} masked`).toContain(result);
            for (const [name, state] of Object.entries(probe.network)) expect(state, `${name} denied from the terminal`).not.toBe('connected');
            expect(probe.https.status, `Permitted public HTTPS fetch: ${JSON.stringify(probe.https)}`).toBeGreaterThanOrEqual(200);
            expect(probe.https.status).toBeLessThan(500);
            expect(projectManifest(fixture.root)).toEqual(before);
            // Accepted live-source residual (scenario C): newly created protected names are visible to an already-running view,
            // then masked by the next admission. This records that boundary instead of silently assuming live rescan isolation.
            const late = `LATE-${crypto.randomBytes(12).toString('hex')}`;
            fs.writeFileSync(path.join(fixture.root, 'late/.env'), late);
            before = projectManifest(fixture.root);
            expect((await terminalCommand(page, terminal, 'cat late/.env')).trim()).toBe(late);
            await closeTerminal(page, terminal);
            const next = await ctx.launch(robot, projectName);
            expect((await terminalCommand(page, next, 'stat -c %s late/.env')).trim()).toBe('0');
            ctx.save('late-name.json', { existingViewReadable: true, nextViewBytes: 0 });
            expect(projectManifest(fixture.root)).toEqual(before);
        } finally {
            ctx.save('project-before.json', before);
            ctx.save('project-after.json', projectManifest(fixture.root));
            await cleanup(ctx, page);
            removeRunDirectory({ workspaceRoot: ctx.workspaceRoot, name: projectName, prefixes: ['e2e-term-'] });
        }
    });

    test('UI: robot card and Close terminals work; Explorer chooser lists robot and Box targets and opens both', async ({ page, context }) => {
        test.setTimeout(9 * 60_000);
        const ctx = await setup(page, 'terminal-ui');
        const projectName = `${ctx.name}-project`;
        createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: projectName });
        const popups = [];
        const explorer = await context.newPage();
        const isCreation = (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/webtty/sessions';
        async function registerPopup(action) {
            const popupPromise = context.waitForEvent('page');
            const responsePromise = context.waitForEvent('response', { predicate: isCreation });
            await action();
            const response = await responsePromise;
            expect(response.status()).toBe(201);
            const created = await response.json();
            ctx.terminals.push(created);
            const popup = await popupPromise;
            popups.push(popup);
            await expect(popup.locator('#status')).toHaveText('Connected', { timeout: 60_000 });
            await expect(popup.locator('#terminal .xterm-helper-textarea')).toBeAttached();
            return popup;
        }
        try {
            const robot = await ctx.createRobot();
            await page.reload({ waitUntil: 'load' });
            const card = page.locator(`[data-robot-id="${robot.id}"]`);
            await expect(card).toBeVisible();
            await card.locator('.open-toggle').click();
            const popup = await registerPopup(() => card.locator('.open-terminal').click());
            await popup.locator('.xterm-helper-textarea').fill("printf '%s%s\\n' UI_ CARD_OK; pwd\n");
            await expect(popup.locator('.xterm-rows')).toContainText('UI_CARD_OK');
            await expect(popup.locator('#directory')).toContainText('/home/robot');
            await card.locator('.manage-toggle').click();
            page.once('dialog', (dialog) => dialog.accept());
            await card.locator('.close-terminals').click();
            await expect(popup.locator('#status')).toHaveText(/Closed|Exited/u, { timeout: 20_000 });
            await expect(page.locator('#formMessage')).toContainText('1 terminal');
            await openExplorer(explorer);
            await assertExplorerDirectory(explorer, '/');
            const target = await robotTarget(page, robot);
            for (const kind of ['provider', 'box']) {
                const row = explorer.locator(`tr[data-entry-path="/${projectName}"]`);
                await expect(row).toBeVisible();
                await row.locator('.action-menu-trigger').click();
                const discoveryPromise = explorer.waitForResponse((response) => new URL(response.url()).pathname === '/webtty/target-discoveries' && response.request().method() === 'POST');
                await row.getByRole('menuitem', { name: 'Open Terminal Here' }).click();
                const response = await discoveryPromise;
                expect(response.status()).toBe(201);
                const discovery = (await response.json()).discovery;
                const chooser = explorer.getByRole('dialog', { name: 'Open terminal in' });
                await expect(chooser).toBeVisible();
                const robotRow = discovery.targets.find((entry) => entry.kind === 'provider' && entry.targetId === target.targetId && entry.provider === target.provider);
                const boxRow = discovery.targets.find((entry) => entry.kind === 'box');
                assert.ok(robotRow && boxRow, 'General chooser includes the exact robot and the admin Box');
                const selected = kind === 'provider' ? robotRow : boxRow;
                const terminal = await registerPopup(() => chooser.locator(`[data-launch="${selected.launch}"]`).click());
                const token = crypto.randomBytes(12).toString('hex');
                await terminal.locator('.xterm-helper-textarea').fill(`printf '%s%s\\n' UI_ ${token}; pwd\n`);
                await expect(terminal.locator('.xterm-rows')).toContainText(`UI_${token}`);
                if (kind === 'provider') await expect(terminal.locator('#directory')).toContainText('/projects/');
                else await expect(terminal.locator('#target')).toContainText('Ploinky Box');
                terminal.once('dialog', (dialog) => dialog.accept());
                await terminal.locator('#kill').click();
                await expect(terminal.locator('#status')).toHaveText(/Closed|Exited/u, { timeout: 20_000 });
            }
        } finally {
            await cleanup(ctx, page);
            for (const popup of popups) await popup.close();
            await explorer.close();
            removeRunDirectory({ workspaceRoot: ctx.workspaceRoot, name: projectName, prefixes: ['e2e-term-'] });
        }
    });

    test('F-6: terminal flood on A while B completes a real turn; worker RSS and provider responsiveness stay bounded', async ({ page, context }) => {
        test.skip(process.env.SMOKE_ROBOWORK_TERMINAL_FLOOD !== '1', 'Opt in with SMOKE_ROBOWORK_TERMINAL_FLOOD=1 (output flood and real model turn).');
        test.setTimeout(10 * 60_000);
        const ctx = await setup(page, 'terminal-flood');
        const chatPage = await context.newPage();
        const measurements = [];
        let task;
        try {
            const a = await ctx.createRobot('-a');
            const b = await ctx.createRobot('-b');
            const terminal = await ctx.launch(a);
            const pid = workerMainPid(ctx.containers);
            const measure = () => {
                const status = nested(ctx.containers, ctx.containers.worker, ['cat', `/proc/${pid}/status`]);
                const rssKiB = Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1]);
                assert.ok(rssKiB > 0, 'The actual worker process has a readable RSS sample');
                return { at: Date.now(), rssKiB, ...providerProbe(ctx.containers, ['admin']) };
            };
            const baseline = measure();
            measurements.push({ phase: 'baseline', ...baseline });
            await terminalInput(page, terminal, "node -e 'const b=Buffer.alloc(32768,120); const t=setInterval(()=>process.stdout.write(b),20); setTimeout(()=>{clearInterval(t);process.exit(0)},360000)'\n");
            await waitFor('flood actually produces output', async () => (await terminalSnapshot(page, terminal)).outputChars > 2 * 1024 * 1024, { timeoutMs: 30_000, intervalMs: 500 });
            let done = false;
            task = chatTurn(chatPage, { robot: b.name, robotId: b.id, project: '.', prompt: 'Use your shell tool to run sleep 5; printf FLOOD_B_DONE, then reply FLOOD_B_DONE.', timeoutMs: 5 * 60_000 })
                .then((answer) => ({ answer }), (error) => ({ error })).finally(() => { done = true; });
            while (!done) {
                measurements.push({ phase: 'flood', ...measure() });
                expect((await terminalSnapshot(page, terminal)).exits, 'Flood must remain alive while B completes').toEqual([]);
                await page.waitForTimeout(1000);
            }
            const result = await task;
            if (result.error) throw result.error;
            expect(result.answer).toContain('FLOOD_B_DONE');
            const flood = await terminalSnapshot(page, terminal);
            expect(flood.outputChars).toBeGreaterThan(2 * 1024 * 1024);
            expect(flood.exits).toEqual([]);
            const samples = measurements.filter((row) => row.phase === 'flood');
            expect(samples.length).toBeGreaterThan(0);
            expect(samples.every((row) => row.status === 200)).toBe(true);
            expect(Math.max(...samples.map((row) => row.rssKiB)) - baseline.rssKiB, 'Worker RSS growth stays below 128 MiB during output flood').toBeLessThan(128 * 1024);
            expect(Math.max(...samples.map((row) => row.latencyMs)), 'Signed provider responsiveness stays within baseline + 2 s (not an in-process event-loop histogram)').toBeLessThan(baseline.latencyMs + 2000);
            await terminalInput(page, terminal, '\u0003');
            expect(await terminalCommand(page, terminal, 'echo FLOOD_STOPPED')).toContain('FLOOD_STOPPED');
        } finally {
            ctx.save('measurements.json', { metric: 'worker VmRSS and signed provider response latency; response latency is a responsiveness proxy, not direct event-loop lag', measurements });
            await stopChatTurn(chatPage);
            await task?.catch(() => {});
            await chatPage.close();
            await cleanup(ctx, page);
        }
    });

    test('L9/M-65: terminal A stays open while terminal and AI task B run; no inherited PTY master', async ({ page, context }, testInfo) => {
        test.skip(process.env.SMOKE_ROBOWORK_TERMINAL_CONCURRENT !== '1', 'Opt in with SMOKE_ROBOWORK_TERMINAL_CONCURRENT=1 (real model turn).');
        test.setTimeout(10 * 60_000);
        const ctx = await setup(page, 'terminal-concurrent');
        const chatPage = await context.newPage();
        const chatDiagnostics = attachPageDiagnostics(chatPage, testInfo, 'l9-chat');
        let watcher;
        let watchResult;
        let task;
        let stdout = ''; let stderr = '';
        let watchOutcome; let watchFailure; let taskOutcome;
        let conversationObserver; let chatCleanup; let selectedConversation;
        let primaryError = null;
        try {
            const a = await ctx.createRobot('-a');
            const b = await ctx.createRobot('-b');
            const first = await ctx.launch(a);
            const workerPid = workerMainPid(ctx.containers);
            // The probe has its own inherited-master positive control and rejects unreadable live fd tables.
            watcher = spawn('podman', ['exec', '-i', ctx.containers.box, 'podman', 'exec', '-i', '-e', 'PTYLEAK_TERMINAL_ARGV=/bin/bash', ctx.containers.worker,
                'node', '/code/tests/sandbox/live/ptyleak.mjs', '--watch', '180', '--controlled', '--worker-pid', String(workerPid)], { stdio: ['pipe', 'pipe', 'pipe'] });
            watcher.stdin.on('error', () => {}); // A closed control pipe is reported by watchResult/exit, never as success.
            watcher.stdout.on('data', (chunk) => { stdout += chunk; });
            watcher.stderr.on('data', (chunk) => { stderr += chunk; });
            watchResult = new Promise((resolve, reject) => {
                watcher.on('error', reject);
                watcher.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
            });
            watchResult.then((value) => { watchOutcome = value; }, (error) => { watchFailure = error; });
            // Explicit readiness follows the inherited-master positive control and the first sampler observation.
            await waitFor('fd watch measurement started', () => {
                if (watchFailure) throw watchFailure;
                if (watcher.exitCode !== null) throw new Error(`fd watcher exited ${watcher.exitCode}`);
                return stderr.includes('MEASUREMENT_READY');
            });
            const second = await ctx.launch(b);
            const readB = () => readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: b.name });
            const workerRobotId = readB().robot.id;
            let sentAt;
            conversationObserver = await observeHSessionSelection(chatPage, { baseURL: smokeConfig.baseURL, agent: smokeConfig.webchatAgent, robot: b.name, directory: '.' });
            chatCleanup = observeWebchatCleanup(chatPage, '.');
            task = chatTurn(chatPage, { robot: b.name, robotId: b.id, project: '.', prompt: 'Use one shell command to run sleep 90, then printf TASK_B_DONE. Do not end or stop the command early. Reply TASK_B_DONE after it finishes.', timeoutMs: 5 * 60_000,
                beforeSend: async () => {
                    await expect(chatPage.locator('#sessionsBtn')).toBeEnabled();
                    const listMark = conversationObserver.checkpoint();
                    await chatPage.locator('#sessionsBtn').click();
                    await expect(chatPage.locator('#sessionList .wa-session-list-new')).toBeVisible();
                    let baseline;
                    await expect.poll(() => Boolean(baseline = conversationObserver.listAfter(listMark))).toBe(true);
                    const newMark = conversationObserver.checkpoint();
                    await chatPage.locator('#sessionList .wa-session-list-new').click();
                    await expect.poll(() => Boolean(selectedConversation = conversationObserver.selectedAfter(newMark, baseline))).toBe(true);
                    await expect.poll(async () => {
                        const href = await chatPage.locator('#sessionSettingsLink').getAttribute('href');
                        if (!href) return false;
                        try { return conversationFromSkillsURL(href, smokeConfig.baseURL, { robotId: b.id }).sessionId === selectedConversation.sessionId; }
                        catch { return false; }
                    }).toBe(true);
                    conversationObserver.assertSelected(selectedConversation);
                    ctx.save('fresh-b-conversation.json', selectedConversation);
                    sentAt = Date.now();
                },
            });
            task.then((answer) => { taskOutcome = { answer }; }, (error) => { taskOutcome = { error }; });
            const liveTurn = () => {
                if (taskOutcome?.error) throw taskOutcome.error;
                if (!selectedConversation || !Number.isFinite(sentAt)) return null;
                return runningL9Turn(readB(), { robotName: b.name, workerRobotId, sessionId: selectedConversation.sessionId, sinceMs: sentAt });
            };
            const admitted = await waitFor('B AI admission running while both robot terminals remain open', () => {
                const turn = liveTurn();
                return turn && readB().executions.some((row) => row.kind === 'terminal' && row.state === 'running') ? turn : null;
            });
            expect((await terminalSnapshot(page, first)).exits).toEqual([]);
            // Four terminals on A coexist with its task capacity; the fifth refuses without a fifth running admission.
            for (let index = 1; index < 4; index += 1) await ctx.launch(a);
            // Five terminal SSE streams plus WebChat fill the browser HTTP/1 pool. Both proof and API call use its separate request context.
            const origin = new URL(page.url()).origin;
            const proofReply = await page.request.get('/auth/token?mutationRoute=roboTeamAgent', { timeout: 15_000 });
            expect(proofReply.status()).toBe(200);
            const proof = (await proofReply.json()).browserMutation;
            expect(proof?.routeKey).toBe('roboTeamAgent');
            expect(proof?.csrfToken).toBeTruthy();
            if (proof.origin) expect(proof.origin).toBe(origin);
            const targetReply = await page.request.post(`${ROBOTEAM_BASE_PATH}api/worker/robots/terminal-target`, {
                headers: { origin, 'x-ploinky-browser-csrf-token': proof.csrfToken }, data: { robotId: a.id }, timeout: 15_000,
            });
            expect(targetReply.status()).toBe(200);
            const capTarget = await targetReply.json();
            expect(capTarget.ok).toBe(true);
            expect(capTarget.targetId).toBe(readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: a.name }).robot.id);
            const refusal = await launchTerminal(page, capTarget, { onCreated: (terminal) => ctx.terminals.push(terminal) });
            expect(refusal.status).toBeGreaterThanOrEqual(400);
            expect(JSON.stringify(refusal.payload)).toContain('terminal_limit');
            expect(readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: a.name }).executions.filter((row) => row.kind === 'terminal' && row.state === 'running')).toHaveLength(4);
            await waitFor('fd watch covers every required live role', () => {
                if (taskOutcome?.error) throw taskOutcome.error;
                if (taskOutcome?.answer !== undefined) throw new Error('B AI turn completed before live fd measurement finish');
                if (watchFailure) throw watchFailure;
                if (watcher.exitCode !== null) throw new Error(`fd watcher exited ${watcher.exitCode}`);
                const rows = stderr.split('\n').filter((line) => line.includes('MEASUREMENT_COVERAGE '));
                if (!rows.length) return false;
                const counts = JSON.parse(rows.at(-1).split('MEASUREMENT_COVERAGE ')[1]);
                return ['prep', 'bwrap', 'orchestration', 'endpoint', 'workload', 'terminal'].every((kind) => counts[kind] > 0);
            }, { timeoutMs: 60_000, intervalMs: 100 });
            const aRows = readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: a.name }).executions;
            const bRows = readLedger({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, robotName: b.name }).executions;
            const ai = runningL9Turn(readB(), { robotName: b.name, workerRobotId, sessionId: selectedConversation.sessionId, sinceMs: sentAt, executionId: admitted.execution_id });
            expect(ai, 'The exact fresh B AI turn is alive at measurement finish').toBeTruthy();
            expect(aRows.filter((row) => row.kind === 'terminal' && row.state === 'running')).toHaveLength(4);
            expect(ai.state).toBe('running');
            expect(bRows.some((row) => row.kind === 'terminal' && row.state === 'running')).toBe(true);
            expect((await terminalSnapshot(page, first)).exits).toEqual([]);
            expect((await terminalSnapshot(page, second)).exits).toEqual([]);
            const monitors = [...aRows.filter((row) => row.kind === 'terminal').map((row) => ({ ...row, group: 'terminal-a' })),
                ...bRows.filter((row) => row.kind === 'terminal').map((row) => ({ ...row, group: 'terminal-b' })), { ...ai, group: 'ai' }]
                .filter((row) => row.state === 'running').flatMap((row) => row.blockers
                .filter((blocker) => ['endpoint', 'process-tree'].includes(blocker.kind) && blocker.identity && blocker.settled_at === null)
                .map((blocker) => ({ ...JSON.parse(blocker.identity), marker: markerOf(blocker), group: row.group })));
            expect(monitors.length).toBeGreaterThan(0);
            expect(monitors.some((monitor) => monitor.group === 'ai'), 'Finish evidence contains actual AI process identities').toBe(true);
            ctx.save('measurement-finish.json', { monitors, aRows, bRows });
            // The watch validates exact ledger pid/startTime identities and stops before the task or terminals are torn down.
            watcher.stdin.end(`${JSON.stringify({ type: 'finish', monitors })}\n`);
            const result = await waitFor('controlled fd watcher exits after finish', () => { if (watchFailure) throw watchFailure; return watchOutcome; }, { timeoutMs: 10_000, intervalMs: 100 });
            ctx.save('ptyleak.json', result.stdout);
            ctx.save('ptyleak-stderr.txt', result.stderr);
            expect(result.code).toBe(0);
            const probe = JSON.parse(result.stdout);
            expect(probe.errors).toEqual([]);
            expect(probe.pending, 'Missing process roles are incomplete coverage, never a pass').toEqual([]);
            for (const role of ['prep', 'bwrap', 'orchestration', 'endpoint', 'workload', 'terminal']) expect(probe.counts[role], `${role} actually sampled`).toBeGreaterThan(0);
            expect(await terminalCommand(page, second, 'echo TERMINAL_B_OK; ls -l /proc/$$/fd')).toContain('TERMINAL_B_OK');
            expect(await task).toContain('TASK_B_DONE');
            conversationObserver.assertSelected(selectedConversation);
        } catch (error) { primaryError = error; }
        const cleanupErrors = [];
        const clean = async (action) => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
        {
            // Abort this measurement before product cleanup, even when setup or finish validation failed.
            await clean(() => { if (watcher && watcher.exitCode === null && !watcher.stdin.writableEnded) watcher.stdin.end('{"type":"abort"}\n'); });
            if (watcher) await clean(() => waitFor('controlled fd watcher closes after abort', () => { if (watchFailure) throw watchFailure; return watchOutcome; }, { timeoutMs: 10_000, intervalMs: 100 }));
            await clean(() => ctx.save('ptyleak.json', stdout));
            await clean(() => ctx.save('ptyleak-stderr.txt', stderr));
            // End owned terminals only after the measurement has finished/aborted, freeing browser slots before WebChat controls.
            for (const terminal of ctx.terminals) await clean(() => closeTerminal(page, terminal));
            if (task) await clean(async () => { expect(await stopChatTurn(chatPage), 'Own chat cancellation completes before stream navigation').toBe(true); });
            let detachedAt;
            if (chatCleanup) await clean(async () => { await chatCleanup.quiesce(); detachedAt = Date.now(); });
            await clean(() => ctx.save('conversation-stream.json', conversationObserver?.evidence() || null));
            await clean(() => conversationObserver?.assertNoFailure());
            await clean(() => conversationObserver?.dispose());
            await clean(() => chatCleanup?.dispose());
            await clean(() => chatPage.close());
            detachedAt ||= Date.now();
            if (task) await clean(() => waitFor('own chat task settles after close', () => taskOutcome, { timeoutMs: 10_000, intervalMs: 100 }));
            await clean(() => ctx.save('task-outcome.json', { state: taskOutcome ? (taskOutcome.error ? 'failed' : 'completed') : 'unsettled',
                error: taskOutcome?.error && { name: taskOutcome.error.name, message: taskOutcome.error.message } }));
            if (task) await clean(() => waitFor('own CLI disconnected-runtime grace expires', () => Date.now() >= detachedAt + 121_000, { timeoutMs: 122_000, intervalMs: 1000 }));
            await clean(() => cleanup(ctx, page));
            await clean(() => chatDiagnostics.flush());
            await clean(() => assertPageDiagnosticsClean(chatPage, 'L9 chat has no unrelated browser errors'));
        }
        await clean(() => ctx.save('cleanup-errors.json', cleanupErrors.map((error) => ({ name: error.name, message: error.message }))));
        throwScenarioFailures(primaryError, cleanupErrors);
    });

    test('L7/A11: RoboTeam restart preserves the shell; worker restart ends it and a new terminal opens', async ({ page }) => {
        test.skip(process.env.SMOKE_ROBOWORK_TERMINAL_RESTART !== '1', 'Opt in with SMOKE_ROBOWORK_TERMINAL_RESTART=1 (restarts RoboTeam and kills the worker).');
        test.setTimeout(12 * 60_000);
        const ctx = await setup(page, 'terminal-restart');
        try {
            const robot = await ctx.createRobot();
            const terminal = await ctx.launch(robot);
            const identity = (await terminalCommand(page, terminal, 'echo $$')).trim();
            const token = crypto.randomBytes(12).toString('hex');
            await terminalCommand(page, terminal, `export RW_TERMINAL_CONTINUITY=${token}`);
            const command = process.env.SMOKE_ROBOWORK_PLOINKY || 'ploinky';
            ctx.save('roboteam-restart.txt', execFileSync(command, ['restart', 'roboTeamAgent'], { cwd: ctx.workspaceRoot, encoding: 'utf8', timeout: 5 * 60_000 }));
            expect((await terminalCommand(page, terminal, 'echo $$')).trim()).toBe(identity);
            expect((await terminalCommand(page, terminal, 'echo "$RW_TERMINAL_CONTINUITY"')).trim()).toBe(token);
            const ids = terminalIds(ctx, robot);
            const workerId = execFileSync('podman', ['exec', ctx.containers.box, 'podman', 'inspect', '--format', '{{.Id}}', ctx.containers.worker], { encoding: 'utf8' }).trim();
            assert.match(workerId, /^[a-f0-9]{64}$/u);
            const killedAt = Date.now();
            execFileSync('podman', ['exec', ctx.containers.box, 'podman', 'kill', '--signal', 'KILL', workerId], { encoding: 'utf8', timeout: 30_000 });
            await waitFor('SSE exit after worker kill, without Router restart', async () => (await terminalSnapshot(page, terminal)).exits.length > 0, { timeoutMs: 30_000, intervalMs: 100 });
            ctx.save('worker-exit-latency.json', { killedAt, exitedAt: Date.now() });
            await waitFor('worker generation returns', () => {
                try { ctx.containers = discoverContainers({ workspaceRoot: ctx.workspaceRoot, boxName: ctx.containers.box }); return true; } catch { return false; }
            }, { timeoutMs: 420_000, intervalMs: 2000 });
            ctx.save('old-generation-settled.json', await settledTerminals({ ...ctx, scratchDir: ctx.evidenceDir, robotName: robot.name, executionIds: ids, timeoutMs: 60_000 }));
            const replacement = await waitFor('new terminal after worker recovery, same Router', async () => {
                try {
                    const target = await robotTarget(page, robot);
                    const result = await launchTerminal(page, target, { onCreated: (created) => ctx.terminals.push(created) });
                    return result.status === 201 ? result : null;
                } catch { return null; }
            }, { timeoutMs: 420_000, intervalMs: 5000 });
            expect(await terminalCommand(page, replacement, 'echo RECONNECTED')).toContain('RECONNECTED');
        } finally { await cleanup(ctx, page); }
    });

    test('A40: Router loss ends old-session terminals by lease expiry; Close terminals is not old-session cleanup proof', async ({ page }) => {
        test.skip(process.env.SMOKE_ROBOWORK_TERMINAL_ROUTER_RESTART !== '1', 'Opt in with SMOKE_ROBOWORK_TERMINAL_ROUTER_RESTART=1 (kills the exact Router process).');
        test.setTimeout(8 * 60_000);
        const ctx = await setup(page, 'terminal-router-restart');
        try {
            const robot = await ctx.createRobot();
            const terminal = await ctx.launch(robot);
            expect(await terminalCommand(page, terminal, 'echo ROUTER_OLD_SESSION')).toContain('ROUTER_OLD_SESSION');
            const ids = terminalIds(ctx, robot);
            const outerContainerId = execFileSync('podman', ['inspect', '--format', '{{.Id}}', ctx.containers.box], { encoding: 'utf8' }).trim();
            const evidence = { outerContainerId, workspaceRoot: fs.realpathSync(ctx.workspaceRoot), workspaceHash: workspaceHash(fs.realpathSync(ctx.workspaceRoot)) };
            const router = collectExactRoutingServerIdentity(evidence);
            ctx.save('router-before.json', router);
            const killSource = `const fs=require('fs'); const p=Number(process.argv[1]); const expected=process.argv[2]; const text=fs.readFileSync('/proc/'+p+'/stat','utf8'); if(text.slice(text.lastIndexOf(')')+2).trim().split(/\\s+/)[19] !== expected) throw Error('Router PID reused'); process.kill(p,'SIGKILL');`;
            const killedAt = Date.now();
            execFileSync('podman', ['exec', '--user', 'podman', outerContainerId, '/usr/local/bin/node', '-e', killSource, String(router.routerPid), router.routerStartTime], { encoding: 'utf8', timeout: 30_000 });
            // Inspect all old admissions directly; closeRobot only sees a new current ownership session after restart.
            const rows = await settledTerminals({ ...ctx, scratchDir: ctx.evidenceDir, robotName: robot.name, executionIds: ids, timeoutMs: 35_000 });
            ctx.save('router-lease-cleanup.json', { killedAt, observedAt: Date.now(), rows });
            for (const row of rows) expect(JSON.stringify(row.end_payload) + row.result).toMatch(/lease-expiry|supersession/u);
            await waitFor('Router recovered', async () => {
                try { return (await page.request.get('/webtty/live-sessions')).status() === 200; } catch { return false; }
            }, { timeoutMs: 180_000, intervalMs: 2000 });
            const after = collectExactRoutingServerIdentity(evidence);
            expect(after.routerPid !== router.routerPid || after.routerStartTime !== router.routerStartTime).toBe(true);
            ctx.save('router-after.json', after);
            await page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' });
            const replacement = await ctx.launch(robot);
            expect(await terminalCommand(page, replacement, 'echo ROUTER_NEW_SESSION')).toContain('ROUTER_NEW_SESSION');
        } finally { await cleanup(ctx, page); }
    });
});
