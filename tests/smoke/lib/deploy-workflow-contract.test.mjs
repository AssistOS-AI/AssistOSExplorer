import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const WORKFLOWS = [
  {
    file: '.github/workflows/deploy-explorer-qa.yml',
    name: 'Deploy Explorer QA Box',
    expected: [
      'resolve_default_branch() {',
      'Resolving every managed repository from its configured default branch',
      'default_branch="$(resolve_default_branch "$repository_url")"',
      'PLOINKY_BRANCH="$(resolve_default_branch "$PLOINKY_URL")"',
      "SSH_USER: 'admin'",
      "SSH_HOST: '45.136.70.141'",
      "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'",
      "WORKSPACE: 'explorerQaWorkspace'",
      "PUBLIC_HOST: 'explorer-qa.axiologic.dev'",
      "PLOINKY_NO_WAIT_SEQUENCE_TERMINAL_GRACE_MS='300000'",
      '"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"',
      "'AchillesIDE|https://github.com/AssistOS-AI/AssistOSExplorer.git'",
      "'UmamiAgent|https://github.com/AssistOS-AI/UmamiAgent.git'",
      "'OnlyOfficeAgent|https://github.com/AssistOS-AI/OnlyOfficeAgent.git'",
      "'AchillesCLI|https://github.com/AssistOS-AI/AchillesCLI.git'",
      "'copilot-agents|https://github.com/AssistOS-AI/copilot-agents.git'",
      "'webmeet|https://github.com/AssistOS-AI/webmeet.git'",
      "CLOUDFLARE_TUNNEL_NAME: 'explorer-qa'",
      "CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: '091c4096-d1c8-4dbc-bb12-0c6357431d96'",
      "CLOUDFLARE_TUNNEL_SECRET_HANDLE: 'publication/explorer-qa-tunnel'",
      "CLOUDFLARE_API_SECRET_HANDLE: 'publication/explorer-qa-api'",
      'EXPLORER_QA_CLOUDFLARE_API_TOKEN',
      'EXPLORER_QA_CLOUDFLARE_ACCOUNT_ID',
      'EXPLORER_QA_CLOUDFLARE_ZONE_ID',
      'EXPLORER_QA_PLOINKY_MASTER_KEY',
      'Cloudflare management and connector authorities must be separate credentials',
      'dedicated Explorer QA tunnel create/reuse did not converge to one exact identity',
      'connector token claims do not match the dedicated Explorer QA tunnel/account',
      'dedicated Explorer QA tunnel has shared or ambiguous ingress',
      'Explorer QA DNS does not target the selected dedicated tunnel',
      'protected proxies ingress topology is not the authorized immutable baseline',
      'protected proxies ingress or unrelated DNS identity changed during Explorer QA deployment',
      'Validated the pinned Explorer QA SSH host identity',
      'tunnelId,',
      'tunnelTokenSecret,',
      'MEDIA_PUBLIC_IPV4:',
      "addressMode: 'direct'",
      'achillesAgentLib comes from the Box image; no commit is pinned.',
      'BEGIN QA image-owned AgentLib verification',
      'await adapters.verifyAgentLib(boxes[0])',
      'immutable source ${selection.sourceId}',
      "agent: 'AchillesIDE/explorer'",
      "'browser-auth'",
      "'agent-mcp'",
      "'user-admin'",
      "'workspace-assets'",
      "'blob-transfer'",
      "'marketplace-ui'",
      "'webchat'",
      "'webtty'",
      'const target = "/home/admin/explorerQaWorkspace/.ploinky"',
      'Ploinky authority directory has the wrong owner',
      'STAGED_EDGE_DESIRED="$WORK_DIR/.ploinky/.explorer-qa-edge-desired.json"',
      'const target = "/home/admin/explorerQaWorkspace/.ploinky/edge-desired.json"',
      'staged edge desired file has the wrong owner',
      'Cloudflare mode: cloudflare',
      'Cloudflare management: api-managed',
      'Cloudflare publication: ready',
      'Cloudflare connector: running',
      'Tracked agents: 9',
      'Running agents: 9',
      'EXPECTED_NO_WAIT_AGENTS=4',
      'QA_DEPLOY_STARTED_AT_MS="$(node -p \'Date.now()\')"',
      'check-no-wait-readiness.mjs',
      'QA_READY_STREAK',
      'QA_TERMINAL_FAILURE',
      'for _ in $(seq 1 180); do',
      'current-run no-wait readiness evidence failed',
      'timed out waiting for stable 9/9 process admission and 4/4 semantic readiness',
      'dedicated persistent `%s` tunnel `%s`, ingress, and DNS API-managed by Ploinky',
      '"${PUBLIC_URL%/}/auth/login?agent=explorer"',
      '"${PUBLIC_URL%/}/auth/login?agent=dpuAgent"',
      'BEGIN QA UserPersisto configuration',
      'BEGIN QA public email-first verification',
      "handleVarCommand(['USERPERSISTO_OIDC_ISSUER'",
      "handleVarCommand(['USERPERSISTO_ALLOWED_REDIRECT_ORIGINS'",
      'Continue with Single Sign-On',
      'openid-configuration',
      "mismatchBody?.error !== 'auth_route_context_mismatch'",
      'Public edge verified the host-bound SSO login, email-first wizard, OIDC issuer, and rejected a mismatched agent selector.',
      'Dedicated Explorer QA tunnel id=',
      'EXPLORER_QA_DNS_RECORD_ID=',
      'Recovery: in-place source failures restore the previous commit',
      'SOUL_GATEWAY_WORKSPACE:',
      'SOUL_GATEWAY_ROUTER_PORT:',
      'refusing to operate on the production Soul Gateway workspace',
      'protected Soul Gateway became unhealthy during QA deployment',
      'inspect_outer_box_status() {',
      'createBoxSupervisor().inspectBoxStatus()',
      'process.stdout.write(formatBoxStatus(status))',
      'BOX_STATUS="$(inspect_outer_box_status)"',
      "[ \"$BOX_PATH_HASH\" != '7a31ab7775eb' ]",
      "assert.equal(target, '/home/admin/explorerQaWorkspace')",
      'BEGIN QA policy restoration',
      'BEGIN QA install marker',
      'BEGIN QA teardown',
      'qa-teardown.mjs" complete --lock-held',
      'protected-snapshot',
      'Protected host resource identities remained unchanged',
    ],
  },
];

