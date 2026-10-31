import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isGrantableFolder } from '../copilot/src/lib/execution/grantablePaths.mjs';

const ROOT = path.join(path.sep, 'ws');
const at = (...parts) => path.join(ROOT, ...parts);

test('a managed repository root is not grantable; a folder below it is (B1(b))', () => {
    assert.equal(isGrantableFolder(ROOT, at('.ploinky')), false);
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'repos')), false);
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'repos', 'R')), false);
    assert.equal(isGrantableFolder(ROOT, at('.PLOINKY', 'repos', 'R')), false);
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'repos', 'R', 'x')), true);
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'repos', 'R', 'x', 'y')), true);
});

test('protected components below a repository, other .ploinky areas, the root and plain folders keep their answers', () => {
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'repos', 'R', '.data')), false);
    assert.equal(isGrantableFolder(ROOT, at('.ploinky', 'run', 'x', 'y')), false);
    assert.equal(isGrantableFolder(ROOT, ROOT), false);
    assert.equal(isGrantableFolder(ROOT, at('proj', '.roboteam')), false);
    assert.equal(isGrantableFolder(ROOT, at('proj', 'sub')), true);
});
