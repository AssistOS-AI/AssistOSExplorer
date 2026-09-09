import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exact = (...parts) => new RegExp(`\\b${parts.join('_')}\\b`);
const FORBIDDEN = [
  [['retired', ['web', 'publishing'].join('-'), 'agent'].join(' '), new RegExp(`\\b${['basic', ['web', 'publishing'].join('-')].join('/')}\\b`)],
  [['retired', ['web', 'publishing'].join('-'), 'component'].join(' '), new RegExp(`\\b${['web', 'publishing'].join('-')}\\b`, 'i')],
  ['retired basic cloudflared component', new RegExp(`\\b${['basic', 'cloudflared'].join('/')}\\b`, 'i')],
  ['retired standalone cloudflared agent', new RegExp(`\\b${['cloudflared', 'agent'].join('-')}\\b`, 'i')],
  ['retired publication environment', new RegExp(`\\b${['WEB', 'PUBLISHING'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired OnlyOffice public URL', exact('ONLYOFFICE', 'PUBLIC', 'URL')],
  ['retired OnlyOffice internal URL', exact('ONLYOFFICE', 'INTERNAL', 'URL')],
  ['retired OnlyOffice callback base URL', exact('ONLYOFFICE', 'CALLBACK', 'BASE', 'URL')],
  ['retired WebMeet LiveKit environment', new RegExp(`\\bWEBMEET_[A-Z0-9_]*${['LIVE', 'KIT'].join('')}[A-Z0-9_]*\\b`)],
  ['retired WebMeet TURN environment', new RegExp(`\\b${['WEBMEET', 'TURN'].join('_')}_[A-Z0-9_]*\\b`)],
  ['retired WebMeet TLS hostname', exact('WEBMEET', 'TLS', 'HOSTNAME')],
  ['retired WebMeet certificate email', exact('WEBMEET', 'CERT', 'EMAIL')],
];

test('runtime-v5 active source omits retired edge-publication symbols', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const violations = [];
  for (const relative of files) {
    if (relative.startsWith('docs/superpowers/')) continue;
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(source)) violations.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});
