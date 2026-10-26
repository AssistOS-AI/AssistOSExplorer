import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

// The runner is imported inside the tests, so the command-line cases below
// still run against a source tree whose runner lacks the newer exports.
const smokeRoot = fileURLToPath(new URL('..', import.meta.url));
const benchmarkScript = path.join(smokeRoot, 'scripts', 'run-ui-benchmark.mjs');
const runFile = promisify(execFile);

// Fabricated fixture values only; no real credential is involved.
const LOCAL_USERNAME = 'bench-readiness';
const LOCAL_PASSWORD = 'sentinel-readiness-passphrase-51ab';
const DIRECTORY = '/AdvancedLanguageAgent';
const FILE = '/test1.backlog';
const NESTED_FILE = '/AdvancedLanguageAgent/README.md';
const PLUGIN_MODULE = '/fixture/plugins/git-tool-button.mjs';
// Playwright's non-activating trial click hovers its target; the product has
// no hover behavior on either Git control.
const HOVER_EVENTS = ['pointerover', 'mouseover'];
const touches = (events) => events.filter(({ type }) => !HOVER_EVENTS.includes(type));
const SCENARIO = ['router-login-page', 'login-to-explorer-interactive', 'refresh-root-listing',
  'open-workspace-directory', 'return-root-from-workspace-directory', 'open-confidential',
  'open-confidential-my-space', 'return-root-from-confidential', 'open-workspace-file', 'open-git-panel'];

