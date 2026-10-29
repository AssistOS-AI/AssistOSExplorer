// P0 fixture agent: keeps the container alive and answers readiness. The probes
// run through an operator exec into this container; this server holds no state.
import http from 'node:http';

http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('p0probe\n');
}).listen(7000, '0.0.0.0');
