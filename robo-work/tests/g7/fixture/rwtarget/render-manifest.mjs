#!/usr/bin/env node
// OPERATOR-ONLY fixture tool (proof slice P3). Renders manifest.template.json for one built rwtarget image: fills in
// the exact image reference and the declaration digests. Nothing imports it; it reads no environment variable.
//
//   node render-manifest.mjs --image <ref@sha256:...> --inventory <inventory.json> --helper <rw-target-helper>
//        --transport-vectors <transport-v1.json> --common-vectors <contracts-v1.json> --session-vectors <session-fixture-v1.json>
//        --seccomp-profile <ploinky nested seccomp json> --out <manifest.json>
//
// Digest preimages (proof-fixture definitions, recorded for review; T0 fixes only the Digest format):
//   helper.executableDigest  SHA-256 of the helper executable bytes (the same file the image carries at the fixed path)
//   helper.contractDigest    targetDigest({version:1, contractId, transportVectorsSha256, commonVectorsSha256, sessionVectorsSha256})
//                            (A11.4: the session vectors pin the handshake message shapes, HKDF label and proof prefix)
//   inventoryDigest          targetDigest({version:1, platform, baseImage, files}) with files sorted by path, each
//                            {path, sha256, mode} as hashed inside the built image (inventory.json)
//   profile.digest           targetDigest({version:1, id:"nested-podman", containerSecurity:{nestedPodman:true},
//                            renderedArgs, seccompProfileSha256}) where renderedArgs are Ploinky's rendered nestedPodman
//                            container arguments
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, targetDigest } from '../../../../server/executionTarget/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER_CONTRACT_ID = 'ploinky.execution-target-helper.v1';
export const HELPER_PATH = '/usr/libexec/ploinky-target/rw-target-helper';
export const NESTED_PODMAN_SECCOMP_BOX_PATH = '/opt/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json';
export const RENDERED_NESTED_PODMAN_ARGS = Object.freeze([
    '--cap-add', 'SYS_ADMIN',
    '--cap-add', 'NET_ADMIN',
    '--device', '/dev/fuse',
    '--device', '/dev/net/tun',
    '--security-opt', 'label=disable',
    '--security-opt', `seccomp=${NESTED_PODMAN_SECCOMP_BOX_PATH}`,
]);
const REQUIRED_FILES = Object.freeze([
    HELPER_PATH,
    '/usr/libexec/ploinky-target/keeper',
    '/usr/libexec/ploinky-target/rw-file-server',
    '/usr/libexec/ploinky-target/launch',
    '/usr/libexec/ploinky-target/peer',
    '/usr/bin/bwrap',
    '/bin/setpriv',
]);

function digest(value) {
    const result = targetDigest(value);
    if (!result.ok) throw new Error(`digest failed: ${result.error.code}`);
    return result.value;
}

function validInventory(inventory) {
    if (!inventory || inventory.version !== 1 || typeof inventory.platform !== 'string' || typeof inventory.baseImage !== 'string'
        || !Array.isArray(inventory.files)) return false;
    const paths = inventory.files.map((file) => file.path);
    return paths.join('\n') === [...paths].sort().join('\n') && new Set(paths).size === paths.length
        && REQUIRED_FILES.every((file) => paths.includes(file))
        && inventory.files.every((file) => Object.keys(file).sort().join(',') === 'mode,path,sha256'
            && /^[0-9a-f]{64}$/.test(file.sha256) && /^[0-7]{3,4}$/.test(file.mode)
            // No setuid (4) or setgid (2) bit on any inventoried file.
            && (Number.parseInt(file.mode.padStart(4, '0')[0], 8) & 6) === 0);
}

export function renderManifest({ templateText, image, inventory, helperBytes, transportVectorsBytes, commonVectorsBytes, sessionVectorsBytes, seccompBytes }) {
    if (!sessionVectorsBytes) throw new Error('the session vectors are part of the helper contract (A11.4)');
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('image must be an exact digest reference');
    if (!validInventory(inventory)) throw new Error('inventory is invalid or incomplete');
    const executableDigest = sha256Hex(helperBytes);
    const helperEntry = inventory.files.find((file) => file.path === HELPER_PATH);
    if (helperEntry.sha256 !== executableDigest) throw new Error('the image helper differs from the given helper executable');
    const values = {
        IMAGE: image,
        HELPER_EXECUTABLE_DIGEST: executableDigest,
        HELPER_CONTRACT_DIGEST: digest({
            version: 1,
            contractId: HELPER_CONTRACT_ID,
            transportVectorsSha256: sha256Hex(transportVectorsBytes),
            commonVectorsSha256: sha256Hex(commonVectorsBytes),
            sessionVectorsSha256: sha256Hex(sessionVectorsBytes),
        }),
        INVENTORY_DIGEST: digest(inventory),
        PROFILE_DIGEST: digest({
            version: 1,
            id: 'nested-podman',
            containerSecurity: { nestedPodman: true },
            renderedArgs: [...RENDERED_NESTED_PODMAN_ARGS],
            seccompProfileSha256: sha256Hex(seccompBytes),
        }),
    };
    const text = templateText.replace(/@@([A-Z_]+)@@/g, (match, name) => {
        if (!Object.hasOwn(values, name)) throw new Error(`unknown placeholder ${name}`);
        return values[name];
    });
    const manifest = JSON.parse(text);
    return { manifest, values };
}

function parseArguments(argv) {
    const names = { '--image': 'image', '--inventory': 'inventory', '--helper': 'helper', '--transport-vectors': 'transportVectors',
        '--common-vectors': 'commonVectors', '--session-vectors': 'sessionVectors', '--seccomp-profile': 'seccompProfile', '--out': 'out' };
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = names[argv[index]];
        if (!key || options[key] !== undefined || argv[index + 1] === undefined) throw new Error(`unexpected argument ${argv[index]}`);
        options[key] = argv[index + 1];
    }
    for (const key of Object.values(names)) if (!options[key]) throw new Error(`missing ${key}`);
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = parseArguments(process.argv.slice(2));
    const { manifest, values } = renderManifest({
        templateText: fs.readFileSync(path.join(HERE, 'manifest.template.json'), 'utf8'),
        image: options.image,
        inventory: JSON.parse(fs.readFileSync(options.inventory, 'utf8')),
        helperBytes: fs.readFileSync(options.helper),
        transportVectorsBytes: fs.readFileSync(options.transportVectors),
        commonVectorsBytes: fs.readFileSync(options.commonVectors),
        sessionVectorsBytes: fs.readFileSync(options.sessionVectors),
        seccompBytes: fs.readFileSync(options.seccompProfile),
    });
    fs.writeFileSync(options.out, `${JSON.stringify(manifest, null, 4)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(values)}\n`);
}
