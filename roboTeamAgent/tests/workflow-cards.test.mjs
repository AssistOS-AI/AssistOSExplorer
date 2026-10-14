import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('async function runWorkflowNow('), source.indexOf('async function loadWorkflows('));

function element(hidden = false) {
    return {
        hidden, disabled: false, textContent: '', attributes: {}, listeners: {}, dataset: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, listener) { this.listeners[name] = listener; },
        focus() { this.focused = true; },
    };
}

function fixture() {
    const cards = [];
    const menus = [];
    const context = {
        workflowCount: element(), workflowListMessage: element(), warningText: 'Matching robots are missing', launchingWorkflows: new Set(),
        workflowsList: { get children() { return cards; }, replaceChildren() { cards.length = 0; }, append(card) { cards.push(card); } },
        workflowTemplate: { content: { firstElementChild: { cloneNode() {
            const nodes = new Map(['.avatar', 'h3', '.robot-id', '.workflow-kind', '.workflow-description',
                '.workflow-counts', '.workflow-open', '.manage-toggle', '.workflow-run-now', '.delete-workflow'].map(selector => [selector, element()]));
            nodes.set('.workflow-coverage-warning', element(true));
            nodes.set('.workflow-source', element(true));
            nodes.set('.robot-manage', element(true));
            const classes = new Set();
            return { querySelector: selector => nodes.get(selector), classes, classList: { add: value => classes.add(value) } };
        } } } },
        document: { createElement: () => element() },
        initials: name => name[0], endpoint: value => `/rt/${value}`,
        closeOpenMenus() {}, initRobotMenu(options) { menus.push(options); },
        navigation: { bindLink() {}, navigate() {} },
        confirm: () => false, api: async () => {}, loadWorkflows: async () => {},
    };
    vm.runInNewContext(`${renderer}\nthis.render = renderWorkflows;`, context);
    return { context, cards, menus };
}

function workflow(overrides = {}) {
    return { id: 'custom-flow', name: 'Research', description: 'Research a subject.', tasks: [{}], edges: [], ...overrides };
}

test('workflow markup shares the robot card layout and has compact creation and a plain total', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const panel = html.slice(html.indexOf('id="workflowTypesPanel"'), html.indexOf('id="kronJobsPanel"'));
    assert.match(panel, /class="workflow-types"/);
    assert.doesNotMatch(panel, /class="panel"/);
    assert.match(panel, /id="workflowCount"\s+class="robot-count"/);
    assert.match(panel, /id="addWorkflowButton"[^>]*href="flow-types\/generate-new"[\s\S]*class="button-plus"[\s\S]*Create\s+workflow/);
    assert.match(panel, /id="flowsHistoryButton" class="workflow-history" href="flows"/);
    const template = html.slice(html.indexOf('<template id="workflowTemplate"'), html.indexOf('<script src="config.js"'));
    assert.match(template, /class="robot-card workflow-card"/);
    assert.match(template, /<a class="workflow-open" title="View workflow">[\s\S]*class="robot-main"[\s\S]*<\/a>\s*<div class="robot-manage"/);
    assert.doesNotMatch(template, /workflow-actions|button primary workflow-open/);
    assert.doesNotMatch(template, /\bworkflow-main\b|\bworkflow-warning\b/);
    assert.match(template, /class="robot-title-row"><h3><\/h3><span class="robot-id"/);
    assert.match(template, /class="robot-identity"[\s\S]*class="workflow-kind"/);
    assert.match(template, /class="robot-meta"[\s\S]*class="workflow-counts"/);
    assert.match(template, /class="robot-manage" hidden[\s\S]*class="manage-options"[\s\S]*class="button danger delete-workflow"/);
    assert.match(template, /class="manage-options"[\s\S]*class="button secondary workflow-run-now"[\s\S]*class="robot-danger-actions"/);
});

test('workflow card navigation has hover feedback without underlines or persistent mouse focus outlines', async () => {
    const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.workflow-open, \.workflow-open:hover, \.workflow-open:focus, \.workflow-open:active \{ text-decoration: none; \}/);
    assert.match(css, /\.button:focus:not\(:focus-visible\), \.button\.pointer-restored-focus:focus \{ outline: none; \}/);
    assert.match(css, /\.workflow-open:focus:not\(:focus-visible\), \.workflow-open\.pointer-restored-focus:focus \{ outline: none; \}/);
    assert.match(css, /\.workflow-card:hover \{[^}]*border-color: var\(--accent-muted\);[^}]*box-shadow: var\(--shadow-sm\)/);
    assert.match(css, /:where\(button, a, summary\):focus-visible \{ outline: 2px solid var\(--accent\)/);
});

