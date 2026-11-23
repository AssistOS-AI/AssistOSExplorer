import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflows = new URL('../../../.github/workflows/', import.meta.url);
const rules = 'node .github/scripts/cloudflare-cache-rules.mjs ';
const tokenName = 'EXPLORER_QA_CLOUDFLARE_CACHE_RULES_TOKEN';
const ruleCommand = operation => rules + operation + ' --token-env ' + tokenName;
const receipt = ' --activation-receipt "$RUNNER_TEMP/cache-activation-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"';
const preRouter = 'bash "$GITHUB_WORKSPACE/.github/scripts/qa-cache-router.sh" pre';
const postRouter = 'bash "$GITHUB_WORKSPACE/.github/scripts/qa-cache-router.sh" post';
const deploys = [
    ['deploy-explorer-qa-ploinky.yml', 'Bootstrap the host and deploy through Ploinky commands', [
        'Verify public URL', 'Verify Bizanso and ScriptaHub', 'Verify dedicated connector and protected Cloudflare topology',
    ]],
    ['deploy-explorer-qa-bizanso.yml', 'Deploy Bizanso through Ploinky commands', ['Verify the QA routes']],
];

function readWorkflow(name) {
    const source = readFileSync(new URL(name, workflows), 'utf8');
    const [header, ...blocks] = source.split('\n      - name: ');
    const steps = blocks.map(block => ({
        name: block.split('\n')[0],
        block,
        run: (block.match(/\n        run: (?:\|\n)?([\s\S]+)$/)?.[1] ?? '').trim(),
        condition: block.match(/^        if: (.+)$/m)?.[1],
        id: block.match(/^        id: (\w+)$/m)?.[1],
    }));
    return { header, steps };
}

function exactlyOne(steps, predicate, description) {
    const matches = steps.filter(predicate);
    assert.equal(matches.length, 1, description);
    return matches[0];
}

function assertOrdered(steps, expected) {
    const positions = expected.map(step => steps.indexOf(step));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), expected.map(step => step.name).join(' → '));
}

function assertQaTarget(header) {
    for (const entry of [
        "PUBLIC_HOST: 'explorer-qa.axiologic.dev'",
        'CLOUDFLARE_ZONE_ID: ${{ vars.EXPLORER_QA_CLOUDFLARE_ZONE_ID }}',
        "CLOUDFLARE_CACHE_R1_REF: 'explorer_qa_cache_r1'",
        "CLOUDFLARE_CACHE_R2_REF: 'explorer_qa_cache_r2'",
    ]) {
        assert.ok(header.split('\n').includes('  ' + entry), entry);
    }
}

function assertRecovery(step, mutations, command) {
    const outcomes = mutations.flatMap(mutation => ['failure', 'cancelled'].map(outcome =>
        `steps.${mutation.id}.outcome == '${outcome}'`));
    assert.equal(step.condition, '${{ always() && (' + outcomes.join(' || ') + ') }}');
    assert.equal(step.run, command);
}

for (const [name, deployName, healthNames] of deploys) {
    test(`${name} gates deployment and cache activation on the preceding checks`, () => {
        const { header, steps } = readWorkflow(name);
        assertQaTarget(header);
        const byCommand = command => exactlyOne(steps, step => step.run.includes(command), command);
        const byName = label => exactlyOne(steps, step => step.name === label, label);
        const r1 = byCommand(rules + 'ensure-r1');
        const off = steps.filter(step => step.run.includes(rules + 'r2-off'));
        const pre = byCommand(preRouter);
        const post = byCommand(postRouter);
        const on = byCommand(rules + 'r2-on');
        assert.equal(off.length, 3, 'initial disable, initial guard recovery, and cancelled activation recovery');
        assertOrdered(steps, [r1, off[0], pre, byName(deployName), ...healthNames.map(byName), post, on]);
        if (r1 === off[0]) {
            assert.ok(r1.run.indexOf(rules + 'ensure-r1') < r1.run.indexOf(rules + 'r2-off'));
        }
        const mutation = name.includes('bizanso') ? '\n          prune_images pre' : "CLOUDFLARE_TUNNEL_CREATED='false'";
        assert.ok(pre.run.indexOf(preRouter) < pre.run.indexOf(mutation), 'clear runs before deployment changes');
        assert.ok(post.id, 'probe and second purge publish their outcome');
        assert.equal(on.condition, '${{ success() && steps.' + post.id + ".outputs.verified == 'true' }}");
        assert.equal(pre.condition, undefined, 'the first purge applies to every deploy');
        assert.equal(post.condition, undefined, 'health failures skip the origin probe');
        for (const step of [r1, ...off, post, on]) {
            assert.doesNotMatch(step.block, /continue-on-error: true|\|\| true/);
        }
        assert.deepEqual(steps.slice(steps.indexOf(on) + 1), off.slice(1), 'activation must follow every ordinary step');
        assertRecovery(off[1], [off[0]], ruleCommand('r2-off') + ' --if-present');
        assert.equal(on.run, ruleCommand('r2-on') + receipt);
        assert.equal(off[2].condition, "${{ always() && steps.cache_on.outcome == 'cancelled' }}");
        assert.equal(off[2].run, ruleCommand('r2-off') + receipt);
    });

    test(`${name} declares a default-off T9 probe failure and scopes it to the probe`, () => {
        const { header, steps } = readWorkflow(name);
        const post = exactlyOne(steps, step => step.run.includes(postRouter), 'post-deploy probe');
        const input = post.block.match(/QA_CACHE_FORCE_PROBE_FAILURE: \$\{\{ inputs\.(\w+) \}\}/);
        assert.ok(input, 'T9 dispatch input reaches the actual probe');
        const declaration = header.match(new RegExp(`^      ${input[1]}:\\n((?: {8}[^\\n]+\\n)+)`, 'm'));
        assert.ok(declaration, 'T9 input declared');
        assert.match(declaration[1], /^        type: boolean$/m);
        assert.match(declaration[1], /^        default: false$/m);
        assert.deepEqual(steps.filter(step => step.block.includes(`inputs.${input[1]}`)), [post]);
    });

    test(`${name} gives credentials only to their dedicated runner commands`, () => {
        const { header, steps } = readWorkflow(name);
        for (const [secret, commands] of [
            ['EXPLORER_QA_CLOUDFLARE_CACHE_RULES_TOKEN', [rules]],
            ['EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN', [preRouter, postRouter]],
        ]) {
            assert.ok(!header.includes(secret), 'cache credentials must be step-local');
            const owners = steps.filter(step => step.block.includes(secret));
            assert.ok(owners.length >= 2);
            assert.deepEqual(owners.map(step => step.name), steps.filter(step => commands.some(command => step.run.includes(command))).map(step => step.name));
            for (const { block, run } of owners) {
                assert.deepEqual(block.split('\n').filter(line => line.includes('secrets.' + secret)).map(line => line.trim()), [
                    secret + ': ${{ secrets.' + secret + ' }}',
                ]);
                if (secret.endsWith('_PURGE_TOKEN') && run.includes(preRouter)) {
                    const uses = run.split('\n').filter(line => line.includes(secret)).map(line => line.trim());
                    assert.deepEqual(uses, [
                        'export -n ' + secret,
                        'QA_NODE_HOME="$QA_NODE_HOME" ' + secret + '="${' + secret + ':-}" ' + preRouter,
                        'unset ' + secret,
                    ]);
                } else if (secret === tokenName) {
                    for (const line of run.split('\n').map(line => line.trim()).filter(line => line.includes(tokenName) || line.includes(rules))) {
                        assert.ok([ruleCommand('ensure-r1'), ruleCommand('r2-off'), ruleCommand('r2-off') + ' --if-present',
                            ruleCommand('r2-on') + receipt, ruleCommand('r2-off') + receipt].includes(line),
                            'only a literal variable name may reach the runner command');
                    }
                } else {
                    assert.ok(!run.includes(secret), 'the workflow must not interpolate or log a cache credential');
                }
            }
        }
    });
}

