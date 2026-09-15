import net from 'node:net';
import tls from 'node:tls';

export function editorUrl(base, path) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, '');
  const suffix = new URL(String(path || '/'), 'http://probe.invalid');
  url.pathname = `${prefix}${suffix.pathname}`;
  url.search = suffix.search;
  url.hash = '';
  return url.toString();
}

export async function probeUpgrade(baseUrl, path, { timeoutMs = 5000 } = {}) {
  const url = new URL(editorUrl(baseUrl, path));
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = url.protocol === 'https:'
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port });
    let data = '';
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(status);
    };
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for editor WebSocket upgrade.')), timeoutMs);
    socket.on(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        `Origin: ${url.origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n')) {
        finish(null, Number(data.match(/^HTTP\/1\.[01]\s+(\d+)/)?.[1] || 0));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Editor connection closed before an HTTP upgrade response.')));
  });
}