const SHARED_DEPLOYMENT_CONTRACT = [
  'workflow_dispatch:',
  'permissions:',
  'contents: read',
  'export PLOINKY_WORKSPACE_ROOT="$WORK_DIR"',
  '- name: Create summary',
  '- name: Cleanup',
];

const STALE_COMPONENT_ENDPOINTS = [
  /127\.0\.0\.1:8082/,
  /livekit-skills\.axiologic\.dev/,
  /web-apps\/apps\/api\/documents\/api\.js/,
  /base-agent-additional-server\/onlyOffice/,
  /base-agent-additional-server\/webtty/,
  /\b7681\b/,
];

for (const workflow of WORKFLOWS) {
  test(`${workflow.name} preserves deployment behavior without a component route inventory`, () => {
    const source = fs.readFileSync(path.join(ROOT, workflow.file), 'utf8');

    assert.match(source, new RegExp(`^name: ${workflow.name}$`, 'm'));
    assert.equal(source.includes('\t'), false, 'workflow YAML must not contain tabs');
    assert.equal(source.endsWith('\n'), true, 'workflow YAML must end with a newline');

    for (const required of [...SHARED_DEPLOYMENT_CONTRACT, ...workflow.expected]) {
      assert.equal(source.includes(required), true, `missing restored workflow contract: ${required}`);
    }
    for (const staleEndpoint of STALE_COMPONENT_ENDPOINTS) {
      assert.doesNotMatch(source, staleEndpoint);
    }
    // No Explorer graph agent lives in proxies any more, so Ploinky never installs it.
    assert.doesNotMatch(source, /'proxies\|https:\/\/github\.com\/AssistOS-AI\/proxies\.git'/, `${workflow.file} must not require a proxies checkout`);
    if (workflow.file.endsWith('deploy-explorer-qa.yml')) {
      assert.doesNotMatch(source, /BRANCH_ARGS=\(--branch|--branch-fallback|--reset-repos/);
      assert.doesNotMatch(source, /deleteTunnelOnTeardown|create-managed-tunnel/);
      assert.doesNotMatch(source, /BOX_STATUS="\$\("\$PLOINKY" status\)"/);
    }

    assert.equal(source.match(/<< ?'REMOTE'/g)?.length, 1, 'expected one remote deployment heredoc');
    assert.equal(source.match(/^          REMOTE$/gm)?.length, 1, 'expected one closed remote deployment heredoc');
  });
}

test('Explorer QA deploy and destroy do not manage container-image-builds as a graph repository', () => {
    for (const file of [
        '.github/workflows/deploy-explorer-qa.yml',
        '.github/workflows/destroy-explorer-qa.yml',
    ]) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /container-image-builds/, `${file} must not pin or require container-image-builds`);
    }
});

