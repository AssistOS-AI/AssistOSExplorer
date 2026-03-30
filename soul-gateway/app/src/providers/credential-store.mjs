import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('credential-store');

const BASE_DIR = process.env.CREDENTIAL_STORE_PATH || '/shared/soul-gateway/providers';

function accountsDir(providerName) {
  return join(BASE_DIR, providerName, 'accounts');
}

function statePath(providerName) {
  return join(BASE_DIR, providerName, 'state.json');
}

export async function ensureProviderDir(providerName) {
  await mkdir(accountsDir(providerName), { recursive: true });
}

export async function readAccounts(providerName) {
  try {
    const dir = accountsDir(providerName);
    const files = await readdir(dir);
    const accounts = [];
    for (const file of files.filter(f => f.startsWith('account-') && f.endsWith('.json')).sort()) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf8'));
        const index = parseInt(file.replace('account-', '').replace('.json', ''));
        accounts.push({ ...data, _index: index });
      } catch { /* skip corrupt files */ }
    }
    return accounts;
  } catch {
    return [];
  }
}

export async function writeAccount(providerName, index, data) {
  await ensureProviderDir(providerName);
  const file = join(accountsDir(providerName), `account-${index}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
}

export async function removeAccount(providerName, index) {
  try {
    const file = join(accountsDir(providerName), `account-${index}.json`);
    await unlink(file);
  } catch { /* file may not exist */ }
}

export async function readState(providerName) {
  try {
    return JSON.parse(await readFile(statePath(providerName), 'utf8'));
  } catch {
    return { activeIndex: 0, lastRotation: null };
  }
}

export async function writeState(providerName, state) {
  await ensureProviderDir(providerName);
  await writeFile(statePath(providerName), JSON.stringify(state, null, 2));
}

export async function nextAccountIndex(providerName) {
  const accounts = await readAccounts(providerName);
  if (accounts.length === 0) return 0;
  return Math.max(...accounts.map(a => a._index)) + 1;
}
