import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function readText(relativePath) {
    return fs.readFile(new URL(relativePath, root), 'utf8');
}

async function readJson(relativePath) {
    return JSON.parse(await readText(relativePath));
}

test('expanded-modal is a registered WebSkel modal component', async () => {
    const webskel = await readJson('webskel.json');
    const entry = webskel.components.find((component) => component.name === 'expanded-modal');

    assert.ok(entry, 'expanded-modal must be registered in webskel.json');
    assert.equal(entry.type, 'modals');
    assert.equal(entry.presenterClassName, 'ExpandedModal');

    const html = await readText('web-components/modals/expanded-modal/expanded-modal.html');
    const presenter = await readText('web-components/modals/expanded-modal/expanded-modal.js');
    const css = await readText('web-components/modals/expanded-modal/expanded-modal.css');

    assert.match(html, /expanded-modal-header/);
    assert.match(html, /data-local-action="reloadContent"/);
    assert.match(html, /data-local-action="toggleFullscreen"/);
    assert.match(html, /data-local-action="closeModal"/);
    assert.match(html, /data-resize-dir="se"/);
    assert.match(html, /expandedModalBody/);

    assert.match(css, /dialog\.modal\.expanded-modal-dialog/);
    assert.match(css, /expanded-modal-resize-handle/);
    assert.match(css, /\.is-fullscreen/);

    assert.match(presenter, /export class ExpandedModal/);
    assert.match(presenter, /ensureMarketplaceAgentRunning/);
    assert.match(presenter, /mountComponentContent/);
    assert.match(presenter, /mountFrameContent/);
    assert.match(presenter, /waitForAgentRuntimeAvailability/);
    assert.match(presenter, /probeAgentRuntimeTarget/);
    assert.match(presenter, /setFullscreen/);
    assert.match(presenter, /startResize/);
    assert.match(presenter, /closeModal/);
});

test('openExpandedModal is a thin host shell over assistOS.UI.showModal', async () => {
    const source = await readText('shared/ui/expanded-modal.js');

    assert.match(source, /export function openExpandedModal/);
    assert.match(source, /showModal\(EXPANDED_MODAL_COMPONENT/);
    assert.doesNotMatch(source, /document\.createElement/);
});

test('Explorer exposes the expanded modal host API', async () => {
    const source = await readText('main.js');

    assert.match(source, /import \{ openExpandedModal \} from '\.\/shared\/ui\/expanded-modal\.js'/);
    assert.match(source, /webSkel\.openExpandedModal = openExpandedModal/);
});

test('toolbar plugins declare a toolbarModal descriptor', async () => {
    const help = await readJson('IDE-plugins/help/config.json');
    const marketplace = await readJson('IDE-plugins/marketplace/config.json');

    assert.equal(help.toolbarModal.mode, 'component');
    assert.equal(help.toolbarModal.component, 'help-modal');
    assert.equal(marketplace.toolbarModal.mode, 'component');
    assert.equal(marketplace.toolbarModal.component, 'marketplace-modal');
});

test('Explorer opens the toolbar panel from the manifest descriptor before loading the plugin', async () => {
    const source = await readText('web-components/pages/file-exp/file-exp-application-plugins.js');

    assert.match(source, /import \{ openExpandedModal \} from "\.\.\/\.\.\/\.\.\/shared\/ui\/expanded-modal\.js"/);
    assert.match(source, /function openPluginToolbarModal/);
    assert.match(source, /openExpandedModal\(\{ \.\.\.descriptor, title: descriptor\.title \|\| label \}\)/);
    assert.match(source, /openToolbarPluginWithFeedback\(trigger, \(\) => openPluginToolbarModal\(plugin\)\)/);
});

test('help and marketplace toolbar buttons open the shared expanded modal', async () => {
    const helpButton = await readText('IDE-plugins/help/help-tool-button.js');
    const marketplaceButton = await readText('IDE-plugins/marketplace/marketplace-tool-button.js');

    assert.match(helpButton, /openExpandedModal/);
    assert.match(marketplaceButton, /openExpandedModal/);
    assert.doesNotMatch(marketplaceButton, /window\.open/);
});