test('Explorer workflows omit retired stack repositories', () => {
    const retiredRepositories = ['basic', ['webmeet', 'Infra'].join('')];
    const retiredRepositoryPattern = new RegExp(`\\b(?:${retiredRepositories.join('|')})\\b`);
    for (const file of [
        ...WORKFLOWS.map((workflow) => workflow.file),
        '.github/workflows/destroy-explorer-qa.yml',
    ]) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, retiredRepositoryPattern, `${file} must not manage a retired stack repository`);
    }
});

test('Explorer deployment workflows neither provision nor inspect the retired local model runtime', () => {
    for (const workflow of WORKFLOWS) {
        const source = fs.readFileSync(path.join(ROOT, workflow.file), 'utf8');
        assert.doesNotMatch(source, /DEFAULT_LOCAL_LLM/, `${workflow.file} must not define or forward a local model image`);
        assert.doesNotMatch(source, /default-local-llm/i, `${workflow.file} must not pull, start, or inspect the retired local model agent`);
        assert.doesNotMatch(source, /default local LLM image/i, `${workflow.file} must not inspect a local model image`);
    }
});

test('Explorer QA workflow rejects unsafe identity and tunnel state before SSH', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );

  assert.doesNotMatch(source, /workspace_name|inputs\.workspace_name/);
  assert.doesNotMatch(source, /(?<![\w.-])\/workspace(?![\w-])/, 'QA deploy uses the same-path host workspace inside the Box');
  assert.doesNotMatch(source, /vars\.EXPLORER_QA_(?:SSH_USER|SSH_HOST|WORKSPACE)/);
  assert.doesNotMatch(source, /\n  rollback:\n/, 'the deploy workflow has no rollback job');
  assert.equal(source.match(/ssh-keyscan/g)?.length, 1, 'host key must be scanned only in pinned preflight');
  assert.ok(
    source.indexOf('connector token claims do not match') < source.indexOf('          scp \\'),
    'connector identity must fail before the first SSH transfer',
  );
  assert.ok(
    source.indexOf('SSH_ED25519_FINGERPRINT') < source.indexOf('- name: Reconcile and start Explorer QA Box'),
    'pinned host identity must be established before the remote deployment step',
  );
  assert.match(source, /install -m 600 "\$RUNNER_TEMP\/explorer_qa_known_hosts"/);
});

test('Explorer QA deploy resolves graph defaults and takes AgentLib from the Box image, not a branch head', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );

  assert.match(source, /resolve_default_branch\(\) \{/);
  assert.doesNotMatch(source, /dependencies\.lock\.json|resolve_default_branch "\$AGENTLIB_URL"|AchillesAgentLib\.git/);
  assert.match(source, /PLOINKY_BRANCH="\$\(resolve_default_branch "\$PLOINKY_URL"\)"/);
  assert.match(source, /checkout -B "\$PLOINKY_BRANCH" "refs\/remotes\/origin\/\$PLOINKY_BRANCH"/);
  assert.match(source, /branch --set-upstream-to="origin\/\$PLOINKY_BRANCH" "\$PLOINKY_BRANCH"/);
  assert.match(source, /BRANCH_ARGS\+=\(--repo-branch "\$repository_name=\$default_branch"\)/);
  assert.match(source, /--dry-run --port "\$ROUTER_PORT" start explorer "\$\{BRANCH_ARGS\[@\]\}"/);
  assert.match(source, /"\$PLOINKY" start explorer "\$\{BRANCH_ARGS\[@\]\}"/);
  assert.doesNotMatch(source, /PLOINKY_AGENTLIB_REF|globalDeps\/package\.json/);
  assert.doesNotMatch(source, /inputs\.(?:deploy_branch|ploinky_branch)|ploinky-proxy/);
});

