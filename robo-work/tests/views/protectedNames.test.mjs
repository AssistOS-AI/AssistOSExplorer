import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    NAME_CLASSES, classifyGrantName, firstProtectedComponent, foldEnvironment, foldIgnorableStripped, foldPathName,
    isProtectedName, isProtectedPath, isValidComponentName
} from '../../server/views/protectedNames.mjs';
import { loadVectors, runNameVectors } from './helpers/vectors.mjs';

const vectors = loadVectors('protected-names.json');
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Ploinky is a sibling checkout, as for the other tests of this repository (tests/helpers/sibling-roots.mjs). Only two
// of its files are read, and only as text: nothing of the checkout is imported or executed.
const ploinkyRoot = path.resolve(process.env.PLOINKY_ROOT || path.join(repositoryRoot, '..', 'ploinky'));
const ploinkyText = (relative) => fs.readFileSync(path.join(ploinkyRoot, relative), 'utf8');
const normalizeSource = (text) => text.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
const functionSource = (text, name) => {
    const start = text.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} not found in the Ploinky source`);
    let depth = 0;
    for (let index = text.indexOf('{', start); index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(start, index + 1);
        }
    }
    throw new Error(`${name} is not closed`);
};

// The text of Ploinky's matcher as read for this slice (protectedWorkspacePaths.js, isProtectedWorkspaceSegments),
// with `foldWorkspaceName` and the host-state fold written out. The next test compares it with the live file text, so a
// change on the Ploinky side shows up here instead of silently diverging.
const PLOINKY_MATCHER_REFERENCE = `function isProtectedWorkspaceSegments(segments) {
    if (segments.some((segment) => segment && foldWorkspaceName(segment) === HOST_STATE_FOLDED_NAME)) return true;
    for (let index = 0; index < segments.length; index += 1) {
        const name = foldWorkspaceName(segments[index]);
        if (PROTECTED_FILE_NAMES.has(name) || name.endsWith(SECRETS_SUFFIX) || name === AGENT_DATA_ROOT) return true;
        if (name === CONTROLLER_ROOT && !(index === 0 && segments[1] === REPOSITORIES_DIRECTORY)) return true;
    }
    return false;
}`;
const ploinkyMatcher = new Function('foldWorkspaceName', 'HOST_STATE_FOLDED_NAME', 'PROTECTED_FILE_NAMES', 'SECRETS_SUFFIX', 'AGENT_DATA_ROOT',
    'CONTROLLER_ROOT', 'REPOSITORIES_DIRECTORY', `${PLOINKY_MATCHER_REFERENCE}; return isProtectedWorkspaceSegments;`)(
    foldPathName, '.ploinky-box', new Set(['master-key', '.env']), '.secrets', '.data', '.ploinky', 'repos');

const real = {
    classify: (name) => classifyGrantName(name),
    classifyPath: (segments) => firstProtectedComponent(segments)
};

// --- Deliberately weakened implementations: every one of them must be caught by the shared vectors. -----------------

// Builds a predicate pair from a fold, an exact-name map and a suffix rule, so that one ingredient can be weakened.
function makeImplementation({
    fold = foldPathName,
    exact = new Map([['.ploinky', 'controller_state'], ['.data', 'agent_data'], ['.ploinky-box', 'host_state'],
        ['.roboteam', 'private_session'], ['.env', 'key_material'], ['master-key', 'key_material']]),
    suffix = (key) => key.endsWith('.secrets'),
    prefixMatch = false,
    hardening = true
} = {}) {
    const classifyFold = (key) => {
        if (exact.has(key)) return exact.get(key);
        if (prefixMatch) {
            for (const [name, kind] of exact) if (key.startsWith(name)) return kind;
        }
        return suffix(key) ? 'key_material' : null;
    };
    const classify = (name) => {
        const plain = classifyFold(fold(name));
        if (plain) return { class: plain, layer: 'ploinky-fold' };
        if (!hardening) return null;
        const stripped = classifyFold(fold(name.replace(/\p{Default_Ignorable_Code_Point}/gu, '')));
        return stripped ? { class: stripped, layer: 'default-ignorable' } : null;
    };
    const classifyPath = (segments) => {
        for (let index = 0; index < segments.length; index += 1) {
            const got = classify(segments[index]);
            if (got) return { index, ...got };
        }
        return null;
    };
    return { classify, classifyPath };
}

const withoutRoboteam = new Map([['.ploinky', 'controller_state'], ['.data', 'agent_data'], ['.ploinky-box', 'host_state'],
    ['.env', 'key_material'], ['master-key', 'key_material']]);

// Ploinky's matcher semantics inside a grant: the index-0 `.ploinky/repos` exemption (R4-4 item 3).
function ploinkyExemptionPath(segments) {
    for (let index = 0; index < segments.length; index += 1) {
        const got = makeImplementation().classify(segments[index]);
        if (got && got.class === 'controller_state' && index === 0 && segments[1] === 'repos') continue;
        if (got) return { index, ...got };
    }
    return null;
}

const WEAKENINGS = [
    { name: 'no trailing dot and space strip', impl: makeImplementation({ fold: (n) => n.normalize('NFKC').toLowerCase() }), mustCatch: ['n05', 'n09', 'n11', 'n29'] },
    { name: 'no NFKC', impl: makeImplementation({ fold: (n) => n.toLowerCase().replace(/[. ]+$/, '') }), mustCatch: ['n13', 'n25', 'n28', 'n35'] },
    { name: 'no lowercasing', impl: makeImplementation({ fold: (n) => n.normalize('NFKC').replace(/[. ]+$/, '') }), mustCatch: ['n02', 'n27', 'n31'] },
    { name: 'only strip trailing dots, not spaces', impl: makeImplementation({ fold: (n) => n.normalize('NFKC').toLowerCase().replace(/\.+$/, '') }), mustCatch: ['n06', 'n10', 'n24', 'n34'] },
    { name: 'no .roboteam', impl: makeImplementation({ exact: withoutRoboteam }), mustCatch: ['n18', 'n19', 'n20', 't06'] },
    { name: 'secrets suffix must be the whole name', impl: makeImplementation({ suffix: (k) => k === '.secrets' }), mustCatch: ['n30', 'n31', 'n33'] },
    { name: 'secrets matched anywhere in the name', impl: makeImplementation({ suffix: (k) => k.includes('.secrets') }), mustCatch: ['p19'] },
    { name: 'prefix match instead of exact name', impl: makeImplementation({ prefixMatch: true }), mustCatch: ['p20', 'p22', 'p24', 'p09'] },
    { name: 'no default-ignorable hardening', impl: makeImplementation({ hardening: false }), mustCatch: ['n36', 'n37', 'n39', 'n42', 'n44'] },
    { name: 'Ploinky repos exemption inside a grant', impl: { classify: real.classify, classifyPath: ploinkyExemptionPath }, mustCatch: ['t03'] }
];

test('the real predicate passes every shared name and path vector', () => {
    assert.deepEqual(runNameVectors(vectors, real), []);
    assert.ok(vectors.names.some((entry) => entry.protected) && vectors.names.some((entry) => !entry.protected), 'vectors need both classes');
});

test('the vectors contain positive controls of ordinary names and cover every class and both layers', () => {
    const protectedEntries = vectors.names.filter((entry) => entry.protected);
    assert.deepEqual([...new Set(protectedEntries.map((entry) => entry.class))].sort(), Object.values(NAME_CLASSES).sort());
    assert.deepEqual([...new Set(protectedEntries.map((entry) => entry.layer))].sort(), ['default-ignorable', 'ploinky-fold']);
    assert.ok(vectors.names.filter((entry) => !entry.protected).length >= 25);
    const ids = [...vectors.names, ...vectors.paths].map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'vector ids are unique');
});

for (const weakening of WEAKENINGS) {
    test(`negative control: the vectors catch a predicate with ${weakening.name}`, () => {
        const failures = runNameVectors(vectors, weakening.impl);
        for (const id of weakening.mustCatch) assert.ok(failures.includes(id), `${id} must fail for the weakened predicate (got ${failures.join(',')})`);
    });
}

test('negative control harness: an unweakened rebuild of the predicate passes, so the controls above are not vacuous', () => {
    assert.deepEqual(runNameVectors(vectors, makeImplementation()), []);
});

test('the fold is identical to the text of Ploinky foldPathName', () => {
    const source = functionSource(ploinkyText('ploinky-box/hostState/paths.mjs'), 'foldPathName');
    assert.equal(normalizeSource(source), normalizeSource(functionSource(`${foldPathName}`, 'foldPathName')));
});

test('the reference copy of the Ploinky matcher equals the live file text', () => {
    const live = functionSource(ploinkyText('cli/server/utils/protectedWorkspacePaths.js'), 'isProtectedWorkspaceSegments');
    // The live function carries comments; normalizeSource drops them.
    assert.equal(normalizeSource(live), normalizeSource(PLOINKY_MATCHER_REFERENCE));
});

test('the predicate agrees with the Ploinky matcher except where this predicate deliberately differs', () => {
    for (const entry of vectors.names) {
        const ploinkyVerdict = ploinkyMatcher([entry.name]);
        if (entry.class === 'private_session') {
            assert.equal(ploinkyVerdict, false, `${entry.id}: Ploinky does not know .roboteam`);
        } else if (entry.layer === 'default-ignorable') {
            assert.equal(ploinkyVerdict, false, `${entry.id}: Ploinky does not strip default-ignorable code points`);
        } else {
            assert.equal(ploinkyVerdict, entry.protected, entry.id);
        }
    }
    assert.equal(ploinkyMatcher(['.ploinky', 'repos', 'x']), false, 'Ploinky exempts index 0 .ploinky/repos');
    assert.equal(isProtectedPath(['.ploinky', 'repos', 'x']), true, 'inside a grant there is no exemption');
});

test('every component is checked, wherever it sits', () => {
    assert.equal(firstProtectedComponent(['a', 'b', '.Env.']).index, 2);
    assert.equal(firstProtectedComponent(['.ploinky', 'repos']).index, 0);
    assert.equal(firstProtectedComponent([]), null);
});

test('hardening can be switched off and then equals the Ploinky-fold layer only', () => {
    assert.equal(classifyGrantName('.e‌nv', { hardening: false }), null);
    assert.equal(classifyGrantName('.e‌nv').layer, 'default-ignorable');
    assert.equal(classifyGrantName('.ENV', { hardening: false }).layer, 'ploinky-fold');
});

test('the hardening fold reaches a fixed point and survives NFKC producing an ignorable code point', () => {
    for (const entry of vectors.names) {
        const once = foldIgnorableStripped(entry.name);
        assert.equal(foldIgnorableStripped(once), once, entry.id);
    }
    assert.equal(classifyGrantName('ﾠ.env').class, 'key_material');
});

test('component validity: only a single plain component is a name', () => {
    for (const valid of ['a', '.hidden', 'x'.repeat(255), '日本']) assert.equal(isValidComponentName(valid), true, valid);
    for (const invalid of ['', '.', '..', 'a/b', '/a', 'a\0b', 'x'.repeat(256), '日'.repeat(86), 7, null, undefined]) {
        assert.equal(isValidComponentName(invalid), false, String(invalid));
    }
    assert.equal(isValidComponentName('abc', 2), false);
});

test('a non-string name is a programming error, not an ordinary name', () => {
    assert.throws(() => isProtectedName(7), TypeError);
    assert.throws(() => classifyGrantName(null), TypeError);
});

test('the Unicode and ICU versions of the run are available, and the vector file records the versions it was generated against', () => {
    const environment = foldEnvironment();
    assert.match(environment.unicode, /^\d+\.\d+/);
    assert.match(environment.icu, /^\d+/);
    assert.match(vectors.fold.unicodeVersionAtGeneration, /^\d+\.\d+$/);
    assert.match(vectors.fold.icuVersionAtGeneration, /^\d+\.\d+$/);
    // The hard check is that every vector passes on the running Node (first test). Pinning the Rust crate's Unicode
    // version against the image's Node ICU is deferred: the image runs another Node than this host.
});
