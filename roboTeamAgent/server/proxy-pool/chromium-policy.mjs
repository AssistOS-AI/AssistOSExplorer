import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Port of the robot's relay inside its container; pasta forwards it to the relay's loopback port.
export const CONTAINER_PROXY_PORT = 3128;
// Both GUI images ship Debian-packaged Chromium, which reads managed policies from this directory.
// A managed policy applies however Chromium is launched (the browser image's own start, the
// desktop's launcher, a user starting it again) and cannot be changed from the browser.
export const CHROMIUM_POLICY_TARGET = '/etc/chromium/policies/managed/roboteam-proxy.json';

export const CHROMIUM_PROXY_POLICY = Object.freeze({
    ProxySettings: { ProxyMode: 'fixed_servers', ProxyServer: `http://127.0.0.1:${CONTAINER_PROXY_PORT}` },
    // WebRTC would otherwise reveal the host's own address over direct UDP.
    WebRtcIPHandling: 'disable_non_proxied_udp',
});

export async function writeChromiumProxyPolicy(directory) {
    const file = path.join(directory, 'chromium-proxy-policy.json');
    const content = `${JSON.stringify(CHROMIUM_PROXY_POLICY, null, 2)}\n`;
    const current = await fs.readFile(file, 'utf8').catch(() => null);
    if (current === content) return file;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(staging, content, { mode: 0o644 });
    await fs.rename(staging, file);
    return file;
}
