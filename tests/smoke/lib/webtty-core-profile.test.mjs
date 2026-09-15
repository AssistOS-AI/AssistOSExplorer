import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const smokeRoot = fileURLToPath(new URL('../', import.meta.url));
const expectedTitle = 'local administrator controls the mounted workspace while an ordinary user is denied';

test('npm WebTTY core profile owns the exact Chromium release gate', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts?.['test:webtty'];
  assert.equal(typeof command, 'string');
  assert.match(command, /\bSMOKE_WEBTTY_CORE=1\b/);
  assert.match(command, /--project=chromium\b/);
  assert.match(command, /\bspecs\/01-webtty-core\.spec\.mjs\b/);
  assert.doesNotMatch(command, /--grep|--headed|--retries/);

  const webttySpec = fs.readFileSync(
    new URL('../specs/01-webtty-core.spec.mjs', import.meta.url),
    'utf8',
  );
  assert.match(webttySpec, new RegExp(`test\\(['\"]${expectedTitle}['\"]`));
  assert.match(webttySpec, /readAuthenticatedPrincipal\(page, smokeConfig\.primaryUser\)/);
  assert.match(webttySpec, /expect\(admin\.roles\)\.toContain\('admin'\)/);
  assert.match(webttySpec, /readAuthenticatedPrincipal\(userPage, smokeConfig\.secondaryUser\)/);
  assert.match(webttySpec, /assertDistinctAuthenticatedPrincipals\(admin, ordinaryUser\)/);
  assert.match(webttySpec, /expect\(ordinaryUser\.roles\)\.not\.toContain\('admin'\)/);
  assert.match(webttySpec, /assertExplorerDirectory\(page, fixture\.parentDirectoryPath\)/);
  assert.match(webttySpec, /openTerminalFromExplorer\(page, fixture\.nestedDirectoryPath\)/);
  assert.match(webttySpec, /normalCloseKeptWebttyAvailable: true/);
  assert.match(webttySpec, /collectWebttyRuntimeEvidence/);
  assert.match(webttySpec, /SMOKE_PLOINKY_BOX_CONTAINER/);
  assert.match(webttySpec, /SMOKE_EXPECT_BOX_IMAGE_ID/);
  assert.match(webttySpec, /SMOKE_EXPECT_BOX_IMAGE_REF/);
  assert.match(webttySpec, /expectedPloinkySource/);
  assert.match(webttySpec, /requireFreshImage: false/);
  assert.match(webttySpec, /requireAgentEvidence\(initialRuntime, 'gitAgent', \{ eligible: true \}\)/);
  assert.match(webttySpec, /requireAgentEvidence\(initialRuntime, 'liveKitServerAgent', \{ eligible: false \}\)/);
  assert.match(webttySpec, /independentlyProvedAgentTargetCount/);
  assert.match(webttySpec, /missingCsrfStatus/);
  assert.match(webttySpec, /forgedOriginStatus/);
  assert.match(webttySpec, /crossSessionLaunchStatus/);
  assert.match(webttySpec, /restartPloinkyTarget\('gitAgent'/);
  assert.match(webttySpec, /crashExactRoutingServer\(replacementRuntime, replacementGitAgent\)/);
  assert.match(webttySpec, /collectExactRoutingServerIdentity\(replacementRuntime\)/);
  assert.match(webttySpec, /readOnlyTargetExercised/);
  assert.match(webttySpec, /runWhileObservingNoAgentShell/);
  assert.match(webttySpec, /collectNestedContainerEvents/);
  assert.match(webttySpec, /WEBTTY_AGENT_HOSTNAME/);
  assert.match(webttySpec, /authRevocationRemovedExecAndForegroundProcess/);
  assert.match(webttySpec, /defaultRouterCrashRecoveryRemovedAgentExecAndForegroundProcess/);
  assert.match(webttySpec, /single-use launch replay rejection/);
  assert.match(webttySpec, /stale predecessor launch rejection/);
  const cancellationBlockStart = webttySpec.indexOf(
    "const cancellationCheckpoint = checkpointPageDiagnostics(page, 'consumed discovery cancellation');",
  );
  const cancellationBlockEnd = webttySpec.indexOf(
    'const refreshedTargets = refreshedDiscovery.targets;',
    cancellationBlockStart,
  );
  assert.ok(cancellationBlockStart >= 0, 'the consumed cancellation proof must exist');
  assert.ok(
    cancellationBlockEnd > cancellationBlockStart,
    'the consumed cancellation proof must have a bounded end',
  );
  const cancellationBlock = webttySpec.slice(cancellationBlockStart, cancellationBlockEnd);
  assert.match(cancellationBlock, /page\.waitForResponse[\s\S]+response\.url\(\) === cancellationUrl[\s\S]+response\.request\(\)\.method\(\) === 'DELETE'/);
  assert.match(cancellationBlock, /page\.waitForEvent\('requestfinished'/);
  assert.match(cancellationBlock, /expect\(cancellationResponse\.status\(\)\)\.toBe\(404\)/);
  assert.match(cancellationBlock, /expect\(cancellationFinishedRequest\)\.toBe\(cancellationResponse\.request\(\)\)/);
  assert.match(cancellationBlock, /expect\(cancellationFinishedRequest\.failure\(\)\)\.toBeNull\(\)/);
  assert.match(cancellationBlock, /expect\(await cancellationResponse\.json\(\)\)\.toEqual\(\{ ok: false, error: 'not_found' \}\)/);
  assert.match(cancellationBlock, /expect\(cancellationRequests\)\.toHaveLength\(1\)/);
  assert.match(cancellationBlock, /expect\(cancellationRequests\[0\]\)\.toBe\(cancellationResponse\.request\(\)\)/);
  assert.match(cancellationBlock, /'cancellation response',[\s\S]+'replacement discovery request'/);
  assert.match(cancellationBlock, /expect\(refreshedDiscovery\.id\)\.not\.toBe\(consumedDiscoveryId\)/);
  assert.match(cancellationBlock, /acknowledgeExactPageDiagnostics/);
  assert.doesNotMatch(
    cancellationBlock,
    /waitForEvent\('requestfailed'|response\.finished|acknowledgeOneOfExact/,
  );
  assert.match(webttySpec, /exact prior-epoch Router stream invalidation/);
  const quiesceIndex = webttySpec.indexOf("await page.goto('about:blank'");
  const crashIndex = webttySpec.indexOf('const crashedRouter = crashExactRoutingServer(');
  const recoveredIndex = webttySpec.indexOf('expect(recoveredRouter).toBeTruthy()');
  const reopenedIndex = webttySpec.indexOf('acknowledgeExactPageDiagnostics(page, primaryRecoveryCheckpoint, [])');
  assert.ok(quiesceIndex > 0 && quiesceIndex < crashIndex, 'unrelated Explorer traffic stops before the exact Router crash');
  assert.ok(crashIndex < recoveredIndex && recoveredIndex < reopenedIndex, 'Explorer reopens only after verified Router recovery');
  assert.match(webttySpec.slice(quiesceIndex - 120, quiesceIndex), /background traffic without muting/);
  assert.doesNotMatch(webttySpec.slice(quiesceIndex, reopenedIndex), /\.pause\(|setExpectedOffline\(true\)/);
  const replacementVictimIndex = webttySpec.indexOf('const replacementVictim = await openTerminalFromExplorer(');
  const replacementChooserIndex = webttySpec.indexOf('const replacementChooser = await openTerminalChooser(');
  assert.ok(replacementVictimIndex >= 0, 'the replacement victim must be launched through Explorer');
  assert.ok(
    replacementChooserIndex > replacementVictimIndex,
    'the stale-target chooser must open only after the replacement victim launch has closed its chooser',
  );
  assert.match(webttySpec, /staleLaunchSubmittedAt[\s\S]+toBeLessThan\(replacementChooser\.discovery\.expiresAt\)/);
  assert.match(webttySpec, /staleLaunchObservedAt[\s\S]+toBeLessThan\(replacementChooser\.discovery\.expiresAt\)/);
  assert.match(
    webttySpec,
    /const refreshedTargets = refreshedDiscovery\.targets;/,
    'replacement chooser refresh must compare the discovery target array, not the discovery envelope',
  );
});

test('WebTTY core profile collects exactly one enabled Playwright test', { timeout: 30_000 }, () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-core-selector-'));
  try {
    const result = spawnSync(
      'npm',
      ['run', 'test:webtty', '--', '--list'],
      {
        cwd: smokeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          SMOKE_ARTIFACT_DIR: artifactRoot,
          SMOKE_RUN_ID: 'webtty-core-selector-contract',
        },
        timeout: 20_000,
      },
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /01-webtty-core\.spec\.mjs:\d+:\d+.*local administrator controls the mounted workspace while an ordinary user is denied/);
    assert.match(output, /Total: 1 test in 1 file/);
    assert.doesNotMatch(output, /No tests found/);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});
