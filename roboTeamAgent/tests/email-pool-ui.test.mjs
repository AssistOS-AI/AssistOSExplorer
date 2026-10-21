import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { emailPoolSummary, importReport, parseEmailCsv } from '../public/email-pool.js';

test('reads only the email column of a CSV export', () => {
    assert.deepEqual(parseEmailCsv('﻿Email,Password,Recovery\r\n"a@example.com",secret,code1\nb@example.com,other,code2\n'),
        ['a@example.com', 'b@example.com']);
    assert.deepEqual(parseEmailCsv('name;e-mail\nOne;one@example.com\nTwo;two@example.com'), ['one@example.com', 'two@example.com']);
    assert.deepEqual(parseEmailCsv('x@example.com,pass\ny@example.com,pass'), ['x@example.com', 'y@example.com']);
    assert.deepEqual(parseEmailCsv('one@example.com\n\n two@example.com \none@example.com'), ['one@example.com', 'two@example.com']);
    assert.deepEqual(parseEmailCsv(''), []);
});

test('summarizes the pool and an import', () => {
    assert.equal(emailPoolSummary({ emails: [{}, {}], freeCount: 1 }), '2 emails · 1 free');
    assert.equal(emailPoolSummary({ emails: [{}], freeCount: 0 }), '1 email · 0 free');
    assert.equal(importReport({ added: 3, duplicates: 1, invalid: ['bad'] }), '3 added · 1 already present · 1 invalid: bad');
});

test('the Emails tab is served and wired into the dashboard', async () => {
    const [app, server] = await Promise.all([
        readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
        readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(app, /emailPool\.setContext\(canCreateRobots\)/);
    assert.match(app, /emails: 'emailsTab'/);
    assert.match(server, /pathname === '\/email-pool\.js'/);
});
