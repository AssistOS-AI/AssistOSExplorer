#!/usr/bin/env node

// Plants a fabricated owner Codex login for the route-A probes that must not use the real one (C3 rejected authentication, C4 near
// expiry, C11 leak negative control): `node ./scripts/codex-test-auth-synthetic-owner.mjs plant <dir> --exp-minutes <n>`.
// It writes <dir>/auth.json once (O_EXCL, mode 0600, <dir> created 0700 when absent) in the managed ChatGPT shape that
// lib/codex-test-auth-owner.mjs accepts, with random tokens that were never issued by anyone. Point CODEX_TEST_AUTH_OWNER_AUTH at it.
// Nothing here makes a network call, reads a credential or runs Codex. A <dir> inside the account's own Codex directory is refused.
// Stdout is one JSON line with the file and the validity in minutes; a token value is never printed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLAIM_KEY = 'https://api.openai.com/auth';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const random = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

function usage(reason) {
  process.stdout.write(`${JSON.stringify({ command: 'plant', result: 'failed', code: 'USAGE', reason })}\n`);
  process.exitCode = 2;
}

// The realpath of the nearest existing ancestor plus the lexical tail, so a directory that does not exist yet is still located.
function locate(target) {
  const tail = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export function syntheticOwnerLogin({ expMs, now = Date.now() }) {
  const account = `acct-synthetic-${random(8)}`;
  const token = (kind) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(expMs / 1000), sub: `synthetic-owner-${kind}-${random(8)}`,
    [CLAIM_KEY]: { chatgpt_account_id: account } })}.synthetic-signature-${random(8)}`;
  return Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: token('id'), access_token: token('access'), refresh_token: `rt-synthetic-${random()}`, account_id: account },
    last_refresh: new Date(now).toISOString() }));
}

function plant(argv) {
  const [directory, flag, minutesText, ...rest] = argv;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes('\0')) return usage('relative-path');
  if (flag !== '--exp-minutes' || rest.length > 0 || !/^-?[0-9]{1,6}$/.test(String(minutesText))) return usage('bad-variable');
  const minutes = Number(minutesText);
  // The account's own Codex directory is refused by name first, before any file system call could touch it; the located path then
  // catches a symlinked route into it. Only the home directory itself and the given path are ever resolved.
  const realCodex = [path.join(os.userInfo().homedir, '.codex'), path.join(locate(os.userInfo().homedir), '.codex')];
  const overlaps = (candidate) => realCodex.some((root) => inside(root, candidate) || inside(candidate, root));
  if (overlaps(path.resolve(directory)) || overlaps(locate(directory))) return usage('owner-location');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'auth.json');
  const now = Date.now();
  const bytes = syntheticOwnerLogin({ expMs: now + minutes * 60_000, now });
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch (error) {
    if (error?.code === 'EEXIST') return usage('target-exists');
    throw error;
  }
  try { fs.writeSync(fd, bytes); } finally { fs.closeSync(fd); bytes.fill(0); }
  // The mode was set at creation; the path chmod (descriptor chmod is unavailable under Node's permission model) only undoes a umask,
  // and the lstat proves the name is still the regular single-link file just created.
  fs.chmodSync(file, 0o600);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return usage('target-exists');
  process.stdout.write(`${JSON.stringify({ command: 'plant', result: 'done', code: 'OK', file, accessValidMinutes: minutes })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'plant') plant(process.argv.slice(3));
  else usage('bad-subcommand');
}
