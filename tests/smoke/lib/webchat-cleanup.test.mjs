import assert from 'node:assert/strict';
import http from 'node:http';
import {after, before, test} from 'node:test';
import {chromium, expect} from '@playwright/test';
import {assertPageDiagnosticsClean, attachPageDiagnostics} from './fixtures.mjs';
import {observeWebchatCleanup, WEBCHAT_FIXTURE_DOCUMENT} from './webchat-cleanup.mjs';
import {cancelWebchatGenerationIfActive, selectWebchatWorkspacePath} from './webchat.mjs';

let browser;
before(async () => { browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });

async function fixture(run, {stream = true, controlStatus = 204, controlDelay = 150,
  hangingControl = false, consumeControlResponse = false} = {}) {
  const directory = 'upload-cleanup-project';
  const query = `agent=roboTeamAgent&robot=default&workspace-dir=${directory}&tabId=fixture-tab&pageInstanceId=fixture-page`;
  const state = {controlCompleted: false, controlStarted: false};
  const timers = new Set();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    if (pathname === '/webchat/stream') {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('event: ready\ndata: {}\n\n');
      return;
    }
    if (pathname === '/webchat/control') {
      state.controlStarted = true;
      if (hangingControl) return;
      request.on('data', () => {});
      request.on('end', () => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          response.writeHead(controlStatus);
          response.end();
          state.controlCompleted = true;
        }, controlDelay);
        timers.add(timer);
      });
      return;
    }
    if (pathname === '/unrelated-pending') return;
    if (pathname === WEBCHAT_FIXTURE_DOCUMENT) {
      response.writeHead(200, {'content-type': 'text/css'});
      response.end('body { color: black; }');
      return;
    }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, {'content-type': 'text/html'});
    response.end(`<!doctype html><input id="cmd"><div id="typingIndicator" aria-hidden="false"></div>
      <button id="cancelBtn">Cancel</button><button id="send">Send</button>
      <script>
        ${stream ? `window.source = new EventSource('/webchat/stream?${query}');` : ''}
        cancelBtn.onclick = () => {
          void fetch('/webchat/control?${query}', {method: 'POST', body: '\\x1b'})${consumeControlResponse ? '.then(response => response.text())' : ''};
          typingIndicator.setAttribute('aria-hidden', 'true');
          cancelBtn.hidden = true;
        };
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({baseURL});
  const page = await context.newPage();
  page.setDefaultTimeout(3_000);
  const diagnostics = attachPageDiagnostics(page, {}, 'cleanup-browser-unit');
  const cleanup = observeWebchatCleanup(page, directory, {baseURL, timeout: 2_000});
  try {
    const opened = stream ? page.waitForResponse(response => new URL(response.url()).pathname === '/webchat/stream') : Promise.resolve();
    await page.goto(`/webchat?agent=roboTeamAgent&robot=default&workspace-dir=${directory}`);
    await opened;
    await run({page, diagnostics, cleanup, state, baseURL});
  } finally {
    cleanup.dispose();
    await context.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('original optimistic cancel followed by navigation aborts both control and live stream in Chromium', async () => {
  await fixture(async ({page, diagnostics}) => {
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/webchat/control');
    await page.locator('#cancelBtn').click();
    await requested;
    await page.goto(WEBCHAT_FIXTURE_DOCUMENT);
    await expect.poll(() => diagnostics.actionableEvents().filter(event => event.kind === 'requestfailed').length).toBe(2);
    assert.deepEqual(diagnostics.actionableEvents().map(event => [event.method, new URL(event.url).pathname, event.failure]).sort(), [
      ['GET', '/webchat/stream', 'net::ERR_ABORTED'],
      ['POST', '/webchat/control', 'net::ERR_ABORTED'],
    ]);
  }, {controlDelay: 5_000});
});

test('completed cancellation and exact stream navigation preserve retained evidence with no actionable errors', async () => {
  await fixture(async ({page, diagnostics, cleanup, state}) => {
    await cancelWebchatGenerationIfActive(page);
    assert.equal(state.controlCompleted, true, 'control must complete before leaving the chat');
    assertPageDiagnosticsClean(page);
    await cleanup.quiesce();
    assert.equal(new URL(page.url()).pathname, WEBCHAT_FIXTURE_DOCUMENT);
    assert.deepEqual(diagnostics.actionableEvents(), []);
    assert.equal(diagnostics.events.filter(event => event.kind === 'requestfailed').length, 1);
    assert.equal(new URL(diagnostics.events.find(event => event.kind === 'requestfailed').url).pathname, '/webchat/stream');
    await page.evaluate(() => console.error('late cleanup failure'));
    await expect.poll(() => diagnostics.actionableEvents().length).toBe(1);
    assert.throws(() => assertPageDiagnosticsClean(page), /late cleanup failure/);
  }, {consumeControlResponse: true});
});

test('an unconsumed HTTP204 is not misreported as a completed control response', async () => {
  await fixture(async ({page, cleanup, state, diagnostics}) => {
    await assert.rejects(cancelWebchatGenerationIfActive(page, {timeout: 300}), /response (?:did not|must) finish/);
    assert.equal(state.controlCompleted, true, 'the server sent204 but Chromium still has an unconsumed response');
    // Chromium may retain the unread response or cancel it during garbage collection.
    // Neither state is successful cleanup, and no captured error may be acknowledged.
    await assert.rejects(cleanup.quiesce(), /all WebChat cancellation controls must finish|WebChat must be error-free before upload cleanup/);
    assert.deepEqual(diagnostics.actionableEvents(), diagnostics.events.filter(event => event.type === 'error'));
    assert.equal(new URL(page.url()).pathname, '/webchat');
  });
});

test('cleanup rejects a still-pending control instead of accepting its navigation abort', async () => {
  await fixture(async ({page, cleanup, state}) => {
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/webchat/control');
    await page.locator('#cancelBtn').click();
    await requested;
    await assert.rejects(cleanup.quiesce(), /all WebChat cancellation controls must finish/);
    assert.equal(state.controlCompleted, false);
    assert.equal(new URL(page.url()).pathname, '/webchat');
  }, {controlDelay: 5_000});
});

test('cleanup rejects a chat with no observed stream before navigating or deleting its project', async () => {
  await fixture(async ({page, cleanup}) => {
    await assert.rejects(cleanup.quiesce(), /sole live WebChat stream/);
    assert.equal(new URL(page.url()).pathname, '/webchat');
  }, {stream: false});
});

for (const controlStatus of [401, 500]) {
  test(`cancel rejects HTTP ${controlStatus} and retains the failure as actionable`, async () => {
    await fixture(async ({page, diagnostics}) => {
      await assert.rejects(cancelWebchatGenerationIfActive(page), /cancellation must be accepted/);
      assert.ok(diagnostics.actionableEvents().some(event => event.kind === 'response' && event.status === controlStatus));
      assert.equal(new URL(page.url()).pathname, '/webchat');
    }, {controlStatus});
  });
}

test('cancel rejects a response timeout and leaves the chat in place', async () => {
  await fixture(async ({page, cleanup}) => {
    page.setDefaultTimeout(300);
    await assert.rejects(cancelWebchatGenerationIfActive(page, {timeout: 300}), /Timeout 300ms exceeded/);
    await assert.rejects(cleanup.quiesce(), /all WebChat cancellation controls must finish/);
    assert.equal(new URL(page.url()).pathname, '/webchat');
  }, {hangingControl: true});
});

test('an unrelated navigation abort cannot be acknowledged alongside the captured stream', async () => {
  await fixture(async ({page, diagnostics, cleanup}) => {
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/unrelated-pending');
    await page.evaluate(() => { void fetch('/unrelated-pending'); });
    await requested;
    await assert.rejects(cleanup.quiesce(), /unexpected diagnostic event multiset/);
    assert.ok(diagnostics.actionableEvents().some(event => new URL(event.url).pathname === '/unrelated-pending'));
  });
});

test('preexisting browser errors prevent the intentional stream-abort checkpoint', async () => {
  await fixture(async ({page, cleanup, diagnostics}) => {
    await page.evaluate(() => console.error('preexisting failure'));
    await expect.poll(() => diagnostics.actionableEvents().length).toBe(1);
    await assert.rejects(cleanup.quiesce(), /WebChat must be error-free before upload cleanup/);
    assert.equal(diagnostics.actionableEvents().length, 1);
    assert.equal(new URL(page.url()).pathname, '/webchat');
  });
});

test('workspace path selection drills through immediate folder entries before selecting the exact leaf', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="cmd"><div class="wa-slash-menu"><div class="wa-slash-menu-group">Files and folders</div><div class="wa-slash-menu-item"><span class="wa-slash-menu-label">unrelated-first-choice/</span></div><div class="wa-slash-menu-item" id="target"><span class="wa-slash-menu-label"></span></div></div>');
    await page.evaluate(() => {
      const entries = {'@upload-folder': 'upload-folder/', '@upload-folder/': 'upload-folder/nested/',
        '@upload-folder/nested/': 'upload-folder/nested/folder-note.txt'};
      window.selected = [];
      const input = document.querySelector('#cmd');
      const item = document.querySelector('#target .wa-slash-menu-label');
      const update = () => { item.textContent = entries[input.value] || ''; };
      input.addEventListener('input', update);
      document.querySelector('#target').addEventListener('click', () => {
        if (!item.textContent) return;
        const selected = item.textContent;
        window.selected.push(selected);
        input.value = `@${selected}${selected.endsWith('/') ? '' : ' '}`;
        update();
      });
    });
    await selectWebchatWorkspacePath(page, 'upload-folder/nested/folder-note.txt');
    assert.deepEqual(await page.evaluate(() => window.selected), ['upload-folder/', 'upload-folder/nested/', 'upload-folder/nested/folder-note.txt']);
    await expect(page.locator('#cmd')).toHaveValue('@upload-folder/nested/folder-note.txt ');
  } finally {
    await page.close();
  }
});