// Runs in the fixture Explorer page. The Git controls copy the product's DOM:
// the host's lazy trigger (file-exp-application-plugins.js) inside
// #fileExpToolbarPlugins, and the mounted git-tool-button's #gitButton. Every
// pointer, focus or click event on either control and every activation is
// recorded in the page and reported to the server under its own path.
function explorerFixture(config) {
  const events = [];
  window.__gitEvents = events;
  const report = (type, form) => {
    events.push({ type, form });
    fetch(`/fixture/event/${type}/${form}`, { method: 'POST', keepalive: true }).catch(() => {});
  };
  window.webSkel = {};
  const loader = { depth: 0 };
  window.__assistosExplorerGlobalLoader = loader;
  const tree = {
    '/': [
      ...(config.structure === 'missing-directory' ? [] : [{ path: '/AdvancedLanguageAgent', directory: true }]),
      { path: '/Confidential', directory: true },
      { path: '/test1.backlog' },
    ],
    '/AdvancedLanguageAgent': [{ path: '/AdvancedLanguageAgent/README.md' }],
    '/Confidential': [{ path: '/Confidential/My Space', directory: true }],
    '/Confidential/My Space': [],
  };
  const basename = (value) => value.split('/').filter(Boolean).at(-1) || '/';
  const parent = (value) => value.split('/').slice(0, -1).join('/') || '/';
  const content = document.getElementById('page_content');
  const fileExp = document.createElement('file-exp');
  const presenter = { state: { path: '/', selectedPath: '' } };
  fileExp.webSkelPresenter = presenter;
  fileExp.innerHTML = '<div id="fileExpToolbar"><button id="refreshButton" type="button">Refresh</button>'
    + '<button id="upButton" type="button">Up</button><nav id="breadcrumbs"></nav>'
    + '<div id="fileExpToolbarPlugins" class="app-plugin-toolbar-slot"></div></div>'
    + '<table><tbody id="entriesBody"></tbody></table><div id="editorFileName"></div>';
  content.append(fileExp);
  const body = fileExp.querySelector('#entriesBody');
  const host = fileExp.querySelector('#fileExpToolbarPlugins');

  async function navigate(target) {
    loader.depth += 1;
    await fetch('/fixture/list', { method: 'POST', body: target });
    presenter.state.path = target;
    body.replaceChildren(...(tree[target] || []).map((entry) => {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.className = 'col-name';
      cell.setAttribute('data-local-action', 'selectEntry');
      cell.setAttribute('data-entry-path', entry.path);
      cell.textContent = basename(entry.path);
      row.append(cell);
      return row;
    }));
    const crumbs = fileExp.querySelector('#breadcrumbs');
    const root = document.createElement('button');
    root.type = 'button';
    root.textContent = 'Root';
    root.addEventListener('click', () => { void navigate('/'); });
    crumbs.replaceChildren(root);
    loader.depth -= 1;
  }
  async function selectFile(target) {
    loader.depth += 1;
    await fetch('/fixture/file', { method: 'POST', body: target });
    presenter.state.selectedPath = target;
    fileExp.querySelector('#editorFileName').textContent = basename(target);
    loader.depth -= 1;
    if (raceArmed && config.raceAt === 'file-open') { raceArmed = false; startRace(); }
  }
  body.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-entry-path]');
    if (!cell) return;
    const target = cell.getAttribute('data-entry-path');
    const entry = Object.values(tree).flat().find((candidate) => candidate.path === target);
    if (entry?.directory) void navigate(target);
    else void selectFile(target);
  });
  fileExp.querySelector('#refreshButton').addEventListener('click', () => { void navigate(presenter.state.path); });
  fileExp.querySelector('#upButton').addEventListener('click', () => { void navigate(parent(presenter.state.path)); });

  const lazyTrigger = (key = 'gitAgent/git') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-plugin-tool-button app-plugin-lazy-trigger';
    button.setAttribute('data-app-plugin-trigger', key);
    button.setAttribute('data-plugin-label', 'Git');
    button.setAttribute('aria-label', 'Git');
    button.title = 'Git';
    button.innerHTML = '<span class="app-plugin-tool-icon" aria-hidden="true"><img class="app-plugin-tool-icon-image" alt=""></span>'
      + '<span class="app-plugin-tool-label">Git</span>';
    button.addEventListener('click', () => activate('lazy', button));
    return button;
  };
  const mountedControl = () => {
    const component = document.createElement('git-tool-button');
    component.innerHTML = '<button id="gitButton" class="git-tool-button app-plugin-tool-button" type="button" '
      + 'title="Commit and push with Git" aria-label="Open Git tools" data-local-action="openGitPanel">'
      + '<span class="git-tool-button-label app-plugin-tool-label">Git</span></button>';
    component.querySelector('#gitButton').addEventListener('click', () => activate('mounted'));
    return component;
  };
  const pluginMount = (child) => {
    const mount = document.createElement('div');
    mount.className = 'app-plugin-mount';
    mount.setAttribute('data-app-plugin-key', 'gitAgent/git');
    mount.setAttribute('data-app-plugin-slot', 'toolbar');
    mount.append(child);
    return mount;
  };
  for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'click', 'focusin']) {
    document.addEventListener(type, (event) => {
      const control = event.target instanceof Element
        ? event.target.closest('[data-app-plugin-trigger], #gitButton') : null;
      if (control) report(type, control.id === 'gitButton' ? 'mounted' : 'lazy');
    }, true);
  }

  // Git's panel descriptor opens the panel at once; the lazy form then loads
  // the component and replaces the trigger with the mounted control.
  function activate(form, trigger) {
    report('activation', form);
    const panel = document.createElement('git-panel');
    panel.innerHTML = '<div class="git-panel">Git</div>';
    const state = { repoOverviewsLoading: true, repoOverviewsLoaded: false, credentialsGate: false };
    panel.webSkelPresenter = { state };
    document.body.append(panel);
    loader.depth += 1;
    if (form === 'lazy') {
      void import(config.pluginModule).then(() => trigger.closest('.app-plugin-mount')?.replaceChildren(mountedControl()));
    }
    void fetch('/fixture/git/overview', { method: 'POST' }).then(() => {
      if (config.panel === 'shell-only') { loader.depth -= 1; return; }
      state.repoOverviewsLoading = false;
      state.repoOverviewsLoaded = config.panel === 'overview';
      state.credentialsGate = config.panel === 'credentials';
      if (config.panel !== 'loader-stuck') loader.depth -= 1;
    });
  }

  function mountGit() {
    const git = config.git;
    if (git === 'lazy' || git === 'replace') host.append(pluginMount(lazyTrigger()));
    if (git === 'mounted') host.append(pluginMount(mountedControl()));
    if (git === 'misplaced') fileExp.querySelector('#fileExpToolbar').append(lazyTrigger());
    if (git === 'unrelated') host.append(pluginMount(lazyTrigger('gitAgent/other')));
    if (git === 'duplicate') host.append(pluginMount(lazyTrigger()), pluginMount(lazyTrigger()));
    if (git === 'both') host.append(pluginMount(lazyTrigger()), pluginMount(mountedControl()));
    const control = host.querySelector('[data-app-plugin-trigger="gitAgent/git"], #gitButton');
    if (git === 'replace') {
      control.setAttribute('aria-busy', 'true');
      setTimeout(() => control.closest('.app-plugin-mount').replaceChildren(mountedControl()), config.replaceAfterMs);
    }
    if (!control || !config.block) return;
    if (config.block === 'hidden') control.hidden = true;
    if (config.block === 'display-none') control.style.display = 'none';
    if (config.block === 'disabled') control.disabled = true;
    if (config.block === 'aria-disabled') control.setAttribute('aria-disabled', 'true');
    if (config.block === 'busy') control.setAttribute('aria-busy', 'true');
    if (config.block === 'loading') control.setAttribute('data-app-plugin-loading', '');
    if (config.block === 'inert') control.closest('.app-plugin-mount').inert = true;
    if (config.block === 'detached') {
      control.addEventListener('pointerover', () => control.closest('.app-plugin-mount')?.remove(), { once: true });
    }
    if (config.block === 'obstructed') {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;z-index:1000;background:transparent';
      document.body.append(cover);
    }
  }

  // Arms a change for the moment a trial click hovers the Git control: while
  // that trial is still in flight, a second supported trigger appears
  // (duplicate) or the control turns busy. Only a check of the Git control
  // itself can set it off.
  function startRace() {
    const control = host.querySelector('[data-app-plugin-trigger="gitAgent/git"], #gitButton');
    control.addEventListener('pointerover', () => {
      if (config.race === 'duplicate') host.append(pluginMount(lazyTrigger()));
      else control.setAttribute('aria-busy', 'true');
      report('race', config.race);
    }, { once: true });
  }
  let raceArmed = Boolean(config.race);

  let releaseRender = () => {};
  window.__fixture = {
    startRace,
    release() {
      releaseRender();
      delete presenter.__appPluginRenderPromise;
      if (config.structure === 'loader') loader.depth = 0;
    },
  };
  setTimeout(async () => {
    await navigate(config.structure === 'non-root' ? '/Confidential' : '/');
    mountGit();
    if (raceArmed && config.raceAt === 'boot') { raceArmed = false; startRace(); }
    document.getElementById('before_webskel_loader')?.remove();
    if (config.structure === 'no-presenter') delete fileExp.webSkelPresenter;
    if (config.structure === 'pending-render') {
      presenter.__appPluginRenderPromise = new Promise((resolve) => { releaseRender = resolve; });
    }
    if (config.structure === 'loader') loader.depth = 1;
    // Unrelated Explorer work starting right after the Git check, which the
    // readiness recheck must wait for.
    if (config.structure === 'loader-after-git-check') {
      host.addEventListener('pointerover', () => {
        loader.depth += 1;
        setTimeout(() => { loader.depth -= 1; }, 400);
      }, { once: true });
    }
  }, config.bootDelayMs);
}