test('both QA destroy modes disable caching before Box and publication teardown', () => {
    const { header, steps } = readWorkflow('destroy-explorer-qa-ploinky.yml');
    assertQaTarget(header);
    const disables = steps.filter(step => step.run.includes(rules + 'r2-off'));
    assert.equal(disables.length, 2, 'disable plus recovery');
    const [off, recovery] = disables;
    const box = exactlyOne(steps, step => step.name === 'Destroy the Box through Ploinky commands', 'Box teardown');
    const publication = exactlyOne(steps, step => step.name === 'Delete the dedicated Cloudflare publication', 'publication deletion');
    assertOrdered(steps, [off, box, publication]);
    assert.equal(off.run, ruleCommand('r2-off') + ' --if-present', 'destroy may only disable an existing R2');
    assert.doesNotMatch(off.block, /delete_data|continue-on-error: true|\|\| true/);
    assertRecovery(recovery, [off], ruleCommand('r2-off') + ' --if-present');
    assert.ok(steps.every(step => !step.run.includes(rules + 'r2-on')));
});

test('the Router receives the purge secret on stdin with command and error output suppressed', () => {
    const script = readFileSync(new URL('../scripts/qa-cache-router.sh', workflows), 'utf8');
    const token = 'EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN';
    const lines = script.split('\n').filter(line => line.includes(token)).map(line => line.trim());
    assert.equal(lines.length, 4, 'unexport, validate presence, transfer, unset');
    assert.equal(lines[0], 'export -n ' + token);
    assert.equal(lines[1], 'if [[ -z "${' + token + ':-}" ]]; then');
    assert.equal(lines[2], 'printf \'%s\' "$' + token + '" | ploinky_locked var publication/explorer-qa-purge --stdin >/dev/null 2>&1 ||');
    assert.equal(lines[3], 'unset ' + token);
    assert.ok(script.indexOf('set +x\n') >= 0 && script.indexOf('set +x\n') < script.indexOf(token));
    assert.doesNotMatch(script, /^\s*(?:set -[^\n ]*x|env\s*$|printenv|declare -p|export -p)/m);
});

test('the second QA host bootstrap session verifies its account and tools before Git or workspace changes', () => {
    const { steps } = readWorkflow('deploy-explorer-qa-ploinky.yml');
    const deploy = exactlyOne(steps, step => step.run.includes(preRouter), 'QA deployment');
    const session = deploy.run.match(/bash -s -- '\$QA_NODE_HOME'" <<'REMOTE'([^]*?)^          REMOTE$/m)?.[1];
    assert.ok(session);
    const beforeGit = session.slice(0, session.indexOf('git ls-remote'));
    assert.match(beforeGit, /if \[ "\$\(id -un\)" != 'admin' \] \|\| \[ "\$HOME" != '\/home\/admin' \]; then[^]*?exit 1/);
    assert.match(beforeGit, /for tool in git node curl podman flock; do\s+if ! command -v "\$tool"[^]*?exit 1/);
});
