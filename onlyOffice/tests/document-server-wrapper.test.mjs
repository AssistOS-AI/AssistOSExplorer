import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fixtureBootstrapEnv } from './bootstrap-fixture.mjs';

const execFileAsync = promisify(execFile);

test('document server wrapper enables auto assembly before supervisor starts', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-wrapper-'));
  const jsonLog = path.join(tempDir, 'json.log');
  const fakeJson = path.join(tempDir, 'json-tool.sh');
  const fakeDocumentServer = path.join(tempDir, 'run-document-server.sh');
  const configureV5 = path.join(tempDir, 'configure-v5.sh');
  const configureSupportListeners = path.join(tempDir, 'configure-support-listeners.sh');

  await writeFile(fakeJson, [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(jsonLog)}`,
  ].join('\n'), { mode: 0o755 });
  await writeFile(fakeDocumentServer, [
    '#!/bin/bash',
    'set -e',
    'CHILD=""',
    'start_process() {',
    '  "$@" &',
    '  CHILD=$!; wait "$CHILD"; CHILD="";',
    '}',
    'function clean_exit {',
    '  [[ -z "$CHILD" ]] || kill -s SIGTERM "$CHILD" 2>/dev/null',
    '  if [ "${ONLYOFFICE_DATA_CONTAINER:-false}" = "false" ]; then',
    '    /usr/bin/documentserver-prepare4shutdown.sh',
    '  fi',
    '  exit',
    '}',
    'trap clean_exit SIGTERM SIGQUIT SIGABRT SIGINT',
    `JSON=${JSON.stringify(fakeJson)}`,
    'service() { echo "service $*"; }',
    'install() { echo "install $*"; }',
    'start-stop-daemon() { echo "start-stop-daemon $*"; }',
    'LOCAL_SERVICES=(postgresql rabbitmq-server)',
    '#start needed local services',
    'for i in "${LOCAL_SERVICES[@]}"; do',
    '  service $i start',
    'done',
    'service supervisor start',
    'start_process documentserver-generate-allfonts.sh ${ONLYOFFICE_DATA_CONTAINER}',
    'start_process documentserver-static-gzip.sh ${ONLYOFFICE_DATA_CONTAINER}',
    'bash() { :; }',
    'start_process bash -c "find /tmp -type f -name *.log | xargs tail -F"',
  ].join('\n'), { mode: 0o755 });
  await writeFile(configureV5, [
    '#!/bin/bash',
    'echo "configure v5"',
  ].join('\n'), { mode: 0o755 });
  await writeFile(configureSupportListeners, [
    '#!/bin/bash',
    'echo "configure support listeners"',
  ].join('\n'), { mode: 0o755 });

  const { stdout } = await execFileAsync('/bin/bash', [
    'scripts/run-document-server-with-autoassembly.sh',
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      ...await fixtureBootstrapEnv(tempDir),
      ONLYOFFICE_DOCUMENT_SERVER_BASE_SCRIPT: fakeDocumentServer,
      ONLYOFFICE_V5_CONFIGURE_SCRIPT: configureV5,
      ONLYOFFICE_SUPPORT_LISTENER_SCRIPT: configureSupportListeners,
      ONLYOFFICE_BOUNDED_SHUTDOWN_SCRIPT: configureV5,
      ONLYOFFICE_AUTO_ASSEMBLY_ENABLED: 'true',
      ONLYOFFICE_AUTO_ASSEMBLY_INTERVAL: '2m',
      ONLYOFFICE_AUTO_ASSEMBLY_STEP: '30s',
    },
  });
  const calls = await readFile(jsonLog, 'utf8');

  assert.match(calls, /autoAssembly\.enable = true/);
  assert.match(calls, /autoAssembly\.interval = '2m'/);
  assert.match(calls, /autoAssembly\.step = '30s'/);
  assert.match(stdout, /service postgresql start/);
  assert.match(stdout, /start-stop-daemon .*--exec \/usr\/sbin\/rabbitmq-server .*--background/);
  assert.doesNotMatch(stdout, /service rabbitmq-server start/);
  assert.ok(stdout.indexOf('configure support listeners') < stdout.indexOf('service postgresql start'));
  assert.ok(stdout.indexOf('configure v5') < stdout.indexOf('service supervisor start'));
  assert.match(stdout, /configure support listeners/);
  assert.match(stdout, /service supervisor start/);
});

test('document server wrapper bounds the native shutdown hook after application drain', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-wrapper-stop-'));
  const fakeDocumentServer = path.join(tempDir, 'run-document-server.sh');
  const boundedShutdown = path.join(tempDir, 'bounded-shutdown.sh');
  const noOpScript = path.join(tempDir, 'no-op.sh');
  const shutdownLog = path.join(tempDir, 'shutdown.log');

  await writeFile(fakeDocumentServer, [
    '#!/bin/bash',
    'CHILD=""',
    'start_process() {',
    '  "$@" &',
    '  CHILD=$!; wait "$CHILD"; CHILD="";',
    '}',
    'function clean_exit {',
    '  [[ -z "$CHILD" ]] || kill -s SIGTERM "$CHILD" 2>/dev/null',
    '  if [ "${ONLYOFFICE_DATA_CONTAINER:-false}" = "false" ]; then',
    '    /usr/bin/documentserver-prepare4shutdown.sh',
    '  fi',
    '  exit',
    '}',
    'trap clean_exit SIGTERM SIGQUIT SIGABRT SIGINT',
    'JSON=/usr/bin/true',
    'service() { :; }',
    'install() { :; }',
    'start-stop-daemon() { :; }',
    'LOCAL_SERVICES=(rabbitmq-server)',
    '#start needed local services',
    'for i in "${LOCAL_SERVICES[@]}"; do',
    '  service $i start',
    'done',
    'service supervisor start',
    'start_process documentserver-generate-allfonts.sh ${ONLYOFFICE_DATA_CONTAINER}',
    'start_process documentserver-static-gzip.sh ${ONLYOFFICE_DATA_CONTAINER}',
    'bash() { echo ready; sleep 300; }',
    'start_process bash -c "find /tmp -type f -name *.log | xargs tail -F"',
  ].join('\n'), { mode: 0o755 });
  await writeFile(boundedShutdown, [
    '#!/bin/bash',
    `printf '%s\\n' bounded >> ${JSON.stringify(shutdownLog)}`,
  ].join('\n'), { mode: 0o755 });
  await writeFile(noOpScript, '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const child = spawn('/bin/bash', ['scripts/run-document-server-with-autoassembly.sh'], {
    cwd: new URL('..', import.meta.url),
    detached: true,
    env: {
      ...process.env,
      ...await fixtureBootstrapEnv(tempDir),
      ONLYOFFICE_DOCUMENT_SERVER_BASE_SCRIPT: fakeDocumentServer,
      ONLYOFFICE_V5_CONFIGURE_SCRIPT: noOpScript,
      ONLYOFFICE_SUPPORT_LISTENER_SCRIPT: noOpScript,
      ONLYOFFICE_BOUNDED_SHUTDOWN_SCRIPT: boundedShutdown,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const forcedExit = once(child, 'exit');
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) {
      return;
    }
    await forcedExit.catch(() => {});
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  await Promise.race([
    new Promise((resolve) => {
      const checkReady = () => {
        if (output.join('').includes('ready')) resolve();
        else setTimeout(checkReady, 10);
      };
      checkReady();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper did not become ready')), 2_000)),
  ]);

  const childExit = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  const [exitCode, signal] = await Promise.race([
    childExit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper shutdown was not bounded')), 2_000)),
  ]);

  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.equal(await readFile(shutdownLog, 'utf8'), 'bounded\n');
});

test('bounded DocumentServer shutdown helper uses an exact loopback request and fixed limits', async () => {
  const helper = await readFile(
    new URL('scripts/prepare-document-server-shutdown.sh', new URL('..', import.meta.url)),
    'utf8',
  );
  assert.match(helper, /\/usr\/bin\/curl/);
  assert.match(helper, /--connect-timeout 1/);
  assert.match(helper, /--max-time 2/);
  assert.match(helper, /--request PUT/);
  assert.match(helper, /http:\/\/\[::1\]:8000\/internal\/cluster\/inactive/);
  assert.match(helper, /did not complete within its bounded shutdown window/);
  assert.match(helper, /exit 0/);
});

test('support-listener configuration hardens every bundled dependency without duplicate settings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-support-listeners-'));
  const postgresqlConfig = path.join(tempDir, 'postgresql.conf');
  const redisConfig = path.join(tempDir, 'redis.conf');
  const rabbitmqConfig = path.join(tempDir, 'rabbitmq.conf');
  const rabbitmqEnv = path.join(tempDir, 'rabbitmq-env.conf');
  const prepareLog = path.join(tempDir, 'prepare-postgresql.log');
  const preparePostgresql = path.join(tempDir, 'prepare-postgresql.mjs');

  await writeFile(postgresqlConfig, [
    '#listen_addresses = localhost',
    'listen_addresses = *',
    'port = 9999',
    '',
  ].join('\n'));
  await writeFile(redisConfig, [
    '# bind 127.0.0.1',
    'bind 0.0.0.0',
    'protected-mode no',
    'port 6380',
    '',
  ].join('\n'));
  await writeFile(rabbitmqConfig, [
    'listeners.tcp.default = 5672',
    'vm_memory_calculation_strategy = rss',
    'vm_memory_calculation_strategy=allocated',
    '',
  ].join('\n'));
  await writeFile(rabbitmqEnv, [
    '#NODE_IP_ADDRESS=127.0.0.1',
    '#NODE_PORT=5672',
    '',
  ].join('\n'));
  await writeFile(preparePostgresql, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(prepareLog)}, \`\${process.argv[2]}\\n\`);`,
  ].join('\n'));

  await execFileAsync('/bin/bash', [
    'scripts/configure-support-listeners-v5.sh',
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      ONLYOFFICE_POSTGRESQL_CONFIG_GLOB: postgresqlConfig,
      ONLYOFFICE_REDIS_CONFIG_FILE: redisConfig,
      ONLYOFFICE_RABBITMQ_CONFIG_FILE: rabbitmqConfig,
      ONLYOFFICE_RABBITMQ_ENV_FILE: rabbitmqEnv,
      ONLYOFFICE_NODE_BIN: process.execPath,
      ONLYOFFICE_SUPPORT_RUNTIME_PREPARER: preparePostgresql,
    },
  });

  const [postgresql, redis, rabbitmq, rabbitEnv, preparedPostgresql] = await Promise.all([
    readFile(postgresqlConfig, 'utf8'),
    readFile(redisConfig, 'utf8'),
    readFile(rabbitmqConfig, 'utf8'),
    readFile(rabbitmqEnv, 'utf8'),
    readFile(prepareLog, 'utf8'),
  ]);
  assert.deepEqual(postgresql.match(/^listen_addresses\s*=.*$/gm), ["listen_addresses = '127.0.0.1'"]);
  assert.deepEqual(postgresql.match(/^port\s*=.*$/gm), ['port = 5432']);
  assert.deepEqual(redis.match(/^bind\s+.*$/gm), ['bind 127.0.0.1']);
  assert.deepEqual(redis.match(/^protected-mode\s+.*$/gm), ['protected-mode yes']);
  assert.deepEqual(redis.match(/^port\s+.*$/gm), ['port 6379']);
  assert.deepEqual(rabbitmq.match(/^listeners\.tcp\.default\s*=.*$/gm), ['listeners.tcp.default = 127.0.0.1:5672']);
  assert.deepEqual(rabbitmq.match(/^distribution\.listener\.interface\s*=.*$/gm), ['distribution.listener.interface = 127.0.0.1']);
  assert.deepEqual(rabbitmq.match(/^vm_memory_calculation_strategy\s*=.*$/gm), ['vm_memory_calculation_strategy = erlang']);
  assert.deepEqual(rabbitEnv.match(/^NODE_IP_ADDRESS=.*$/gm), ['NODE_IP_ADDRESS=127.0.0.1']);
  assert.deepEqual(rabbitEnv.match(/^NODENAME=.*$/gm), ['NODENAME=rabbit@localhost']);
  assert.deepEqual(rabbitEnv.match(/^NODE_PORT=.*$/gm), ['NODE_PORT=5672']);
  assert.deepEqual(rabbitEnv.match(/^ERL_EPMD_ADDRESS=.*$/gm), ['ERL_EPMD_ADDRESS=127.0.0.1']);
  assert.equal(preparedPostgresql, `${postgresqlConfig}\n${postgresqlConfig}\n`);
});