function createFixture() {
  const fixture = { log: [], options: {} };
  const defaults = { git: 'lazy', block: '', structure: '', race: '', raceAt: '', panel: 'overview', bootDelayMs: 150, panelDelayMs: 150,
    replaceAfterMs: 400, pluginModule: PLUGIN_MODULE };
  fixture.reset = (options = {}) => {
    fixture.log.length = 0;
    fixture.options = { ...defaults, ...options };
  };
  fixture.count = (pathname) => fixture.log.filter((entry) => entry.pathname === pathname).length;
  fixture.gitEvents = () => fixture.log.filter((entry) => entry.pathname.startsWith('/fixture/event/'))
    .map((entry) => entry.pathname.slice('/fixture/event/'.length));
  const authenticated = (incoming) => Boolean(incoming.headers.cookie?.includes('fixture-session=authenticated'));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  fixture.server = http.createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://fixture.invalid');
    fixture.log.push({ method: incoming.method, pathname: url.pathname });
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    if (url.pathname === '/explorer/index.html') {
      if (!authenticated(incoming)) {
        response.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(url.pathname)}` }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><div id="before_webskel_loader">Loading</div><div id="page_content"></div>'
        + `<script>(${explorerFixture.toString()})(${JSON.stringify(fixture.options)});</script></body></html>`);
      return;
    }
    if (url.pathname === '/auth/login' && incoming.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<form action="/auth/login" method="post"><input id="username" name="username"><input id="password" name="password" type="password">'
        + `<input type="hidden" name="returnTo" value="${url.searchParams.get('returnTo') || '/'}"><button type="submit">Sign in</button></form>`);
      return;
    }
    if (url.pathname === '/auth/login' && incoming.method === 'POST') {
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (form.get('username') !== LOCAL_USERNAME || form.get('password') !== LOCAL_PASSWORD) {
        response.writeHead(401).end('Invalid username or password');
        return;
      }
      response.writeHead(303, { location: form.get('returnTo') || '/explorer/index.html',
        'set-cookie': 'fixture-session=authenticated; Path=/; HttpOnly' }).end();
      return;
    }
    if (url.pathname === PLUGIN_MODULE) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end('export default true;\n');
      return;
    }
    if (url.pathname === '/fixture/git/overview') {
      await delay(fixture.options.panelDelayMs);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (['/fixture/list', '/fixture/file'].includes(url.pathname) || url.pathname.startsWith('/fixture/event/')) {
      await delay(15);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(404).end();
  });
  return fixture;
}

const fixture = createFixture();
let browser;

test.before(async () => {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  fixture.baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  fixture.server.closeAllConnections();
  await new Promise((resolve) => fixture.server.close(resolve));
});

function childEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return { ...environment, UI_BENCHMARK_USERNAME: LOCAL_USERNAME, UI_BENCHMARK_PASSWORD: LOCAL_PASSWORD };
}

// Runs the production benchmark command against the fixture and returns its
// exit code, output and parsed result.
async function runBenchmark(iterations, extra = []) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-benchmark-readiness-'));
  try {
    let run;
    try {
      const { stdout, stderr } = await runFile(process.execPath, [benchmarkScript, '--base-url', fixture.baseURL,
        '--label', 'readiness-fixture', '--iterations', String(iterations), '--timeout-ms', '5000',
        '--artifact-dir', artifactDir, '--directory-path', DIRECTORY, '--file-path', FILE, ...extra],
      { cwd: smokeRoot, env: childEnvironment(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      run = { code: 0, stdout, stderr };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      run = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    const resultText = fs.readFileSync(path.join(artifactDir, 'result.json'), 'utf8');
    assert.equal(resultText.includes(LOCAL_PASSWORD), false, 'the result never contains the password');
    assert.equal(`${run.stdout}${run.stderr}`.includes(LOCAL_PASSWORD), false, 'the output never contains the password');
    const report = JSON.parse(resultText);
    const statuses = report.iterations.map((iteration) => iteration.steps.map((step) => `${step.name}:${step.status}`));
    return { ...run, report, explain: `exit ${run.code}\n${JSON.stringify(statuses)}\n${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

// Requests of one iteration with the step each was attributed to.
const stepsOf = (iteration, predicate) => iteration.waterfall.requests
  .filter((request) => predicate(request.pathname)).map((request) => request.step);

for (const [form, iterations] of [['lazy', 2], ['mounted', 1]]) {
  test(`the production benchmark completes all ten steps with the ${form} Git control`, { timeout: 120_000 }, async () => {
    fixture.reset({ git: form });
    const run = await runBenchmark(iterations);
    assert.equal(run.code, 0, run.explain);
    const { report } = run;
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, 'passed');
    assert.equal(report.scenario.version, 'explorer-ui-v1');
    assert.deepEqual(report.scenario.steps, SCENARIO);
    assert.equal(report.iterations.length, iterations);
    for (const iteration of report.iterations) {
      assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]), SCENARIO.map((name) => [name, 'passed']));
      assert.deepEqual(iteration.steps.at(-1).details, { readiness: 'repository-overview' });
      assert.deepEqual(stepsOf(iteration, (pathname) => pathname === `/fixture/event/activation/${form}`), ['open-git-panel'],
        'exactly one activation, inside the Git step');
      // Readiness's non-activating trial may hover the control; nothing else
      // reaches Git before its own step.
      assert.deepEqual(iteration.waterfall.requests
        .filter(({ pathname, step }) => pathname.startsWith('/fixture/event/') && step !== 'open-git-panel')
        .map(({ pathname }) => pathname.split('/')[3])
        .filter((type) => !HOVER_EVENTS.includes(type)), [], 'no press, click, focus or activation on Git before its step');
      assert.deepEqual(stepsOf(iteration, (pathname) => pathname === PLUGIN_MODULE), form === 'lazy' ? ['open-git-panel'] : [],
        'the Git component is imported only by its activation');
      assert.deepEqual(stepsOf(iteration, (pathname) => pathname === '/fixture/git/overview'), ['open-git-panel']);
    }
    assert.equal(fixture.count(`/fixture/event/activation/${form}`), iterations);
    assert.equal(fixture.count(PLUGIN_MODULE), form === 'lazy' ? iterations : 0);
  });
}