test('Explorer QA deploy explicitly reconciles every managed checkout to the selected graph branch', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );
  const graphStart = source.indexOf('GRAPH_REPOSITORIES=(');
  const graphEnd = source.indexOf("PLOINKY_URL='", graphStart);
  const graphBlock = source.slice(graphStart, graphEnd);

  assert.match(graphBlock, /BRANCH_ARGS=\(\)/);
  assert.match(
    graphBlock,
    /for repository_record in "\$\{GRAPH_REPOSITORIES\[@\]\}"; do[\s\S]*default_branch="\$\(resolve_default_branch "\$repository_url"\)"[\s\S]*BRANCH_ARGS\+=\(--repo-branch "\$repository_name=\$default_branch"\)[\s\S]*done/,
  );
  assert.doesNotMatch(graphBlock, /--branch/, 'the graph selects no AgentLib branch; the Box image supplies AgentLib');
  assert.equal(
    source.match(/start explorer "\$\{BRANCH_ARGS\[@\]\}"/g)?.length,
    2,
    'dry-run and real start must use the same exact branch arguments',
  );
  assert.match(source, /observed branch: \$\{deployed_branch:-<detached>\}/);
  assert.match(source, /observed upstream: \$\{deployed_upstream:-<none>\}/);
});

test('Explorer QA takes AchillesAgentLib from the Box image and pins no commit', (t) => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );
  // Ploinky no longer ships a dependency lock, so QA must neither read one nor
  // compare the image's library with a branch head.
  // The in-place step passes the pinned AssistOSExplorer commit to the updater as --expected-commit;
  // the Reconcile script, which owns the AgentLib verification, takes no such option.
  const reconcile = source.slice(source.indexOf("<<'REMOTE'"));
  assert.doesNotMatch(source, /dependencies\.lock|EXPECTED_AGENTLIB|Ploinky locks achillesAgentLib/);
  assert.doesNotMatch(reconcile, /--expected-commit/);
  const marker = '// BEGIN QA image-owned AgentLib verification';
  const markerIndex = source.indexOf(marker);
  const heredocStart = source.lastIndexOf("<<'NODE'\n", markerIndex);
  const scriptStart = heredocStart + "<<'NODE'\n".length;
  const scriptEnd = source.indexOf('\n          NODE', markerIndex);
  assert.ok(markerIndex > 0 && heredocStart > 0 && scriptEnd > scriptStart, 'AgentLib verification heredoc must close');
  assert.equal(
    source.slice(source.lastIndexOf('\n', heredocStart) + 1, heredocStart).trim(),
    'node --input-type=module - "$QA_TAIL_HELPER" "$BOX_INSTANCE"',
    'the verifier receives only the tail rollback helper and the exact Box instance',
  );
  const script = source.slice(scriptStart, scriptEnd).replace(/^          /gm, '');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-qa-agentlib-verifier-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const helper = path.join(temporary, 'helper.mjs');
  const instance = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
  const install = (selection) => fs.writeFileSync(helper, `
export function productionAdapters() {
  return {
    boxes: () => [{ engine: 'podman', box: { name: ${JSON.stringify(instance)} } }],
    async verifyAgentLib(...args) {
      if (args.length !== 1) throw new Error('verifyAgentLib received ' + args.length + ' arguments');
      return ${JSON.stringify(selection)};
    },
  };
}
`);
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-', helper, instance],
    { encoding: 'utf8', input: script });
  const image = `sha256:${'d'.repeat(64)}`;
  const selection = {
    mode: 'image', contract: 'image-owned', imageId: image, sourceId: 'e'.repeat(64), sourceRelativePath: 'image',
    packageName: 'ploinky-agent-lib', packageVersion: '1.2.3',
    provenance: { repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: 'a'.repeat(40) },
  };
  install(selection);
  const verified = run();
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout.trim(), `[deploy-qa] Verified image-supplied achillesAgentLib ploinky-agent-lib@1.2.3 from ${image}; `
    + `immutable source ${'e'.repeat(64)}; build provenance https://github.com/AssistOS-AI/AchillesAgentLib.git@${'a'.repeat(40)} (diagnostic only).`);
  install({ ...selection, packageVersion: null, provenance: null });
  const unversioned = run();
  assert.equal(unversioned.status, 0, unversioned.stderr);
  assert.match(unversioned.stdout, /ploinky-agent-lib@unversioned .*build provenance unavailable \(diagnostic only\)\.$/m);
});

