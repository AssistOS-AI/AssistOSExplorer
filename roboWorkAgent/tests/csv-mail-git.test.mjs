import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createCsvMailGitServer } from '../server/csv-mail-git.mjs';

test('CSV Mail uses the current default robot credential only on the fixed GitHub repository', async t => {
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(body) });
        res.writeHead(req.headers.authorization ? 200 : 401).end();
    }).listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    let credential = { username: 'robot', token: 'fixture-token' };
    const broker = createCsvMailGitServer({
        readCredential: async () => credential,
        request(options, callback) {
            assert.equal(options.hostname, 'github.com');
            return http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, callback);
        },
    }).listen(0, '127.0.0.1');
    await once(broker, 'listening');
    t.after(() => { broker.close(); upstream.close(); });
    const root = `http://127.0.0.1:${broker.address().port}`;
    const advertisement = '/info/refs?service=git-upload-pack';
    assert.equal((await fetch(root + '/Another/repository.git' + advertisement)).status, 404);
    assert.equal((await fetch(root + '/credential')).status, 404);
    assert.equal((await fetch(root + advertisement)).status, 200);
    const pack = Buffer.from([0, 255, 42]);
    assert.equal((await fetch(root + '/git-receive-pack', {
        method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request' }, body: pack,
    })).status, 200);
    credential = null;
    assert.equal((await fetch(root + advertisement)).status, 503);
    assert.deepEqual(requests, [
        { method: 'GET', url: '/Axiologic/simpleCSVMailSend.git' + advertisement, auth: 'Basic ' + Buffer.from('robot:fixture-token').toString('base64'), body: Buffer.alloc(0) },
        { method: 'POST', url: '/Axiologic/simpleCSVMailSend.git/git-receive-pack', auth: 'Basic ' + Buffer.from('robot:fixture-token').toString('base64'), body: pack },
    ]);
});
