import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXPORT_LEDGER, skillTreeDigest } from './managed-skill-exports.mjs';

// Retain CLI update ownership while Ploinky publishes the actual links.
export async function readRepositorySkillState(folder) {
  const file = path.join(folder, '.agents', EXPORT_LEDGER);
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('Invalid skill ownership record');
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    if (ledger.version !== 1 || !ledger.entries || Array.isArray(ledger.entries)) throw new Error('Invalid skill ownership record');
    return ledger;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, entries: {} };
  }
}

export function ownsRepositorySkillLink(ledger, name, destination) {
  const record = ledger.entries[name];
  return record?.owner === 'manifest' && record.kind === 'symlink' && skillTreeDigest(destination) === record.digest;
}

export async function saveRepositorySkillState(folder, ledger, result, removed, entries) {
  for (const destination of removed) delete ledger.entries[path.basename(destination)];
  for (const link of result.results) {
    if (!['installed', 'present'].includes(link.status) || path.dirname(link.destination) !== path.join(folder, '.agents/skills')) continue;
    const name = path.basename(link.destination);
    const source = entries.find(entry => entry.skills.includes(name));
    if (!source) continue;
    ledger.entries[name] = { owner: 'manifest', kind: 'symlink', digest: skillTreeDigest(link.destination),
      source: { name: source.name, url: source.url, branch: source.branch } };
  }
  const file = path.join(folder, '.agents', EXPORT_LEDGER);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(ledger), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}