test('configuration and readiness require the exact IPv6 DocService nginx pairing', async () => {
  const agentRoot = new URL('..', import.meta.url);
  const [configureScript, configurator, healthcheck] = await Promise.all([
    readFile(new URL('scripts/configure-document-server-v5.sh', agentRoot), 'utf8'),
    readFile(new URL('scripts/configure-docservice-nginx-loopback.mjs', agentRoot), 'utf8'),
    readFile(new URL('scripts/healthcheck.sh', agentRoot), 'utf8'),
  ]);

  assert.match(
    configureScript,
    /\/usr\/local\/bin\/node "\$docservice_nginx_configurator"/,
  );
  assert.match(
    healthcheck,
    /configure-docservice-nginx-loopback\.mjs --verify-runtime/,
  );
  assert.match(
    healthcheck,
    /assert_exact_docservice_listener/,
  );
  assert.match(
    healthcheck,
    /\$4 == "\[::1\]:8000"/,
  );
  assert.match(
    healthcheck,
    /assert_loopback_owner 'OnlyOffice DocService' 8000 docservice/,
  );
  assert.match(
    healthcheck,
    /\/usr\/local\/bin\/node \/code\/scripts\/verify-document-server-jwt-config\.mjs/,
  );
  assert.match(
    configurator,
    /aliasPath: '\/etc\/nginx\/includes\/http-common\.conf'/,
  );
  assert.match(
    configurator,
    /\.\.\/\.\.\/onlyoffice\/documentserver\/nginx\/includes\/http-common\.conf/,
  );
  assert.match(
    configurator,
    /canonicalRealPath !== aliasRealPath/,
  );
  assert.match(
    configurator,
    /uid: 105,[\s\S]*gid: 107,[\s\S]*mode: 0o644/,
  );
  assert.match(
    configurator,
    /entries\[0\]\.stat\.dev === entries\[1\]\.stat\.dev/,
  );
  assert.match(
    configurator,
    /entries\[0\]\.content\.equals\(entries\[1\]\.content\)/,
  );
});

test('configuration writes inbox JWTs into the body before fail-closed verification', async () => {
  const configureScript = await readFile(
    new URL('scripts/configure-document-server-v5.sh', new URL('..', import.meta.url)),
    'utf8',
  );
  const matches = [...configureScript.matchAll(
    /"\$\{json_bin\}" -I -f "\$\{config_file\}" -e '([^']*token\.inbox[^']*)'/g,
  )];
  assert.equal(matches.length, 1);

  const config = { services: { CoAuthoring: { token: {} } } };
  Function(matches[0][1]).call(config);
  assert.equal(config.services.CoAuthoring.token.inbox.inBody, true);
  assert.ok(
    configureScript.indexOf(matches[0][0])
      < configureScript.indexOf('"/usr/local/bin/node" "$jwt_config_verifier"'),
  );
});
