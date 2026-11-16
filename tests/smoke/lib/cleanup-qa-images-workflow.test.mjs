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
    // The only mutations are an image prune inside the QA Box and `image rm <validated id>` on the host.
    assert.equal(source.split('box_podman image prune --all --force').length - 1, 1);
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
    const start = source.indexOf('removed=0');
    const loop = source.slice(start, source.indexOf('done <<< "$listing"', start));
    assert.match(loop, /\[ "\$containers" = 0 \] \|\| continue/);
    assert.match(loop, /if \[ "\$dangling" != true \]; then[\s\S]*\[ "\$is_box_image" = true \] \|\| continue/);
    assert.match(source, /BOX_IMAGE=docker\.io\/assistos\/ploinky-box\n/);
});

test('cleanup: the key never outlives the job', () => {
    assert.match(source, /- name: Cleanup\n        if: always\(\)\n        run: \|\n          rm -f ~\/\.ssh\/deploy_key ~\/\.ssh\/explorer_qa_known_hosts/);
});
