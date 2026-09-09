import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HISTORICAL_PREFIXES = ['docs/superpowers/'];
const exact = (...parts) => new RegExp(`\\b${parts.join('_')}\\b`);
const FORBIDDEN = [
  ['retired media repository', new RegExp(['webmeet', 'Infra'].join(''), 'i')],
  ['retired web-publishing agent', new RegExp(`\\b${['basic', 'web-publishing'].join('/')}\\b`)],
  ['retired basic cloudflared component', new RegExp(`\\b${['basic', 'cloudflared'].join('/')}\\b`, 'i')],
  ['retired publication environment', new RegExp(`\\b${['WEB', 'PUBLISHING'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired OnlyOffice public URL', exact('ONLYOFFICE', 'PUBLIC', 'URL')],
  ['retired OnlyOffice internal URL', exact('ONLYOFFICE', 'INTERNAL', 'URL')],
  ['retired OnlyOffice callback base URL', exact('ONLYOFFICE', 'CALLBACK', 'BASE', 'URL')],
  ['retired WebMeet LiveKit environment', new RegExp(`\\bWEBMEET_[A-Z0-9_]*${['LIVE', 'KIT'].join('')}[A-Z0-9_]*\\b`)],
  ['retired WebMeet TURN environment', new RegExp(`\\b${['WEBMEET', 'TURN'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired WebMeet TLS hostname', exact('WEBMEET', 'TLS', 'HOSTNAME')],
  ['retired WebMeet certificate email', exact('WEBMEET', 'CERT', 'EMAIL')],
  ['retired Box evidence helper', new RegExp(`\\bv[56]-${['box', 'evidence'].join('-')}\\b`, 'i')],
  ['retired live Box helper', new RegExp(`\\bv[56]-${['live', 'box'].join('-')}\\b`, 'i')],
  ['retired Box smoke environment', new RegExp(`\\bSMOKE_V[56]_[A-Z0-9_]*\\b`)],
  ['retired Box runtime label', new RegExp(['io', 'assistos', 'ploinky', 'runtime-contract'].join('\\.'))],
  ['retired external scanner identity', new RegExp(`\\b${['ploinky', 'external', 'boundary', 'v1'].join('-')}\\b`)],
];

test('tracked executable, config, workflow, test, and normative documentation scopes omit retired publication symbols', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const violations = [];
  for (const relative of tracked) {
    if (HISTORICAL_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    for (const [label, pattern] of FORBIDDEN) {
      const activeSource = label === 'retired media repository' && relative === '.github/workflows/deploy-skills-explorer.yml'
        ? source.replace(/^          # BEGIN LiveKit repository migration\n[\s\S]*?^          # END LiveKit repository migration$/gm, '')
        : source;
      if (pattern.test(activeSource)) violations.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});
