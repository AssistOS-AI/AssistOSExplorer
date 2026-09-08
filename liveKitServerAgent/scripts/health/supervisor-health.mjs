import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const socketPath = process.env.SUPERVISOR_SOCKET || '/run/ploinky/livekit-supervisor.sock';
const supervisedPids = String(process.env.SUPERVISED_PIDS || '')
  .split(',')
  .filter(Boolean)
  .map((value) => Number.parseInt(value, 10));

function processState() {
  return supervisedPids.map((pid) => {
    try {
      process.kill(pid, 0);
      return { pid, running: true };
    } catch {
      return { pid, running: false };
    }
  });
}

function allRunning() {
  return supervisedPids.length === 4 && processState().every((entry) => entry.running);
}

const readinessServer = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/ready') {
    response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('not found\n');
    return;
  }
  const ready = allRunning();
  response.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.end(ready ? 'ok\n' : 'not ready\n');
});
readinessServer.listen(17000, '127.0.0.1');

try {
  fs.unlinkSync(socketPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const detailServer = net.createServer((socket) => {
  const detail = {
    ready: allRunning(),
    processes: processState(),
    checkedAt: new Date().toISOString(),
  };
  socket.end(`${JSON.stringify(detail)}\n`);
});
detailServer.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));

function shutdown() {
  readinessServer.close();
  detailServer.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
