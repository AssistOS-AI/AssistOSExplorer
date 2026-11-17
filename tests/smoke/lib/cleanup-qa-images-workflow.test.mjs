import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Static tests of cleanup-explorer-qa-images.yml. Only the shell is checked here; what podman removes on the
// real host is proven by the run's before and after listings.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/cleanup-explorer-qa-images.yml'), 'utf8');

function runBlocks(text) {
    const blocks = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^(\s*)run: \|$/);
        if (!match) continue;
        const body = [];
        const indent = match[1].length;
        let cursor = index + 1;
        while (cursor < lines.length && (!lines[cursor].trim() || lines[cursor].search(/\S/) > indent)) {
            body.push(lines[cursor].slice(indent + 2));
            cursor += 1;
        }
        blocks.push(body.join('\n'));
    }
    return blocks;
}

test('cleanup: every run block is valid shell', () => {
    const blocks = runBlocks(source);
    assert.ok(blocks.length >= 3);
    for (const block of blocks) {
        const result = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
});

test('cleanup: targets the pinned QA host and shares the deploy serialization and host lock', () => {
    for (const line of [
        "SSH_USER: 'admin'",
        "SSH_HOST: '45.136.70.141'",
        "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'",
        "WORKSPACE: 'explorerQaWorkspace'",
        '  group: deploy-explorer-qa\n',
        'cancel-in-progress: false',
        'LOCK=/home/admin/.qa-deployment-operation.lock',
        '-o StrictHostKeyChecking=yes',
        'if [ "$HOST_KEY_FINGERPRINT" != "$SSH_ED25519_FINGERPRINT" ]; then',
        'BOX_CONTAINER=ploinky-box-explorerqaworkspace-7a31ab7775eb',
    ]) {
        assert.ok(source.includes(line), line);
    }
    assert.match(source, /^on:\n  workflow_dispatch:\n\n/m);
});

test('cleanup: removes only images, through podman, under the host lock', () => {
    // The only mutations are `image rm <validated id or name>` inside the QA Box and `image rm <validated id>` on the host.
    assert.doesNotMatch(source, /image prune/);
    assert.equal(source.split('box_podman image rm "$target"').length - 1, 1);
    assert.equal(source.split('host_podman image rm "$id"').length - 1, 1);
    assert.match(source, /if \[\[ ! "\$id" =~ \^\[a-f0-9\]\{12,64\}\$ \]\]; then/);
    for (const forbidden of [
        /\brm -rf\b/, /system prune/, /volume (?:rm|prune)/, /container (?:rm|stop|kill|prune)/, /image rm (?:-f|--force)/,
        /\bsudo\b/, /\bploinky\b(?!-box)/, /network (?:rm|prune)/,
    ]) {
        assert.doesNotMatch(source, forbidden);
    }
    for (const helper of ['host_podman() {', 'box_podman() {']) {
        const start = source.indexOf(helper);
        assert.notEqual(start, -1, helper);
        assert.match(source.slice(start, source.indexOf('\n          }\n', start)), /exec flock -n -E 75 --close '\$LOCK' podman/);
    }
});

test('cleanup: on the host only dangling or Box images are candidates', () => {
    const start = source.indexOf('\n          removed=0\n');
    assert.ok(start > 0, 'the host loop');
    const loop = source.slice(start, source.indexOf('done <<< "$listing"', start));
    assert.match(loop, /\[ "\$containers" = 0 \] \|\| continue/);
    assert.match(loop, /if \[ "\$dangling" != true \]; then[\s\S]*\[ "\$is_box_image" = true \] \|\| continue/);
    assert.match(source, /BOX_IMAGE=docker\.io\/assistos\/ploinky-box\n/);
});

// Runs the Box loop itself under `set -euo pipefail` with a stub box_podman that serves a listing and records removals.
function runBoxLoop(listing, failRm = []) {
    const start = source.indexOf('            box_removed=0\n');
    const endMarker = 'echo "[cleanup-qa] Box: removed $box_removed image(s)"';
    const end = source.indexOf(endMarker, start);
    assert.ok(start > 0 && end > start, 'the Box loop');
    const loop = source.slice(start, end + endMarker.length);
    const script = `set -euo pipefail
box_podman() {
  if [ "$1 $2" = "image ls" ]; then printf '%b' "$LISTING"; return 0; fi
  if [ "$1 $2" = "image rm" ]; then
    echo "rm $3" >&2
    case " $FAIL_RM " in *" $3 "*) return 2 ;; esac
    return 0
  fi
  return 9
}
${loop}
echo completed`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, LISTING: listing, FAIL_RM: failRm.join(' ') } });
    return { ...result, removals: result.stderr.split('\n').filter((line) => line.startsWith('rm ')).map((line) => line.slice(3)) };
}

test('cleanup: the Box loop keeps Ploinky\'s Router authority helper and :runtime tags and removes other unused images', () => {
    const d = (n) => n.repeat(64);
    const helper = 'docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
    const listing = [
        `111111111111 0 [docker.io/assistos/scriptahub-agent@sha256:${d('1')}]`,
        `222222222222 0 [${helper}]`,
        `333333333333 0 [docker.io/assistos/scriptahub-agent:runtime docker.io/assistos/scriptahub-agent@sha256:${d('3')}]`,
        `444444444444 2 [docker.io/assistos/local-llm:latest]`,
        `555555555555 0 [docker.io/assistos/onlyoffice:9 docker.io/assistos/onlyoffice@sha256:${d('5')}]`,
        '666666666666 0 []',
        '777777777777 0 [docker.io/library/node:24-bookworm-slim]',
        `888888888888 0 [docker.io/assistos/x@sha256:${d('8')} bad$(name)]`,
        `111111111111 0 [docker.io/assistos/scriptahub-agent@sha256:${d('1')}]`,
        '../x 0 []',
        `999999999999 0 [docker.io/assistos/y@sha256:${d('9')}]`,
        '',
    ].join('\\n');
    const result = runBoxLoop(listing, [`docker.io/assistos/y@sha256:${d('9')}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /completed/);
    // Each name of a named image, the ID of a dangling one; a repeated row is handled once.
    assert.deepEqual(result.removals, [
        `docker.io/assistos/scriptahub-agent@sha256:${d('1')}`,
        'docker.io/assistos/onlyoffice:9',
        `docker.io/assistos/onlyoffice@sha256:${d('5')}`,
        '666666666666',
        `docker.io/assistos/y@sha256:${d('9')}`,
    ]);
    assert.match(result.stdout, /^\[cleanup-qa\] Box: kept 222222222222 \[docker\.io\/library\/node@sha256:6f7b/m);
    assert.match(result.stdout, /^\[cleanup-qa\] Box: kept 333333333333 /m);
    assert.match(result.stdout, /^\[cleanup-qa\] Box: kept 777777777777 /m);
    assert.match(result.stdout, /^\[cleanup-qa\] Box: kept 888888888888 /m);
    assert.match(result.stdout, /^::warning::Skipped an unexpected image ID in the Box listing$/m);
    assert.match(result.stdout, /^::warning::Box: podman kept 999999999999$/m);
    assert.match(result.stdout, /^\[cleanup-qa\] Box: removed 3 image\(s\)$/m);
});

test('cleanup: the key never outlives the job', () => {
    assert.match(source, /- name: Cleanup\n        if: always\(\)\n        run: \|\n          rm -f ~\/\.ssh\/deploy_key ~\/\.ssh\/explorer_qa_known_hosts/);
});
