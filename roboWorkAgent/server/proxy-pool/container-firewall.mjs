import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NSENTER_COMMAND = '/usr/bin/nsenter';
export const NFT_COMMAND = '/usr/bin/nft';

// Loaded into a proxied Browser container's network namespace before the container starts. Its
// only way out is loopback, where port 3128 reaches the robot's relay; DNS, UDP and direct TCP are
// dropped, so nothing in the container reaches the internet on the host's own address. Inbound,
// only the session UI (3000) and the MCP endpoint (8100) are reachable. The container has no
// CAP_NET_ADMIN, so not even its root user can change these rules.
export const CONTAINER_FIREWALL_RULES = `table inet roboteam {
    chain output {
        type filter hook output priority 0; policy drop;
        oif "lo" accept
        ct state established,related accept
    }
    chain input {
        type filter hook input priority 0; policy drop;
        iif "lo" accept
        ct state established,related accept
        tcp dport { 3000, 8100 } accept
    }
}
`;

export async function writeContainerFirewallRules(directory) {
    const file = path.join(directory, 'container-firewall.nft');
    const current = await fs.readFile(file, 'utf8').catch(() => null);
    if (current === CONTAINER_FIREWALL_RULES) return file;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(staging, CONTAINER_FIREWALL_RULES, { mode: 0o644 });
    await fs.rename(staging, file);
    return file;
}
