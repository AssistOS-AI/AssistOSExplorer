import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const explorerRoot = path.resolve(import.meta.dirname, '..', '..');

// Static imports and re-exports of a module. Dynamic import() calls are not part of the graph.
function staticSpecifiers(source) {
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const patterns = [
        /(?:^|[\n;])\s*import\s*(?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)?\s*from\s*(['"])([^'"\n]+)\1/g,
        /(?:^|[\n;])\s*import\s*(['"])([^'"\n]+)\1/g,
        /(?:^|[\n;])\s*export\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*(['"])([^'"\n]+)\1/g
    ];
    return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2]));
}

function computeStaticGraph(entryFile) {
    const modules = new Set();
    const routerServed = new Set();
    const queue = [entryFile];
    while (queue.length) {
        const file = queue.shift();
        if (modules.has(file)) continue;
        modules.add(file);
        for (const specifier of staticSpecifiers(fs.readFileSync(file, 'utf8'))) {
            if (!specifier.startsWith('.')) {
                routerServed.add(specifier);
                continue;
            }
            queue.push(path.resolve(path.dirname(file), specifier));
        }
    }
    return { modules, routerServed };
}

test('the import scanner follows static imports and re-exports but not dynamic imports', () => {
    const source = [
        "import a from './a.js';",
        "import { b,",
        "    c } from \"./b.js\";",
        "import * as d from './d.js';",
        "import './side-effect.js';",
        "export { e } from './e.js';",
        "export * from './f.js';",
        "// import hidden from './comment.js';",
        "/* import hidden2 from './block.js'; */",
        "const lazy = () => import('./lazy.js');",
        "const text = 'import x from \"./string.js\"';"
    ].join('\n');
    assert.deepEqual(
        staticSpecifiers(source).sort(),
        ['./a.js', './b.js', './d.js', './e.js', './f.js', './side-effect.js']
    );
});

test('T7: index.html preloads exactly the static import graph of main.js', () => {
    const html = fs.readFileSync(path.join(explorerRoot, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"\s*>/g)].map((match) => match[1]);
    assert.equal(new Set(hrefs).size, hrefs.length, 'no module is preloaded twice');

    const mainFile = path.join(explorerRoot, 'main.js');
    const { modules, routerServed } = computeStaticGraph(mainFile);
    modules.delete(mainFile);
    assert.deepEqual([...routerServed], ['/MCPBrowserClient.js'], 'the only non-relative import is the Router-served client');

    const expected = [...modules].map((file) => path.relative(explorerRoot, file).split(path.sep).join('/')).sort();
    assert.ok(expected.length > 30, `the scan found the main.js graph (${expected.length} modules)`);
    assert.deepEqual([...hrefs].sort(), expected);
    for (const href of hrefs) {
        assert.ok(fs.existsSync(path.join(explorerRoot, href)), `${href} exists`);
    }
});

test('T7: the file browser module graph is not preloaded for every visitor', () => {
    const html = fs.readFileSync(path.join(explorerRoot, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /modulepreload"\s+href="web-components\//);
    assert.doesNotMatch(html, /modulepreload"\s+href="main\.js"/);
});
