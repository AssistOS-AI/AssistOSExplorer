import assert from 'node:assert/strict';
import test from 'node:test';
import { GitCredentialsPrompt } from '../../IDE-plugins/git-tool-button/components/git-credentials-prompt/git-credentials-prompt.js';

test('AutoSync preferences start unchecked and display saved repository selections', (t) => {
    const checkboxes = [];
    const previousDocument = globalThis.document;
    const createContainer = () => ({ appendChild() {} });
    globalThis.document = {
        createDocumentFragment: createContainer,
        createElement(tag) {
            if (tag !== 'input') return createContainer();
            const input = { dataset: {} };
            checkboxes.push(input);
            return input;
        },
    };
    t.after(() => {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    });

    const prompt = new GitCredentialsPrompt({ classList: { toggle() {} } }, () => {});
    prompt.autocommitReposContainer = createContainer();
    prompt.autocommitToggleAllInput = {};
    const repoPaths = ['/workspace/project', '/workspace/another'];

    for (const [selection, checked, allChecked, indeterminate] of [
        [null, [false, false], false, false],
        [[repoPaths[0]], [true, false], false, true],
        [repoPaths, [true, true], true, false],
        [[], [false, false], false, false],
    ]) {
        checkboxes.length = 0;
        prompt.applyState({
            autocommitReposLoaded: true,
            autocommitRepos: repoPaths.map((path) => ({ path })),
            autocommitSelected: selection,
            refreshAutocommitRepos: true,
        });
        assert.deepEqual(checkboxes.map((input) => input.checked), checked);
        assert.equal(prompt.autocommitToggleAllInput.checked, allChecked);
        assert.equal(prompt.autocommitToggleAllInput.indeterminate, indeterminate);
    }
});