test('the production benchmark fails at Explorer readiness without a supported Git control', { timeout: 120_000 }, async () => {
  fixture.reset({ git: 'none' });
  const run = await runBenchmark(1);
  assert.equal(run.code, 1, run.explain);
  const [iteration] = run.report.iterations;
  assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]),
    [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'failed']], run.explain);
  assert.match(iteration.error.message, /Timeout 5000ms exceeded waiting for one actionable Explorer Git control \(no supported Git control is visible\)/);
});

test('the production benchmark fails the Git step when the panel never finishes loading', { timeout: 120_000 }, async () => {
  fixture.reset({ git: 'lazy', panel: 'shell-only' });
  const run = await runBenchmark(1);
  assert.equal(run.code, 1, run.explain);
  const [iteration] = run.report.iterations;
  assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]),
    SCENARIO.map((name) => [name, name === 'open-git-panel' ? 'failed' : 'passed']), run.explain);
  assert.equal(fixture.count('/fixture/event/activation/lazy'), 1, 'the failed step activated Git once and never retried');
});

// A second supported control, or a busy state, that appears while the
// non-activating trial waits must be seen before the control is accepted.
const RACE_REASONS = { duplicate: /2 supported Git controls are visible/, busy: /the Git control is busy/ };

test('the production benchmark refuses a second Git control that appears during the Git step check', { timeout: 120_000 }, async () => {
  fixture.reset({ git: 'lazy', race: 'duplicate', raceAt: 'file-open' });
  const run = await runBenchmark(1);
  assert.equal(run.code, 1, run.explain);
  const [iteration] = run.report.iterations;
  assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]),
    SCENARIO.map((name) => [name, name === 'open-git-panel' ? 'failed' : 'passed']), run.explain);
  assert.match(iteration.error.message, RACE_REASONS.duplicate);
  assert.deepEqual(stepsOf(iteration, (pathname) => pathname === '/fixture/event/race/duplicate'), ['open-git-panel'],
    'the race happened during the Git step check');
  assert.equal(fixture.count('/fixture/event/activation/lazy'), 0, 'neither control was clicked');
  assert.equal(fixture.count(PLUGIN_MODULE), 0);
});