test('Explorer QA validates Ploinky AgentLib selection against the outer Box identity', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );

  for (const required of [
    'BEGIN QA image-owned AgentLib verification',
    `"$QA_TAIL_HELPER" "$BOX_INSTANCE" <<'NODE'`,
    'const adapters = productionAdapters();',
    'await adapters.verifyAgentLib(boxes[0])',
    'immutable source ${selection.sourceId}',
  ]) {
    assert.equal(source.includes(required), true, `missing AgentLib outer Box identity contract: ${required}`);
  }
  assert.doesNotMatch(source, /\[ "\$AGENTLIB_MODE" != "managed" \]/, 'image bundles must not be rejected as missing managed checkouts');
  assert.doesNotMatch(
    source,
    /agentlib-attest\.mjs|EXPECTED_AGENTLIB_COUNT|dependency cache did not select|no AgentLib dependency cache|require\.resolve\("achillesAgentLib/,
  );
});

test('Explorer QA dedicated tunnel provisioning is fail-closed and preserves the shared tunnel', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );

  for (const required of [
    "CLOUDFLARE_TUNNEL_CREATED='true'",
    "if (created === 'true' && (ingress.length > 1 || records.length !== 0))",
    'named.length !== 1 || named[0]?.id !== selectedId',
    "ingress[0]?.service !== 'http://127.0.0.1:8080'",
    'records[0]?.content !== expectedTarget',
    'config?.config?.ingress ?? config?.ingress ?? []',
    'cleanup_local_files() {',
    'trap cleanup_local_files EXIT',
    "REMOTE_ENV_UPLOADED='true'",
    '"rm -f -- \'$REMOTE_ENV_FILE\'"',
    'echo "::add-mask::$CLOUDFLARE_TUNNEL_TOKEN"',
    'publication/explorer-qa-api',
    'publication/explorer-qa-tunnel',
    'beforeJson !== afterJson',
    'digest(after) !== process.env.PROTECTED_CLOUDFLARE_DIGEST',
    "result.filter((record) => record?.name !== publicHost)",
    "records.filter((record) => record?.name !== process.env.PUBLIC_HOST)",
    'dedicated Explorer QA connector has no active Cloudflare connection',
  ]) {
    assert.equal(source.includes(required), true, `missing dedicated tunnel invariant: ${required}`);
  }
  assert.doesNotMatch(source, /EXPLORER_QA_CLOUDFLARE_TUNNEL_TOKEN/);
  assert.doesNotMatch(source, /cfd_tunnel\/091c4096-d1c8-4dbc-bb12-0c6357431d96(?:\/token|\"\s*,\s*\{\s*method:\s*['\"](?:PUT|POST|DELETE))/);
  assert.doesNotMatch(
    source,
    /^ {11,}(?:NODE|REMOTE)$/gm,
    'workflow heredoc delimiters must normalize to shell column zero',
  );
  assert.equal(
    source.match(/<< ?'(?:NODE|REMOTE)'/g)?.length,
    source.match(/^ {10}(?:NODE|REMOTE)$/gm)?.length,
    'every workflow heredoc must have one runner-compatible closing delimiter',
  );
  assert.ok(
    source.indexOf("REMOTE_ENV_UPLOADED='true'") < source.indexOf('          scp \\\n'),
    'partial remote credential transfers must be cleanup-eligible',
  );
  assert.equal(
    source.match(/config\?\.config\?\.ingress \?\? config\?\.ingress \?\? \[\]/g)?.length,
    2,
    'both existing-tunnel inventories must normalize Cloudflare missing configuration to empty ingress',
  );
});

