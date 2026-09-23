import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const readText = (relativePath) => fs.readFile(new URL(relativePath, root), 'utf8');

test('guest-reachable shared assets avoid the non-public /assets tree', async () => {
    const customSelectHtml = await readText('web-components/components/custom-select/custom-select.html');
    const uiCommonCss = await readText('shared/ui/ui-common.css');

    // Only /shared/* and /web-components/components/* are public for unauthenticated guests;
    // /assets/* is denied, so guest-facing components must use the shared tree.
    assert.doesNotMatch(customSelectHtml, /\/explorer\/assets\//);
    assert.doesNotMatch(uiCommonCss, /\/explorer\/assets\//);
    assert.match(customSelectHtml, /\/explorer\/shared\/assets\/icons\/arrow\.svg/);
    assert.match(uiCommonCss, /\/explorer\/shared\/assets\/icons\/x-mark\.svg/);

    for (const icon of ['arrow.svg', 'x-mark.svg', 'fullscreen.svg']) {
        await assert.doesNotReject(
            fs.access(new URL(`shared/assets/icons/${icon}`, root)),
            `shared/assets/icons/${icon} must exist for guests`
        );
    }
});
