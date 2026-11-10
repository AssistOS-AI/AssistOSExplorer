import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { openExplorer, assertExplorerDirectory } from '../lib/explorer.mjs';
import { createDirectory, deleteDirectoryIfPresent, directoryRow } from '../lib/copilot.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { browserMutation, createRobot, deleteRobot } from '../lib/robot-terminal.mjs';
import { cleanupWebttyTerminals, registerCreatedTerminal } from '../lib/webtty-terminal-cleanup.mjs';
import { collectWebttyRuntimeEvidence, requireAgentEvidence } from '../lib/webtty-runtime-evidence.mjs';
import { probeRobotHome } from '../lib/terminal-agent-home.mjs';
import { gitAgentTarget, matchesProfileDiscovery, safePrimaryFailure } from '../lib/terminal-agent-chooser.mjs';

const enabled = /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_TERMINAL_LIVE_AGENT || ''));

test('Open Terminal Here preserves the selected folder and robot home in a running agent', async ({ page }, testInfo) => {
  test.skip(!enabled, 'Select the terminal live-agent profile explicitly.');
  test.setTimeout(480_000);
  const root = fs.realpathSync(smokeConfig.workspaceRoot);
  const suffix = crypto.randomBytes(6).toString('hex');
  const name = `terminal ${suffix} țară`;
  const directory = `/${name}`;
  const hostDirectory = path.join(root, name);
  const marker = `terminal-${suffix}`;
  const terminals = [];
  let robot;
  let primaryFailure = null;
  let liveCreationAttempted = false;
  let created = false;
  let phase = 'setup';
  try {
    await openExplorer(page);
    await assertExplorerDirectory(page, '/');
    robot = await createRobot(page, `terminal-${suffix}`, ['opencode']);
    expect(fs.existsSync(hostDirectory)).toBe(false);
    created = true;
    await createDirectory(page, name, directory);
    const runtime = collectWebttyRuntimeEvidence({
      baseURL: smokeConfig.baseURL, boxBaseURL: process.env.SMOKE_BOX_BASE_URL,
      workspaceRoot: root, selectedDirectory: hostDirectory,
      expectedContainerName: process.env.SMOKE_PLOINKY_BOX_CONTAINER,
      expectedImageId: process.env.SMOKE_EXPECT_BOX_IMAGE_ID,
      expectedImageRef: process.env.SMOKE_EXPECT_BOX_IMAGE_REF,
      requireFreshImage: false,
    });
    const provider = requireAgentEvidence(runtime, 'roboWorkAgent');
    const homeInode = probeRobotHome(runtime, provider, robot, marker, 'seed').inode;
    const agent = requireAgentEvidence(runtime, 'gitAgent', { eligible: true });
    expect(agent.mapping.access).toBe('rw');
    phase = 'chooser';
    await directoryRow(page, directory).locator('.action-menu-trigger').click();
    await directoryRow(page, directory).getByRole('menuitem', { name: 'Open Terminal Here' }).click();
    const chooser = page.getByRole('dialog', { name: 'Open terminal in' });
    await expect(chooser.locator('#terminalTargetDirectory')).toHaveText(directory);
    const select = chooser.locator('#terminalTargetRobot');
    await expect(select.locator('option').filter({ hasText: robot.name })).toHaveCount(1);
    const defaultOption = select.locator('option').filter({ hasText: /^default$/i });
    await expect(defaultOption).toHaveCount(1);
    const choose = async (value) => {
      const id = /^\d+:([a-z0-9][a-z0-9-]{2,63})$/.exec(value || '')?.[1];
      expect(id).toBeTruthy();
      const response = page.waitForResponse(r => matchesProfileDiscovery(r, `${id}.default`));
      await select.selectOption(value);
      const result = await response;
      expect(result.status(), 'profiled target discovery must succeed').toBe(201);
      const request = result.request().postDataJSON();
      const body = await result.json();
      expect(request.profile.mode).toBe('live-agent');
      expect(body.discovery.profile).toMatchObject(request.profile);
      return request.profile;
    };
    const defaultValue = await defaultOption.getAttribute('value');
    const defaultId = /^\d+:([a-z0-9][a-z0-9-]{2,63})$/.exec(defaultValue || '')?.[1];
    expect(defaultId).toBeTruthy();
    const defaultProfile = await choose(defaultValue);
    expect(defaultProfile.id).toBe(`${defaultId}.default`);
    await expect(chooser.locator('#terminalTargetEnvironment')).toHaveValue('live-agents');
    const target = gitAgentTarget(page, chooser);
    await expect(target).toHaveCount(1);
    await expect(target).toBeEnabled();
    await target.click();
    await expect(chooser.locator('#terminalTargetOpen')).toBeEnabled();
    const owned = select.locator('option').filter({ hasText: robot.name });
    const profile = await choose(await owned.getAttribute('value'));
    expect(profile.id).toBe(`${robot.id}.default`);
    await expect(chooser.locator('#terminalTargetEnvironment')).toHaveValue('live-agents');
    await expect(target).toHaveCount(1);
    await expect(target).toBeEnabled();
    await target.click();
    phase = 'terminal creation';
    const popupPromise = page.context().waitForEvent('page');
    const creationPromise = page.context().waitForEvent('response', { predicate: r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/webtty/sessions' });
    liveCreationAttempted = true;
    await chooser.locator('#terminalTargetOpen').click();
    const response = await creationPromise;
    expect(response.status()).toBe(201);
    const payload = await response.json().catch(() => null);
    const terminal = await registerCreatedTerminal(terminals, payload);
    terminal.terminalPage = await popupPromise;
    phase = 'shell proof';
    expect(payload.session.cwd).toBe(name);
    expect(payload.session.target.cwdDisplay).toBe(agent.mapping.translatedCwd);
    await expect(terminal.terminalPage.locator('#status')).toHaveText('Connected', { timeout: smokeConfig.timeouts.navigation });
    const resize = await browserMutation(terminal.terminalPage, `/webtty/sessions/${encodeURIComponent(terminal.session.id)}/resize`, { body: { cols: 240, rows: 40 } });
    expect(resize.status).toBe(200);
    const proof = `printf '%s' '${marker}' > cwd-proof; printf '__C%s%s__\\n' 'WD__' "$PWD"; printf '__H%s%s__\\n' 'OME__' "$HOME"; printf '__N%s%s__\\n' 'ODE__' "$(hostname)"; printf '__I%s%s__\\n' 'NODE__' "$(stat -c %i "$HOME/terminal-proof")"; printf '__V%s%s__\\n' 'ALUE__' "$(cat "$HOME/terminal-proof")"; printf '__F%s%s__\\n' 'ILE__' "$(stat -c %i cwd-proof)"; printf '%s' '${marker}-writeback' > "$HOME/terminal-proof" && printf '__D%s__\\n' 'ONE'\r`;
    const input = await browserMutation(terminal.terminalPage, `/webtty/sessions/${encodeURIComponent(terminal.session.id)}/input`, { body: { data: proof } });
    expect(input.status).toBe(200);
    const rows = terminal.terminalPage.locator('#terminal .xterm-rows');
    for (const expected of [
      `__CWD__${agent.mapping.translatedCwd}__`, `__HOME__/run/ploinky-webtty-home-${terminal.session.id}__`,
      `__NODE__${agent.hostname}__`, `__INODE__${homeInode}__`, `__VALUE__${marker}__`,
    ]) {
      await expect.poll(() => rows.innerText(), { timeout: smokeConfig.timeouts.navigation }).toContain(expected);
    }
    await expect.poll(() => fs.existsSync(path.join(hostDirectory, 'cwd-proof')) && fs.readFileSync(path.join(hostDirectory, 'cwd-proof'), 'utf8')).toBe(marker);
    const hostInode = fs.statSync(path.join(hostDirectory, 'cwd-proof')).ino;
    await expect.poll(() => rows.innerText(), { timeout: smokeConfig.timeouts.navigation }).toContain(`__FILE__${hostInode}__`);
    await expect.poll(() => rows.innerText(), { timeout: smokeConfig.timeouts.navigation }).toContain('__DONE__');
    expect(probeRobotHome(runtime, provider, robot, marker, 'verify', homeInode).inode).toBe(homeInode);
  } catch (error) {
    primaryFailure = error;
    const evidence = safePrimaryFailure(error, phase);
    await testInfo.attach('terminal-primary-failure.json', { body: JSON.stringify(evidence), contentType: 'application/json' }).catch(() => {});
    throw error;
  } finally {
    await cleanupWebttyTerminals({
      terminals, priorFailure: primaryFailure, authenticate: async () => page,
      closeTerminal: async (terminal, { requestPage }) => {
        const result = await browserMutation(requestPage, `/webtty/sessions/${encodeURIComponent(terminal.session.id)}`, { method: 'DELETE' });
        if (result.status === 200) expect(result.payload).toMatchObject({ ok: true });
        else if (result.status === 404) expect(result.payload).toEqual({ ok: false, error: 'not_found' });
        else throw new Error(`Terminal cleanup failed: HTTP ${result.status}`);
        terminal.cleaned = true;
        await terminal.terminalPage?.close();
      },
      closeContexts: async () => {
        const failures = [];
        try {
          const chooser = page.getByRole('dialog', { name: 'Open terminal in' });
          if (await chooser.isVisible()) {
            await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(chooser).toBeHidden();
          }
        } catch (error) { failures.push(error); }
        if ((liveCreationAttempted && !terminals.length) || terminals.some(terminal => !terminal.cleaned)) {
          failures.push(new Error('Live terminal cleanup is unproven; retaining the robot and its home.'));
        }
        if (robot && !failures.length) await deleteRobot(page, robot.id).catch(error => failures.push(error));
        if (failures.length) throw new AggregateError(failures, 'Robot cleanup failed.');
      },
      removeFixture: async () => { if (created) await deleteDirectoryIfPresent(page, directory); },
    });
  }
});
