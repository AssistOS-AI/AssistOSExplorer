// Unit tests for docs consistency validation
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const explorerRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(explorerRoot, '..');

const readText = (relativePath, base = repoRoot) =>
    fs.readFileSync(path.resolve(base, relativePath), 'utf8');

const readExplorerText = (relativePath) =>
    fs.readFileSync(path.resolve(explorerRoot, relativePath), 'utf8');

test('docs include repo-scoped HTML preview guidance', () => {
    const rootReadme = readText('README.md');
    const explorerReadme = readExplorerText('README.md');
    const developmentHtml = readText('docs/development.html');

    const requiredSnippets = [
        '/.ploinky/repos/AchillesIDE/docs/development.html'
    ];

    for (const snippet of requiredSnippets) {
        assert.ok(rootReadme.includes(snippet), `README.md missing snippet: ${snippet}`);
        assert.ok(explorerReadme.includes(snippet), `explorer/README.md missing snippet: ${snippet}`);
        assert.ok(developmentHtml.includes(snippet), `docs/development.html missing snippet: ${snippet}`);
    }
});

test('mcp tools documentation matches current tool definitions', () => {
    const definitionsSource = readExplorerText('utils/server/tool-definitions.mjs');
    const docsToolsHtml = readText('docs/mcp-tools.html');

    const toolNames = new Set();
    const regex = /name:\s*'([^']+)'/g;
    let match = regex.exec(definitionsSource);
    while (match) {
        toolNames.add(match[1]);
        match = regex.exec(definitionsSource);
    }

    assert.ok(toolNames.size > 0, 'No MCP tools extracted from tool-definitions.mjs');

    for (const toolName of toolNames) {
        assert.ok(
            docsToolsHtml.includes(`<code>${toolName}</code>`),
            `docs/mcp-tools.html is missing MCP tool: ${toolName}`
        );
    }
});

test('docs consistency does not depend on legacy fileExplorer symlink layout', () => {
    const symlinkPath = path.resolve(explorerRoot, '.ploinky/repos/fileExplorer');
    assert.equal(
        fs.existsSync(symlinkPath),
        false,
        'legacy explorer/.ploinky/repos/fileExplorer path should not be required by docs consistency checks'
    );
});

test('architecture and development docs mention split file-exp presenters', () => {
    const architectureHtml = readText('docs/architecture.html');
    const developmentHtml = readText('docs/development.html');

    const requiredComponentMentions = [
        'file-exp-entries',
        'file-exp-preview',
        'html-web-view'
    ];

    for (const componentName of requiredComponentMentions) {
        assert.ok(
            architectureHtml.includes(componentName),
            `docs/architecture.html missing component mention: ${componentName}`
        );
        assert.ok(
            developmentHtml.includes(componentName),
            `docs/development.html missing component mention: ${componentName}`
        );
    }
});

test('agent documentation linked from Explorer can navigate back through a breadcrumb', () => {
    const overviewHtml = readText('docs/index.html');
    const agentDocPaths = [...overviewHtml.matchAll(/href="\.\.\/([^"?#]+\/docs\/index\.html)"/g)]
        .map((match) => match[1]);

    assert.ok(agentDocPaths.length > 0, 'Explorer overview does not link to any agent documentation');

    for (const agentDocPath of agentDocPaths) {
        const agentHtml = readText(agentDocPath);
        const agentDocsDirectory = path.dirname(agentDocPath);
        const agentStyles = readText(path.join(agentDocsDirectory, 'styles.css'));
        const partialLoader = readText(path.join(agentDocsDirectory, 'partials-loader.js'));
        assert.match(agentHtml, /<h1(?:\s|>)/);
        assert.match(agentStyles, /\.breadcrumbs\s*\{/);
        assert.match(agentStyles, /\.site-header \.breadcrumbs\s*\{/);
        assert.match(partialLoader, /documentation-breadcrumb\.js/);
        assert.match(partialLoader, /initializeDocumentationBreadcrumb\(/);
    }

    const breadcrumbSource = readText('docs/documentation-breadcrumb.js');
    assert.match(breadcrumbSource, /export function initializeDocumentationBreadcrumb/);
    assert.match(breadcrumbSource, /\.site-header/);
    assert.match(breadcrumbSource, /'\.\.\/\.\.\/docs\/index\.html'/);
    assert.match(breadcrumbSource, /brand\.replaceWith\(navigation\)/);
    assert.match(breadcrumbSource, /header\.prepend\(navigation\)/);
});

test('Explorer documentation replaces its header brand with a breadcrumb', () => {
    const partialLoader = readText('docs/partials-loader.js');
    const styles = readText('docs/styles.css');
    const workspaceOperations = readText('docs/workspace-operations.html');

    assert.match(workspaceOperations, /<h1>Workspace Operations<\/h1>/);
    assert.match(partialLoader, /initializeDocumentationBreadcrumb\('AchillesIDE'/);
    assert.match(partialLoader, /overviewHref:\s*'index\.html'/);
    assert.match(partialLoader, /includeAgentLevel:\s*false/);
    assert.match(styles, /\.site-header \.breadcrumbs\s*\{/);
});

test('hardware policy documentation matches the separate editor and applied memory byte schema', () => {
    const modal = readExplorerText('web-components/modals/settings-modal/settings-modal.html');
    const settings = readText('docs/specs/DS008-user-settings.md');
    const operations = readText('docs/workspace-operations.html');
    const monitor = readText('workspaceMonitorAgent/docs/specs/DS004-monitoring-and-history.md');
    const tools = readText('workspaceMonitorAgent/docs/mcp-tools.html');
    const administration = modal.match(/<section[^>]*data-section="users"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    assert.ok(administration);
    assert.doesNotMatch(administration, /hardware-limits-panel|<input|<form/);
    assert.match(modal, /data-hardware-tab hidden[^>]*>Hardware limits/);
    assert.match(settings, /Hardware limits is a separate editable administrator tab/);
    assert.match(settings, /Apply sends exact registry keys/);
    assert.match(settings, /Conflicts preserve unsaved edits/);
    assert.match(operations, /limits\.memory\.bytes/);
    assert.match(monitor, /`limits\.memory` \(bytes, assurance\)/);
    assert.match(tools, /limits\.memory=\{bytes,assurance\}/);
    assert.match(operations, /best-effort, not a security boundary/);
    assert.match(operations, /exposure is accepted for v1/);
    assert.match(operations, /optional no-wait child refusal leaves its parent ready/);
});
