// G1 fixture agent: keeps the container alive and answers readiness, as tests/p0/fixture/p0probe/server.mjs does.
// The harness runs as a separate process through an operator exec into this container; probes never kill this
// process (the Box Watchdog can take about 430 s to notice a crashed agent container).
import http from 'node:http';

http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('g1probe\n');
}).listen(7000, '0.0.0.0');