test('the production benchmark refuses a Git control that turns busy during the readiness check', { timeout: 120_000 }, async () => {
  fixture.reset({ git: 'lazy', race: 'busy', raceAt: 'boot' });
  const run = await runBenchmark(1);
  assert.equal(run.code, 1, run.explain);
  const [iteration] = run.report.iterations;
  assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]),
    [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'failed']], run.explain);
  assert.match(iteration.error.message, RACE_REASONS.busy);
  assert.equal(fixture.count('/fixture/event/race/busy'), 1, 'the race happened');
  assert.equal(fixture.count('/fixture/event/activation/lazy'), 0);
});

// ---- direct readiness and Git-step checks on the fixture page ---------------
async function fixturePage(options) {
  fixture.reset(options);
  const context = await browser.newContext({ baseURL: fixture.baseURL });
  await context.addCookies([{ name: 'fixture-session', value: 'authenticated', url: fixture.baseURL }]);
  const page = await context.newPage();
  await page.goto('/explorer/index.html');
  return { page, context, events: () => page.evaluate(() => window.__gitEvents) };
}
const readinessConfig = (overrides = {}) => ({ timeoutMs: 1_500, directoryPath: DIRECTORY, filePath: FILE, ...overrides });

test('readiness accepts each supported control without touching Git, however often it runs', async (t) => {
  const { waitForExplorerInteractive } = await import('../scripts/run-ui-benchmark.mjs');
  for (const git of ['lazy', 'mounted']) {
    await t.test(git, async () => {
      const { page, context, events } = await fixturePage({ git });
      try {
        for (let round = 0; round < 3; round += 1) await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
        assert.deepEqual(touches(await events()), [], 'no press, focus, click or activation');
        assert.equal(fixture.count(PLUGIN_MODULE), 0, 'nothing imported');
        assert.equal(await page.locator('git-panel').count(), 0, 'nothing opened');
      } finally {
        await context.close();
      }
    });
  }
});

