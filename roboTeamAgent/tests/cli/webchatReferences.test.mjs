import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    normalizeWebchatMessage,
    normalizeWebchatReferences
} from '../achilles-cli/src/lib/webchatEnvelope.mjs';
import {
    materializeWebchatAttachments,
    materializeWebchatContext,
    materializeWorkspaceReferences
} from '../achilles-cli/src/lib/webchatResources.mjs';

function makeWorkingDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `achilles-references-${prefix}-`));
}

describe('webchat references', () => {
    it('normalizes envelope references and drops unsafe entries', () => {
        const message = normalizeWebchatMessage(JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: 'inspect',
            attachments: [],
            references: [
                { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                { kind: 'workspace-path', path: '../escape' },
                { kind: 'workspace-path', path: '/etc/passwd' },
                { kind: 'workspace-path', path: 'docs/.secrets' },
                { kind: 'workspace-path', path: 'with\0nul' },
                { kind: 'unknown-kind', path: 'notes.md' }
            ],
            invocation: { token: 'caller-token' }
        }));
        assert.equal(message.references.length, 1);
        assert.equal(message.references[0].path, 'notes.md');
        assert.match(message.text, /Referenced workspace paths:/);
    });

    it('normalizeWebchatReferences accepts only workspace-path entries with safe paths', () => {
        const cleaned = normalizeWebchatReferences([
            { kind: 'workspace-path', path: 'src/index.mjs', type: 'file' },
            { kind: 'workspace-path', path: 'src/index.mjs', type: 'file' },
            { kind: 'workspace-path', path: '' },
            { kind: '', path: 'ignored.md' }
        ]);
        assert.equal(cleaned.length, 1);
        assert.equal(cleaned[0].path, 'src/index.mjs');
    });

    it('materializeWorkspaceReferences emits resources for files and warnings for rejects', () => {
        const root = makeWorkingDir('materialize');
        try {
            fs.writeFileSync(path.join(root, 'notes.md'), 'hello world');
            fs.mkdirSync(path.join(root, 'logs'));
            const { resources, paths, warnings } = materializeWorkspaceReferences([
                { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                { kind: 'workspace-path', path: 'logs', type: 'directory' },
                { kind: 'workspace-path', path: 'missing.txt', label: 'Missing' },
                { kind: 'workspace-path', path: '../outside.txt' }
            ], { workingDir: root });
            assert.equal(resources.length, 1);
            assert.equal(resources[0].content, 'hello world');
            assert.equal(resources[0].workspacePath, 'notes.md');
            assert.equal(paths.length, 1);
            assert.equal(paths[0].path, 'logs');
            assert.equal(paths[0].type, 'directory');
            assert.ok(warnings.some((entry) => entry.includes('Missing') && entry.includes('no longer available')));
            assert.ok(warnings.some((entry) => entry.includes('../outside.txt') && entry.includes('not a safe')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materializeWebchatAttachments accepts cwd-relative WebChat session uploads', () => {
        const root = makeWorkingDir('upload-attachment');
        try {
            const uploadDir = path.join(root, 'uploads', 'sessionA');
            fs.mkdirSync(uploadDir, { recursive: true });
            fs.writeFileSync(path.join(uploadDir, 'notes.md'), 'uploaded note');
            const { resources, paths, warnings } = materializeWebchatAttachments([
                {
                    filename: 'notes.md',
                    mime: 'text/markdown',
                    localPath: 'uploads/sessionA/notes.md',
                    downloadUrl: '/webchat/uploads?path=notes.md'
                }
            ], { workingDir: root, sharedRoot: path.join(root, 'shared') });
            assert.deepEqual(warnings, []);
            assert.equal(resources.length, 1);
            assert.equal(resources[0].name, 'notes.md');
            assert.equal(resources[0].mime, 'text/markdown');
            assert.equal(resources[0].content, 'uploaded note');
            assert.equal(resources[0].localPath, 'uploads/sessionA/notes.md');
            assert.deepEqual(paths, []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materializeWebchatAttachments accepts direct files under the active working directory', () => {
        const root = makeWorkingDir('direct-attachment');
        try {
            fs.mkdirSync(path.join(root, 'documents'), { recursive: true });
            fs.writeFileSync(path.join(root, 'documents', 'report.md'), 'direct upload');
            const { resources, paths, warnings } = materializeWebchatAttachments([
                {
                    filename: 'report.md',
                    mime: 'text/markdown',
                    localPath: 'documents/report.md',
                    downloadUrl: '/workspace-files/project/documents/report.md'
                }
            ], { workingDir: root, sharedRoot: path.join(root, 'shared') });
            assert.deepEqual(warnings, []);
            assert.equal(resources.length, 1);
            assert.equal(resources[0].content, 'direct upload');
            assert.equal(resources[0].localPath, 'documents/report.md');
            assert.deepEqual(paths, []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materializeWebchatAttachments keeps large direct uploads available by path', () => {
        const root = makeWorkingDir('large-direct-attachment');
        try {
            fs.mkdirSync(path.join(root, 'datasets'), { recursive: true });
            fs.writeFileSync(path.join(root, 'datasets', 'large.bin'), Buffer.alloc((128 * 1024) + 1));
            const { resources, paths, warnings } = materializeWebchatAttachments([
                {
                    filename: 'large.bin',
                    mime: 'application/octet-stream',
                    localPath: 'datasets/large.bin'
                }
            ], { workingDir: root, sharedRoot: path.join(root, 'shared') });
            assert.equal(resources.length, 0);
            assert.deepEqual(paths, [{
                path: 'datasets/large.bin',
                type: 'file',
                label: 'large.bin'
            }]);
            assert.ok(warnings.some((entry) => entry.includes('inline limit') && entry.includes('datasets/large.bin')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materializeWebchatAttachments rejects unsafe direct workspace paths', () => {
        const root = makeWorkingDir('unsafe-direct-attachment');
        try {
            fs.writeFileSync(path.join(root, 'visible.txt'), 'visible');
            const { resources, paths, warnings } = materializeWebchatAttachments([
                { filename: 'absolute.txt', mime: 'text/plain', localPath: '/etc/passwd' },
                { filename: 'traversal.txt', mime: 'text/plain', localPath: '../visible.txt' },
                { filename: 'secret.txt', mime: 'text/plain', localPath: 'private/app.secrets' },
                { filename: 'nested-secret.txt', mime: 'text/plain', localPath: 'private/app.secrets/token.txt' }
            ], { workingDir: root, sharedRoot: path.join(root, 'shared') });
            assert.equal(resources.length, 0);
            assert.deepEqual(paths, []);
            assert.equal(warnings.length, 4);
            assert.ok(warnings.every((entry) => entry.includes('not a safe file')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materializeWebchatAttachments rejects upload symlink escapes', () => {
        const root = makeWorkingDir('upload-escape');
        const outside = makeWorkingDir('upload-outside');
        try {
            const uploadDir = path.join(root, 'uploads', 'sessionA');
            fs.mkdirSync(uploadDir, { recursive: true });
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
            try {
                fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(uploadDir, 'leak.txt'));
            } catch (error) {
                if (error.code === 'EPERM' || error.code === 'EACCES') return;
                throw error;
            }
            const { resources, warnings } = materializeWebchatAttachments([
                {
                    filename: 'leak.txt',
                    mime: 'text/plain',
                    localPath: 'uploads/sessionA/leak.txt'
                }
            ], { workingDir: root, sharedRoot: path.join(root, 'shared') });
            assert.equal(resources.length, 0);
            assert.ok(warnings.some((entry) => entry.includes('leak.txt') && entry.includes('not a safe file')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('materializeWebchatContext combines attachments, references, paths, and warnings', () => {
        const root = makeWorkingDir('context');
        try {
            fs.writeFileSync(path.join(root, 'notes.md'), 'reference body');
            fs.mkdirSync(path.join(root, 'uploads', 'sessionA'), { recursive: true });
            fs.writeFileSync(path.join(root, 'uploads', 'sessionA', 'attachment.txt'), 'attachment body');
            fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
            const result = materializeWebchatContext({
                attachments: [
                    {
                        filename: 'attachment.txt',
                        mime: 'text/plain',
                        localPath: 'uploads/sessionA/attachment.txt'
                    }
                ],
                references: [
                    { kind: 'workspace-path', path: 'notes.md', type: 'file', label: 'Notes' },
                    { kind: 'workspace-path', path: 'docs', type: 'directory', label: 'Docs' },
                    { kind: 'workspace-path', path: '../outside' }
                ],
            }, { workingDir: root });
            assert.equal(result.resources.length, 2);
            assert.equal(result.resources[0].localPath, 'uploads/sessionA/attachment.txt');
            assert.equal(result.resources[1].workspacePath, 'notes.md');
            assert.deepEqual(result.paths, [{ path: 'docs', type: 'directory', label: 'Docs' }]);
            assert.ok(result.warnings.some((entry) => entry.includes('../outside') && entry.includes('not a safe')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
