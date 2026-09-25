// Explorer adapter for the shared skill export transaction protocol. The
// protocol module is a byte-identical copy of Ploinky's
// cli/utils/skills/exportTransaction.mjs; only the link factory differs.
import {
  syncManagedSkillExports as syncWithTransaction,
  relativeSkillLink,
  skillTreeDigest,
  EXPORT_LEDGER
} from './skill-export-transaction.mjs';

export { skillTreeDigest, EXPORT_LEDGER };

/** Exports skills as links. Existing files are never adopted from names and
 * replaced links are retained outside the skill root. Publication runs as one
 * recoverable transaction under the
 * folder's export lock.
 */
export function syncManagedSkillExports(options) {
  return syncWithTransaction({ linker: relativeSkillLink, ...options });
}