test('Explorer QA dedicated tunnel validator rejects malformed, shared, ambiguous, and wrong-DNS fixtures', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );
  const marker = 'const [listPath, detailPath, configPath, dnsPath, selectedId, created]';
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex > 0, 'dedicated tunnel validator marker must exist');
  const heredocStart = source.lastIndexOf("<<'NODE'\n", markerIndex);
  const scriptStart = heredocStart + "<<'NODE'\n".length;
  const scriptEnd = source.indexOf('\n          NODE', markerIndex);
  assert.ok(heredocStart > 0 && scriptEnd > scriptStart, 'dedicated tunnel validator heredoc must close');
  const script = source.slice(scriptStart, scriptEnd).replace(/^          /gm, '');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-qa-tunnel-validator-'));
  const selectedId = '11111111-2222-4333-8444-555555555555';
  const accountId = 'a'.repeat(32);
  const hostname = 'explorer-qa.axiologic.dev';
  const response = (result) => ({ success: true, result });
  const run = ({
    named = [{ id: selectedId, name: 'explorer-qa' }],
    detail = { id: selectedId, name: 'explorer-qa', deleted_at: null, account_tag: accountId },
    ingress = [],
    dns = [],
    created = 'false',
  } = {}) => {
    const documents = [response(named), response(detail), response({ config: { ingress } }), response(dns)];
    const files = documents.map((document, index) => {
      const file = path.join(temporary, `${index}.json`);
      fs.writeFileSync(file, JSON.stringify(document));
      return file;
    });
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-', ...files, selectedId, created],
      {
        encoding: 'utf8',
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, PUBLIC_HOST: hostname },
        input: script,
      },
    );
  };
  try {
    assert.equal(run({ created: 'true' }).status, 0, 'a newly created empty dedicated tunnel is accepted');
    assert.notEqual(run({ created: 'maybe' }).status, 0, 'the creation marker must be a literal boolean');
    assert.notEqual(run({
      created: 'true',
      ingress: [
        { hostname, service: 'http://127.0.0.1:8080' },
        { service: 'http_status:404' },
      ],
    }).status, 0, 'a newly created tunnel must not already carry routes');
    assert.notEqual(run({ named: [] }).status, 0, 'the created or reused tunnel must be listed before token retrieval');
    assert.equal(
      run({ ingress: null }).status,
      0,
      'existing selected tunnel with no configuration object may have empty ingress',
    );
    assert.notEqual(run({ ingress: { unexpected: true } }).status, 0);
    assert.equal(run({
      ingress: [
        { hostname, service: 'http://127.0.0.1:8080' },
        { service: 'http_status:404' },
      ],
      dns: [{
        id: 'dns_1',
        type: 'CNAME',
        name: hostname,
        content: `${selectedId}.cfargotunnel.com`,
        proxied: true,
      }],
    }).status, 0, 'exact reusable dedicated tunnel must pass');
    assert.notEqual(run({ named: [{ id: selectedId }, { id: 'other' }] }).status, 0);
    assert.notEqual(run({ detail: { id: selectedId, name: 'explorer-qa', account_tag: 'b'.repeat(32) } }).status, 0);
    assert.notEqual(run({
      ingress: [
        { hostname: 'unrelated.example.test', service: 'http://127.0.0.1:8080' },
        { service: 'http_status:404' },
      ],
    }).status, 0);
    assert.notEqual(run({
      dns: [{ type: 'CNAME', name: hostname, content: 'wrong.cfargotunnel.com', proxied: true }],
    }).status, 0);
    assert.notEqual(run({ created: 'true', dns: [{ type: 'CNAME' }] }).status, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Explorer QA credential staging does not use exclusive create on a mktemp file', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );
  const start = source.indexOf('CLOUDFLARE_CREDENTIAL_FILE="$(mktemp');
  const end = source.indexOf('STAGED_CREDENTIAL_FILE=', start);
  assert.ok(start > 0 && end > start, 'credential staging block must exist');
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /flag:\s*['"]wx['"]/, 'mktemp already created the credential file');
  assert.match(block, /flag:\s*['"]w['"]/);
});

test('Explorer QA teardown deletes through the reviewed helper only, and the workspace is created after it', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-explorer-qa.yml'),
    'utf8',
  );
  const marker = source.indexOf('# BEGIN QA install marker');
  const teardownEnd = source.indexOf('# END QA teardown\n');
  const firstMkdir = source.indexOf('mkdir -p "$WORK_DIR"');
  assert.ok(marker > 0 && teardownEnd > marker && firstMkdir > teardownEnd, 'the marker and the teardown precede the first workspace creation');
  // The slice from the marker to the first workspace creation is the whole mutation region of a rebuild.
  const region = source.slice(marker, firstMkdir);
  assert.doesNotMatch(region, /rm\s+-rf|rm\s+-fr/, 'the region must delete only through the guarded helper');
  assert.doesNotMatch(region, /mkdir -p "\$WORK_DIR"/);
  assert.equal(region.match(/qa-teardown\.mjs" execute --scope/g)?.length, 1, 'exactly one teardown call');
  assert.equal(region.match(/qa-teardown\.mjs" mark /g)?.length, 1, 'exactly one marker write');
  assert.match(region, /--plan-digest "\$QA_PLAN_DIGEST" --lock-held/);
  assert.doesNotMatch(region, /container (?:stop|rm|rename)|image (?:rm|untag)/, 'the helper removes containers and images, never the shell');
  assert.equal(source.split('mkdir -p "$WORK_DIR"').length - 1, 1, 'the only workspace mkdir is the one after the teardown');
});
