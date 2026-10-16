import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The soul-gateway folder; the inventory covers this agent only. The former repository's deployment
// workflows and root scripts are not part of it.
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const EXECUTABLE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'docs', 'node_modules']);
const SIGNALS = Object.freeze({
    'direct-router-env': /\bPLOINKY_ROUTER_(?:URL|HOST|PORT|AUTHORITY|REQUEST_AUTHORITY|DESCRIPTOR_FILE)\b/,
    'generated-router-key': /\bPLOINKY_AGENT_API_KEY\b/,
    'generated-source-marker': /\bPLOINKY_ENV_SOURCE_[A-Z0-9_]+\b/,
    'legacy-soul-api-key': /\bSOUL_API_KEY\b/,
    'legacy-identity-header': /\bx-soul-agent\b/i,
    'verified-router-descriptor': /\bloadVerifiedPloinkyRouterDescriptor\b/,
});

const DISPOSITIONS = Object.freeze({
    'deploy.sh': {
        signals: ['direct-router-env'],
        disposition: 'Host-side operator health URL only; it sends no generated credential.',
    },
    'src/config/env.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Runtime configuration receiver; it does not attach the generated key to an outbound request.',
    },
    'src/ploinky/discovery-client.mjs': {
        signals: ['direct-router-env', 'verified-router-descriptor'],
        disposition: 'Authenticated discovery validates the mounted signed descriptor before secret, signing, and socket.',
    },
    'src/ploinky/reconcile-agents.mjs': {
        signals: ['direct-router-env'],
        disposition: 'Persists the runtime physical origin for provider compatibility; outbound code re-verifies it.',
    },
    'src/ploinky/router-descriptor.mjs': {
        signals: ['verified-router-descriptor'],
        disposition: 'Loads only the verifier from the mounted Ploinky Agent runtime.',
    },
    'src/request/identity.mjs': {
        signals: ['legacy-identity-header'],
        disposition: 'Legacy parser is unreachable after authentication middleware rejects the header.',
    },
    'src/runtime/backends/builtin/ploinky-agent-openai.backend.mjs': {
        signals: ['direct-router-env', 'verified-router-descriptor'],
        disposition: 'Models/chat transport validates the signed descriptor and uses its physical origin plus request Host.',
    },
    'src/runtime/route/authenticate.mjs': {
        signals: ['legacy-identity-header'],
        disposition: 'Explicit deny-list rejects the legacy header with HTTP 400 before authentication.',
    },
    'src/test/unit/bootstrap-auth.test.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Startup fixture proves generated runtime configuration is accepted only with provenance.',
    },
    'src/test/unit/upstream-failover.test.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Startup fixture boots the gateway with generated runtime configuration and provenance; the key is only a test signer.',
    },
    'src/test/unit/free-defaults-offline-boot.test.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Offline startup fixture boots the gateway with generated runtime configuration and provenance; the key is only a test signer.',
    },
    'src/test/fixtures/fresh-gateway-boot.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Shared startup fixture builds generated runtime configuration with provenance for isolated test gateways; the key is only a test signer.',
    },
    'src/test/unit/free-defaults-enable-later.test.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Offline two-boot fixture boots the gateway with generated runtime configuration and provenance; the key is only a test signer.',
    },
    'src/test/unit/config.test.mjs': {
        signals: ['direct-router-env', 'generated-router-key', 'generated-source-marker'],
        disposition: 'Configuration receiver fixture covers present and missing generated runtime fields.',
    },
    'src/test/unit/dashboard-app.test.mjs': {
        signals: ['generated-router-key'],
        disposition: 'Negative assertion proves client export never names the managed generated key.',
    },
    'src/test/unit/discovery-client.test.mjs': {
        signals: ['direct-router-env'],
        disposition: 'Loopback capture fixtures verify split physical connection and exact request Host.',
    },
    'src/test/unit/embedded-auth.test.mjs': {
        signals: ['generated-router-key'],
        disposition: 'Negative authentication fixture proves the managed key is not accepted publicly.',
    },
    'src/test/unit/legacy-identity-headers.test.mjs': {
        signals: ['legacy-identity-header'],
        disposition: 'Negative suite proves every legacy identity header is rejected before authentication.',
    },
    'src/test/unit/management.test.mjs': {
        signals: ['generated-router-key'],
        disposition: 'Management fixture proves the managed key cannot authorize external management calls.',
    },
    'src/test/unit/ploinky-agent-backend.test.mjs': {
        signals: ['direct-router-env', 'legacy-identity-header'],
        disposition: 'Capture fixtures prove exact request Host and absence of every legacy identity header.',
    },
    'src/test/unit/ploinky-manifest.test.mjs': {
        signals: ['generated-router-key'],
        disposition: 'Negative manifest assertions forbid workspace declaration or aliasing of the managed key.',
    },
    'src/test/unit/reconcile-agents.test.mjs': {
        signals: ['direct-router-env'],
        disposition: 'Provider persistence fixtures cover the runtime physical origin compatibility field.',
    },
    'src/test/unit/request-helpers.test.mjs': {
        signals: ['legacy-identity-header'],
        disposition: 'Legacy parser compatibility fixture remains downstream of the rejecting middleware.',
    },
    'src/test/unit/route-chain.test.mjs': {
        signals: ['legacy-identity-header'],
        disposition: 'Negative route-chain fixture proves the legacy identity header receives HTTP 400.',
    },
});

function executableFiles(directory, relative = '') {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const childRelative = path.posix.join(relative, entry.name);
        if (childRelative === 'src/test/unit/generated-key-consumer-safety.test.mjs') continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...executableFiles(absolute, childRelative));
        else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name))) files.push(childRelative);
    }
    return files;
}

test('every executable generated-key, Router, and legacy consumer has one explicit disposition', () => {
    const observed = {};
    for (const relative of executableFiles(REPOSITORY_ROOT)) {
        const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
        const signals = Object.entries(SIGNALS)
            .filter(([, pattern]) => pattern.test(source))
            .map(([name]) => name)
            .sort();
        if (signals.length) observed[relative] = signals;
    }
    assert.deepEqual(
        observed,
        Object.fromEntries(Object.entries(DISPOSITIONS).map(([relative, disposition]) => [
            relative,
            [...disposition.signals].sort(),
        ])),
    );
    for (const disposition of Object.values(DISPOSITIONS)) {
        assert.ok(disposition.disposition.length > 20);
    }
});

test('runnable API consumers use the dedicated external key and no legacy identity header', () => {
    for (const relative of [
        // list-models.mjs and test-search-tier.mjs stayed in the proxies repository.
        'test-nvidia.mjs',
        'test-nvidia-all-models.mjs',
        'src/test/integration/gateway.test.mjs',
    ]) {
        const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
        assert.match(source, /SOUL_GATEWAY_API_KEY/, relative);
        assert.doesNotMatch(source, /\bSOUL_API_KEY\b|\bx-soul-agent\b/i, relative);
    }
});