test('readiness refuses unsupported, ambiguous and blocked Git controls within its budget', async (t) => {
  const { waitForExplorerInteractive } = await import('../scripts/run-ui-benchmark.mjs');
  const cases = {
    'no control': [{ git: 'none' }, /no supported Git control is visible/],
    'a trigger outside the plugin host': [{ git: 'misplaced' }, /no supported Git control is visible/],
    'an unrelated plugin trigger': [{ git: 'unrelated' }, /no supported Git control is visible/],
    'two lazy triggers': [{ git: 'duplicate' }, /2 supported Git controls are visible/],
    'a lazy trigger and a mounted button': [{ git: 'both' }, /2 supported Git controls are visible/],
    hidden: [{ block: 'hidden' }, /no supported Git control is visible/],
    'display none': [{ block: 'display-none' }, /no supported Git control is visible/],
    disabled: [{ block: 'disabled' }, /the Git control is disabled/],
    'aria-disabled': [{ block: 'aria-disabled' }, /the Git control is aria-disabled/],
    busy: [{ block: 'busy' }, /the Git control is busy/],
    loading: [{ block: 'loading' }, /the Git control is busy/],
    inert: [{ block: 'inert' }, /the Git control is (hidden|not actionable)|no supported Git control is visible/],
    obstructed: [{ block: 'obstructed' }, /the Git control is not actionable/],
    'detached during the check': [{ block: 'detached' }, /no supported Git control is visible|the Git control is detached/],
  };
  for (const [name, [options, reason]] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { page, context, events } = await fixturePage(options);
      try {
        const started = Date.now();
        await assert.rejects(waitForExplorerInteractive(page, readinessConfig()), (error) => {
          assert.match(error.message, /^Timeout 1500ms exceeded waiting for one actionable Explorer Git control/);
          assert.match(error.message, reason);
          return true;
        });
        assert.ok(Date.now() - started < 1_500 + 1_000, 'the refusal stays within the readiness budget');
        assert.deepEqual(touches(await events()), []);
      } finally {
        await context.close();
      }
    });
  }
});

test('a lazy trigger replaced by the mounted control is resolved without activating Git', async () => {
  const { waitForExplorerInteractive, openGitPanel } = await import('../scripts/run-ui-benchmark.mjs');
  const { page, context, events } = await fixturePage({ git: 'replace', replaceAfterMs: 400 });
  try {
    await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
    assert.equal(await page.locator('#gitButton').count(), 1);
    assert.equal(await page.locator('[data-app-plugin-trigger]').count(), 0);
    assert.deepEqual(touches(await events()), []);
    assert.deepEqual(await openGitPanel(page, readinessConfig({ timeoutMs: 5_000 })), { readiness: 'repository-overview' });
    assert.deepEqual((await events()).filter(({ type }) => type === 'activation'), [{ type: 'activation', form: 'mounted' }]);
  } finally {
    await context.close();
  }
});

test('the existing structural gates still hold readiness, and a released delay passes', async (t) => {
  const { waitForExplorerInteractive } = await import('../scripts/run-ui-benchmark.mjs');
  const blocked = {
    'missing presenter': { structure: 'no-presenter' },
    'non-root presenter': { structure: 'non-root' },
    'missing root directory entry': { structure: 'missing-directory' },
    'pending plugin render': { structure: 'pending-render' },
    'global loader': { structure: 'loader' },
    'a nested-only file': { fileOverride: NESTED_FILE },
  };
  for (const [name, options] of Object.entries(blocked)) {
    await t.test(`${name} fails boundedly`, async () => {
      const { fileOverride, ...fixtureOptions } = options;
      const { page, context, events } = await fixturePage(fixtureOptions);
      try {
        const started = Date.now();
        await assert.rejects(waitForExplorerInteractive(page, readinessConfig(fileOverride ? { filePath: fileOverride } : {})),
          /^Error: Timeout 1500ms exceeded waiting for the Explorer root listing\.$|Timeout 1500ms exceeded waiting for the Explorer root listing\./);
        assert.ok(Date.now() - started < 1_500 + 1_000);
        assert.deepEqual(touches(await events()), []);
      } finally {
        await context.close();
      }
    });
  }
  for (const structure of ['pending-render', 'loader']) {
    await t.test(`a released ${structure} passes`, async () => {
      const { page, context } = await fixturePage({ structure });
      try {
        const ready = waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
        await page.waitForTimeout(500);
        await page.evaluate(() => window.__fixture.release());
        await ready;
      } finally {
        await context.close();
      }
    });
  }
});

