import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { importEmailRobots } from '../server/robot-import.mjs';
import { normalizeEmailAddress, robotEmailAddress } from '../server/robot-email.mjs';
import { importReport, parseEmailCsv } from '../public/robot-import.js';

async function withStore(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-robot-import-'));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    t.after(async () => {
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    return { robotStore, workspaceRoot };
}

test('the CSV import keeps only the email column and never sends other columns', () => {
    assert.deepEqual(parseEmailCsv('﻿Name;E-mail;Password\nAna;"ana@example.com";secret\nBob;bob@example.com;hunter2\n'), ['ana@example.com', 'bob@example.com']);
    assert.deepEqual(parseEmailCsv('ana@example.com\nana@example.com\n\nbob@example.com'), ['ana@example.com', 'bob@example.com']);
    assert.deepEqual(parseEmailCsv(''), []);
    assert.equal(importReport({ created: [{}, {}], existing: 1, invalid: ['bad'] }), '2 robots created · 1 already exists · 1 invalid: bad');
    assert.equal(importReport({ created: [{}], existing: 0, invalid: [] }), '1 robot created');
});

test('a robot is named by an email address only when its whole name is a plain address', () => {
    assert.equal(robotEmailAddress({ name: 'ana@example.com' }), 'ana@example.com');
    assert.equal(robotEmailAddress({ name: 'Ana' }), null);
    assert.equal(normalizeEmailAddress(' ana@example.com '), 'ana@example.com');
    assert.equal(normalizeEmailAddress('Ana <ana@example.com>'), null);
    assert.equal(normalizeEmailAddress(`${'a'.repeat(70)}@example.com`), null, 'robot names hold at most 80 characters');
});

test('importing creates one robot per new address, named exactly by it, and skips the rest', async (t) => {
    const { robotStore } = await withStore(t);
    await robotStore.create({ name: 'Bob@Example.com' });
    const result = await importEmailRobots(robotStore, ['ana@example.com', 'bob@example.com', 'ANA@example.com', 'not an email']);
    assert.deepEqual(result.created.map(robot => robot.name), ['ana@example.com']);
    assert.equal(result.existing, 2, 'an address that already names a robot, in any case, is not imported again');
    assert.deepEqual(result.invalid, ['not an email']);
    assert.ok((await robotStore.list()).some(robot => robot.name === 'ana@example.com'));
    await assert.rejects(importEmailRobots(robotStore, []), error => error.statusCode === 400);
    await assert.rejects(importEmailRobots(robotStore, Array.from({ length: 201 }, (_, i) => `r${i}@example.com`)), error => error.statusCode === 400);
});

test('only administrators import robots from emails', async (t) => {
    const { robotStore, workspaceRoot } = await withStore(t);
    const prepared = [];
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false,
        prepareOpenCode: async (id) => { prepared.push(id); } };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const call = (roles, body) => fetch(`http://127.0.0.1:${server.address().port}/api/robots/import-emails`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'actor', 'x-roboteam-user-roles': JSON.stringify(roles) },
        body: JSON.stringify(body),
    });
    assert.equal((await call(['user'], { addresses: ['ana@example.com'] })).status, 403);
    const answer = await (await call(['admin'], { addresses: ['ana@example.com', 'bad'] })).json();
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.created.map(robot => robot.name), ['ana@example.com']);
    assert.deepEqual(answer.invalid, ['bad']);
    assert.deepEqual(prepared, [answer.created[0].id]);
    assert.equal((await call(['admin'], { addresses: 'ana@example.com' })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/email-pool`, {
        headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'actor', 'x-roboteam-user-roles': '["admin"]' } })).status, 404);
});