test('dashboard descriptions stay plain text and card menus share the title-row alignment', async () => {
    const [css, editorCss] = await Promise.all(['styles.css', 'workflow-editor.css']
        .map(file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
    assert.match(editorCss, /^textarea\.workflow-description \{/m);
    assert.doesNotMatch(editorCss, /^\.workflow-description(?=[ :{])/m);
    assert.match(css, /\.robot-main \{[^}]*align-items: start;/);
    assert.match(css, /\.robot-title-row \{[^}]*min-height: 36px;/);
    assert.match(css, /\.workflow-card > \.robot-manage \{ position: absolute; top: 16px; right: 16px; \}/);
    assert.match(css, /\.cron-card \.robot-main \{[^}]*padding-right: var\(--cron-actions-space\);/);
    assert.match(css, /\.cron-card \.cron-actions \{ position: absolute; top: 16px; right: 16px; \}/);
    assert.match(css, /\.workflow-card-manageable \.workflow-open \{ padding-right: 70px; \}/);
});

test('custom workflows expose Edit and grouped Delete while protected workflows stay view-only', () => {
    const { context, cards, menus } = fixture();
    const name = '<img src=x onerror=alert(1)>';
    context.render([workflow({ name }), workflow({ id: 'default', kind: 'default' }),
        workflow({ id: 'code-development', readOnly: true }), workflow({ id: 'protected', kind: 'default' })], true);
    assert.equal(context.workflowCount.textContent, '4 workflows');
    assert.equal(cards[0].querySelector('h3').textContent, name);
    assert.equal(cards[0].querySelector('.workflow-kind').textContent, 'Custom');
    assert.equal(cards[0].querySelector('.workflow-open').attributes['aria-label'], `Edit workflow ${name}`);
    assert.equal(cards[0].querySelector('.workflow-open').title, 'View workflow');
    assert.equal(cards[0].classes.has('workflow-card-manageable'), true);
    assert.equal(cards[0].querySelector('.workflow-open').href, '/rt/flow-types?id=custom-flow');
    assert.equal(cards[0].querySelector('.robot-manage').hidden, false);
    assert.equal(menus.length, 1);
    assert.equal(menus[0].id, 'workflow-options-custom-flow');
    for (const card of cards.slice(1)) {
        assert.equal(card.querySelector('.workflow-kind').textContent, 'Built-in');
        assert.equal(card.querySelector('.workflow-open').attributes['aria-label'], 'View workflow Research');
        assert.equal(card.querySelector('.workflow-open').title, 'View workflow');
        assert.equal(card.classes.has('workflow-card-manageable'), false);
        assert.equal(card.querySelector('.robot-manage').hidden, true);
        assert.equal(card.querySelector('.delete-workflow').listeners.click, undefined);
        assert.equal(card.querySelector('.workflow-run-now').listeners.click, undefined);
    }
});

test('non-administrators cannot delete and coverage warnings and task counts remain available', () => {
    const { context, cards, menus } = fixture();
    context.render([workflow({ id: 'flow /&', description: '', coverage: { warning: true }, edges: [{}] })], false);
    const card = cards[0];
    assert.equal(context.workflowCount.textContent, '1 workflow');
    assert.equal(card.querySelector('.workflow-open').attributes['aria-label'], 'View workflow Research');
    assert.equal(card.querySelector('.workflow-open').href, '/rt/flow-types?id=flow%20%2F%26');
    assert.equal(card.querySelector('.workflow-description').hidden, true);
    assert.equal(card.querySelector('.workflow-counts').textContent, '1 task · 1 connection');
    assert.equal(card.querySelector('.workflow-coverage-warning').hidden, false);
    assert.equal(card.querySelector('.workflow-coverage-warning').attributes['aria-label'], context.warningText);
    assert.equal(card.querySelector('.robot-manage').hidden, true);
    assert.equal(card.querySelector('.workflow-run-now').listeners.click, undefined);
    assert.equal(menus.length, 0);
});

test('workflow deletion retains confirmation, duplicate protection, history promise and error feedback', async () => {
    const { context, cards } = fixture();
    context.render([workflow()], true);
    const remove = cards[0].querySelector('.delete-workflow');
    let requests = 0;
    let reloads = 0;
    let finish;
    context.api = async (url, options) => {
        requests++;
        assert.equal(url, 'api/roboflow/workflows/custom-flow');
        assert.equal(options.method, 'DELETE');
        await new Promise(resolve => { finish = resolve; });
    };
    context.loadWorkflows = async admin => { assert.equal(admin, true); reloads++; };
    await remove.listeners.click();
    assert.equal(requests, 0);
    context.confirm = message => {
        assert.match(message, /Existing runs and their history will be kept/);
        return true;
    };
    const pending = remove.listeners.click();
    assert.equal(remove.disabled, true);
    await remove.listeners.click();
    assert.equal(requests, 1);
    finish();
    await pending;
    assert.equal(reloads, 1);
    assert.equal(remove.disabled, false);
    assert.equal(remove.textContent, 'Delete workflow');
    context.api = async () => { throw new Error('Delete rejected'); };
    await remove.listeners.click();
    assert.equal(context.workflowListMessage.textContent, 'Delete rejected');
    assert.equal(remove.disabled, false);
});

test('only workflows from workspace files show their source path, and deleting one names its file', async () => {
    const { context, cards } = fixture();
    context.render([workflow(), workflow({ id: 'file-flow', name: 'From file', source: { kind: 'file', path: 'Repo/flows/file-flow.json' } })], true);
    const [internal, file] = cards.map(card => card.querySelector('.workflow-source'));
    assert.deepEqual([internal.hidden, internal.textContent], [true, '']);
    assert.deepEqual([file.hidden, file.textContent], [false, 'Repo/flows/file-flow.json']);
    const messages = [];
    context.confirm = message => { messages.push(message); return false; };
    for (const card of cards) await card.querySelector('.delete-workflow').listeners.click();
    assert.doesNotMatch(messages[0], /deletes its file/);
    assert.match(messages[1], /This deletes its file Repo\/flows\/file-flow\.json\. Existing runs/);
});

test('empty workflow catalogs use the shared empty state', () => {
    const { context, cards } = fixture();
    context.render([], false);
    assert.equal(context.workflowCount.textContent, '0 workflows');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].className, 'empty-state');
    assert.match(cards[0].innerHTML, /No workflow types yet/);
});

test('Run now launches the saved workflow directly and navigates with return context', async () => {
    const { context, cards } = fixture();
    context.render([workflow()], true);
    const button = cards[0].querySelector('.workflow-run-now'), remove = cards[0].querySelector('.delete-workflow');
    let finish, requests = 0, destination;
    context.api = async (url, options) => {
        requests++;
        assert.equal(url, 'api/roboflow/flows');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(JSON.stringify(options.body)), { workflowTypeId: 'custom-flow' });
        await new Promise(resolve => { finish = resolve; });
        return { flow: { id: 'flow_123' } };
    };
    context.navigation.navigate = url => { destination = url; };
    assert.equal(button.dataset.navigationKey, 'workflow-run:custom-flow');
    assert.equal(cards[0].querySelector('.manage-toggle').dataset.navigationKey, 'workflow-menu:custom-flow');
    assert.equal(button.attributes['aria-label'], 'Run workflow Research now');
    const pending = button.listeners.click();
    assert.equal(button.disabled, true); assert.equal(remove.disabled, true); assert.equal(button.textContent, 'Starting…');
    assert.equal(cards[0].querySelector('.manage-toggle').focused, true);
    await button.listeners.click();
    // A catalog refresh cannot enable a second launch while the first request is pending.
    context.render([workflow()], true);
    assert.equal(cards[0].querySelector('.workflow-run-now').disabled, true);
    await cards[0].querySelector('.workflow-run-now').listeners.click();
    assert.equal(requests, 1);
    finish(); await pending;
    assert.equal(destination, '/rt/flows?flowId=flow_123');
    assert.equal(button.disabled, false); assert.equal(remove.disabled, false);
    assert.equal(button.textContent, 'Run now');
    assert.equal(cards[0].querySelector('.workflow-run-now').disabled, false);
});

test('a rejected direct launch displays its error and permits retry without navigation', async () => {
    const { context, cards } = fixture();
    context.render([workflow()], true);
    const button = cards[0].querySelector('.workflow-run-now');
    context.api = async () => { context.render([workflow()], true); throw new Error('Working folder unavailable'); };
    context.navigation.navigate = () => assert.fail('A rejected launch must not navigate');
    await button.listeners.click();
    assert.equal(context.workflowListMessage.textContent, 'Working folder unavailable');
    assert.equal(button.disabled, false); assert.equal(context.launchingWorkflows.size, 0);
    assert.equal(cards[0].querySelector('.workflow-run-now').disabled, false);
    assert.equal(cards[0].querySelector('.delete-workflow').disabled, false);
});