test('a duplicate or busy state that appears during the trial is refused by readiness and by the Git step', async (t) => {
  const { waitForExplorerInteractive, openGitPanel } = await import('../scripts/run-ui-benchmark.mjs');
  for (const race of ['duplicate', 'busy']) {
    await t.test(`readiness: ${race}`, async () => {
      const { page, context, events } = await fixturePage({ git: 'lazy', race, raceAt: 'boot' });
      try {
        await assert.rejects(waitForExplorerInteractive(page, readinessConfig()), (error) => {
          assert.match(error.message, /^Timeout 1500ms exceeded waiting for one actionable Explorer Git control/);
          assert.match(error.message, RACE_REASONS[race]);
          return true;
        });
        assert.deepEqual(touches(await events()), [{ type: 'race', form: race }]);
      } finally {
        await context.close();
      }
    });
    await t.test(`Git step: ${race}`, async () => {
      const { page, context, events } = await fixturePage({ git: 'lazy', race });
      try {
        await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
        // As the measured steps do, move the pointer away from Git first, so
        // the Git step's own trial is what hovers it.
        await page.mouse.move(0, 0);
        await page.evaluate(() => window.__fixture.startRace());
        await assert.rejects(openGitPanel(page, readinessConfig()), RACE_REASONS[race]);
        assert.deepEqual(touches(await events()), [{ type: 'race', form: race }], 'nothing was clicked');
        assert.equal(await page.locator('git-panel').count(), 0);
      } finally {
        await context.close();
      }
    });
  }
});

test('readiness checks the Explorer structure again after the Git check', async () => {
  const { waitForExplorerInteractive } = await import('../scripts/run-ui-benchmark.mjs');
  const { page, context, events } = await fixturePage({ structure: 'loader-after-git-check' });
  try {
    await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
    assert.equal(await page.evaluate(() => window.__assistosExplorerGlobalLoader.depth), 0,
      'readiness returned only after the work that began during the Git check settled');
    assert.ok((await events()).some(({ type }) => type === 'pointerover'), 'the fixture work was started by the Git check');
  } finally {
    await context.close();
  }
});

test('the Git step activates once and passes only when the panel finished loading', async (t) => {
  const { waitForExplorerInteractive, openGitPanel } = await import('../scripts/run-ui-benchmark.mjs');
  for (const [panel, expected] of [['overview', 'repository-overview'], ['credentials', 'credentials-gate']]) {
    await t.test(`${panel} on the lazy control`, async () => {
      const { page, context, events } = await fixturePage({ git: 'lazy', panel });
      try {
        await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
        assert.deepEqual(await openGitPanel(page, readinessConfig({ timeoutMs: 5_000 })), { readiness: expected });
        assert.deepEqual((await events()).filter(({ type }) => type === 'activation' || type === 'click'),
          [{ type: 'click', form: 'lazy' }, { type: 'activation', form: 'lazy' }]);
        assert.equal(fixture.count(PLUGIN_MODULE), 1);
      } finally {
        await context.close();
      }
    });
  }
  for (const panel of ['shell-only', 'loader-stuck']) {
    await t.test(`${panel} fails`, async () => {
      const { page, context, events } = await fixturePage({ git: 'lazy', panel });
      try {
        await waitForExplorerInteractive(page, readinessConfig({ timeoutMs: 5_000 }));
        await assert.rejects(openGitPanel(page, readinessConfig()), /Timeout 1500ms exceeded/);
        assert.equal((await events()).filter(({ type }) => type === 'activation').length, 1, 'never activated twice');
      } finally {
        await context.close();
      }
    });
  }
  await t.test('no supported control fails the step without a click', async () => {
    const { page, context, events } = await fixturePage({ git: 'unrelated' });
    try {
      await assert.rejects(openGitPanel(page, readinessConfig()), /one actionable Explorer Git control/);
      assert.deepEqual(touches(await events()), []);
    } finally {
      await context.close();
    }
  });
});
